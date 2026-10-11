/**
 * Issue #366 — the purchase comparison's storage in PostgreSQL, beside the in-memory stores in
 * `adapters.ts` and behaving the same (`test/itc-repository-contract.ts` runs one suite on both).
 *
 * Unit of work v1: every write goes through `requireUnitOfWork(companyId).sql`, so it is saved
 * with the rest of the action or not at all, and throws `NO_UNIT_OF_WORK` when there is none.
 * Reads use `tenantTransaction`. Nothing here opens a transaction of its own.
 *
 * `itc_import_batches`, `itc_decisions` and `itc_claims` are frozen by #368: rows are only ever
 * added. `itc_portal_documents` is the one table that is updated, because a second reading of the
 * same statement replaces the first (see `PortalRecordRepository.put`). Nothing is ever deleted.
 *
 * Lists come back in the order the rows were written (`seq`), which is the order the in-memory
 * stores keep and the order the service's "newest answer wins" relies on.
 */
import { conflict, money, type CompanyId, type IsoDate, type UserId } from '@invoice/kernel';
import type { SqlExecutor, TransactionalExecutor } from '../../platform/src/database.ts';
import { normaliseNumber } from './match.ts';
import type { ImportBatchRepository, ItcClaimRepository, ItcDecisionRepository, Page, PortalRecordRepository } from './ports.ts';
import type { ImportBatch, ItcClaim, ItcDecision, PortalDocument, TaxPeriod } from './types.ts';

type Row = Record<string, unknown>;

const paise = (value: unknown) => money(BigInt(String(value)));
const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PostgreSQL's "this already exists" becomes the same refusal the in-memory store gives. */
const duplicateAs = async <T>(code: string, message: string, work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw conflict(code, message);
    throw error;
  }
};

/**
 * One list query: this company's rows that match, in the order they were written, a page at a time.
 * `where` uses $1 for the company and $2 onwards for `values`.
 */
const listRows = async (
  sql: SqlExecutor,
  table: string,
  columns: string,
  companyId: CompanyId,
  where: string,
  values: readonly unknown[],
  page?: Page,
): Promise<Row[]> => {
  const params: unknown[] = [companyId, ...values];
  let paging = '';
  if (page !== undefined) {
    // A cursor that is not one of this company's rows means "from the start", as in the in-memory
    // stores. One that could not be an id of a uuid table is never sent, so it is not a database error.
    if (page.after !== undefined && (table === 'itc_portal_documents' || UUID.test(page.after))) {
      params.push(page.after);
      paging += ` AND seq > COALESCE((SELECT seq FROM ${table} WHERE company_id = $1 AND id = $${params.length}), 0)`;
    }
    params.push(page.limit);
    paging += ` ORDER BY seq LIMIT $${params.length}`;
  } else {
    paging = ' ORDER BY seq';
  }
  return (await sql.query(`SELECT ${columns} FROM ${table} WHERE company_id = $1 AND ${where}${paging}`, params)).rows;
};

// ---------------------------------------------------------------------------- portal rows

const DOCUMENT_COLUMNS = `id, company_id, period, supplier_gstin, supplier_name, kind, document_number,
  document_date::text AS document_date, taxable_value_paise, cgst_paise, sgst_paise, igst_paise, cess_paise,
  invoice_value_paise, itc_available, itc_unavailable_reason, amends_number, amends_period, reversed,
  reverse_charge, source, batch_id, observed_at`;

const toDocument = (r: Row): PortalDocument => ({
  id: String(r.id),
  companyId: r.company_id as CompanyId,
  period: r.period as TaxPeriod,
  supplierGstin: String(r.supplier_gstin),
  supplierName: text(r.supplier_name),
  kind: r.kind as PortalDocument['kind'],
  number: String(r.document_number),
  documentDate: r.document_date as IsoDate,
  amounts: {
    taxableValue: paise(r.taxable_value_paise),
    cgst: paise(r.cgst_paise),
    sgst: paise(r.sgst_paise),
    igst: paise(r.igst_paise),
    cess: paise(r.cess_paise),
  },
  invoiceValue: paise(r.invoice_value_paise),
  itcAvailableOnPortal: r.itc_available === null || r.itc_available === undefined ? null : Boolean(r.itc_available),
  itcUnavailableReason: text(r.itc_unavailable_reason),
  amends: r.amends_number === null || r.amends_number === undefined
    ? null
    : { number: String(r.amends_number), period: r.amends_period as TaxPeriod },
  reversed: Boolean(r.reversed),
  reverseCharge: Boolean(r.reverse_charge),
  source: r.source as PortalDocument['source'],
  batchId: String(r.batch_id),
  observedAt: iso(r.observed_at),
});

/** The part of a held row `put` compares to tell "unchanged" from "replaced", exactly as the in-memory store does. */
const comparable = (taxable: bigint, date: string, itc: boolean | null, reversed: boolean): string =>
  `${taxable}|${date}|${itc}|${reversed}`;

export class PostgresPortalRecords implements PortalRecordRepository {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) { this.#db = db; }

  async listForPeriod(companyId: CompanyId, period: TaxPeriod, page?: Page): Promise<readonly PortalDocument[]> {
    return this.#db.tenantTransaction(companyId, async (sql) =>
      (await listRows(sql, 'itc_portal_documents', DOCUMENT_COLUMNS, companyId, 'period = $2', [period], page)).map(toDocument));
  }

  async listThroughPeriod(companyId: CompanyId, period: TaxPeriod, page?: Page): Promise<readonly PortalDocument[]> {
    return this.#db.tenantTransaction(companyId, async (sql) =>
      (await listRows(sql, 'itc_portal_documents', DOCUMENT_COLUMNS, companyId, 'period <= $2', [period], page)).map(toDocument));
  }

  async findByDocument(
    companyId: CompanyId,
    input: { readonly supplierGstin: string; readonly invoiceNumber: string },
  ): Promise<PortalDocument | null> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const found = await sql.query(
        `SELECT ${DOCUMENT_COLUMNS} FROM itc_portal_documents
          WHERE company_id = $1 AND supplier_gstin = $2 AND normalised_number = $3 ORDER BY seq LIMIT 1`,
        [companyId, input.supplierGstin.toUpperCase(), normaliseNumber(input.invoiceNumber)],
      );
      return found.rows[0] === undefined ? null : toDocument(found.rows[0]);
    });
  }

  async put(
    companyId: CompanyId,
    period: TaxPeriod,
    records: readonly PortalDocument[],
  ): Promise<{ added: number; replaced: number; unchanged: number }> {
    const sql = this.#db.requireUnitOfWork(companyId).sql;
    let added = 0;
    let replaced = 0;
    let unchanged = 0;
    if (records.length === 0) return { added, replaced, unchanged };

    const keyOf = (gstin: string, normalised: string, kind: string): string => `${gstin.toUpperCase()}|${normalised}|${kind}`;
    // One read of what is already held for these suppliers this month, then one write. The unit of
    // work holds the company's lock, so nothing changes between the two.
    const held = new Map<string, string>();
    const before = await sql.query(
      `SELECT supplier_gstin, normalised_number, kind, taxable_value_paise, document_date::text AS document_date, itc_available, reversed
         FROM itc_portal_documents WHERE company_id = $1 AND period = $2 AND supplier_gstin = ANY($3::text[])`,
      [companyId, period, [...new Set(records.map((record) => record.supplierGstin.toUpperCase()))]],
    );
    for (const r of before.rows) {
      held.set(
        keyOf(String(r.supplier_gstin), String(r.normalised_number), String(r.kind)),
        comparable(BigInt(String(r.taxable_value_paise)), String(r.document_date), r.itc_available === null ? null : Boolean(r.itc_available), Boolean(r.reversed)),
      );
    }

    // A file may carry the same document twice. Each is counted as the in-memory store counts it,
    // and the last one is the row that is kept, in the place of the first.
    const toWrite = new Map<string, Record<string, unknown>>();
    for (const record of records) {
      const normalised = normaliseNumber(record.number);
      const key = keyOf(record.supplierGstin, normalised, record.kind);
      const now = comparable(record.amounts.taxableValue.minor, record.documentDate, record.itcAvailableOnPortal, record.reversed);
      const was = held.get(key);
      if (was === undefined) added += 1;
      else if (was === now) unchanged += 1;
      else replaced += 1;
      held.set(key, now);
      toWrite.set(key, {
        id: record.id,
        supplier_gstin: record.supplierGstin,
        supplier_name: record.supplierName,
        kind: record.kind,
        document_number: record.number,
        normalised_number: normalised,
        document_date: record.documentDate,
        // Paise travel as strings: a JSON number would lose anything above 2^53.
        taxable_value_paise: record.amounts.taxableValue.minor.toString(),
        cgst_paise: record.amounts.cgst.minor.toString(),
        sgst_paise: record.amounts.sgst.minor.toString(),
        igst_paise: record.amounts.igst.minor.toString(),
        cess_paise: record.amounts.cess.minor.toString(),
        invoice_value_paise: record.invoiceValue.minor.toString(),
        itc_available: record.itcAvailableOnPortal,
        itc_unavailable_reason: record.itcUnavailableReason,
        amends_number: record.amends?.number ?? null,
        amends_period: record.amends?.period ?? null,
        reversed: record.reversed,
        reverse_charge: record.reverseCharge,
        source: record.source,
        batch_id: record.batchId,
        observed_at: record.observedAt,
      });
    }
    const rows = [...toWrite.values()].map((row, ord) => ({ ...row, ord }));

    await duplicateAs('ITC_PORTAL_RECORD_DUPLICATE', 'This purchase from the government record has already been saved.', () => sql.query(
      `INSERT INTO itc_portal_documents (id, company_id, period, supplier_gstin, supplier_name, kind, document_number,
         normalised_number, document_date, taxable_value_paise, cgst_paise, sgst_paise, igst_paise, cess_paise,
         invoice_value_paise, itc_available, itc_unavailable_reason, amends_number, amends_period, reversed,
         reverse_charge, source, batch_id, observed_at)
       SELECT x.id, $1, $2, x.supplier_gstin, x.supplier_name, x.kind, x.document_number, x.normalised_number,
              x.document_date, x.taxable_value_paise, x.cgst_paise, x.sgst_paise, x.igst_paise, x.cess_paise,
              x.invoice_value_paise, x.itc_available, x.itc_unavailable_reason, x.amends_number, x.amends_period,
              x.reversed, x.reverse_charge, x.source, x.batch_id, x.observed_at
         FROM jsonb_to_recordset($3::jsonb) AS x(ord integer, id text, supplier_gstin text, supplier_name text, kind text,
              document_number text, normalised_number text, document_date date, taxable_value_paise bigint,
              cgst_paise bigint, sgst_paise bigint, igst_paise bigint, cess_paise bigint, invoice_value_paise bigint,
              itc_available boolean, itc_unavailable_reason text, amends_number text, amends_period text,
              reversed boolean, reverse_charge boolean, source text, batch_id uuid, observed_at timestamptz)
        ORDER BY x.ord
       ON CONFLICT (company_id, period, supplier_gstin, normalised_number, kind) DO UPDATE SET
         id = EXCLUDED.id, supplier_name = EXCLUDED.supplier_name, document_number = EXCLUDED.document_number,
         document_date = EXCLUDED.document_date, taxable_value_paise = EXCLUDED.taxable_value_paise,
         cgst_paise = EXCLUDED.cgst_paise, sgst_paise = EXCLUDED.sgst_paise, igst_paise = EXCLUDED.igst_paise,
         cess_paise = EXCLUDED.cess_paise, invoice_value_paise = EXCLUDED.invoice_value_paise,
         itc_available = EXCLUDED.itc_available, itc_unavailable_reason = EXCLUDED.itc_unavailable_reason,
         amends_number = EXCLUDED.amends_number, amends_period = EXCLUDED.amends_period, reversed = EXCLUDED.reversed,
         reverse_charge = EXCLUDED.reverse_charge, source = EXCLUDED.source, batch_id = EXCLUDED.batch_id,
         observed_at = EXCLUDED.observed_at
       WHERE itc_portal_documents.company_id = $1`,
      [companyId, period, JSON.stringify(rows)],
    ));
    return { added, replaced, unchanged };
  }
}

// ---------------------------------------------------------------------------- import batches

const BATCH_COLUMNS = `id, company_id, period, source, file_name, checksum, imported_by, imported_at, document_count,
  added_count, replaced_count, unchanged_count, rejected, sentence`;

const toBatch = (r: Row): ImportBatch => ({
  id: String(r.id),
  companyId: r.company_id as CompanyId,
  period: r.period as TaxPeriod,
  source: r.source as ImportBatch['source'],
  fileName: text(r.file_name),
  checksum: String(r.checksum),
  importedBy: r.imported_by as UserId,
  importedAt: iso(r.imported_at),
  documentCount: Number(r.document_count),
  addedCount: Number(r.added_count),
  replacedCount: Number(r.replaced_count),
  unchangedCount: Number(r.unchanged_count),
  rejected: r.rejected as ImportBatch['rejected'],
  sentence: r.sentence as ImportBatch['sentence'],
});

export class PostgresImportBatches implements ImportBatchRepository {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) { this.#db = db; }

  async insert(batch: ImportBatch): Promise<void> {
    const sql = this.#db.requireUnitOfWork(batch.companyId).sql;
    await duplicateAs('ITC_IMPORT_DUPLICATE', 'This file has already been imported for this month.', () => sql.query(
      `INSERT INTO itc_import_batches (id, company_id, period, source, file_name, checksum, imported_by, imported_at,
         document_count, added_count, replaced_count, unchanged_count, rejected, sentence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb)`,
      [batch.id, batch.companyId, batch.period, batch.source, batch.fileName, batch.checksum, batch.importedBy,
        batch.importedAt, batch.documentCount, batch.addedCount, batch.replacedCount, batch.unchangedCount,
        JSON.stringify(batch.rejected), JSON.stringify(batch.sentence)],
    ));
  }

  async findByChecksum(companyId: CompanyId, period: TaxPeriod, checksum: string): Promise<ImportBatch | null> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const found = await sql.query(
        `SELECT ${BATCH_COLUMNS} FROM itc_import_batches WHERE company_id = $1 AND period = $2 AND checksum = $3`,
        [companyId, period, checksum],
      );
      return found.rows[0] === undefined ? null : toBatch(found.rows[0]);
    });
  }

  async latestFor(companyId: CompanyId, period: TaxPeriod): Promise<ImportBatch | null> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const found = await sql.query(
        `SELECT ${BATCH_COLUMNS} FROM itc_import_batches WHERE company_id = $1 AND period = $2 ORDER BY seq DESC LIMIT 1`,
        [companyId, period],
      );
      return found.rows[0] === undefined ? null : toBatch(found.rows[0]);
    });
  }

  async list(companyId: CompanyId, period: TaxPeriod, page?: Page): Promise<readonly ImportBatch[]> {
    return this.#db.tenantTransaction(companyId, async (sql) =>
      (await listRows(sql, 'itc_import_batches', BATCH_COLUMNS, companyId, 'period = $2', [period], page)).map(toBatch));
  }
}

// ---------------------------------------------------------------------------- decisions

const DECISION_COLUMNS = 'id, company_id, period, line_key, kind, reason, decided_by, decided_at, fingerprint, idempotency_key';

const toDecision = (r: Row): ItcDecision => ({
  id: String(r.id),
  companyId: r.company_id as CompanyId,
  period: r.period as TaxPeriod,
  lineKey: String(r.line_key),
  kind: r.kind as ItcDecision['kind'],
  reason: String(r.reason),
  decidedBy: r.decided_by as UserId,
  decidedAt: iso(r.decided_at),
  fingerprint: String(r.fingerprint),
  idempotencyKey: String(r.idempotency_key),
});

export class PostgresItcDecisions implements ItcDecisionRepository {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) { this.#db = db; }

  async insert(decision: ItcDecision): Promise<void> {
    const sql = this.#db.requireUnitOfWork(decision.companyId).sql;
    await duplicateAs('ITC_DECISION_DUPLICATE', 'This answer has already been recorded.', () => sql.query(
      `INSERT INTO itc_decisions (id, company_id, period, line_key, kind, reason, decided_by, decided_at, fingerprint, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [decision.id, decision.companyId, decision.period, decision.lineKey, decision.kind, decision.reason,
        decision.decidedBy, decision.decidedAt, decision.fingerprint, decision.idempotencyKey],
    ));
  }

  /** Every decision of the period, oldest first; the service keeps the newest per line. */
  async latestForPeriod(companyId: CompanyId, period: TaxPeriod, page?: Page): Promise<readonly ItcDecision[]> {
    return this.#db.tenantTransaction(companyId, async (sql) =>
      (await listRows(sql, 'itc_decisions', DECISION_COLUMNS, companyId, 'period = $2', [period], page)).map(toDecision));
  }

  async findByIdempotencyKey(companyId: CompanyId, key: string): Promise<ItcDecision | null> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const found = await sql.query(
        `SELECT ${DECISION_COLUMNS} FROM itc_decisions WHERE company_id = $1 AND idempotency_key = $2`,
        [companyId, key],
      );
      return found.rows[0] === undefined ? null : toDecision(found.rows[0]);
    });
  }

  async history(companyId: CompanyId, lineKey: string, page?: Page): Promise<readonly ItcDecision[]> {
    return this.#db.tenantTransaction(companyId, async (sql) =>
      (await listRows(sql, 'itc_decisions', DECISION_COLUMNS, companyId, 'line_key = $2', [lineKey], page)).map(toDecision));
  }
}

// ---------------------------------------------------------------------------- claims

const CLAIM_COLUMNS = 'id, company_id, source_kind, source_id, period, outcome, line_key, fingerprint, claimed_by, claimed_at';

const toClaim = (r: Row): ItcClaim => ({
  id: String(r.id),
  companyId: r.company_id as CompanyId,
  sourceKind: String(r.source_kind),
  sourceId: String(r.source_id),
  period: r.period as TaxPeriod,
  outcome: r.outcome as ItcClaim['outcome'],
  lineKey: String(r.line_key),
  fingerprint: String(r.fingerprint),
  claimedBy: r.claimed_by as UserId,
  claimedAt: iso(r.claimed_at),
});

export class PostgresItcClaims implements ItcClaimRepository {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) { this.#db = db; }

  /**
   * One claim per purchase document. A second claim for the same document is not an error: the
   * first is handed back, as the in-memory store does. `ON CONFLICT … DO NOTHING` names the one
   * rule that means "already claimed"; any other database refusal is still raised.
   */
  async insert(claim: ItcClaim): Promise<{ claim: ItcClaim; inserted: boolean }> {
    const sql = this.#db.requireUnitOfWork(claim.companyId).sql;
    const written = await duplicateAs('ITC_CLAIM_DUPLICATE', 'This credit has already been recorded.', () => sql.query(
      `INSERT INTO itc_claims (id, company_id, source_kind, source_id, period, outcome, line_key, fingerprint, claimed_by, claimed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (company_id, source_kind, source_id) DO NOTHING RETURNING id`,
      [claim.id, claim.companyId, claim.sourceKind, claim.sourceId, claim.period, claim.outcome, claim.lineKey,
        claim.fingerprint, claim.claimedBy, claim.claimedAt],
    ));
    if (written.rows.length === 1) return { claim, inserted: true };
    const existing = await sql.query(
      `SELECT ${CLAIM_COLUMNS} FROM itc_claims WHERE company_id = $1 AND source_kind = $2 AND source_id = $3`,
      [claim.companyId, claim.sourceKind, claim.sourceId],
    );
    return { claim: toClaim(existing.rows[0] as Row), inserted: false };
  }

  async listForCompany(companyId: CompanyId, page?: Page): Promise<readonly ItcClaim[]> {
    return this.#db.tenantTransaction(companyId, async (sql) =>
      (await listRows(sql, 'itc_claims', CLAIM_COLUMNS, companyId, 'true', [], page)).map(toClaim));
  }
}
