// Issue #366 — e-invoices and their policies in PostgreSQL (`e_invoices`, `e_invoice_policies`).
//
// Built on the platform's transaction executor (unit-of-work-v1). Every write joins the action's
// open unit of work and throws `NO_UNIT_OF_WORK` without one; every read runs under the company's
// row-level security and names `company_id` itself as well. Nothing here opens a transaction.
//
// `e_invoices` is frozen by the database once REGISTERED or CANCELLED (database-immutability-v1).
// `update` saves the whole record, as the in-memory store does; the freeze compares by value, so
// that is fine as long as the IRN, the acknowledgement and the document particulars are unchanged.

import { conflict, type CompanyId } from "@invoice/kernel";
import type { SqlExecutor, TransactionalExecutor } from "../../platform/src/database.ts";
import type { Id, IsoDate } from "../../masters/src/types.ts";
import { duplicateEInvoice } from "./einvoice-adapters.ts";
import { readAckDate } from "./irn.ts";
import { DEFAULT_EINVOICE_POLICY } from "./einvoice-types.ts";
import type { ApplicabilityDecision, EInvoicePolicy, EInvoiceRecord } from "./einvoice-types.ts";
import type { EInvoicePage, EInvoicePolicyPort, EInvoiceRepository } from "./einvoice-ports.ts";

type Row = Record<string, unknown>;

/** In the order `values()` gives them. `id` and `company_id` first: they are the key, never updated. */
const WRITTEN = [
  "id", "company_id", "document_id", "document_number", "document_date", "document_type", "supplier_gstin", "recipient_gstin",
  "financial_year", "status", "applicability", "irn", "ack_number", "ack_date", "signed_qr_code", "signed_invoice",
  "eway_bill_number", "provider_request_id", "acknowledged_at", "failure_code", "failure_message", "failure_retryable",
  "cancellable_until", "reportable_until", "cancelled_at", "cancel_reason_code", "cancel_reason", "message", "created_by",
  "created_at", "updated_at", "idempotency_key",
] as const;
const DATES = new Set<string>(["document_date", "reportable_until"]);
/** `date` columns are read as text: node-postgres would otherwise make a local-time `Date` of them. */
const COLUMNS = WRITTEN.map((name) => (DATES.has(name) ? `${name}::text AS ${name}` : name)).join(", ");
const placeholder = (name: string, index: number): string => `$${index + 1}${name === "applicability" ? "::jsonb" : ""}`;

// The threshold inside the decision is bigint paise; JSON has no bigint, so it is tagged and restored exactly.
const encode = (decision: ApplicabilityDecision): string =>
  JSON.stringify(decision, (_key, value: unknown) => (typeof value === "bigint" ? { $bigint: value.toString() } : value));
const decode = (stored: unknown): ApplicabilityDecision =>
  JSON.parse(JSON.stringify(stored), (_key, value: unknown) =>
    (value !== null && typeof value === "object" && "$bigint" in value ? BigInt((value as { $bigint: string }).$bigint) : value)) as ApplicabilityDecision;

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
const has = (value: unknown): boolean => value !== null && value !== undefined;

/**
 * The portal writes a cancellation time as Indian wall-clock time with no zone; the column is a
 * `timestamptz`, which would read that in the server's zone (5½ hours out, the mistake of #283).
 * So it is read the way the acknowledgement date is, and the instant is what is kept.
 */
const instant = (raw: string): string => {
  const at = readAckDate(raw);
  return Number.isNaN(at.getTime()) ? raw : at.toISOString();
};

const values = (record: EInvoiceRecord): unknown[] => {
  const ack = record.acknowledgement;
  return [
    record.id, record.companyId, record.documentId, record.documentNumber, record.documentDate, record.documentType,
    record.supplierGstin, record.recipientGstin ?? null, record.financialYear, record.status, encode(record.applicability),
    ack?.irn ?? null, ack?.ackNumber ?? null, ack?.ackDate ?? null, ack?.signedQrCode ?? null, ack?.signedInvoice ?? null,
    ack?.ewayBillNumber ?? null, ack?.providerRequestId ?? null, ack?.receivedAt ?? null,
    record.failure?.code ?? null, record.failure?.message ?? null, record.failure?.retryable ?? null,
    record.cancellableUntil ?? null, record.reportableUntil ?? null,
    record.cancelledAt === undefined ? null : instant(record.cancelledAt), record.cancelReasonCode ?? null, record.cancelReason ?? null,
    record.message, record.createdBy, record.createdAt, record.updatedAt, record.idempotencyKey,
  ];
};

const toRecord = (r: Row): EInvoiceRecord => ({
  id: String(r.id),
  companyId: String(r.company_id),
  documentId: String(r.document_id),
  documentNumber: String(r.document_number),
  documentDate: String(r.document_date) as IsoDate,
  documentType: r.document_type as EInvoiceRecord["documentType"],
  supplierGstin: String(r.supplier_gstin),
  ...(has(r.recipient_gstin) ? { recipientGstin: String(r.recipient_gstin) } : {}),
  financialYear: String(r.financial_year),
  status: r.status as EInvoiceRecord["status"],
  applicability: decode(r.applicability),
  ...(has(r.irn) ? {
    acknowledgement: {
      irn: String(r.irn), ackNumber: String(r.ack_number ?? ""), ackDate: String(r.ack_date ?? ""),
      signedQrCode: String(r.signed_qr_code ?? ""),
      ...(has(r.signed_invoice) ? { signedInvoice: String(r.signed_invoice) } : {}),
      ...(has(r.eway_bill_number) ? { ewayBillNumber: String(r.eway_bill_number) } : {}),
      providerRequestId: String(r.provider_request_id ?? ""), receivedAt: has(r.acknowledged_at) ? iso(r.acknowledged_at) : "",
    },
  } : {}),
  message: String(r.message),
  ...(has(r.failure_code) ? { failure: { code: String(r.failure_code), message: String(r.failure_message ?? ""), retryable: r.failure_retryable === true } } : {}),
  ...(has(r.cancelled_at) ? { cancelledAt: iso(r.cancelled_at) } : {}),
  ...(has(r.cancel_reason_code) ? { cancelReasonCode: r.cancel_reason_code as NonNullable<EInvoiceRecord["cancelReasonCode"]> } : {}),
  ...(has(r.cancel_reason) ? { cancelReason: String(r.cancel_reason) } : {}),
  ...(has(r.cancellable_until) ? { cancellableUntil: iso(r.cancellable_until) } : {}),
  ...(has(r.reportable_until) ? { reportableUntil: String(r.reportable_until) as IsoDate } : {}),
  createdBy: String(r.created_by),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  idempotencyKey: String(r.idempotency_key),
});

/** The database's refusals, as the errors the rest of the module already speaks. Anything else is rethrown as it came. */
const translate = (error: unknown): unknown => {
  const code = (error as { code?: string }).code;
  // e_invoices_pkey, e_invoices_one_per_document_idx, e_invoices_irn_idx.
  if (code === "23505") return duplicateEInvoice();
  // platform_freeze_posted (#368): a registered or cancelled e-invoice keeps its number and particulars.
  if (code === "23001") {
    return conflict("EINVOICE_FROZEN", "This e-invoice is already on the government's record, so its number and details cannot be changed. To undo it, cancel it in time or raise a credit note.");
  }
  return error;
};

export class PostgresEInvoiceRepository implements EInvoiceRepository {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) { this.#db = db; }

  async insert(record: EInvoiceRecord): Promise<void> {
    const sql = this.#db.requireUnitOfWork(record.companyId).sql;
    try {
      await sql.query(`INSERT INTO e_invoices (${WRITTEN.join(", ")}) VALUES (${WRITTEN.map(placeholder).join(", ")})`, values(record));
    } catch (error) { throw translate(error); }
  }

  /** Like the in-memory store, a record that is not this company's (or not there) is left alone. */
  async update(record: EInvoiceRecord): Promise<void> {
    const sql = this.#db.requireUnitOfWork(record.companyId).sql;
    try {
      await sql.query(
        `UPDATE e_invoices SET ${WRITTEN.map((name, index) => (index < 2 ? "" : `${name} = ${placeholder(name, index)}`)).filter(Boolean).join(", ")}
          WHERE company_id = $2 AND id = $1`,
        values(record),
      );
    } catch (error) { throw translate(error); }
  }

  async findById(companyId: CompanyId, id: Id): Promise<EInvoiceRecord | null> {
    return (await this.#select(companyId, "id = $2", [id]))[0] ?? null;
  }

  async findByDocumentId(companyId: CompanyId, documentId: Id): Promise<EInvoiceRecord | null> {
    return (await this.#select(companyId, "document_id = $2", [documentId]))[0] ?? null;
  }

  async findByIrn(companyId: CompanyId, irn: string): Promise<EInvoiceRecord | null> {
    return (await this.#select(companyId, "irn = $2", [irn]))[0] ?? null;
  }

  list(companyId: CompanyId, page?: EInvoicePage): Promise<EInvoiceRecord[]> {
    return this.#select(companyId, "true", [], page);
  }

  // e_invoices_cancellable_idx
  listCancellable(companyId: CompanyId, now: string, page?: EInvoicePage): Promise<EInvoiceRecord[]> {
    return this.#select(companyId, "status = 'REGISTERED' AND cancellable_until > $2::timestamptz", [now], page);
  }

  // e_invoices_awaiting_idx
  listPendingReport(companyId: CompanyId, on: IsoDate, page?: EInvoicePage): Promise<EInvoiceRecord[]> {
    return this.#select(
      companyId,
      "status IN ('PENDING','FAILED') AND applicability->>'outcome' = 'APPLICABLE' AND (reportable_until IS NULL OR reportable_until >= $2::date)",
      [on], page,
    );
  }

  /** Oldest first, the id breaking a tie (e_invoices_listing_idx); a page starts after the row whose id it names. */
  #select(companyId: CompanyId, where: string, params: readonly unknown[], page?: EInvoicePage): Promise<EInvoiceRecord[]> {
    const args: unknown[] = [companyId, ...params];
    let paging = "";
    if (page !== undefined) {
      if (page.after !== undefined) {
        args.push(page.after);
        paging += ` AND (created_at, id) > (SELECT created_at, id FROM e_invoices WHERE company_id = $1 AND id = $${args.length})`;
      }
      args.push(page.limit);
    }
    return this.#db.tenantTransaction(companyId, async (sql: SqlExecutor) => (await sql.query(
      `SELECT ${COLUMNS} FROM e_invoices WHERE company_id = $1 AND ${where}${paging} ORDER BY created_at, id${page === undefined ? "" : ` LIMIT $${args.length}`}`,
      args,
    )).rows.map(toRecord));
  }
}

/** Effective-dated policies per company; the newest one in force on the day answers. */
export class PostgresEInvoicePolicies implements EInvoicePolicyPort {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) { this.#db = db; }

  /** Setting a policy for a day that already has one replaces it, as the in-memory store does. `setBy` is who decided. */
  async set(companyId: CompanyId, policy: EInvoicePolicy, setBy: Id): Promise<void> {
    await this.#db.requireUnitOfWork(companyId).sql.query(
      `INSERT INTO e_invoice_policies (company_id, effective_from, cancellation_window_hours, verify_irn_hash, set_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id, effective_from) DO UPDATE
         SET cancellation_window_hours = EXCLUDED.cancellation_window_hours, verify_irn_hash = EXCLUDED.verify_irn_hash,
             set_by = EXCLUDED.set_by, set_at = now()`,
      [companyId, policy.effectiveFrom, policy.cancellationWindowHours, policy.verifyIrnHash, setBy],
    );
  }

  async policyFor(companyId: CompanyId, on: IsoDate): Promise<EInvoicePolicy> {
    const row = await this.#db.tenantTransaction(companyId, async (sql) => (await sql.query(
      `SELECT cancellation_window_hours, verify_irn_hash, effective_from::text AS effective_from FROM e_invoice_policies
        WHERE company_id = $1 AND effective_from <= $2::date ORDER BY effective_from DESC LIMIT 1`,
      [companyId, on],
    )).rows[0]);
    return row === undefined ? DEFAULT_EINVOICE_POLICY : {
      cancellationWindowHours: Number(row.cancellation_window_hours),
      verifyIrnHash: row.verify_irn_hash === true,
      effectiveFrom: String(row.effective_from) as IsoDate,
    };
  }
}
