// Issue #27 [E27] — the e-way bill portal behind #8's connector, a synthetic one, and storage.
//
// No production credential is needed to run or test any of this. The synthetic portal below
// implements the behaviours that actually bite: it refuses a second bill for the same consignment
// with the portal's own duplicate error, it starts validity only when Part B goes in, it computes
// expiry at midnight Indian time from the distance, it refuses a cancellation after twenty-four
// hours, and it refuses one outright once an officer has verified the goods in transit.

import type { CompanyId } from "@invoice/kernel";
import type { TransactionParticipant } from "@invoice/ledger";
import { ConnectorError, type ConnectorGateway, type ConnectorRequest } from "../../platform/src/connectors.ts";
import { DEFAULT_EWAY_BILL_POLICY } from "./types.ts";
import { readPortalTimestamp, validUntilFrom, writePortalTimestamp } from "./validity.ts";
import type {
  ConsolidatedTripRecord, EwayBillAcknowledgement, EwayBillPolicy, EwayBillRecord, VehicleType,
} from "./types.ts";
import type {
  ConsolidatedTripRepository, EwayBillPolicyPort, EwayBillPort, EwayBillRepository,
  EwayCancelOutcome, EwayConsolidateOutcome, EwayFetchOutcome, EwayGenerateOutcome, EwayUpdateOutcome,
} from "./ports.ts";
import type { Id, IsoDate } from "../../masters/src/types.ts";

/** The portal's own error codes we act on differently from the rest. */
export const EWB_DUPLICATE_CODE = "604";
export const EWB_CANCEL_WINDOW_CODE = "108";
/** An officer has already checked these goods on the road. The bill can never be cancelled now. */
export const EWB_VERIFIED_IN_TRANSIT_CODE = "110";
export const EWB_NOT_FOUND_CODE = "325";

const unavailable = (error: unknown): { code: string; message: string; retryable: boolean } => {
  if (error instanceof ConnectorError) {
    if (error.code === "TIMEOUT") return { code: "TIMEOUT", message: "The e-way bill portal did not answer in time.", retryable: true };
    if (error.code === "OUTAGE") return { code: "OUTAGE", message: "The e-way bill portal is not responding at the moment.", retryable: true };
    if (error.code === "UNAUTHORIZED") return { code: "UNAUTHORIZED", message: "This business is not set up with the e-way bill provider yet.", retryable: false };
    return { code: "INVALID_REQUEST", message: "The e-way bill portal could not accept the request as it was made.", retryable: false };
  }
  return { code: "OUTAGE", message: "The e-way bill portal could not be reached.", retryable: true };
};

const readAck = (payload: Readonly<Record<string, unknown>>, providerRequestId: string, receivedAt: string): EwayBillAcknowledgement => {
  const text = (key: string): string => {
    const value = payload[key];
    return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  };
  return {
    ewayBillNumber: text("ewayBillNo"),
    generatedAt: text("ewayBillDate"),
    // Absent until Part B goes in: validity does not start before the vehicle is known, and an
    // empty string here would read on screen as "valid until nothing".
    ...(text("validUpto") === "" ? {} : { validUntil: text("validUpto") }),
    ...(text("alert") === "" ? {} : { alert: text("alert") }),
    providerRequestId,
    receivedAt,
  };
};

export interface EwayAdapterDeps {
  readonly gateway: ConnectorGateway;
  readonly clock: () => Date;
  readonly correlationId?: () => string;
}

/**
 * The e-way bill portal behind `connector-v1`.
 *
 * The idempotency key is the caller's and is passed straight through, because the whole point is
 * that a retry after a timeout reaches the provider as the same call rather than a second one.
 */
export const ewayBillAdapter = (deps: EwayAdapterDeps): EwayBillPort => {
  const request = (companyId: CompanyId, operation: string, payload: Readonly<Record<string, unknown>>, idempotencyKey: string): ConnectorRequest => ({
    tenantId: companyId,
    operation,
    payload,
    idempotencyKey,
    correlationId: deps.correlationId?.() ?? `ewb-${idempotencyKey}`,
  });

  const update = async (companyId: CompanyId, operation: string, payload: Readonly<Record<string, unknown>>, idempotencyKey: string): Promise<EwayUpdateOutcome> => {
    try {
      const response = await deps.gateway.execute("eway_bill", request(companyId, operation, payload, idempotencyKey));
      const body = response.payload;
      if (typeof body.errorCode === "string") {
        return { kind: "REFUSED", code: body.errorCode, message: typeof body.errorMessage === "string" ? body.errorMessage : "The portal refused the change." };
      }
      return { kind: "UPDATED", acknowledgement: readAck(body, response.providerRequestId, deps.clock().toISOString()) };
    } catch (error) {
      return { kind: "UNAVAILABLE", ...unavailable(error) };
    }
  };

  const finish = async (companyId: CompanyId, operation: string, payload: Readonly<Record<string, unknown>>, idempotencyKey: string): Promise<EwayCancelOutcome> => {
    try {
      const response = await deps.gateway.execute("eway_bill", request(companyId, operation, payload, idempotencyKey));
      const body = response.payload;
      if (typeof body.errorCode === "string") {
        return { kind: "REFUSED", code: body.errorCode, message: typeof body.errorMessage === "string" ? body.errorMessage : "The portal refused." };
      }
      return { kind: "DONE", at: typeof body.at === "string" ? body.at : deps.clock().toISOString() };
    } catch (error) {
      return { kind: "UNAVAILABLE", ...unavailable(error) };
    }
  };

  return {
    async generate(companyId, _movement, partA, partB, idempotencyKey): Promise<EwayGenerateOutcome> {
      try {
        const response = await deps.gateway.execute("eway_bill", request(companyId, "eway.generate", { ...partA, ...(partB ?? {}) }, idempotencyKey));
        const body = response.payload;
        const receivedAt = deps.clock().toISOString();
        const code = typeof body.errorCode === "string" ? body.errorCode : undefined;

        // The portal's "already raised" reply is a success for our purposes: the caller must end up
        // holding the right number, whatever the network did on the first attempt.
        if (code === EWB_DUPLICATE_CODE) {
          return {
            kind: "DUPLICATE",
            acknowledgement: readAck(body, response.providerRequestId, receivedAt),
            message: typeof body.errorMessage === "string" ? body.errorMessage : "This consignment already has an e-way bill.",
          };
        }
        if (code !== undefined) {
          return {
            kind: "REJECTED", code,
            message: typeof body.errorMessage === "string" ? body.errorMessage : "The portal refused this movement.",
            ...(Array.isArray(body.fieldHints) ? { fieldHints: body.fieldHints as readonly string[] } : {}),
          };
        }
        return { kind: "GENERATED", acknowledgement: readAck(body, response.providerRequestId, receivedAt) };
      } catch (error) {
        return { kind: "UNAVAILABLE", ...unavailable(error) };
      }
    },

    async fetch(companyId, ewayBillNumber): Promise<EwayFetchOutcome> {
      try {
        const response = await deps.gateway.execute("eway_bill", request(companyId, "eway.fetch", { ewbNo: ewayBillNumber }, `ewb:fetch:${companyId}:${ewayBillNumber}`));
        const body = response.payload;
        if (body.errorCode !== undefined || typeof body.ewayBillNo !== "string") return { kind: "NOT_FOUND" };
        const status = body.status === "CNL" ? "CANCELLED" : body.status === "REJ" ? "REJECTED" : body.status === "PARTA" ? "PART_A_ONLY" : "ACTIVE";
        return {
          kind: "FOUND",
          acknowledgement: readAck(body, response.providerRequestId, deps.clock().toISOString()),
          status,
          ...(typeof body.vehicleNo === "string" && body.vehicleNo !== "" ? { vehicleNumber: body.vehicleNo } : {}),
        };
      } catch (error) {
        return { kind: "UNAVAILABLE", ...unavailable(error) };
      }
    },

    updateVehicle(companyId, partB, idempotencyKey) {
      return update(companyId, "eway.vehicle", partB, idempotencyKey);
    },

    assignTransporter(companyId, input) {
      return update(companyId, "eway.transporter", { ewbNo: Number(input.ewayBillNumber), transporterId: input.transporterId }, input.idempotencyKey);
    },

    extendValidity(companyId, input) {
      return update(companyId, "eway.extend", {
        ewbNo: Number(input.ewayBillNumber),
        fromPlace: input.currentPlace,
        fromState: input.currentStateCode,
        remainingDistance: String(input.remainingDistanceKm),
        extnRsnCode: input.reasonCode,
        extnRemarks: input.reason,
        ...(input.vehicleNumber === undefined ? {} : { vehicleNo: input.vehicleNumber }),
      }, input.idempotencyKey);
    },

    cancel(companyId, input) {
      return finish(companyId, "eway.cancel", {
        ewbNo: Number(input.ewayBillNumber),
        cancelRsnCode: CANCEL_CODES[input.reasonCode],
        cancelRmrk: input.reason,
      }, input.idempotencyKey);
    },

    reject(companyId, input) {
      return finish(companyId, "eway.reject", {
        ewbNo: Number(input.ewayBillNumber),
        rejectRsnCode: REJECT_CODES[input.reasonCode],
        rejectRmrk: input.reason,
      }, input.idempotencyKey);
    },

    async consolidate(companyId, input): Promise<EwayConsolidateOutcome> {
      try {
        const response = await deps.gateway.execute("eway_bill", request(companyId, "eway.consolidate", {
          vehicleNo: input.vehicleNumber,
          fromPlace: input.fromPlace,
          fromState: input.fromStateCode,
          transMode: input.transportMode,
          tripSheetEwbBills: input.ewayBillNumbers.map((number) => ({ ewbNo: Number(number) })),
        }, input.idempotencyKey));
        const body = response.payload;
        if (typeof body.errorCode === "string") {
          return { kind: "REFUSED", code: body.errorCode, message: typeof body.errorMessage === "string" ? body.errorMessage : "The portal refused the trip sheet." };
        }
        return {
          kind: "CONSOLIDATED",
          tripNumber: typeof body.cEwbNo === "string" ? body.cEwbNo : String(body.cEwbNo ?? ""),
          at: typeof body.cEwbDate === "string" ? body.cEwbDate : deps.clock().toISOString(),
        };
      } catch (error) {
        return { kind: "UNAVAILABLE", ...unavailable(error) };
      }
    },
  };
};

/** The portal's numeric cancellation reasons. */
export const CANCEL_CODES: Readonly<Record<string, string>> = Object.freeze({
  DUPLICATE: "1",
  ORDER_CANCELLED: "2",
  DATA_ENTRY_MISTAKE: "3",
  OTHERS: "4",
});

export const REJECT_CODES: Readonly<Record<string, string>> = Object.freeze({
  NOT_MY_CONSIGNMENT: "1",
  DATA_ENTRY_MISTAKE: "2",
  OTHERS: "3",
});

// ------------------------------------------------------------------------- the synthetic portal

interface StoredBill {
  number: string;
  generatedAt: string;
  validUntil?: string;
  vehicleNumber?: string;
  vehicleType: VehicleType;
  distanceKm: number;
  status: "ACTIVE" | "PART_A_ONLY" | "CANCELLED" | "REJECTED";
  /** Set once an officer has checked the goods on the road. Then it can never be cancelled. */
  verifiedInTransit: boolean;
  transporterId?: string;
  consignmentKey: string;
}

/**
 * An e-way bill portal for development and tests.
 *
 * It behaves like the real one where it matters: a second bill for the same consignment comes back
 * as error 604 with the number already on record, validity starts at Part B and expires at midnight
 * Indian time, cancellation after twenty-four hours is refused with 108, and a consignment an
 * officer has verified on the road cannot be cancelled at all.
 */
export class SyntheticEwayBillPortal {
  readonly kind = "eway_bill" as const;
  readonly #bills = new Map<string, StoredBill>();
  readonly #byConsignment = new Map<string, string>();
  readonly #seen = new Map<string, { providerRequestId: string; payload: Record<string, unknown> }>();
  readonly #trips = new Map<string, readonly string[]>();
  #mode: "healthy" | "timeout" | "outage" = "healthy";
  #now: () => Date;
  #policy: EwayBillPolicy;
  #sequence = 0;
  #rejectWith: { code: string; message: string } | null = null;

  constructor(now: () => Date = () => new Date(), policy: EwayBillPolicy = DEFAULT_EWAY_BILL_POLICY) {
    this.#now = now;
    this.#policy = policy;
  }

  setMode(mode: "healthy" | "timeout" | "outage"): void { this.#mode = mode; }
  rejectNext(code: string, message: string): void { this.#rejectWith = { code, message }; }
  /** Marks a bill as checked by an officer on the road, which locks cancellation for good. */
  markVerifiedInTransit(ewayBillNumber: string): void {
    const bill = this.#bills.get(ewayBillNumber);
    if (bill !== undefined) bill.verifiedInTransit = true;
  }
  /** Every number the portal currently holds, so a test can prove nothing was raised twice. */
  numbers(): readonly string[] { return [...this.#bills.keys()]; }
  tripSheets(): ReadonlyMap<string, readonly string[]> { return this.#trips; }

  async execute(request: ConnectorRequest): Promise<{ providerRequestId: string; status: "completed"; payload: Record<string, unknown> }> {
    if (this.#mode === "timeout") throw new ConnectorError("TIMEOUT", true);
    if (this.#mode === "outage") throw new ConnectorError("OUTAGE", true);

    // Same idempotency key, same answer — the provider's half of "raised once".
    const prior = this.#seen.get(request.idempotencyKey);
    if (prior !== undefined) return { providerRequestId: prior.providerRequestId, status: "completed", payload: prior.payload };

    const providerRequestId = `synthetic-ewb-${(this.#sequence += 1)}`;
    const payload = this.#handle(request);
    this.#seen.set(request.idempotencyKey, { providerRequestId, payload });
    return { providerRequestId, status: "completed", payload };
  }

  async health(): Promise<"healthy" | "degraded" | "unavailable"> {
    return this.#mode === "healthy" ? "healthy" : "unavailable";
  }

  #handle(request: ConnectorRequest): Record<string, unknown> {
    switch (request.operation) {
      case "eway.generate": return this.#generate(request.payload);
      case "eway.fetch": return this.#fetch(request.payload);
      case "eway.vehicle": return this.#vehicle(request.payload);
      case "eway.transporter": return this.#transporter(request.payload);
      case "eway.extend": return this.#extend(request.payload);
      case "eway.cancel": return this.#cancel(request.payload);
      case "eway.reject": return this.#reject(request.payload);
      case "eway.consolidate": return this.#consolidate(request.payload);
      default: return { errorCode: "100", errorMessage: "Unknown operation." };
    }
  }

  #generate(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
    if (this.#rejectWith !== null) {
      const rejection = this.#rejectWith;
      this.#rejectWith = null;
      return { errorCode: rejection.code, errorMessage: rejection.message };
    }
    // The portal identifies a consignment by the seller and the document on it.
    const key = `${String(payload.fromGstin ?? "")}|${String(payload.docNo ?? "")}|${String(payload.docDate ?? "")}`;
    const existingNumber = this.#byConsignment.get(key);
    if (existingNumber !== undefined) {
      const existing = this.#bills.get(existingNumber);
      return {
        errorCode: EWB_DUPLICATE_CODE,
        errorMessage: `Duplicate EWB. E-way bill is already generated for this document number ${String(payload.docNo ?? "")}.`,
        ewayBillNo: existingNumber,
        ewayBillDate: existing?.generatedAt ?? "",
        ...(existing?.validUntil === undefined ? {} : { validUpto: existing.validUntil }),
      };
    }

    const now = this.#now();
    // Twelve digits, as the portal issues.
    const number = String(100_000_000_000n + BigInt(this.#sequence) * 7n + 3n);
    const distanceKm = Number(payload.transDistance ?? 0);
    const vehicleType: VehicleType = payload.vehicleType === "O" ? "ODC" : "REGULAR";
    const hasVehicle = typeof payload.vehicleNo === "string" && payload.vehicleNo !== "";
    const bill: StoredBill = {
      number,
      generatedAt: writePortalTimestamp(now),
      vehicleType,
      distanceKm,
      status: hasVehicle ? "ACTIVE" : "PART_A_ONLY",
      verifiedInTransit: false,
      consignmentKey: key,
      ...(hasVehicle ? { vehicleNumber: String(payload.vehicleNo), validUntil: validUntilFrom(now, distanceKm, vehicleType, this.#policy).toISOString() } : {}),
      ...(typeof payload.transporterId === "string" ? { transporterId: payload.transporterId } : {}),
    };
    this.#bills.set(number, bill);
    this.#byConsignment.set(key, number);
    return {
      ewayBillNo: number,
      ewayBillDate: bill.generatedAt,
      ...(bill.validUntil === undefined ? {} : { validUpto: bill.validUntil }),
      status: bill.status === "ACTIVE" ? "ACT" : "PARTA",
    };
  }

  #fetch(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const bill = this.#bills.get(String(payload.ewbNo ?? ""));
    if (bill === undefined) return { errorCode: EWB_NOT_FOUND_CODE, errorMessage: "E-way bill not found." };
    return {
      ewayBillNo: bill.number,
      ewayBillDate: bill.generatedAt,
      ...(bill.validUntil === undefined ? {} : { validUpto: bill.validUntil }),
      ...(bill.vehicleNumber === undefined ? {} : { vehicleNo: bill.vehicleNumber }),
      status: bill.status === "CANCELLED" ? "CNL" : bill.status === "REJECTED" ? "REJ" : bill.status === "PART_A_ONLY" ? "PARTA" : "ACT",
    };
  }

  #vehicle(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const bill = this.#bills.get(String(payload.ewbNo ?? ""));
    if (bill === undefined) return { errorCode: EWB_NOT_FOUND_CODE, errorMessage: "E-way bill not found." };
    if (bill.status === "CANCELLED" || bill.status === "REJECTED") {
      return { errorCode: "112", errorMessage: "Vehicle details cannot be updated for a cancelled or rejected e-way bill." };
    }
    const now = this.#now();
    bill.vehicleNumber = String(payload.vehicleNo ?? "");
    bill.vehicleType = payload.vehicleType === "O" ? "ODC" : "REGULAR";
    // Validity starts at the *first* Part B and never restarts on a vehicle change: a lorry
    // breaking down does not buy the consignment another two days.
    if (bill.validUntil === undefined) {
      bill.validUntil = validUntilFrom(now, bill.distanceKm, bill.vehicleType, this.#policy).toISOString();
    }
    bill.status = "ACTIVE";
    return { ewayBillNo: bill.number, ewayBillDate: bill.generatedAt, validUpto: bill.validUntil, vehicleNo: bill.vehicleNumber };
  }

  #transporter(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const bill = this.#bills.get(String(payload.ewbNo ?? ""));
    if (bill === undefined) return { errorCode: EWB_NOT_FOUND_CODE, errorMessage: "E-way bill not found." };
    bill.transporterId = String(payload.transporterId ?? "");
    return {
      ewayBillNo: bill.number, ewayBillDate: bill.generatedAt,
      ...(bill.validUntil === undefined ? {} : { validUpto: bill.validUntil }),
    };
  }

  #extend(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const bill = this.#bills.get(String(payload.ewbNo ?? ""));
    if (bill === undefined) return { errorCode: EWB_NOT_FOUND_CODE, errorMessage: "E-way bill not found." };
    if (bill.validUntil === undefined) return { errorCode: "356", errorMessage: "Validity has not started, so it cannot be extended." };
    const now = this.#now();
    const expiry = new Date(bill.validUntil).getTime();
    const window = this.#policy.extensionWindowHours * 3_600_000;
    if (now.getTime() < expiry - window || now.getTime() > expiry + window) {
      return { errorCode: "378", errorMessage: "E-way bill can be extended only 8 hours before or after its expiry." };
    }
    const remaining = Number(payload.remainingDistance ?? 0);
    bill.validUntil = validUntilFrom(now, remaining, bill.vehicleType, this.#policy).toISOString();
    bill.status = "ACTIVE";
    return { ewayBillNo: bill.number, ewayBillDate: bill.generatedAt, validUpto: bill.validUntil };
  }

  #cancel(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const bill = this.#bills.get(String(payload.ewbNo ?? ""));
    if (bill === undefined) return { errorCode: EWB_NOT_FOUND_CODE, errorMessage: "E-way bill not found." };
    if (bill.status === "CANCELLED") return { errorCode: "109", errorMessage: "This e-way bill is already cancelled." };
    if (bill.verifiedInTransit) {
      return { errorCode: EWB_VERIFIED_IN_TRANSIT_CODE, errorMessage: "This e-way bill has been verified by an officer during transit and cannot be cancelled." };
    }
    const generated = readPortalTimestamp(bill.generatedAt).getTime();
    if (this.#now().getTime() - generated > this.#policy.cancellationWindowHours * 3_600_000) {
      return { errorCode: EWB_CANCEL_WINDOW_CODE, errorMessage: "E-way bill cannot be cancelled after 24 hours of its generation." };
    }
    bill.status = "CANCELLED";
    return { ewayBillNo: bill.number, at: this.#now().toISOString() };
  }

  #reject(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const bill = this.#bills.get(String(payload.ewbNo ?? ""));
    if (bill === undefined) return { errorCode: EWB_NOT_FOUND_CODE, errorMessage: "E-way bill not found." };
    if (bill.status === "CANCELLED") return { errorCode: "109", errorMessage: "This e-way bill is already cancelled." };
    const generated = readPortalTimestamp(bill.generatedAt).getTime();
    if (this.#now().getTime() - generated > this.#policy.rejectionWindowHours * 3_600_000) {
      return { errorCode: "358", errorMessage: "The time limit for rejecting this e-way bill has passed." };
    }
    bill.status = "REJECTED";
    return { ewayBillNo: bill.number, at: this.#now().toISOString() };
  }

  #consolidate(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const rows = Array.isArray(payload.tripSheetEwbBills) ? payload.tripSheetEwbBills as { ewbNo: number }[] : [];
    const numbers = rows.map((row) => String(row.ewbNo));
    for (const number of numbers) {
      const bill = this.#bills.get(number);
      if (bill === undefined) return { errorCode: EWB_NOT_FOUND_CODE, errorMessage: `E-way bill ${number} not found.` };
      if (bill.status !== "ACTIVE") return { errorCode: "121", errorMessage: `E-way bill ${number} is not active and cannot go on a trip sheet.` };
    }
    const tripNumber = String(900_000_000_000n + BigInt(this.#trips.size + 1));
    this.#trips.set(tripNumber, numbers);
    return { cEwbNo: tripNumber, cEwbDate: this.#now().toISOString() };
  }
}

// --------------------------------------------------------------------------- storage

export class InMemoryEwayBillStore implements EwayBillRepository, TransactionParticipant {
  #rows: EwayBillRecord[] = [];

  snapshot(): unknown { return [...this.#rows]; }
  restore(taken: unknown): void { this.#rows = [...(taken as EwayBillRecord[])]; }

  async insert(record: EwayBillRecord): Promise<void> { this.#rows.push(Object.freeze(record)); }

  async update(record: EwayBillRecord): Promise<void> {
    const index = this.#rows.findIndex((row) => row.companyId === record.companyId && row.id === record.id);
    if (index >= 0) this.#rows[index] = Object.freeze(record);
  }

  async findById(companyId: CompanyId, id: Id): Promise<EwayBillRecord | null> {
    return this.#rows.find((row) => row.companyId === companyId && row.id === id) ?? null;
  }

  async findByMovementId(companyId: CompanyId, movementId: Id): Promise<EwayBillRecord | null> {
    return this.#rows.find((row) => row.companyId === companyId && row.movementId === movementId) ?? null;
  }

  async findByNumber(companyId: CompanyId, ewayBillNumber: string): Promise<EwayBillRecord | null> {
    return this.#rows.find((row) => row.companyId === companyId && row.acknowledgement?.ewayBillNumber === ewayBillNumber) ?? null;
  }

  async list(companyId: CompanyId): Promise<EwayBillRecord[]> {
    return this.#rows.filter((row) => row.companyId === companyId);
  }

  async listActive(companyId: CompanyId): Promise<EwayBillRecord[]> {
    return this.#rows.filter((row) => row.companyId === companyId && (row.status === "ACTIVE" || row.status === "PART_A_ONLY"));
  }

  async listExpiringBefore(companyId: CompanyId, before: string): Promise<EwayBillRecord[]> {
    return this.#rows.filter((row) => row.companyId === companyId && row.status === "ACTIVE"
      && row.acknowledgement?.validUntil !== undefined && row.acknowledgement.validUntil <= before);
  }
}

export class InMemoryConsolidatedTripStore implements ConsolidatedTripRepository, TransactionParticipant {
  #rows: ConsolidatedTripRecord[] = [];

  snapshot(): unknown { return [...this.#rows]; }
  restore(taken: unknown): void { this.#rows = [...(taken as ConsolidatedTripRecord[])]; }

  async insert(record: ConsolidatedTripRecord): Promise<void> { this.#rows.push(Object.freeze(record)); }
  async list(companyId: CompanyId): Promise<ConsolidatedTripRecord[]> { return this.#rows.filter((row) => row.companyId === companyId); }
  async findByTripNumber(companyId: CompanyId, tripNumber: string): Promise<ConsolidatedTripRecord | null> {
    return this.#rows.find((row) => row.companyId === companyId && row.tripNumber === tripNumber) ?? null;
  }
}

/** Effective-dated policies, newest first, as every other policy in this product is held. */
export class InMemoryEwayBillPolicies implements EwayBillPolicyPort {
  readonly #byCompany = new Map<string, EwayBillPolicy[]>();

  set(companyId: CompanyId, policy: EwayBillPolicy): void {
    const merged = [...(this.#byCompany.get(companyId) ?? []).filter((candidate) => candidate.effectiveFrom !== policy.effectiveFrom), policy];
    merged.sort((left, right) => (left.effectiveFrom < right.effectiveFrom ? 1 : -1));
    this.#byCompany.set(companyId, merged);
  }

  async policyFor(companyId: CompanyId, on: IsoDate): Promise<EwayBillPolicy> {
    return (this.#byCompany.get(companyId) ?? []).find((policy) => policy.effectiveFrom <= on) ?? DEFAULT_EWAY_BILL_POLICY;
  }
}

/** A credential vault for development: opaque references, never a secret. */
export class SyntheticEwayVault {
  async credentialReference(tenantId: string, connector: string): Promise<string> {
    return `vault://${connector}/${tenantId}`;
  }
}
