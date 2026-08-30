// Issue #27 [E27] — the e-way bill lifecycle.
//
// Four rules run through everything below.
//
//   1. **A Part A number is not a permit.** A consignment with Part A and no vehicle is
//      `PART_A_ONLY`, and every sentence this module produces about it says the goods may not move
//      yet. The state after a timeout is `PENDING` — "we do not know" — and never `ACTIVE`.
//   2. **One movement, one e-way bill.** The idempotency key comes from the movement rather than
//      from the attempt, and the portal's own duplicate reply is treated as success. Pressing the
//      button twice cannot put two permits on the same lorry.
//   3. **Validity is derived, never stored as an opinion.** A bill whose midnight has passed reads
//      as expired the moment it is looked at, whatever the last write said.
//   4. **Nothing is guessed.** A missing fact is a question with the movement held back, not a
//      default that lets a lorry leave.

import { conflict, forbidden, invalid, notFound, type CompanyId, type Clock } from "@invoice/kernel";
import type { ActorContext, AuditPort } from "@invoice/ledger";
import { consignmentValueOf, decideEwayApplicability, movementRoute } from "./applicability.ts";
import { buildPartA, buildPartB, toOfflineJson, type PayloadProblem } from "./payload.ts";
import {
  canExtendNow, describeExpiry, describeTimeLeft, isExpired, normaliseVehicleNumber, validityDays,
} from "./validity.ts";
import { DEFAULT_EWAY_BILL_POLICY } from "./types.ts";
import type {
  ConsolidatedTripRecord, EwayApplicabilityDecision, EwayBillPolicy, EwayBillRecord,
  EwayBillStatus, EwayCancelReasonCode, EwayRejectReasonCode, EwayVehicleLeg, Movement,
  TransporterAssignment, VehicleAssignment,
} from "./types.ts";
import type {
  ConsolidatedTripRepository, EwayBillPolicyPort, EwayBillPort, EwayBillRepository,
} from "./ports.ts";
import type { Id, IsoDate } from "../../masters/src/types.ts";

/** Raising a permit for goods on the road is its own permission, separate from billing. */
export const EWAY_GENERATE_PERMISSION = "eway.generate";
/** Adding or changing the vehicle: the transporter's day-to-day act. */
export const EWAY_UPDATE_PERMISSION = "eway.update";
/** Withdrawing a permit from the government's record is gated separately and needs a reason. */
export const EWAY_CANCEL_PERMISSION = "eway.cancel";
export const EWAY_VIEW_PERMISSION = "eway.view";

export interface EwayBillServiceDeps {
  readonly portal: EwayBillPort;
  readonly records: EwayBillRepository;
  readonly trips?: ConsolidatedTripRepository;
  readonly audit: AuditPort;
  readonly clock: Clock;
  readonly policy?: EwayBillPolicyPort;
  readonly idFactory?: () => string;
}

/** What a preview returns: the decision, what is missing, and nothing written anywhere. */
export interface EwayBillPreview {
  readonly applicability: EwayApplicabilityDecision;
  readonly ready: boolean;
  readonly problems: readonly PayloadProblem[];
  readonly consignmentValuePaise: bigint;
  /** How many days the bill would be valid for, once a vehicle is on it. */
  readonly validityDays?: number;
  /** True when Part B can go in straight away, so the goods can actually leave. */
  readonly vehicleReady: boolean;
  readonly summary: string;
}

export class EwayBillService {
  readonly #portal: EwayBillPort;
  readonly #records: EwayBillRepository;
  readonly #trips: ConsolidatedTripRepository | undefined;
  readonly #audit: AuditPort;
  readonly #clock: Clock;
  readonly #policy: EwayBillPolicyPort | undefined;
  readonly #newId: () => string;

  constructor(deps: EwayBillServiceDeps) {
    this.#portal = deps.portal;
    this.#records = deps.records;
    this.#trips = deps.trips;
    this.#audit = deps.audit;
    this.#clock = deps.clock;
    this.#policy = deps.policy;
    this.#newId = deps.idFactory ?? (() => crypto.randomUUID());
  }

  // ------------------------------------------------------------------------ reading

  async forMovement(actor: ActorContext, movementId: Id): Promise<EwayBillRecord | null> {
    this.#require(actor, EWAY_VIEW_PERMISSION);
    const record = await this.#records.findByMovementId(actor.companyId, movementId);
    return record === null ? null : this.#withExpiry(record);
  }

  async byNumber(actor: ActorContext, ewayBillNumber: string): Promise<EwayBillRecord | null> {
    this.#require(actor, EWAY_VIEW_PERMISSION);
    const record = await this.#records.findByNumber(actor.companyId, ewayBillNumber);
    return record === null ? null : this.#withExpiry(record);
  }

  async list(actor: ActorContext): Promise<readonly EwayBillRecord[]> {
    this.#require(actor, EWAY_VIEW_PERMISSION);
    return (await this.#records.list(actor.companyId)).map((record) => this.#withExpiry(record));
  }

  /** What is on the road right now, and how long each one has left. */
  async onTheRoad(actor: ActorContext): Promise<readonly { readonly record: EwayBillRecord; readonly timeLeft: string }[]> {
    this.#require(actor, EWAY_VIEW_PERMISSION);
    const now = this.#clock.now();
    return (await this.#records.listActive(actor.companyId))
      .map((record) => this.#withExpiry(record))
      .filter((record) => record.status === "ACTIVE")
      .map((record) => ({
        record,
        timeLeft: record.acknowledgement?.validUntil === undefined
          ? "Waiting for a vehicle, so the clock has not started."
          : describeTimeLeft(record.acknowledgement.validUntil, now),
      }));
  }

  /** Bills about to run out, so a lorry is never stopped for a permit that quietly expired. */
  async expiringWithin(actor: ActorContext, hours: number): Promise<readonly EwayBillRecord[]> {
    this.#require(actor, EWAY_VIEW_PERMISSION);
    const before = new Date(this.#clock.now().getTime() + hours * 3_600_000).toISOString();
    return (await this.#records.listExpiringBefore(actor.companyId, before)).map((record) => this.#withExpiry(record));
  }

  /**
   * Everything raising a bill would do, written nowhere.
   *
   * Deliberately available before anything is sent. Most consignments a small business moves need
   * no e-way bill at all, and the honest thing to show first is the decision and the rule behind it
   * rather than a button.
   */
  async preview(actor: ActorContext, movement: Movement): Promise<EwayBillPreview> {
    this.#require(actor, EWAY_VIEW_PERMISSION);
    const applicability = decideEwayApplicability(movement);
    const value = consignmentValueOf(movement.documents);
    const policy = await this.#policyFor(actor.companyId, this.#dateOf(movement));

    if (applicability.outcome !== "REQUIRED") {
      return {
        applicability, ready: false, problems: [], vehicleReady: false,
        consignmentValuePaise: value.valuePaise,
        // The reason already says what was decided, so prefixing it would say it twice.
        summary: applicability.reason,
      };
    }

    const built = buildPartA(movement);
    const days = movement.approximateDistanceKm === undefined
      ? undefined
      : validityDays(movement.approximateDistanceKm, movement.vehicle?.vehicleType ?? movement.vehicleType, policy);
    const vehicleReady = movement.vehicle !== undefined;

    if (!built.ok) {
      return {
        applicability, ready: false, problems: built.problems, vehicleReady,
        consignmentValuePaise: value.valuePaise,
        ...(days === undefined ? {} : { validityDays: days }),
        summary: `This movement needs an e-way bill, but ${built.problems.length === 1 ? "one thing is" : `${built.problems.length} things are`} missing first: ${built.problems[0]?.message ?? ""}`,
      };
    }

    return {
      applicability, ready: true, problems: [], vehicleReady,
      consignmentValuePaise: value.valuePaise,
      ...(days === undefined ? {} : { validityDays: days }),
      summary: vehicleReady
        ? `This movement needs an e-way bill and everything is ready${days === undefined ? "" : `. Once the vehicle goes on it, it will be valid for ${days} day${days === 1 ? "" : "s"}`}.`
        : "This movement needs an e-way bill. It can be raised now, but the goods may not leave until a vehicle number is added to it.",
    };
  }

  // ------------------------------------------------------------------------ writing

  /**
   * Raises the e-way bill, once.
   *
   * Calling it again for the same movement returns the record that already exists rather than
   * raising a second permit — and if the portal says the consignment already has one, that reply is
   * treated as success and its number is kept.
   */
  async generate(actor: ActorContext, movement: Movement): Promise<EwayBillRecord> {
    this.#require(actor, EWAY_GENERATE_PERMISSION);
    const policy = await this.#policyFor(actor.companyId, this.#dateOf(movement));
    const at = this.#clock.now().toISOString();

    const existing = await this.#records.findByMovementId(actor.companyId, movement.movementId);
    if (existing !== null && ["ACTIVE", "PART_A_ONLY", "CANCELLED", "REJECTED", "EXPIRED"].includes(existing.status)) {
      return this.#withExpiry(existing);
    }

    const applicability = decideEwayApplicability(movement);
    if (applicability.outcome === "CANNOT_DECIDE") {
      throw invalid(
        "EWAY_CANNOT_DECIDE",
        `We cannot tell whether these goods need an e-way bill, so nothing has been raised and the vehicle should not leave yet. ${applicability.reason}`,
        { details: { missing: (applicability.missingFacts ?? []).join(", ") } },
      );
    }
    if (applicability.outcome === "NOT_REQUIRED") {
      // Raising one that was not needed puts a permit on the government's record with a validity
      // running against it, so this refuses rather than obliges.
      throw conflict(
        "EWAY_NOT_REQUIRED",
        `These goods do not need an e-way bill, so none has been raised. ${applicability.reason}`,
      );
    }

    const partA = buildPartA(movement);
    if (!partA.ok) {
      throw invalid(
        "EWAY_INCOMPLETE",
        `This e-way bill cannot be raised yet: ${partA.problems[0]?.message ?? "something is missing."}`,
        { details: { problems: partA.problems.map((problem) => `${problem.field}: ${problem.message}`).join(" | ") } },
      );
    }

    // Part B is optional here on purpose: Part A alone is a legitimate half-step, and the record
    // that comes back says plainly that the goods may not move on it.
    let partB: Readonly<Record<string, unknown>> | null = null;
    if (movement.vehicle !== undefined) {
      const built = buildPartB("0", movement.vehicle, movement.transportMode);
      if (!built.ok) {
        throw invalid("EWAY_VEHICLE_INVALID", built.problems[0]?.message ?? "The vehicle details are not right.");
      }
      const { ewbNo: _ignored, ...rest } = built.payload as Record<string, unknown>;
      partB = rest;
    }

    // Derived from the movement, never from the attempt: that is what makes a retry the same call.
    const idempotencyKey = `eway:generate:${actor.companyId}:${movement.movementId}`;
    const record = existing ?? this.#blank(actor, movement, applicability, at, idempotencyKey);
    if (existing === null) await this.#records.insert(record);

    // Marked pending before the call, so a process that dies mid-flight leaves a record saying "we
    // do not know" rather than no record at all.
    const pending: EwayBillRecord = {
      ...record, status: "PENDING", applicability, updatedAt: at,
      message: "This movement has been sent to the e-way bill portal and we are waiting for the number.",
    };
    await this.#records.update(pending);

    const outcome = await this.#portal.generate(actor.companyId, movement, partA.payload, partB, idempotencyKey);

    if (outcome.kind === "UNAVAILABLE") {
      const failed: EwayBillRecord = {
        ...pending, status: "FAILED", updatedAt: this.#clock.now().toISOString(),
        failure: { code: outcome.code, message: outcome.message, retryable: outcome.retryable },
        message: `${outcome.message} No e-way bill number has been given, so these goods must not leave yet.${outcome.retryable ? " We will try again, and the consignment can also be prepared as a file for manual upload." : ""}`,
      };
      await this.#records.update(failed);
      await this.#record(actor, failed, "eway.generate_failed", { code: outcome.code, retryable: String(outcome.retryable) });
      return failed;
    }

    if (outcome.kind === "REJECTED") {
      const failed: EwayBillRecord = {
        ...pending, status: "FAILED", updatedAt: this.#clock.now().toISOString(),
        failure: { code: outcome.code, message: outcome.message, retryable: false },
        message: `The portal did not accept this movement: ${outcome.message} Sending it again unchanged will get the same answer, so something on it needs correcting first.`,
      };
      await this.#records.update(failed);
      await this.#record(actor, failed, "eway.rejected", { code: outcome.code, hints: (outcome.fieldHints ?? []).join(", ") });
      return failed;
    }

    const acknowledgement = outcome.acknowledgement;
    if (acknowledgement.ewayBillNumber.trim() === "") {
      const failed: EwayBillRecord = {
        ...pending, status: "FAILED", updatedAt: this.#clock.now().toISOString(),
        failure: { code: "NO_NUMBER", message: "The portal's reply had no e-way bill number in it.", retryable: true },
        message: "The portal's reply did not contain an e-way bill number, so nothing has been recorded and the goods must not leave yet.",
      };
      await this.#records.update(failed);
      await this.#record(actor, failed, "eway.acknowledgement_rejected", { problem: "NO_NUMBER" });
      return failed;
    }

    const moving = partB !== null;
    const legs: readonly EwayVehicleLeg[] = moving && movement.vehicle !== undefined
      ? [this.#legOf(actor, movement.vehicle, movement.transportMode, "FIRST_TIME")]
      : [];

    const generated: EwayBillRecord = {
      ...pending,
      status: moving ? "ACTIVE" : "PART_A_ONLY",
      acknowledgement,
      vehicleLegs: legs,
      ...(movement.transporter === undefined ? {} : { transporter: movement.transporter }),
      updatedAt: this.#clock.now().toISOString(),
      cancellableUntil: new Date(this.#portalTime(acknowledgement.generatedAt).getTime() + policy.cancellationWindowHours * 3_600_000).toISOString(),
      message: outcome.kind === "DUPLICATE"
        ? "This consignment already had an e-way bill, so the existing number has been kept. Nothing has been raised twice."
        : moving
          ? `E-way bill ${acknowledgement.ewayBillNumber} is ready. Keep the number with the driver.${acknowledgement.validUntil === undefined ? "" : ` It is valid until ${describeExpiry(acknowledgement.validUntil)}.`}`
          : `E-way bill ${acknowledgement.ewayBillNumber} has been raised without a vehicle. The goods may not move until the vehicle number is added to it.`,
    };
    await this.#records.update(generated);
    await this.#record(actor, generated, outcome.kind === "DUPLICATE" ? "eway.duplicate_reconciled" : "eway.generated", {
      ewayBillNumber: acknowledgement.ewayBillNumber,
      partB: moving ? "present" : "absent",
      validUntil: acknowledgement.validUntil ?? "not started",
    });
    return generated;
  }

  /**
   * Adds or changes the vehicle — Part B.
   *
   * This is where validity starts. It is also the ordinary act of a working transport office: a
   * lorry breaks down at Hubballi and the goods go on another one, and the e-way bill has to follow
   * the goods rather than the paperwork.
   */
  async updateVehicle(
    actor: ActorContext,
    movementId: Id,
    vehicle: VehicleAssignment,
    options: { readonly mode?: Movement["transportMode"] } = {},
  ): Promise<EwayBillRecord> {
    this.#require(actor, EWAY_UPDATE_PERMISSION);
    const record = this.#withExpiry(await this.#mustFind(actor, movementId));
    if (record.status === "CANCELLED" || record.status === "REJECTED") {
      throw conflict("EWAY_NOT_LIVE", `This e-way bill is ${record.status.toLowerCase()}, so a vehicle cannot be put on it. Raise a fresh one for the goods.`);
    }
    if (record.status === "EXPIRED") {
      throw conflict("EWAY_EXPIRED", "This e-way bill has run out, so a vehicle cannot be put on it. Extend it if the portal still allows that, or raise a fresh one.");
    }
    if (record.acknowledgement === undefined) {
      throw conflict("EWAY_NOT_RAISED", "This movement has no e-way bill number yet, so there is nothing to add a vehicle to.");
    }

    const mode = options.mode ?? record.vehicleLegs[record.vehicleLegs.length - 1]?.mode ?? "ROAD";
    const built = buildPartB(record.acknowledgement.ewayBillNumber, vehicle, mode);
    if (!built.ok) throw invalid("EWAY_VEHICLE_INVALID", built.problems[0]?.message ?? "The vehicle details are not right.");

    const first = record.vehicleLegs.length === 0;
    // A vehicle change after the first one has to say why: the portal asks, and so does an officer.
    const reason = vehicle.reason ?? (first ? "FIRST_TIME" : "OTHERS");
    const outcome = await this.#portal.updateVehicle(actor.companyId, built.payload, `eway:partb:${actor.companyId}:${movementId}:${normaliseVehicleNumber(vehicle.registrationNumber)}`);

    if (outcome.kind === "UNAVAILABLE") {
      throw conflict("EWAY_UPDATE_UNAVAILABLE", `${outcome.message} The vehicle has not been recorded on the e-way bill; nothing has changed.`);
    }
    if (outcome.kind === "REFUSED") {
      throw conflict("EWAY_UPDATE_REFUSED", `The portal would not accept this vehicle: ${outcome.message}`);
    }

    const updated: EwayBillRecord = {
      ...record,
      status: "ACTIVE",
      acknowledgement: outcome.acknowledgement,
      vehicleLegs: [...record.vehicleLegs, this.#legOf(actor, vehicle, mode, reason)],
      updatedAt: this.#clock.now().toISOString(),
      message: first
        ? `Vehicle ${normaliseVehicleNumber(vehicle.registrationNumber)} is on e-way bill ${record.acknowledgement.ewayBillNumber}. The goods may move now${outcome.acknowledgement.validUntil === undefined ? "" : `, and the bill is valid until ${describeExpiry(outcome.acknowledgement.validUntil)}`}.`
        : `The goods have moved to vehicle ${normaliseVehicleNumber(vehicle.registrationNumber)}. The e-way bill number is unchanged, and its validity has not restarted.`,
    };
    await this.#records.update(updated);
    await this.#record(actor, updated, first ? "eway.part_b_entered" : "eway.vehicle_changed", {
      ewayBillNumber: record.acknowledgement.ewayBillNumber,
      vehicle: normaliseVehicleNumber(vehicle.registrationNumber),
      reason,
    }, vehicle.reasonNote);
    return updated;
  }

  /** Hands the consignment to a transporter, who fills in the vehicle themselves. */
  async assignTransporter(actor: ActorContext, movementId: Id, transporter: TransporterAssignment): Promise<EwayBillRecord> {
    this.#require(actor, EWAY_UPDATE_PERMISSION);
    const record = this.#withExpiry(await this.#mustFind(actor, movementId));
    if (record.acknowledgement === undefined) {
      throw conflict("EWAY_NOT_RAISED", "This movement has no e-way bill number yet, so there is no one to hand it to.");
    }
    if (record.status === "CANCELLED" || record.status === "REJECTED" || record.status === "EXPIRED") {
      throw conflict("EWAY_NOT_LIVE", `This e-way bill is ${record.status.toLowerCase()}, so it cannot be handed to a transporter.`);
    }

    const outcome = await this.#portal.assignTransporter(actor.companyId, {
      ewayBillNumber: record.acknowledgement.ewayBillNumber,
      transporterId: transporter.transporterId.toUpperCase(),
      idempotencyKey: `eway:transporter:${actor.companyId}:${movementId}:${transporter.transporterId.toUpperCase()}`,
    });
    if (outcome.kind === "UNAVAILABLE") throw conflict("EWAY_UPDATE_UNAVAILABLE", `${outcome.message} The transporter has not been recorded; nothing has changed.`);
    if (outcome.kind === "REFUSED") throw conflict("EWAY_UPDATE_REFUSED", `The portal would not accept this transporter: ${outcome.message}`);

    const updated: EwayBillRecord = {
      ...record, transporter, acknowledgement: outcome.acknowledgement,
      updatedAt: this.#clock.now().toISOString(),
      message: `${transporter.name} is now the transporter on e-way bill ${record.acknowledgement.ewayBillNumber}. They can add the vehicle themselves; until they do, the goods may not move.`,
    };
    await this.#records.update(updated);
    await this.#record(actor, updated, "eway.transporter_assigned", {
      ewayBillNumber: record.acknowledgement.ewayBillNumber, transporterId: transporter.transporterId,
    });
    return updated;
  }

  /**
   * Extends a bill that is about to run out, or has just run out.
   *
   * The window is the portal's and it is narrow — eight hours either side of midnight. Checked here
   * before the call so a driver gets a sentence they can act on rather than error 378, but the
   * portal is the authority and its refusal is honoured if the two disagree.
   */
  async extendValidity(
    actor: ActorContext,
    movementId: Id,
    input: { readonly currentPlace: string; readonly currentStateCode: string; readonly remainingDistanceKm: number; readonly reason: string; readonly reasonCode?: string; readonly vehicleNumber?: string },
  ): Promise<EwayBillRecord> {
    this.#require(actor, EWAY_UPDATE_PERMISSION);
    const record = await this.#mustFind(actor, movementId);
    const policy = await this.#policyFor(actor.companyId, record.documentDate);
    if (record.acknowledgement?.validUntil === undefined) {
      throw conflict("EWAY_NOT_RUNNING", "This e-way bill has no validity running yet, because no vehicle has been put on it. There is nothing to extend.");
    }
    if (record.status === "CANCELLED" || record.status === "REJECTED") {
      throw conflict("EWAY_NOT_LIVE", `This e-way bill is ${record.status.toLowerCase()} and cannot be extended.`);
    }
    if (input.reason.trim() === "") {
      throw invalid("EWAY_EXTENSION_REASON_REQUIRED", "Please say why the journey is taking longer; the portal asks for a reason and it stays on the record.");
    }

    const allowed = canExtendNow(record.acknowledgement.validUntil, this.#clock.now(), policy);
    if (!allowed.ok) throw conflict("EWAY_EXTENSION_WINDOW", allowed.explanation);

    const outcome = await this.#portal.extendValidity(actor.companyId, {
      ewayBillNumber: record.acknowledgement.ewayBillNumber,
      currentPlace: input.currentPlace,
      currentStateCode: input.currentStateCode,
      remainingDistanceKm: input.remainingDistanceKm,
      reasonCode: input.reasonCode ?? "1",
      reason: input.reason,
      ...(input.vehicleNumber === undefined ? {} : { vehicleNumber: normaliseVehicleNumber(input.vehicleNumber) }),
      idempotencyKey: `eway:extend:${actor.companyId}:${movementId}:${record.acknowledgement.validUntil}`,
    });
    if (outcome.kind === "UNAVAILABLE") throw conflict("EWAY_EXTEND_UNAVAILABLE", `${outcome.message} The e-way bill has not been extended; nothing has changed.`);
    if (outcome.kind === "REFUSED") throw conflict("EWAY_EXTEND_REFUSED", `The portal would not extend this e-way bill: ${outcome.message}`);

    const extended: EwayBillRecord = {
      ...record, status: "ACTIVE", acknowledgement: outcome.acknowledgement,
      updatedAt: this.#clock.now().toISOString(),
      message: `E-way bill ${record.acknowledgement.ewayBillNumber} has been extended${outcome.acknowledgement.validUntil === undefined ? "" : ` and is now valid until ${describeExpiry(outcome.acknowledgement.validUntil)}`}. Reason kept on record: ${input.reason}`,
    };
    await this.#records.update(extended);
    await this.#record(actor, extended, "eway.validity_extended", {
      ewayBillNumber: record.acknowledgement.ewayBillNumber,
      validUntil: outcome.acknowledgement.validUntil ?? "unknown",
      remainingKm: String(input.remainingDistanceKm),
    }, input.reason);
    return extended;
  }

  /**
   * Cancels an e-way bill with the portal.
   *
   * Two things make this different from cancelling an invoice. The window is twenty-four hours, and
   * a bill that has already been checked by an officer on the road cannot be cancelled at all — the
   * portal refuses, and that refusal is passed on in plain words rather than retried.
   */
  async cancel(
    actor: ActorContext,
    movementId: Id,
    input: { readonly reasonCode: EwayCancelReasonCode; readonly reason: string },
  ): Promise<EwayBillRecord> {
    this.#require(actor, EWAY_CANCEL_PERMISSION);
    const record = await this.#mustFind(actor, movementId);
    if (record.status === "CANCELLED") return record;
    if (record.acknowledgement === undefined) {
      throw conflict("EWAY_NOT_RAISED", "This movement has no e-way bill with the portal, so there is nothing to cancel.");
    }
    if (input.reason.trim() === "") {
      throw invalid("EWAY_CANCEL_REASON_REQUIRED", "Please say why this e-way bill is being cancelled; the portal asks for a reason and it is kept with the record.");
    }

    const now = this.#clock.now();
    if (record.cancellableUntil !== undefined && record.cancellableUntil <= now.toISOString()) {
      throw conflict(
        "EWAY_WINDOW_CLOSED",
        "The portal only allows an e-way bill to be cancelled within 24 hours of raising it, and that time has passed. The bill will simply run out at the end of its validity; if the goods never moved, keep a note of why on the movement.",
      );
    }

    const outcome = await this.#portal.cancel(actor.companyId, {
      ewayBillNumber: record.acknowledgement.ewayBillNumber,
      reasonCode: input.reasonCode,
      reason: input.reason,
      idempotencyKey: `eway:cancel:${actor.companyId}:${movementId}`,
    });
    if (outcome.kind === "UNAVAILABLE") throw conflict("EWAY_CANCEL_UNAVAILABLE", `${outcome.message} The e-way bill has not been cancelled; nothing has changed. Please try again.`);
    if (outcome.kind === "REFUSED") throw conflict("EWAY_CANCEL_REFUSED", `The portal would not cancel this e-way bill: ${outcome.message}`);

    const cancelled: EwayBillRecord = {
      ...record, status: "CANCELLED", cancelledAt: outcome.at,
      cancelReasonCode: input.reasonCode, cancelReason: input.reason,
      updatedAt: now.toISOString(),
      message: `E-way bill ${record.acknowledgement.ewayBillNumber} has been cancelled with the portal. The goods must not move on it. The bill in your books is unchanged — cancel or credit that separately if it is also wrong. Reason kept on record: ${input.reason}`,
    };
    await this.#records.update(cancelled);
    await this.#record(actor, cancelled, "eway.cancelled", {
      ewayBillNumber: record.acknowledgement.ewayBillNumber, reasonCode: input.reasonCode,
    }, input.reason);
    return cancelled;
  }

  /**
   * The other party saying the consignment is not theirs.
   *
   * Rejection is not cancellation. Anyone named on an e-way bill has seventy-two hours to say it is
   * nothing to do with them, and if nobody says anything the bill stands as accepted. Recording it
   * as its own state is what lets a business notice that a supplier has raised a movement against
   * them by mistake.
   */
  async reject(
    actor: ActorContext,
    movementId: Id,
    input: { readonly reasonCode: EwayRejectReasonCode; readonly reason: string },
  ): Promise<EwayBillRecord> {
    this.#require(actor, EWAY_CANCEL_PERMISSION);
    const record = await this.#mustFind(actor, movementId);
    if (record.acknowledgement === undefined) {
      throw conflict("EWAY_NOT_RAISED", "This movement has no e-way bill with the portal, so there is nothing to reject.");
    }
    const policy = await this.#policyFor(actor.companyId, record.documentDate);
    const raisedAt = this.#portalTime(record.acknowledgement.generatedAt).getTime();
    const now = this.#clock.now();
    if (now.getTime() - raisedAt > policy.rejectionWindowHours * 3_600_000) {
      throw conflict(
        "EWAY_REJECT_WINDOW_CLOSED",
        `An e-way bill can only be rejected within ${policy.rejectionWindowHours} hours of it being raised, and that time has passed. It now counts as accepted, so it has to be sorted out with the other party directly.`,
      );
    }

    const outcome = await this.#portal.reject(actor.companyId, {
      ewayBillNumber: record.acknowledgement.ewayBillNumber,
      reasonCode: input.reasonCode,
      reason: input.reason,
      idempotencyKey: `eway:reject:${actor.companyId}:${movementId}`,
    });
    if (outcome.kind === "UNAVAILABLE") throw conflict("EWAY_REJECT_UNAVAILABLE", `${outcome.message} The e-way bill has not been rejected; nothing has changed.`);
    if (outcome.kind === "REFUSED") throw conflict("EWAY_REJECT_REFUSED", `The portal would not reject this e-way bill: ${outcome.message}`);

    const rejected: EwayBillRecord = {
      ...record, status: "REJECTED", rejectedAt: outcome.at, rejectReasonCode: input.reasonCode,
      updatedAt: now.toISOString(),
      message: `E-way bill ${record.acknowledgement.ewayBillNumber} has been marked as not your consignment. The other party has been told. Reason kept on record: ${input.reason}`,
    };
    await this.#records.update(rejected);
    await this.#record(actor, rejected, "eway.rejected_by_party", {
      ewayBillNumber: record.acknowledgement.ewayBillNumber, reasonCode: input.reasonCode,
    }, input.reason);
    return rejected;
  }

  /**
   * One trip sheet for several consignments on one lorry.
   *
   * A consolidated bill does not replace the individual ones and does not extend anything: each
   * consignment keeps its own number and its own validity, and this is the sheet the driver shows.
   * Saying that clearly is the whole point of the message below.
   */
  async consolidate(
    actor: ActorContext,
    input: {
      readonly vehicleNumber: string; readonly fromPlace: string; readonly fromStateCode: string;
      readonly transportMode: Movement["transportMode"]; readonly movementIds: readonly Id[];
    },
  ): Promise<ConsolidatedTripRecord> {
    this.#require(actor, EWAY_UPDATE_PERMISSION);
    if (this.#trips === undefined) throw conflict("EWAY_CONSOLIDATION_UNAVAILABLE", "Consolidated trip sheets are not set up for this business.");
    if (input.movementIds.length < 2) {
      throw invalid("EWAY_CONSOLIDATION_TOO_SMALL", "A consolidated trip sheet is for two or more consignments on the same lorry. With one consignment, its own e-way bill is the document the driver carries.");
    }

    const records: EwayBillRecord[] = [];
    for (const movementId of input.movementIds) {
      const record = this.#withExpiry(await this.#mustFind(actor, movementId));
      if (record.acknowledgement === undefined || record.status === "CANCELLED" || record.status === "REJECTED" || record.status === "EXPIRED") {
        throw conflict(
          "EWAY_CONSOLIDATION_NOT_LIVE",
          `${record.documentNumber} has no live e-way bill (it is ${record.status.toLowerCase().replace(/_/g, " ")}), so it cannot go on a trip sheet. Sort that consignment out first.`,
        );
      }
      records.push(record);
    }

    const numbers = records.map((record) => record.acknowledgement?.ewayBillNumber ?? "");
    const outcome = await this.#portal.consolidate(actor.companyId, {
      vehicleNumber: normaliseVehicleNumber(input.vehicleNumber),
      fromPlace: input.fromPlace,
      fromStateCode: input.fromStateCode,
      transportMode: input.transportMode,
      ewayBillNumbers: numbers,
      idempotencyKey: `eway:consolidate:${actor.companyId}:${normaliseVehicleNumber(input.vehicleNumber)}:${[...numbers].sort().join(",")}`,
    });
    if (outcome.kind === "UNAVAILABLE") throw conflict("EWAY_CONSOLIDATE_UNAVAILABLE", `${outcome.message} No trip sheet has been made; the individual e-way bills are unaffected.`);
    if (outcome.kind === "REFUSED") throw conflict("EWAY_CONSOLIDATE_REFUSED", `The portal would not make this trip sheet: ${outcome.message}`);

    const trip: ConsolidatedTripRecord = {
      id: this.#newId(),
      companyId: actor.companyId,
      tripNumber: outcome.tripNumber,
      vehicleNumber: normaliseVehicleNumber(input.vehicleNumber),
      fromPlace: input.fromPlace,
      fromStateCode: input.fromStateCode,
      transportMode: input.transportMode,
      ewayBillNumbers: numbers,
      createdBy: actor.userId,
      createdAt: outcome.at,
      message: `Trip sheet ${outcome.tripNumber} covers ${numbers.length} consignments on ${normaliseVehicleNumber(input.vehicleNumber)}. Each consignment keeps its own e-way bill and its own expiry; this sheet is what the driver shows at a check post.`,
    };
    await this.#trips.insert(trip);

    for (const record of records) {
      await this.#records.update({ ...record, consolidatedTripNumber: outcome.tripNumber, updatedAt: this.#clock.now().toISOString() });
    }
    await this.#audit.record({
      companyId: actor.companyId, actorId: actor.userId, at: this.#clock.now().toISOString(),
      action: "eway.consolidated", subjectType: "eway_trip", subjectId: trip.id,
      summary: trip.message,
      details: { tripNumber: trip.tripNumber, vehicle: trip.vehicleNumber, bills: numbers.join(", ") },
    });
    return trip;
  }

  /**
   * Asks the portal what it actually holds and reconciles our record with it.
   *
   * The honest answer to "the call timed out — did the bill get raised?" is to ask, and this is how.
   */
  async reconcile(actor: ActorContext, movementId: Id): Promise<EwayBillRecord> {
    this.#require(actor, EWAY_VIEW_PERMISSION);
    const record = await this.#mustFind(actor, movementId);
    const number = record.acknowledgement?.ewayBillNumber;
    if (number === undefined) {
      // Nothing to ask about: no number was ever received, so the honest state is unchanged.
      return record;
    }
    const outcome = await this.#portal.fetch(actor.companyId, number);
    const at = this.#clock.now().toISOString();
    if (outcome.kind === "UNAVAILABLE") return this.#withExpiry(record);
    if (outcome.kind === "NOT_FOUND") {
      const failed: EwayBillRecord = {
        ...record, status: "FAILED", updatedAt: at,
        failure: { code: "NOT_FOUND", message: "The portal has no record of this e-way bill.", retryable: true },
        message: "The portal has no record of this e-way bill, so the earlier attempt did not go through. It can be raised again.",
      };
      await this.#records.update(failed);
      return failed;
    }

    const status: EwayBillStatus = outcome.status;
    const reconciled: EwayBillRecord = {
      ...record, status, acknowledgement: outcome.acknowledgement, updatedAt: at,
      message: status === "CANCELLED"
        ? "The portal's record shows this e-way bill was cancelled."
        : status === "REJECTED"
          ? "The portal's record shows the other party rejected this consignment."
          : status === "PART_A_ONLY"
            ? "The portal holds Part A for this consignment but no vehicle, so the goods may not move yet."
            : `The portal's record shows this e-way bill is live${outcome.acknowledgement.validUntil === undefined ? "" : ` until ${describeExpiry(outcome.acknowledgement.validUntil)}`}.`,
    };
    await this.#records.update(reconciled);
    await this.#record(actor, reconciled, "eway.reconciled", { ewayBillNumber: number, status });
    return this.#withExpiry(reconciled);
  }

  /** Part A as a file, for the day the portal is down and the goods still have to go out. */
  async offlineJson(actor: ActorContext, movement: Movement): Promise<string> {
    this.#require(actor, EWAY_VIEW_PERMISSION);
    const applicability = decideEwayApplicability(movement);
    if (applicability.outcome === "NOT_REQUIRED") {
      throw conflict("EWAY_NOT_REQUIRED", `These goods do not need an e-way bill, so there is nothing to export. ${applicability.reason}`);
    }
    return toOfflineJson(movement);
  }

  // --------------------------------------------------------------------- internals

  /**
   * Expiry read at the moment of looking.
   *
   * A permit that ran out at midnight is expired whether or not anything has written to it since,
   * so this is derived here rather than trusted from the last update.
   */
  #withExpiry(record: EwayBillRecord): EwayBillRecord {
    if (record.status !== "ACTIVE" || !isExpired(record.acknowledgement?.validUntil, this.#clock.now())) return record;
    return {
      ...record,
      status: "EXPIRED",
      message: `E-way bill ${record.acknowledgement?.ewayBillNumber ?? ""} ran out at ${describeExpiry(record.acknowledgement?.validUntil ?? "")}. Goods must not move on it. If the journey is not finished, extend it if the portal still allows that, or raise a fresh one.`,
    };
  }

  #legOf(actor: ActorContext, vehicle: VehicleAssignment, mode: Movement["transportMode"], reason: EwayVehicleLeg["reason"]): EwayVehicleLeg {
    return {
      registrationNumber: normaliseVehicleNumber(vehicle.registrationNumber),
      vehicleType: vehicle.vehicleType,
      fromPlace: vehicle.fromPlace,
      fromStateCode: vehicle.fromStateCode,
      mode,
      reason,
      ...(vehicle.reasonNote === undefined ? {} : { reasonNote: vehicle.reasonNote }),
      recordedAt: this.#clock.now().toISOString(),
      recordedBy: actor.userId,
    };
  }

  #blank(actor: ActorContext, movement: Movement, applicability: EwayApplicabilityDecision, at: string, idempotencyKey: string): EwayBillRecord {
    const route = movementRoute(movement);
    const primary = movement.documents[0];
    return {
      id: this.#newId(),
      companyId: actor.companyId,
      movementId: movement.movementId,
      documentNumber: primary?.documentNumber ?? "",
      documentDate: this.#dateOf(movement),
      status: "PENDING",
      applicability,
      consignmentValuePaise: consignmentValueOf(movement.documents).valuePaise,
      fromStateCode: route.fromStateCode,
      toStateCode: route.toStateCode,
      ...(movement.approximateDistanceKm === undefined ? {} : { distanceKm: movement.approximateDistanceKm }),
      vehicleLegs: [],
      message: "This movement is about to be sent to the e-way bill portal.",
      createdBy: actor.userId,
      createdAt: at,
      updatedAt: at,
      idempotencyKey,
    };
  }

  #dateOf(movement: Movement): IsoDate {
    return movement.documents[0]?.documentDate ?? this.#clock.now().toISOString().slice(0, 10);
  }

  /** The portal writes wall-clock Indian time; this is the one place we read it. */
  #portalTime(raw: string): Date {
    const indian = /^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw.trim());
    if (indian === null) return new Date(raw);
    const [, day, month, year, hour, minute, second = "00"] = indian;
    return new Date(Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`) - 330 * 60_000);
  }

  async #policyFor(companyId: CompanyId, on: IsoDate): Promise<EwayBillPolicy> {
    return this.#policy === undefined ? DEFAULT_EWAY_BILL_POLICY : this.#policy.policyFor(companyId, on);
  }

  async #mustFind(actor: ActorContext, movementId: Id): Promise<EwayBillRecord> {
    // Tenancy from the query, never from an id the caller supplied.
    const record = await this.#records.findByMovementId(actor.companyId, movementId);
    if (record === null) throw notFound("EWAY_UNKNOWN", "We have no e-way bill record for that movement.");
    return record;
  }

  #require(actor: ActorContext, permission: string): void {
    if (!actor.permissions.includes(permission)) {
      throw forbidden("PERMISSION_DENIED", "You do not have permission to do that. Ask the owner to give you access.", { details: { permission } });
    }
  }

  async #record(
    actor: ActorContext,
    record: EwayBillRecord,
    action: string,
    details: Record<string, string>,
    overrideReason?: string,
  ): Promise<void> {
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at: this.#clock.now().toISOString(),
      action,
      subjectType: "eway_bill",
      subjectId: record.movementId,
      summary: record.message,
      details: { document: record.documentNumber, status: record.status, ...details },
      ...(overrideReason === undefined ? {} : { overrideReason }),
    });
  }
}
