// Issue #27 [E27] — the narrow surfaces the e-way bill lifecycle needs.
//
// The portal sits behind a port for the reason the brief gives: government services are replaceable
// adapters, not a dependency the domain is written against. Everything below is in this module's
// own words, so a change of provider is a change of adapter.

import type { CompanyId, Clock } from "@invoice/kernel";
import type { Id, IsoDate } from "../../masters/src/types.ts";
import type {
  ConsolidatedTripRecord, EwayBillAcknowledgement, EwayBillPolicy, EwayBillRecord,
  EwayCancelReasonCode, EwayRejectReasonCode, TransporterAssignment, VehicleAssignment,
} from "./types.ts";
import type { Movement } from "./types.ts";

export interface EwayBillPort {
  /**
   * Raises an e-way bill. Part B may be absent — that is Part A only, and the goods may not move.
   *
   * A portal that reports the consignment as already having a bill must return
   * `{ kind: "DUPLICATE" }` with the number it already holds rather than an error: a retry after a
   * timeout is the ordinary case, and it has to end with the caller holding the right number.
   */
  generate(companyId: CompanyId, movement: Movement, partA: Readonly<Record<string, unknown>>, partB: Readonly<Record<string, unknown>> | null, idempotencyKey: string): Promise<EwayGenerateOutcome>;
  fetch(companyId: CompanyId, ewayBillNumber: string): Promise<EwayFetchOutcome>;
  /** Adds or changes the vehicle. Allowed any number of times while the bill is valid. */
  updateVehicle(companyId: CompanyId, partB: Readonly<Record<string, unknown>>, idempotencyKey: string): Promise<EwayUpdateOutcome>;
  /** Hands the consignment to a transporter, who then fills in Part B themselves. */
  assignTransporter(companyId: CompanyId, input: { readonly ewayBillNumber: string; readonly transporterId: string; readonly idempotencyKey: string }): Promise<EwayUpdateOutcome>;
  extendValidity(companyId: CompanyId, input: EwayExtensionRequest): Promise<EwayUpdateOutcome>;
  cancel(companyId: CompanyId, input: { readonly ewayBillNumber: string; readonly reasonCode: EwayCancelReasonCode; readonly reason: string; readonly idempotencyKey: string }): Promise<EwayCancelOutcome>;
  /** The other party saying "this consignment is not mine". A different act from cancelling. */
  reject(companyId: CompanyId, input: { readonly ewayBillNumber: string; readonly reasonCode: EwayRejectReasonCode; readonly reason: string; readonly idempotencyKey: string }): Promise<EwayCancelOutcome>;
  /** One trip sheet covering several e-way bills on one lorry. */
  consolidate(companyId: CompanyId, input: EwayConsolidateRequest): Promise<EwayConsolidateOutcome>;
}

export interface EwayExtensionRequest {
  readonly ewayBillNumber: string;
  /** Where the vehicle actually is now. The portal will not extend without it. */
  readonly currentPlace: string;
  readonly currentStateCode: string;
  readonly remainingDistanceKm: number;
  readonly reasonCode: string;
  readonly reason: string;
  readonly vehicleNumber?: string;
  readonly idempotencyKey: string;
}

export interface EwayConsolidateRequest {
  readonly vehicleNumber: string;
  readonly fromPlace: string;
  readonly fromStateCode: string;
  readonly transportMode: string;
  readonly ewayBillNumbers: readonly string[];
  readonly idempotencyKey: string;
}

export type EwayGenerateOutcome =
  | { readonly kind: "GENERATED"; readonly acknowledgement: EwayBillAcknowledgement }
  /** Already on the portal's record. Carries the number it already has. */
  | { readonly kind: "DUPLICATE"; readonly acknowledgement: EwayBillAcknowledgement; readonly message: string }
  /** The portal refused the consignment itself. Retrying unchanged will refuse again. */
  | { readonly kind: "REJECTED"; readonly code: string; readonly message: string; readonly fieldHints?: readonly string[] }
  /** We could not reach the portal. The consignment's state with the government is unknown. */
  | { readonly kind: "UNAVAILABLE"; readonly code: string; readonly message: string; readonly retryable: boolean };

export type EwayFetchOutcome =
  | {
      readonly kind: "FOUND";
      readonly acknowledgement: EwayBillAcknowledgement;
      readonly status: "ACTIVE" | "CANCELLED" | "REJECTED" | "PART_A_ONLY";
      readonly vehicleNumber?: string;
    }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "UNAVAILABLE"; readonly code: string; readonly message: string; readonly retryable: boolean };

export type EwayUpdateOutcome =
  | { readonly kind: "UPDATED"; readonly acknowledgement: EwayBillAcknowledgement }
  | { readonly kind: "REFUSED"; readonly code: string; readonly message: string }
  | { readonly kind: "UNAVAILABLE"; readonly code: string; readonly message: string; readonly retryable: boolean };

export type EwayCancelOutcome =
  | { readonly kind: "DONE"; readonly at: string }
  /** Outside the portal's window, already cancelled, or verified in transit. */
  | { readonly kind: "REFUSED"; readonly code: string; readonly message: string }
  | { readonly kind: "UNAVAILABLE"; readonly code: string; readonly message: string; readonly retryable: boolean };

export type EwayConsolidateOutcome =
  | { readonly kind: "CONSOLIDATED"; readonly tripNumber: string; readonly at: string }
  | { readonly kind: "REFUSED"; readonly code: string; readonly message: string }
  | { readonly kind: "UNAVAILABLE"; readonly code: string; readonly message: string; readonly retryable: boolean };

export interface EwayBillRepository {
  insert(record: EwayBillRecord): Promise<void>;
  update(record: EwayBillRecord): Promise<void>;
  findById(companyId: CompanyId, id: Id): Promise<EwayBillRecord | null>;
  /** The one that matters: one live e-way bill per movement. */
  findByMovementId(companyId: CompanyId, movementId: Id): Promise<EwayBillRecord | null>;
  findByNumber(companyId: CompanyId, ewayBillNumber: string): Promise<EwayBillRecord | null>;
  list(companyId: CompanyId): Promise<EwayBillRecord[]>;
  /** Bills still running, so a screen can show what is on the road right now. */
  listActive(companyId: CompanyId): Promise<EwayBillRecord[]>;
  /** Bills whose validity runs out before a moment — what an expiry warning reads. */
  listExpiringBefore(companyId: CompanyId, before: string): Promise<EwayBillRecord[]>;
}

export interface ConsolidatedTripRepository {
  insert(record: ConsolidatedTripRecord): Promise<void>;
  list(companyId: CompanyId): Promise<ConsolidatedTripRecord[]>;
  findByTripNumber(companyId: CompanyId, tripNumber: string): Promise<ConsolidatedTripRecord | null>;
}

/** Per company, effective-dated. A port, so #7's versioned rules can answer this later. */
export interface EwayBillPolicyPort {
  policyFor(companyId: CompanyId, on: IsoDate): Promise<EwayBillPolicy>;
}

export type { Clock, TransporterAssignment, VehicleAssignment };
