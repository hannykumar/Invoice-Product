// Issue #29 [E29] — asking the registering authority about a lorry, and everything that has to be
// true before and after that question.
//
// The service is small; the rules around it are the work.
//
//   1. **Nothing is asked without consent.** A business has to have turned the service on, said
//      what it may be used for, and be inside the dates. No consent is not an error to hide — it
//      comes back as "we could not ask", which is the same shape as the provider being down and is
//      never the same as "this vehicle is fine".
//   2. **Only permitted fields are requested.** The consent record names them; the request carries
//      them; the adapter drops anything else the provider volunteers. A field nobody agreed to is
//      never in memory long enough to be stored by accident.
//   3. **Every reading carries who answered and when.** Provider name, the provider's own reference
//      and the moment we asked go on every stored reading and into the audit trail.
//   4. **An old reading is shown as old.** Inside the reuse window it is used as-is. Past the stale
//      line it is still shown, with its age, and it is never passed to the suitability rules as
//      today's fact.
//   5. **A retry is the same call.** The idempotency key is built from the company, the vehicle and
//      the day, so pressing "check" twice is one paid lookup at the provider.

import { forbidden, invalid, type Clock, type CompanyId } from "@invoice/kernel";
import type { ActorContext, AuditPort } from "@invoice/ledger";
import { normaliseVehicleNumber } from "./validity.ts";
import { ageInWords, freshnessOf, reusable } from "./vehicle-record.ts";
import {
  DEFAULT_VEHICLE_RECORD_FRESHNESS, looksLikeRegistrationNumber, PERMITTED_VEHICLE_FIELDS,
  VEHICLE_RECORD_UNAVAILABLE_MESSAGES,
} from "./vehicle-record-types.ts";
import { VEHICLE_CLASS_NAMES } from "./suitability-types.ts";
import type { VehicleRecordLookup, VehicleRecordPort } from "./suitability-ports.ts";
import type { IsoDate } from "../../masters/src/types.ts";
import type {
  PermittedVehicleField, VehicleLookupPurpose, VehicleRecordConsent, VehicleRecordFreshnessPolicy,
  VehicleRecordSnapshot, VehicleRecordUnavailableCode, VehicleRecordVerification,
} from "./vehicle-record-types.ts";
import type {
  VehicleRecordCacheRepository, VehicleRecordConsentPort, VehicleRecordFreshnessPort,
  VehicleRecordProviderPort,
} from "./vehicle-record-ports.ts";

/** Looking a vehicle up is part of checking one, so the dispatch desk's permission covers it. */
export const VEHICLE_RECORD_LOOKUP_PERMISSION = "transport.vehicle.check";
/** Turning the government service on, and agreeing what it may read, is an owner's decision. */
export const VEHICLE_RECORD_CONNECT_PERMISSION = "transport.vehicle.connect";

export const TRANSPORT_SUITABILITY_PURPOSE: VehicleLookupPurpose = "TRANSPORT_SUITABILITY";

export interface VehicleRecordDeps {
  readonly provider: VehicleRecordProviderPort;
  readonly cache: VehicleRecordCacheRepository;
  readonly consent: VehicleRecordConsentPort;
  readonly audit: AuditPort;
  readonly clock: Clock;
  readonly freshness?: VehicleRecordFreshnessPort;
}

export interface GrantConsentRequest {
  /** Defaults to every permitted field. A business may agree to less; never to more. */
  readonly fields?: readonly PermittedVehicleField[];
  readonly expiresOn?: IsoDate;
  /** A name the credential vault understands. Never a credential. */
  readonly credentialReference?: string;
}

export class VehicleRecordService {
  readonly #provider: VehicleRecordProviderPort;
  readonly #cache: VehicleRecordCacheRepository;
  readonly #consent: VehicleRecordConsentPort;
  readonly #audit: AuditPort;
  readonly #clock: Clock;
  readonly #freshness: VehicleRecordFreshnessPort | undefined;

  constructor(deps: VehicleRecordDeps) {
    this.#provider = deps.provider;
    this.#cache = deps.cache;
    this.#consent = deps.consent;
    this.#audit = deps.audit;
    this.#clock = deps.clock;
    this.#freshness = deps.freshness;
  }

  // ------------------------------------------------------------------ consent and credentials

  /**
   * Turning the service on for a business.
   *
   * The fields are stored because they are the promise: this is what we said we would read, and a
   * later change to that promise is a new consent record with its own date and its own signer.
   */
  async grantConsent(actor: ActorContext, request: GrantConsentRequest = {}): Promise<VehicleRecordConsent> {
    this.#require(actor, VEHICLE_RECORD_CONNECT_PERMISSION);
    const fields = request.fields ?? PERMITTED_VEHICLE_FIELDS;
    const unknown = fields.filter((field) => !PERMITTED_VEHICLE_FIELDS.includes(field));
    if (unknown.length > 0) {
      throw invalid("VEHICLE_RECORD_FIELD_UNKNOWN", `The vehicle-record service is not allowed to be asked for ${unknown.join(", ")}, so that cannot be agreed to.`);
    }
    const consent: VehicleRecordConsent = {
      companyId: actor.companyId,
      purpose: TRANSPORT_SUITABILITY_PURPOSE,
      fields: [...fields],
      grantedBy: actor.userId,
      grantedAt: this.#clock.now().toISOString(),
      ...(request.expiresOn === undefined ? {} : { expiresOn: request.expiresOn }),
      ...(request.credentialReference === undefined ? {} : { credentialReference: request.credentialReference }),
    };
    await this.#consent.save(consent);
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at: consent.grantedAt,
      action: "transport.vehicle_record.consent_granted",
      subjectType: "vehicle_record_consent",
      subjectId: actor.companyId,
      summary: "Vehicle records may now be looked up with the registering authority, for checking whether a vehicle suits a load.",
      details: {
        provider: this.#provider.provider,
        purpose: consent.purpose,
        fields: consent.fields.join(", "),
        expiresOn: consent.expiresOn ?? "no end date",
        // The reference, never the credential itself.
        credential: consent.credentialReference ?? "none recorded",
      },
    });
    return consent;
  }

  /**
   * Withdrawing it, which also forgets what was read.
   *
   * Stopping future lookups while keeping the old ones would be the wrong half of the promise. The
   * readings are a convenience, and the movements that were decided on them keep their own copy of
   * the evidence in issue #28's assessment, so nothing auditable is lost by dropping these.
   */
  async revokeConsent(actor: ActorContext, reason: string): Promise<void> {
    this.#require(actor, VEHICLE_RECORD_CONNECT_PERMISSION);
    const held = await this.#consent.current(actor.companyId, TRANSPORT_SUITABILITY_PURPOSE);
    if (held === null) throw invalid("VEHICLE_RECORD_NOT_CONNECTED", "The vehicle-record service is not switched on for this business, so there is nothing to withdraw.");
    const at = this.#clock.now().toISOString();
    await this.#consent.save({ ...held, revokedAt: at });
    const kept = await this.#cache.list(actor.companyId);
    for (const snapshot of kept) await this.#cache.forget(actor.companyId, snapshot.registrationNumber);
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: "transport.vehicle_record.consent_revoked",
      subjectType: "vehicle_record_consent",
      subjectId: actor.companyId,
      summary: "Vehicle-record lookups have been switched off and the readings that were kept have been deleted.",
      details: { provider: this.#provider.provider, forgotten: String(kept.length), reason: reason.trim() },
    });
  }

  async consentStatus(actor: ActorContext): Promise<VehicleRecordConsent | null> {
    this.#require(actor, VEHICLE_RECORD_LOOKUP_PERMISSION);
    return this.#consent.current(actor.companyId, TRANSPORT_SUITABILITY_PURPOSE);
  }

  // --------------------------------------------------------------------------------- lookups

  /**
   * The screen's answer for one number plate.
   *
   * Typed in by a person, because that is how a lorry is identified at a gate. The same call backs
   * the plate read out of a photograph in issue #28: what changes is who read the number, never how
   * it is verified.
   */
  async verify(actor: ActorContext, registrationNumber: string): Promise<VehicleRecordVerification> {
    this.#require(actor, VEHICLE_RECORD_LOOKUP_PERMISSION);
    const number = normaliseVehicleNumber(registrationNumber ?? "");
    const at = this.#clock.now().toISOString();

    if (!looksLikeRegistrationNumber(number)) {
      // Not sent anywhere. A malformed number is our mistake to catch, not a provider's to charge
      // for, and it is certainly not evidence that no such lorry exists.
      await this.#writeLookup(actor, number, "UNAVAILABLE:INVALID_NUMBER", "none — nothing was sent", "none", false);
      return this.#unavailable("INVALID_NUMBER", false, at);
    }

    const consent = await this.#consent.current(actor.companyId, TRANSPORT_SUITABILITY_PURPOSE);
    const consentProblem = consentProblemOf(consent, at);
    if (consentProblem !== null) {
      // A lookup that never happened is still worth writing down: somebody looking at a movement
      // that was never checked needs to be able to find out why.
      await this.#writeLookup(actor, number, `UNAVAILABLE:${consentProblem}`, "none — nothing was sent", "none", false);
      return this.#unavailable(consentProblem, false, at);
    }
    const fields = consent?.fields ?? PERMITTED_VEHICLE_FIELDS;

    const policy = await this.#policyFor(actor.companyId, at.slice(0, 10) as IsoDate);
    const held = await this.#cache.find(actor.companyId, number);

    if (held !== null && reusable(held.provenance.retrievedAt, at, policy)) {
      await this.#writeLookup(actor, number, held.notFound ? "NOT_FOUND" : "FOUND", held.provenance.provider, held.provenance.providerReference, true);
      return this.#fromSnapshot(held, at, policy, true);
    }

    const outcome = await this.#ask(actor.companyId, number, fields, at);

    if (outcome.kind === "UNAVAILABLE") {
      await this.#writeLookup(actor, number, `UNAVAILABLE:${outcome.code}`, this.#provider.provider, "none", false);
      const fallback = held === null || held.evidence === undefined
        ? undefined
        : {
            evidence: held.evidence,
            provenance: held.provenance,
            freshness: freshnessOf(held.provenance.retrievedAt, at, policy),
          };
      const base = this.#unavailable(outcome.code, outcome.retryable, outcome.checkedAt);
      if (fallback === undefined) return base;
      return {
        ...base,
        lastKnown: fallback,
        summary: `${base.summary} We do have a reading from ${ageInWords(fallback.provenance.retrievedAt, at)}, shown below, but it is not today's answer and the vehicle counts as unchecked until the service can be reached.`,
      };
    }

    const snapshot: VehicleRecordSnapshot = outcome.kind === "FOUND"
      ? { companyId: actor.companyId, registrationNumber: number, provenance: outcome.provenance, evidence: outcome.evidence, notFound: false }
      : { companyId: actor.companyId, registrationNumber: number, provenance: outcome.provenance, notFound: true };
    await this.#cache.save(snapshot);
    await this.#writeLookup(actor, number, outcome.kind, snapshot.provenance.provider, snapshot.provenance.providerReference, false, outcome.kind === "FOUND" ? outcome.gaps : []);
    return this.#fromSnapshot(snapshot, at, policy, false);
  }

  /**
   * Everything this business has stored about vehicles, so it can be seen and deleted.
   *
   * A business that has had somebody's lorry looked up should be able to see exactly what is held
   * about it, in one list, without asking anybody.
   */
  async held(actor: ActorContext): Promise<readonly VehicleRecordSnapshot[]> {
    this.#require(actor, VEHICLE_RECORD_LOOKUP_PERMISSION);
    return this.#cache.list(actor.companyId);
  }

  async forget(actor: ActorContext, registrationNumber: string): Promise<void> {
    this.#require(actor, VEHICLE_RECORD_CONNECT_PERMISSION);
    const number = normaliseVehicleNumber(registrationNumber ?? "");
    await this.#cache.forget(actor.companyId, number);
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at: this.#clock.now().toISOString(),
      action: "transport.vehicle_record.forgotten",
      subjectType: "vehicle_record",
      subjectId: number,
      summary: `The stored vehicle record for ${number} has been deleted.`,
      details: { vehicle: number, provider: this.#provider.provider },
    });
  }

  /**
   * This service seen as issue #28's port.
   *
   * #28 asks a `VehicleRecordPort` for facts while checking a movement, and passes the actor who is
   * running that check. The actor given here is the fallback for a caller that does not, so a
   * lookup is always recorded against somebody rather than appearing to come from nobody.
   */
  portFor(actor: ActorContext): VehicleRecordPort {
    return {
      lookup: async (companyId: CompanyId, registrationNumber: string, asking?: ActorContext): Promise<VehicleRecordLookup> => {
        // Whoever is running the check, when the caller knows; otherwise the actor this port was
        // built for. Either way the lookup is attributed to a person.
        const actingAs = asking ?? actor;
        if (companyId !== actingAs.companyId) {
          // Tenancy is not a parameter a caller gets to change. Two companies never share a lookup.
          throw forbidden("PERMISSION_DENIED", "You do not have permission to do that. Ask the owner to give you access.", { details: { permission: VEHICLE_RECORD_LOOKUP_PERMISSION } });
        }
        const verification = await this.verify(actingAs, registrationNumber);
        if (verification.kind === "FOUND") return { kind: "FOUND", evidence: verification.evidence };
        if (verification.kind === "NOT_FOUND") {
          return { kind: "NOT_FOUND", checkedAt: verification.provenance.retrievedAt, message: verification.summary };
        }
        // A stale reading is deliberately not passed on as evidence. The check has to be able to
        // say "this lorry was not checked today", and handing it week-old facts would take that
        // sentence away from it.
        return {
          kind: "UNAVAILABLE",
          code: verification.code,
          message: verification.summary,
          retryable: verification.retryable,
          checkedAt: verification.checkedAt,
        };
      },
    };
  }

  // ------------------------------------------------------------------------------- internals

  async #ask(companyId: CompanyId, number: string, fields: readonly PermittedVehicleField[], at: string) {
    try {
      return await this.#provider.fetch({
        companyId,
        registrationNumber: number,
        purpose: TRANSPORT_SUITABILITY_PURPOSE,
        fields,
        // The day is in the key so a retry within the day is one call, while tomorrow's check is a
        // genuinely new question about a lorry whose papers may have expired overnight.
        idempotencyKey: `vehicle-record:${companyId}:${number}:${at.slice(0, 10)}`,
      });
    } catch (error) {
      return {
        kind: "UNAVAILABLE" as const,
        code: "OUTAGE" as VehicleRecordUnavailableCode,
        retryable: true,
        checkedAt: at,
        detail: error instanceof Error ? error.message : "no reason given",
      };
    }
  }

  #fromSnapshot(snapshot: VehicleRecordSnapshot, at: string, policy: VehicleRecordFreshnessPolicy, fromCache: boolean): VehicleRecordVerification {
    if (snapshot.evidence === undefined) {
      return {
        kind: "NOT_FOUND",
        provenance: snapshot.provenance,
        fromCache,
        summary: `The registering authority has no vehicle with the number ${snapshot.registrationNumber} on its record, as at ${when(snapshot.provenance.retrievedAt)}. That is not the same as the number being wrong — check what is written on the lorry before treating it as a problem.`,
      };
    }
    const freshness = freshnessOf(snapshot.provenance.retrievedAt, at, policy);
    const evidence = snapshot.evidence;
    const kind = evidence.vehicleClass === undefined
      ? "a vehicle whose kind the record does not state"
      : withArticle(VEHICLE_CLASS_NAMES[evidence.vehicleClass]);
    const capacity = evidence.ratedPayloadKg !== undefined
      ? ` It is registered to carry ${evidence.ratedPayloadKg} kg.`
      : evidence.grossVehicleWeightKg !== undefined && evidence.unladenWeightKg !== undefined
        ? ` It weighs ${evidence.unladenWeightKg} kg empty and may weigh ${evidence.grossVehicleWeightKg} kg loaded, so it can carry about ${evidence.grossVehicleWeightKg - evidence.unladenWeightKg} kg.`
        : " The record does not say how much it may carry.";
    const age = `Read from ${snapshot.provenance.provider} ${ageInWords(snapshot.provenance.retrievedAt, at)}, on ${when(snapshot.provenance.retrievedAt)}.`;
    return {
      kind: "FOUND",
      evidence,
      provenance: snapshot.provenance,
      freshness,
      fromCache,
      summary: freshness === "STALE"
        ? `${snapshot.registrationNumber} is ${kind}.${capacity} ${age} That is older than this business treats as current, so somebody should check it again before relying on the insurance and fitness dates.`
        : `${snapshot.registrationNumber} is ${kind}.${capacity} ${age}`,
    };
  }

  #unavailable(code: VehicleRecordUnavailableCode, retryable: boolean, at: string): Extract<VehicleRecordVerification, { kind: "UNAVAILABLE" }> {
    return { kind: "UNAVAILABLE", code, retryable, checkedAt: at, summary: VEHICLE_RECORD_UNAVAILABLE_MESSAGES[code] };
  }

  async #policyFor(companyId: CompanyId, on: IsoDate): Promise<VehicleRecordFreshnessPolicy> {
    return this.#freshness === undefined ? DEFAULT_VEHICLE_RECORD_FRESHNESS : this.#freshness.policyFor(companyId, on);
  }

  async #writeLookup(
    actor: ActorContext,
    number: string,
    outcome: string,
    provider: string,
    providerReference: string,
    fromCache: boolean,
    gaps: readonly string[] = [],
  ): Promise<void> {
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at: this.#clock.now().toISOString(),
      action: "transport.vehicle_record.looked_up",
      subjectType: "vehicle_record",
      subjectId: number,
      summary: `The registering authority's record for ${number} was ${fromCache ? "read from what we already had" : "asked for"}: ${outcome}.`,
      details: {
        vehicle: number,
        outcome,
        provider,
        // The provider's reference, so their side and ours can be lined up later.
        providerReference,
        fromCache: String(fromCache),
        purpose: TRANSPORT_SUITABILITY_PURPOSE,
        ...(gaps.length === 0 ? {} : { gaps: gaps.join(" ") }),
      },
    });
  }

  #require(actor: ActorContext, permission: string): void {
    if (actor.permissions.includes(permission)) return;
    throw forbidden("PERMISSION_DENIED", "You do not have permission to do that. Ask the owner to give you access.", { details: { permission } });
  }
}

/** Why we may not ask today, or `null` when we may. */
export const consentProblemOf = (consent: VehicleRecordConsent | null, at: string): VehicleRecordUnavailableCode | null => {
  if (consent === null) return "NOT_CONNECTED";
  if (consent.revokedAt !== undefined) return "CONSENT_EXPIRED";
  if (consent.expiresOn !== undefined && consent.expiresOn < at.slice(0, 10)) return "CONSENT_EXPIRED";
  return null;
};

/** "a light goods vehicle", "an open truck": a sentence a person would actually say. */
const withArticle = (noun: string): string => `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;

/** A timestamp as a person reads it: "31 August 2026". */
const when = (iso: string): string => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "an unknown date";
  return `${at.getUTCDate()} ${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][at.getUTCMonth()]} ${at.getUTCFullYear()}`;
};
