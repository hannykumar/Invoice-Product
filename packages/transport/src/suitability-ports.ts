// Issue #28 [E28] — the outside services this check needs, each behind its own narrow surface.
//
// Two of them are outside the building: the registering authority's vehicle record (issue #29) and
// whatever reads a number plate out of a photograph. Both are replaceable adapters, and both have
// the same shape at the edge that matters — a result, a "no such record", and an "we could not ask
// today", which are three different answers and are never collapsed into two.

import type { CompanyId } from "@invoice/kernel";
import type { ActorContext } from "@invoice/ledger";
import type { Id, IsoDate } from "../../masters/src/types.ts";
import type {
  PlatePhoto, VehicleEvidence, VehicleSuitabilityAssessment, VehicleSuitabilityPolicy,
} from "./suitability-types.ts";

/**
 * What the registering authority said about a vehicle.
 *
 * `NOT_FOUND` and `UNAVAILABLE` are the pair that must never be merged. "The authority has no such
 * vehicle on record" is a finding about the lorry. "We could not reach the authority" is a finding
 * about us, and it means the lorry has not been checked at all. A screen that shows both as "no
 * problem" is the exact failure the brief forbids.
 */
export type VehicleRecordLookup =
  | { readonly kind: "FOUND"; readonly evidence: VehicleEvidence }
  | { readonly kind: "NOT_FOUND"; readonly checkedAt: string; readonly message: string }
  | {
      readonly kind: "UNAVAILABLE";
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly checkedAt: string;
    };

/**
 * Issue #29's contract as this module uses it.
 *
 * #29 owns the real integration. Until it lands, this is the surface written against, and the
 * synthetic adapter in `suitability-adapters.ts` stands in for it. When #29 arrives, its own
 * adapter implements this and nothing above it changes.
 */
export interface VehicleRecordPort {
  /**
   * `actor` is who is asking, and it is optional only so that a simple stand-in can ignore it.
   * The real implementation records the lookup against the person who ran the check, rather than
   * against nobody.
   */
  lookup(companyId: CompanyId, registrationNumber: string, actor?: ActorContext): Promise<VehicleRecordLookup>;
}

export type PlateReadOutcome =
  | { readonly kind: "READ"; readonly text: string; readonly confidence: number }
  /** The image was received and nothing could be made of it. */
  | { readonly kind: "UNREADABLE"; readonly reason: string }
  | { readonly kind: "UNAVAILABLE"; readonly code: string; readonly message: string; readonly retryable: boolean };

/** Reads the registration number out of a photograph of the plate. Never stores the image. */
export interface PlateOcrPort {
  read(companyId: CompanyId, photo: PlatePhoto): Promise<PlateReadOutcome>;
}

/**
 * The company's own vehicle list, from issue #5's masters.
 *
 * Held as a port rather than a direct import so this module never reaches into another module's
 * storage, and so a business with no vehicle master still works — it simply has less evidence.
 */
export interface VehicleMasterPort {
  findByRegistrationNumber(companyId: CompanyId, registrationNumber: string): Promise<VehicleEvidence | null>;
}

export interface SuitabilityRepository {
  insert(assessment: VehicleSuitabilityAssessment): Promise<void>;
  update(assessment: VehicleSuitabilityAssessment): Promise<void>;
  findById(companyId: CompanyId, id: Id): Promise<VehicleSuitabilityAssessment | null>;
  /** The latest check for a movement, which is the one a dispatch screen shows. */
  findLatestForMovement(companyId: CompanyId, movementId: Id): Promise<VehicleSuitabilityAssessment | null>;
  list(companyId: CompanyId): Promise<VehicleSuitabilityAssessment[]>;
  /** Everything still blocked and not overridden: the exception queue for the dispatch desk. */
  listBlocked(companyId: CompanyId): Promise<VehicleSuitabilityAssessment[]>;
}

/** Per company, effective-dated, as every other policy in this product is held. */
export interface VehicleSuitabilityPolicyPort {
  policyFor(companyId: CompanyId, on: IsoDate): Promise<VehicleSuitabilityPolicy>;
}
