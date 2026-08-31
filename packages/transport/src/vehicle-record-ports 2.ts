// Issue #29 [E29] — the three surfaces the vehicle-record verification sits on: the provider, the
// stored readings, and the business's permission to ask at all.
//
// The point of splitting them is replaceability. `VehicleRecordProviderPort` is the only thing that
// knows about a particular government service; the caching, the consent and the audit trail are
// this product's own and do not change when the provider does. A provider swap is one new
// implementation of one interface with four methods between it and the rest of the product.

import type { CompanyId } from "@invoice/kernel";
import type { IsoDate } from "../../masters/src/types.ts";
import type {
  PermittedVehicleField, VehicleLookupPurpose, VehicleRecordConsent, VehicleRecordFreshnessPolicy,
  VehicleRecordProvenance, VehicleRecordSnapshot, VehicleRecordUnavailableCode,
} from "./vehicle-record-types.ts";
import type { VehicleEvidence } from "./suitability-types.ts";

/**
 * One approved provider of vehicle records.
 *
 * It returns facts or it returns a reason. It never throws for an ordinary failure, because "the
 * provider is down" is an answer this product has to store and show, not an exception to escape
 * through. The fields it returns are already normalised and already narrowed to what consent
 * allowed — the narrowing happens at the boundary, in the adapter, not afterwards.
 */
export interface VehicleRecordProviderPort {
  /** The adapter's name, recorded on every reading so an answer can be traced to a service. */
  readonly provider: string;
  fetch(request: VehicleRecordRequest): Promise<VehicleRecordProviderOutcome>;
  /** Whether the provider is answering at all, for a settings screen. */
  health?(): Promise<"healthy" | "degraded" | "unavailable">;
}

export interface VehicleRecordRequest {
  readonly companyId: CompanyId;
  readonly registrationNumber: string;
  readonly purpose: VehicleLookupPurpose;
  /** Only these may be requested and kept. The adapter applies it; nothing downstream re-checks. */
  readonly fields: readonly PermittedVehicleField[];
  /** Makes a retry after a timeout reach the provider as the same call rather than a second one. */
  readonly idempotencyKey: string;
}

export type VehicleRecordProviderOutcome =
  | {
      readonly kind: "FOUND";
      readonly evidence: VehicleEvidence;
      readonly provenance: VehicleRecordProvenance;
      /** Anything the record did not say, in plain words, for the screen and the audit trail. */
      readonly gaps: readonly string[];
    }
  | { readonly kind: "NOT_FOUND"; readonly provenance: VehicleRecordProvenance }
  | {
      readonly kind: "UNAVAILABLE";
      readonly code: VehicleRecordUnavailableCode;
      readonly retryable: boolean;
      readonly checkedAt: string;
      /** The provider's own words, where it gave any. Never a credential and never a payload. */
      readonly detail?: string;
    };

/**
 * The readings we keep.
 *
 * One row per company per vehicle, replaced when a newer reading arrives. History is not kept here:
 * the assessment in issue #28 already stores the evidence that decided a particular movement, and
 * keeping a second, longer trail of somebody's vehicle data would be holding more than the job
 * needs.
 */
export interface VehicleRecordCacheRepository {
  find(companyId: CompanyId, registrationNumber: string): Promise<VehicleRecordSnapshot | null>;
  save(snapshot: VehicleRecordSnapshot): Promise<void>;
  /** Everything held for a company, for the "what do you know about me" screen and for deletion. */
  list(companyId: CompanyId): Promise<readonly VehicleRecordSnapshot[]>;
  /** Removes a reading. Used when consent is withdrawn, and by the retention sweep. */
  forget(companyId: CompanyId, registrationNumber: string): Promise<void>;
}

/** The business's permission to use the service, and the credential reference behind it. */
export interface VehicleRecordConsentPort {
  current(companyId: CompanyId, purpose: VehicleLookupPurpose): Promise<VehicleRecordConsent | null>;
  save(consent: VehicleRecordConsent): Promise<void>;
}

export interface VehicleRecordFreshnessPort {
  policyFor(companyId: CompanyId, on: IsoDate): Promise<VehicleRecordFreshnessPolicy>;
}
