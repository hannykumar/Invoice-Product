// Issue #27 [E27] — the narrow surfaces the e-way bill lifecycle needs.
//
// The portal sits behind a port for the reason the brief gives: government services are replaceable
// adapters, not a dependency the domain is written against. Everything below is in this module's
// own words, so a change of provider is a change of adapter.

import { conflict, type CompanyId, type Clock } from "@invoice/kernel";
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
  /** In the order they were first saved. `page.after` is the id of the last bill of the page before. */
  list(companyId: CompanyId, page?: Page): Promise<EwayBillRecord[]>;
  /** Bills still running, so a screen can show what is on the road right now. */
  listActive(companyId: CompanyId, page?: Page): Promise<EwayBillRecord[]>;
  /** Bills whose validity runs out before a moment — what an expiry warning reads. */
  listExpiringBefore(companyId: CompanyId, before: string, page?: Page): Promise<EwayBillRecord[]>;
}

export interface ConsolidatedTripRepository {
  insert(record: ConsolidatedTripRecord): Promise<void>;
  /** In the order they were saved. `page.after` is the id of the last trip of the page before. */
  list(companyId: CompanyId, page?: Page): Promise<ConsolidatedTripRecord[]>;
  findByTripNumber(companyId: CompanyId, tripNumber: string): Promise<ConsolidatedTripRecord | null>;
}

/** Per company, effective-dated. A port, so #7's versioned rules can answer this later. */
export interface EwayBillPolicyPort {
  policyFor(companyId: CompanyId, on: IsoDate): Promise<EwayBillPolicy>;
}

export type { Clock, TransporterAssignment, VehicleAssignment };

// ------------------------------------------------------------------ issue #366: paging and duplicates

/**
 * One page of a list, by keyset: at most `limit` rows that come after the row whose key is `after`.
 *
 * The key is named on each list method (an id, or the vehicle number). Leaving the page out returns
 * the whole list, which is what every caller did before paging existed.
 */
export interface Page {
  readonly limit: number;
  readonly after?: string;
}

/** Paging for the in-memory stores: `rows` are in their stable order, `keep` is the list's own filter. */
export const pageOf = <T>(rows: readonly T[], keyOf: (row: T) => string, page: Page | undefined, keep: (row: T) => boolean = () => true): T[] => {
  if (page === undefined) return rows.filter(keep);
  const at = page.after === undefined ? -1 : rows.findIndex((row) => keyOf(row) === page.after);
  // A key this company does not hold is the end of the list, not the start of it.
  if (page.after !== undefined && at < 0) return [];
  return rows.slice(at + 1).filter(keep).slice(0, page.limit);
};

/** What both kinds of store say when a row that must be unique is written a second time. */
export const DUPLICATES = {
  ewayBill: () => conflict("EWAY_DUPLICATE", "This movement already has an e-way bill record, so a second one has not been made."),
  trip: () => conflict("EWAY_TRIP_DUPLICATE", "This trip sheet has already been recorded."),
  check: () => conflict("VEHICLE_CHECK_DUPLICATE", "This vehicle check has already been recorded."),
  checkChanged: () => conflict("VEHICLE_CHECK_CHANGED", "Someone else answered this vehicle check a moment ago. Open it again to see what they wrote before adding to it."),
} as const;
