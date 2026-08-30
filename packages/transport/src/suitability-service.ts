// Issue #28 [E28] — checking a vehicle against its load, and what an override actually is.
//
// The service gathers evidence, runs the rules, and keeps what it found. Four things it is careful
// about:
//
//   1. **Evidence is collected before anything is judged, and kept exactly as it came.** The
//      assessment stores the government's reading and the company's own note side by side, with
//      their sources on them, so a decision can be re-read a year later against what was actually
//      known that day.
//   2. **A failed lookup is a fact, not an exception.** The registering authority being down does
//      not fail the check — it produces a `CANNOT_DECIDE` that a person has to answer.
//   3. **An override adds, never edits.** It is a separate record carrying who, when, why and which
//      findings. The findings, the capacity, the photograph and the government's reading are
//      untouched by it, and re-running the check produces the same findings again.
//   4. **A retry is idempotent.** The same movement checked twice with the same facts returns the
//      same assessment rather than filling the exception queue with duplicates.

import { forbidden, invalid, notFound, type Clock, type CompanyId } from "@invoice/kernel";
import type { ActorContext, AuditPort } from "@invoice/ledger";
import { checkVehicleSuitability, outcomeOf, SUITABILITY_RULE_SET_VERSION } from "./suitability.ts";
import { comparePlateReading } from "./plate.ts";
import { DEFAULT_VEHICLE_SUITABILITY_POLICY } from "./suitability-types.ts";
import { normaliseVehicleNumber } from "./validity.ts";
import type {
  PlateComparison, PlatePhoto, ShipmentFacts, SuitabilityFinding, SuitabilityOverride,
  TransportDetails, VehicleEvidence, VehicleSuitabilityAssessment, VehicleSuitabilityPolicy,
} from "./suitability-types.ts";
import type {
  PlateOcrPort, SuitabilityRepository, VehicleMasterPort, VehicleRecordLookup, VehicleRecordPort,
  VehicleSuitabilityPolicyPort,
} from "./suitability-ports.ts";
import type { Id, IsoDate } from "../../masters/src/types.ts";

/** Checking a vehicle is an everyday act at the dispatch desk. */
export const VEHICLE_CHECK_PERMISSION = "transport.vehicle.check";
/** Sending a blocked movement out anyway is not, and it is its own permission. */
export const VEHICLE_OVERRIDE_PERMISSION = "transport.vehicle.override";
export const VEHICLE_VIEW_PERMISSION = "transport.vehicle.view";

export interface VehicleSuitabilityDeps {
  readonly records: SuitabilityRepository;
  readonly audit: AuditPort;
  readonly clock: Clock;
  /** Issue #29's verification. Absent in a business that has not connected it. */
  readonly vehicleRecords?: VehicleRecordPort;
  readonly vehicleMaster?: VehicleMasterPort;
  readonly plateOcr?: PlateOcrPort;
  readonly policy?: VehicleSuitabilityPolicyPort;
  readonly idFactory?: () => string;
}

export interface AssessVehicleRequest {
  readonly movementId: Id;
  readonly transport: TransportDetails;
  readonly shipment: ShipmentFacts;
  /** A photograph of the number plate, when the yard took one. */
  readonly platePhoto?: PlatePhoto;
  /**
   * What a person read off the plate, when there is no photograph or none that can be used.
   *
   * Most yards have no camera. Requiring a photograph would mean the plate is never checked at
   * all on exactly the days it matters, so a typed reading runs through the same comparison and
   * produces the same findings — recorded as a person's reading rather than a machine's.
   */
  readonly plateReadByHand?: string;
  /** Facts typed in for this one movement, on top of whatever the two records hold. */
  readonly declared?: Omit<VehicleEvidence, "registrationNumber" | "source" | "retrievedAt">;
}

export interface OverrideRequest {
  /** Which findings the person is answering for. An empty list is not an override of everything. */
  readonly findingCodes: readonly string[];
  readonly reason: string;
}

export class VehicleSuitabilityService {
  readonly #records: SuitabilityRepository;
  readonly #audit: AuditPort;
  readonly #clock: Clock;
  readonly #vehicleRecords: VehicleRecordPort | undefined;
  readonly #vehicleMaster: VehicleMasterPort | undefined;
  readonly #plateOcr: PlateOcrPort | undefined;
  readonly #policy: VehicleSuitabilityPolicyPort | undefined;
  readonly #newId: () => string;

  constructor(deps: VehicleSuitabilityDeps) {
    this.#records = deps.records;
    this.#audit = deps.audit;
    this.#clock = deps.clock;
    this.#vehicleRecords = deps.vehicleRecords;
    this.#vehicleMaster = deps.vehicleMaster;
    this.#plateOcr = deps.plateOcr;
    this.#policy = deps.policy;
    this.#newId = deps.idFactory ?? (() => crypto.randomUUID());
  }

  // ------------------------------------------------------------------------ reading

  async latestForMovement(actor: ActorContext, movementId: Id): Promise<VehicleSuitabilityAssessment | null> {
    this.#require(actor, VEHICLE_VIEW_PERMISSION);
    return this.#records.findLatestForMovement(actor.companyId, movementId);
  }

  async list(actor: ActorContext): Promise<readonly VehicleSuitabilityAssessment[]> {
    this.#require(actor, VEHICLE_VIEW_PERMISSION);
    return this.#records.list(actor.companyId);
  }

  /** The exception queue: movements stopped by a vehicle problem nobody has answered yet. */
  async blocked(actor: ActorContext): Promise<readonly VehicleSuitabilityAssessment[]> {
    this.#require(actor, VEHICLE_VIEW_PERMISSION);
    return this.#records.listBlocked(actor.companyId);
  }

  // ------------------------------------------------------------------------ checking

  /**
   * Runs the check and keeps the answer.
   *
   * Called twice with the same facts, it returns the first assessment rather than making a second.
   * A dispatch clerk pressing the button again after a slow response should not end up with two
   * rows in the exception queue for one lorry.
   */
  async assess(actor: ActorContext, request: AssessVehicleRequest): Promise<VehicleSuitabilityAssessment> {
    this.#require(actor, VEHICLE_CHECK_PERMISSION);
    const idempotencyKey = keyFor(request);
    const existing = await this.#records.findLatestForMovement(actor.companyId, request.movementId);
    if (existing !== null && existing.idempotencyKey === idempotencyKey) return existing;

    const policy = await this.#policyFor(actor.companyId, request.transport.movementDate);
    const number = normaliseVehicleNumber(request.transport.vehicleNumber ?? "");
    const at = this.#clock.now().toISOString();

    const record = number === "" ? undefined : await this.#lookUpVehicle(actor.companyId, number, at);
    const master = number === "" ? null : await this.#fromMaster(actor.companyId, number);
    const declared = this.#declaredEvidence(request, number, at);
    const plate = await this.#readPlate(actor.companyId, request, number, policy);

    const result = checkVehicleSuitability({
      transport: request.transport,
      shipment: request.shipment,
      ...(record === undefined ? {} : { record }),
      master,
      // Typed facts are kept as their own kind of evidence and ranked last, so they fill gaps in
      // the records without ever overruling what the registering authority holds.
      ...(declared === null ? {} : { declared }),
      ...(plate === undefined ? {} : { plate }),
      policy,
    });

    const assessment: VehicleSuitabilityAssessment = {
      id: this.#newId(),
      companyId: actor.companyId,
      movementId: request.movementId,
      checkedAt: at,
      checkedBy: actor.userId,
      outcome: result.outcome,
      summary: result.summary,
      transport: request.transport,
      shipment: request.shipment,
      evidence: result.evidence,
      ...(result.capacity === undefined ? {} : { capacity: result.capacity }),
      ...(plate === undefined ? {} : { plate }),
      findings: result.findings,
      overrides: [],
      clearedToMove: result.outcome !== "BLOCK" && result.outcome !== "CANNOT_DECIDE",
      idempotencyKey,
    };

    await this.#records.insert(assessment);
    await this.#write(actor, assessment, "transport.vehicle.checked", {
      outcome: assessment.outcome,
      findings: assessment.findings.map((finding) => finding.code).join(", ") || "none",
    });
    return assessment;
  }

  /**
   * A person taking responsibility for going ahead anyway.
   *
   * What this does *not* do is the point. It does not change the weight, the capacity, the
   * photograph or the registering authority's record. It appends a note naming the person, the
   * moment and the reason, against findings that are allowed to be overridden at all — and a
   * scooter carrying five tonnes is not one of them.
   */
  async override(actor: ActorContext, assessmentId: Id, request: OverrideRequest): Promise<VehicleSuitabilityAssessment> {
    this.#require(actor, VEHICLE_OVERRIDE_PERMISSION);
    const assessment = await this.#mustFind(actor, assessmentId);

    const reason = (request.reason ?? "").trim();
    if (reason.length < 10) {
      throw invalid("VEHICLE_OVERRIDE_REASON", "An override has to say why, in a sentence somebody reading this in six months would understand. Write at least a few words.");
    }
    if (request.findingCodes.length === 0) {
      throw invalid("VEHICLE_OVERRIDE_EMPTY", "Choose which findings you are answering for. An override covers named findings, never everything at once.");
    }

    const known = new Map(assessment.findings.map((finding) => [finding.code, finding]));
    const unknown = request.findingCodes.filter((code) => !known.has(code));
    if (unknown.length > 0) {
      throw invalid("VEHICLE_OVERRIDE_UNKNOWN", `This check did not find ${unknown.join(", ")}, so there is nothing there to override.`);
    }
    const refused = request.findingCodes.filter((code) => known.get(code)?.overridable === false);
    if (refused.length > 0) {
      const first = known.get(refused[0] as string) as SuitabilityFinding;
      throw invalid("VEHICLE_OVERRIDE_NOT_ALLOWED", `"${first.title}" cannot be overridden. ${first.reason} Change the vehicle or the load instead.`);
    }

    const entry: SuitabilityOverride = {
      findingCodes: [...request.findingCodes],
      reason,
      byUserId: actor.userId,
      at: this.#clock.now().toISOString(),
    };
    const overrides = [...assessment.overrides, entry];
    const outstanding = outstandingOf(assessment.findings, overrides);
    const updated: VehicleSuitabilityAssessment = {
      ...assessment,
      // The findings and the evidence are copied through untouched. This is the acceptance
      // criterion "override never edits source evidence", held in the shape of the code.
      overrides,
      clearedToMove: outstanding.length === 0,
      summary: outstanding.length === 0
        // The person's id is on the override entry and in the audit trail; a screen shows a name,
        // not a UUID, so the sentence does not carry one.
        ? `${assessment.summary} That has been answered, with the reason on the record, so the movement may go.`
        : `${assessment.summary} ${outstanding.length} thing${outstanding.length === 1 ? "" : "s"} still to answer before this can move.`,
    };

    await this.#records.update(updated);
    await this.#write(actor, updated, "transport.vehicle.overridden", {
      outcome: updated.outcome,
      findings: entry.findingCodes.join(", "),
      stillBlocked: String(outstanding.length),
    }, reason);
    return updated;
  }

  // --------------------------------------------------------------------- internals

  /** The registering authority, when one is connected. Its failure is an answer, not a throw. */
  async #lookUpVehicle(companyId: CompanyId, registrationNumber: string, at: string): Promise<VehicleRecordLookup | undefined> {
    if (this.#vehicleRecords === undefined) return undefined;
    try {
      return await this.#vehicleRecords.lookup(companyId, registrationNumber);
    } catch (error) {
      return {
        kind: "UNAVAILABLE",
        code: "LOOKUP_FAILED",
        message: `The vehicle record service could not be reached: ${error instanceof Error ? error.message : "no reason given"}.`,
        retryable: true,
        checkedAt: at,
      };
    }
  }

  async #fromMaster(companyId: CompanyId, registrationNumber: string): Promise<VehicleEvidence | null> {
    if (this.#vehicleMaster === undefined) return null;
    return this.#vehicleMaster.findByRegistrationNumber(companyId, registrationNumber);
  }

  /** Facts given for this movement alone, kept as their own kind of evidence and no stronger. */
  #declaredEvidence(request: AssessVehicleRequest, registrationNumber: string, at: string): VehicleEvidence | null {
    if (request.declared === undefined || registrationNumber === "") return null;
    return { registrationNumber, source: "ENTERED_BY_HAND", retrievedAt: at, ...request.declared };
  }

  /**
   * The plate, from whichever reading is available.
   *
   * A usable photograph wins, because an image is evidence a person can be shown later. Where
   * there is no photograph, none that could be read, or no reader to ask, a typed reading is used
   * instead rather than the check being skipped.
   */
  async #readPlate(
    companyId: CompanyId,
    request: AssessVehicleRequest,
    declaredNumber: string,
    policy: VehicleSuitabilityPolicy,
  ): Promise<PlateComparison | undefined> {
    const typed = (request.plateReadByHand ?? "").trim();
    const byHand = typed === ""
      ? undefined
      : comparePlateReading({ text: typed, readBy: "PERSON" }, declaredNumber, policy.minimumPlateConfidence);

    const photo = request.platePhoto;
    if (photo === undefined || this.#plateOcr === undefined) return byHand;
    let outcome;
    try {
      outcome = await this.#plateOcr.read(companyId, photo);
    } catch (error) {
      outcome = { kind: "UNAVAILABLE" as const, code: "OCR_FAILED", message: error instanceof Error ? error.message : "The plate reader failed.", retryable: true };
    }
    if (outcome.kind === "READ") {
      const fromPhoto = comparePlateReading({ text: outcome.text, confidence: outcome.confidence, photoId: photo.photoId }, declaredNumber, policy.minimumPlateConfidence);
      // A photograph that could not be trusted falls back to the person's reading rather than
      // leaving the plate unchecked when somebody did in fact read it.
      return fromPhoto.verdict === "CANNOT_READ" && byHand !== undefined ? byHand : fromPhoto;
    }
    if (byHand !== undefined) return byHand;
    // Unreadable and unreachable are both "we do not know", and both say which one it was rather
    // than pretending the plate was checked.
    return {
      verdict: "CANNOT_READ",
      readBy: "PHOTO",
      declaredNumber: normaliseVehicleNumber(declaredNumber),
      photoId: photo.photoId,
      explanation: outcome.kind === "UNREADABLE"
        ? `The number plate photograph could not be read: ${outcome.reason} Nothing has been concluded from it either way. If somebody can see the lorry, they can type what the plate says instead.`
        : `The number plate reader could not be reached: ${outcome.message} The photograph has not been compared with the vehicle number. If somebody can see the lorry, they can type what the plate says instead.`,
    };
  }

  async #policyFor(companyId: CompanyId, on: IsoDate): Promise<VehicleSuitabilityPolicy> {
    return this.#policy === undefined ? DEFAULT_VEHICLE_SUITABILITY_POLICY : this.#policy.policyFor(companyId, on);
  }

  async #mustFind(actor: ActorContext, assessmentId: Id): Promise<VehicleSuitabilityAssessment> {
    // Tenancy comes from the query, never from an id the caller handed us.
    const assessment = await this.#records.findById(actor.companyId, assessmentId);
    if (assessment === null) throw notFound("VEHICLE_CHECK_UNKNOWN", "We have no vehicle check with that reference.");
    return assessment;
  }

  #require(actor: ActorContext, permission: string): void {
    // Checking is enough to view what you checked, so a dispatch clerk needs one permission.
    if (actor.permissions.includes(permission)) return;
    if (permission === VEHICLE_VIEW_PERMISSION && actor.permissions.includes(VEHICLE_CHECK_PERMISSION)) return;
    throw forbidden("PERMISSION_DENIED", "You do not have permission to do that. Ask the owner to give you access.", { details: { permission } });
  }

  async #write(
    actor: ActorContext,
    assessment: VehicleSuitabilityAssessment,
    action: string,
    details: Record<string, string>,
    overrideReason?: string,
  ): Promise<void> {
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at: this.#clock.now().toISOString(),
      action,
      subjectType: "vehicle_suitability",
      subjectId: assessment.movementId,
      summary: assessment.summary,
      details: {
        // The vehicle number and the rule set, never the photograph and never a credential.
        vehicle: normaliseVehicleNumber(assessment.transport.vehicleNumber ?? "") || "none",
        ruleSet: SUITABILITY_RULE_SET_VERSION,
        ...details,
      },
      ...(overrideReason === undefined ? {} : { overrideReason }),
    });
  }
}

/**
 * The findings that still stand: everything blocking or undecided that no override covers.
 *
 * Exported because the screens and the exception queue both need to ask this of a stored
 * assessment, and asking it in two places would eventually give two answers.
 */
export const outstandingOf = (
  findings: readonly SuitabilityFinding[],
  overrides: readonly SuitabilityOverride[],
): readonly SuitabilityFinding[] => {
  const covered = new Set(overrides.flatMap((entry) => entry.findingCodes));
  return findings.filter((finding) => (finding.severity === "BLOCK" || finding.severity === "CANNOT_DECIDE") && !covered.has(finding.code));
};

export { outcomeOf };

/**
 * The key that makes a retry return the first answer.
 *
 * It is built from the facts of the check — the movement, the vehicle, the load and the day — so
 * that pressing the button again gives the same assessment, while a genuinely changed fact (a
 * different lorry, a heavier load) is a new check with a new record.
 */
const keyFor = (request: AssessVehicleRequest): string => {
  const { transport, shipment } = request;
  return [
    request.movementId,
    normaliseVehicleNumber(transport.vehicleNumber ?? ""),
    transport.mode,
    transport.movementDate,
    transport.transporterId ?? "",
    String(transport.distanceKm ?? ""),
    String(transport.interState ?? ""),
    String(shipment.grossWeightKg ?? ""),
    String(shipment.volumeCubicMetres ?? ""),
    String(shipment.requiresColdChain ?? ""),
    String(shipment.hazardous ?? ""),
    String(shipment.bulkLiquid ?? ""),
    request.platePhoto?.photoId ?? "",
    // A typed plate reading or typed vehicle facts change the answer, so they change the key: a
    // second check after somebody types what they can see is a new check, not a repeat.
    request.plateReadByHand ?? "",
    JSON.stringify(request.declared ?? {}),
  ].join("|");
};
