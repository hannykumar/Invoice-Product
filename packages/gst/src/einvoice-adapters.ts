// Issue #26 [E26] — the IRP behind #8's connector, a synthetic one for development, and storage.
//
// No production credential is needed to run or test any of this. The synthetic portal below
// implements the real IRP behaviours that matter: it returns the duplicate error the government
// returns on a repeat submission, it enforces the twenty-four hour cancellation window, and it
// computes IRNs with the published formula so the verification in `irn.ts` is exercised for real
// rather than against a rubber stamp.

import type { CompanyId } from "@invoice/kernel";
import type { TransactionParticipant } from "@invoice/ledger";
import {
  ConnectorError, type ConnectorGateway, type ConnectorRequest,
} from "../../platform/src/connectors.ts";
import { computeIrn, financialYearOf, readAckDate } from "./irn.ts";
import { DEFAULT_EINVOICE_POLICY } from "./einvoice-types.ts";
import type {
  CancelReasonCode, EInvoicePolicy, EInvoiceRecord, IrpAcknowledgement,
} from "./einvoice-types.ts";
import type {
  EInvoicePolicyPort, EInvoiceRepository, IrpCancelOutcome, IrpFetchOutcome, IrpGenerateOutcome,
  IrpPort,
} from "./einvoice-ports.ts";
import type { EInvoiceDocument } from "./payload.ts";
import type { Id, IsoDate } from "../../masters/src/types.ts";

/** The government's own error codes we act on differently from the rest. */
export const IRP_DUPLICATE_CODE = "2150";
export const IRP_CANCEL_WINDOW_CODE = "4002";

const unavailable = (error: unknown): { code: string; message: string; retryable: boolean } => {
  if (error instanceof ConnectorError) {
    if (error.code === "TIMEOUT") return { code: "TIMEOUT", message: "The government's e-invoice service did not answer in time.", retryable: true };
    if (error.code === "OUTAGE") return { code: "OUTAGE", message: "The government's e-invoice service is not responding at the moment.", retryable: true };
    if (error.code === "UNAUTHORIZED") return { code: "UNAUTHORIZED", message: "This business is not set up with the e-invoice provider yet.", retryable: false };
    return { code: "INVALID_REQUEST", message: "The e-invoice service could not accept the request as it was made.", retryable: false };
  }
  return { code: "OUTAGE", message: "The government's e-invoice service could not be reached.", retryable: true };
};

const readAck = (payload: Readonly<Record<string, unknown>>, providerRequestId: string, receivedAt: string): IrpAcknowledgement => {
  const text = (key: string): string => {
    const value = payload[key];
    return typeof value === "string" ? value : "";
  };
  return {
    irn: text("Irn").toLowerCase(),
    ackNumber: text("AckNo"),
    ackDate: text("AckDt"),
    signedQrCode: text("SignedQRCode"),
    ...(text("SignedInvoice") === "" ? {} : { signedInvoice: text("SignedInvoice") }),
    ...(text("EwbNo") === "" ? {} : { ewayBillNumber: text("EwbNo") }),
    providerRequestId,
    receivedAt,
  };
};

export interface IrpAdapterDeps {
  readonly gateway: ConnectorGateway;
  readonly clock: () => Date;
  readonly correlationId?: () => string;
}

/**
 * The IRP behind `connector-v1`.
 *
 * The idempotency key is the caller's and is passed straight through, because the whole point is
 * that a retry after a timeout reaches the provider as the same call rather than a second one.
 */
export const irpAdapter = (deps: IrpAdapterDeps): IrpPort => {
  const request = (companyId: CompanyId, operation: string, payload: Readonly<Record<string, unknown>>, idempotencyKey: string): ConnectorRequest => ({
    tenantId: companyId,
    operation,
    payload,
    idempotencyKey,
    correlationId: deps.correlationId?.() ?? `irp-${idempotencyKey}`,
  });

  return {
    async generate(companyId, _document, payload, idempotencyKey): Promise<IrpGenerateOutcome> {
      try {
        const response = await deps.gateway.execute("irp", request(companyId, "einvoice.generate", payload, idempotencyKey));
        const body = response.payload;
        const receivedAt = deps.clock().toISOString();
        const code = typeof body.ErrorCode === "string" ? body.ErrorCode : undefined;

        // The government's "already registered" reply is a success for our purposes: the caller
        // must end up holding the right IRN, whatever the network did on the first attempt.
        if (code === IRP_DUPLICATE_CODE) {
          return {
            kind: "DUPLICATE",
            acknowledgement: readAck(body, response.providerRequestId, receivedAt),
            message: typeof body.ErrorMessage === "string" ? body.ErrorMessage : "This bill is already registered with the government.",
          };
        }
        if (code !== undefined) {
          return {
            kind: "REJECTED", code,
            message: typeof body.ErrorMessage === "string" ? body.ErrorMessage : "The government refused this bill.",
            ...(Array.isArray(body.FieldHints) ? { fieldHints: body.FieldHints as readonly string[] } : {}),
          };
        }
        return { kind: "REGISTERED", acknowledgement: readAck(body, response.providerRequestId, receivedAt) };
      } catch (error) {
        return { kind: "UNAVAILABLE", ...unavailable(error) };
      }
    },

    async fetch(companyId, irn): Promise<IrpFetchOutcome> {
      try {
        const response = await deps.gateway.execute("irp", request(companyId, "einvoice.fetch", { Irn: irn }, `irp:fetch:${companyId}:${irn}`));
        const body = response.payload;
        if (body.ErrorCode !== undefined || typeof body.Irn !== "string") return { kind: "NOT_FOUND" };
        return {
          kind: "FOUND",
          acknowledgement: readAck(body, response.providerRequestId, deps.clock().toISOString()),
          cancelled: body.Status === "CNL",
        };
      } catch (error) {
        return { kind: "UNAVAILABLE", ...unavailable(error) };
      }
    },

    async cancel(companyId, input): Promise<IrpCancelOutcome> {
      try {
        const response = await deps.gateway.execute("irp", request(companyId, "einvoice.cancel", {
          Irn: input.irn, CnlRsn: CANCEL_CODES[input.reasonCode], CnlRem: input.reason,
        }, input.idempotencyKey));
        const body = response.payload;
        if (typeof body.ErrorCode === "string") {
          return {
            kind: "REFUSED", code: body.ErrorCode,
            message: typeof body.ErrorMessage === "string" ? body.ErrorMessage : "The government would not cancel this e-invoice.",
          };
        }
        return { kind: "CANCELLED", cancelledAt: typeof body.CancelDate === "string" ? body.CancelDate : deps.clock().toISOString() };
      } catch (error) {
        return { kind: "UNAVAILABLE", ...unavailable(error) };
      }
    },
  };
};

/** The government's numeric cancellation reasons. */
export const CANCEL_CODES: Readonly<Record<CancelReasonCode, string>> = Object.freeze({
  DUPLICATE: "1",
  DATA_ENTRY_MISTAKE: "2",
  ORDER_CANCELLED: "3",
  OTHER: "4",
});

/**
 * An Invoice Registration Portal for development and tests.
 *
 * It behaves like the real one where it matters: a second submission of the same document returns
 * error 2150 with the IRN already on record, cancellation outside twenty-four hours is refused
 * with 4002, and IRNs are the published hash so the verification in `irn.ts` is genuinely tested.
 */
export class SyntheticIrp {
  readonly kind = "irp" as const;
  readonly #registered = new Map<string, { ack: IrpAcknowledgement; cancelled: boolean }>();
  readonly #seen = new Map<string, { providerRequestId: string; payload: Record<string, unknown> }>();
  #mode: "healthy" | "timeout" | "outage" = "healthy";
  #now: () => Date;
  #sequence = 0;
  /** Fields the portal will refuse the next document for, to exercise the rejection path. */
  #rejectWith: { code: string; message: string } | null = null;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  setMode(mode: "healthy" | "timeout" | "outage"): void { this.#mode = mode; }
  rejectNext(code: string, message: string): void { this.#rejectWith = { code, message }; }
  /** Every IRN the portal currently holds, so a test can prove nothing was registered twice. */
  registeredIrns(): readonly string[] { return [...this.#registered.keys()]; }

  async execute(request: ConnectorRequest): Promise<{ providerRequestId: string; status: "completed"; payload: Record<string, unknown> }> {
    if (this.#mode === "timeout") throw new ConnectorError("TIMEOUT", true);
    if (this.#mode === "outage") throw new ConnectorError("OUTAGE", true);

    // Same idempotency key, same answer — the provider's half of "submitted once".
    const prior = this.#seen.get(request.idempotencyKey);
    if (prior !== undefined) return { providerRequestId: prior.providerRequestId, status: "completed", payload: prior.payload };

    const providerRequestId = `synthetic-irp-${(this.#sequence += 1)}`;
    const payload = this.#handle(request);
    this.#seen.set(request.idempotencyKey, { providerRequestId, payload });
    return { providerRequestId, status: "completed", payload };
  }

  async health(): Promise<"healthy" | "degraded" | "unavailable"> {
    return this.#mode === "healthy" ? "healthy" : "unavailable";
  }

  #handle(request: ConnectorRequest): Record<string, unknown> {
    if (request.operation === "einvoice.generate") return this.#generate(request.payload);
    if (request.operation === "einvoice.fetch") return this.#fetch(request.payload);
    if (request.operation === "einvoice.cancel") return this.#cancel(request.payload);
    return { ErrorCode: "1000", ErrorMessage: "Unknown operation." };
  }

  #generate(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
    if (this.#rejectWith !== null) {
      const rejection = this.#rejectWith;
      this.#rejectWith = null;
      return { ErrorCode: rejection.code, ErrorMessage: rejection.message };
    }
    const doc = payload.DocDtls as { Typ: string; No: string; Dt: string };
    const seller = payload.SellerDtls as { Gstin: string };
    const isoDate = doc.Dt.split("/").reverse().join("-");
    const irn = computeIrn({
      supplierGstin: seller.Gstin,
      documentNumber: doc.No,
      documentDate: isoDate,
      documentType: doc.Typ === "CRN" ? "CREDIT_NOTE" : doc.Typ === "DBN" ? "DEBIT_NOTE" : "INVOICE",
    });

    const existing = this.#registered.get(irn);
    if (existing !== undefined) {
      // Exactly what the government returns for a document already on its record.
      return {
        ErrorCode: IRP_DUPLICATE_CODE,
        ErrorMessage: `Duplicate IRN. IRN for the given document number ${doc.No} is already generated.`,
        Irn: existing.ack.irn, AckNo: existing.ack.ackNumber, AckDt: existing.ack.ackDate,
        SignedQRCode: existing.ack.signedQrCode,
      };
    }

    const now = this.#now();
    const ackDate = `${String(now.getUTCDate()).padStart(2, "0")}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${now.getUTCFullYear()} ${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}:${String(now.getUTCSeconds()).padStart(2, "0")}`;
    const ack: IrpAcknowledgement = {
      irn,
      ackNumber: `1120${String(this.#sequence).padStart(8, "0")}`,
      ackDate,
      // Not a real signature. Long enough and opaque enough to be stored and shown as one.
      signedQrCode: `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(`${seller.Gstin}|${doc.No}|${irn.slice(0, 16)}`).toString("base64url")}.c2lnbmF0dXJl`,
      providerRequestId: "",
      receivedAt: now.toISOString(),
    };
    this.#registered.set(irn, { ack, cancelled: false });
    return { Irn: ack.irn, AckNo: ack.ackNumber, AckDt: ack.ackDate, SignedQRCode: ack.signedQrCode, Status: "ACT" };
  }

  #fetch(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const found = this.#registered.get(String(payload.Irn ?? ""));
    if (found === undefined) return { ErrorCode: "2283", ErrorMessage: "IRN not found." };
    return {
      Irn: found.ack.irn, AckNo: found.ack.ackNumber, AckDt: found.ack.ackDate,
      SignedQRCode: found.ack.signedQrCode, Status: found.cancelled ? "CNL" : "ACT",
    };
  }

  #cancel(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const irn = String(payload.Irn ?? "");
    const found = this.#registered.get(irn);
    if (found === undefined) return { ErrorCode: "2283", ErrorMessage: "IRN not found." };
    if (found.cancelled) return { ErrorCode: "9999", ErrorMessage: "This IRN is already cancelled." };
    // The real window, enforced the real way: the government simply refuses after 24 hours.
    const acknowledged = readAckDate(found.ack.ackDate).getTime();
    if (this.#now().getTime() - acknowledged > 24 * 3_600_000) {
      return { ErrorCode: IRP_CANCEL_WINDOW_CODE, ErrorMessage: "The time limit for cancelling this IRN has passed." };
    }
    this.#registered.set(irn, { ...found, cancelled: true });
    return { Irn: irn, CancelDate: this.#now().toISOString() };
  }
}

// --------------------------------------------------------------------------- storage

export class InMemoryEInvoiceStore implements EInvoiceRepository, TransactionParticipant {
  #rows: EInvoiceRecord[] = [];

  snapshot(): unknown { return [...this.#rows]; }
  restore(taken: unknown): void { this.#rows = [...(taken as EInvoiceRecord[])]; }

  async insert(record: EInvoiceRecord): Promise<void> { this.#rows.push(Object.freeze(record)); }

  async update(record: EInvoiceRecord): Promise<void> {
    const index = this.#rows.findIndex((row) => row.companyId === record.companyId && row.id === record.id);
    if (index >= 0) this.#rows[index] = Object.freeze(record);
  }

  async findById(companyId: CompanyId, id: Id): Promise<EInvoiceRecord | null> {
    return this.#rows.find((row) => row.companyId === companyId && row.id === id) ?? null;
  }

  async findByDocumentId(companyId: CompanyId, documentId: Id): Promise<EInvoiceRecord | null> {
    return this.#rows.find((row) => row.companyId === companyId && row.documentId === documentId) ?? null;
  }

  async findByIrn(companyId: CompanyId, irn: string): Promise<EInvoiceRecord | null> {
    return this.#rows.find((row) => row.companyId === companyId && row.acknowledgement?.irn === irn) ?? null;
  }

  async list(companyId: CompanyId): Promise<EInvoiceRecord[]> {
    return this.#rows.filter((row) => row.companyId === companyId);
  }

  async listCancellable(companyId: CompanyId, now: string): Promise<EInvoiceRecord[]> {
    return this.#rows.filter((row) => row.companyId === companyId && row.status === "REGISTERED"
      && row.cancellableUntil !== undefined && row.cancellableUntil > now);
  }

  async listPendingReport(companyId: CompanyId, on: IsoDate): Promise<EInvoiceRecord[]> {
    return this.#rows.filter((row) => row.companyId === companyId
      && (row.status === "PENDING" || row.status === "FAILED")
      && row.applicability.outcome === "APPLICABLE"
      && (row.reportableUntil === undefined || row.reportableUntil >= on));
  }
}

/** Effective-dated policies, newest first, as every other policy in this product is held. */
export class InMemoryEInvoicePolicies implements EInvoicePolicyPort {
  readonly #byCompany = new Map<string, EInvoicePolicy[]>();

  set(companyId: CompanyId, policy: EInvoicePolicy): void {
    const merged = [...(this.#byCompany.get(companyId) ?? []).filter((candidate) => candidate.effectiveFrom !== policy.effectiveFrom), policy];
    merged.sort((left, right) => (left.effectiveFrom < right.effectiveFrom ? 1 : -1));
    this.#byCompany.set(companyId, merged);
  }

  async policyFor(companyId: CompanyId, on: IsoDate): Promise<EInvoicePolicy> {
    return (this.#byCompany.get(companyId) ?? []).find((policy) => policy.effectiveFrom <= on) ?? DEFAULT_EINVOICE_POLICY;
  }
}

/** A credential vault for development: opaque references, never a secret. */
export class SyntheticIrpVault {
  async credentialReference(tenantId: string, connector: string): Promise<string> {
    return `vault://${connector}/${tenantId}`;
  }
}

export { financialYearOf };
