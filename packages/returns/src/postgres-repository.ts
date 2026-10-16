/**
 * Issue #201 — return notes in PostgreSQL (`return_notes`, `return_note_lines`).
 *
 * Writes join the caller's unit of work (`PostgresLedgerStore.writeSql`, which throws
 * `NO_UNIT_OF_WORK` when none is open), so a note, its number and the voucher it posts are saved
 * together or not at all — the database's version of what `InMemoryReturnNoteRepository` does by
 * joining the in-memory store. Reads run in `withSql` (`tenantTransaction`). Every query also names
 * `company_id`, so row-level security is a second wall, not the only one.
 */
import { conflict, invalid, money, notFound, type CompanyId, type IsoDate, type Money } from '@invoice/kernel';
import type { PostgresLedgerStore, Sql } from '@invoice/ledger';
import { isChargeLine, type ReturnNote, type ReturnNoteLine, type ReturnTaxAmounts, type SupplierCreditNoteRef } from './model.ts';
import type { Page, ReturnNoteRepository } from './ports.ts';
import { pageLimit } from './repository.ts';

type Row = Record<string, unknown>;
const AMOUNTS = ['taxable_value', 'cgst', 'sgst', 'utgst', 'igst', 'cess', 'ineligible_tax', 'reverse_charge_tax', 'total'] as const;
const KEYS: readonly (keyof ReturnTaxAmounts)[] = ['taxableValue', 'cgst', 'sgst', 'utgst', 'igst', 'cess', 'ineligibleTax', 'reverseChargeTax', 'total'];
const amountColumns = AMOUNTS.map((name) => `${name}_paise`).join(', ');
const amountValues = (amounts: ReturnTaxAmounts): string[] => KEYS.map((key) => amounts[key].minor.toString());
const amountsOf = (r: Row): ReturnTaxAmounts =>
  Object.fromEntries(KEYS.map((key, i) => [key, money(BigInt(String(r[`${AMOUNTS[i]}_paise`])))])) as unknown as ReturnTaxAmounts;
const placeholders = (from: number, count: number): string => Array.from({ length: count }, (_, i) => `$${from + i}`).join(', ');

const NOTE_COLUMNS = `id, company_id, kind, number, document_date::text AS document_date, original_document_id, original_document_number,
  original_document_date::text AS original_document_date, party_id, reason, ${amountColumns}, voucher_id, compliance_status,
  created_by, created_at, idempotency_key, summary, supplier_credit_note_number,
  supplier_credit_note_date::text AS supplier_credit_note_date`;
const LINE_COLUMNS = `return_note_id, original_line_id, item_id, charge_kind, description, supply_kind, quantity_micro, quantity_unit,
  disposition, warehouse_id, batch_id, serial_numbers, replacement_serial_numbers, ${amountColumns}, hsn_or_sac,
  rate_percent_times100, unit_price_paise`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Issue #366 — a freight or other charge (`charge:<kind>`, gst-calc #205) is stored as its kind, not as an item. */
const CHARGE = /^charge:(.+)$/;

export class PostgresReturnNoteRepository implements ReturnNoteRepository {
  readonly #store: PostgresLedgerStore;

  constructor(store: PostgresLedgerStore) { this.#store = store; }

  async insert(note: ReturnNote): Promise<void> {
    // Issue #363 — saved in the transaction that posts the voucher, never in one of its own.
    const sql = this.#store.writeSql(note.companyId);
    try {
      await sql.query(
        `INSERT INTO return_notes (id, company_id, kind, number, document_date, original_document_id, original_document_number,
           original_document_date, party_id, reason, ${amountColumns}, voucher_id, compliance_status, created_by, created_at,
           idempotency_key, summary, supplier_credit_note_number, supplier_credit_note_date)
         VALUES (${placeholders(1, 27)})`,
        [note.id, note.companyId, note.kind, note.number, note.documentDate, note.originalDocument.id, note.originalDocument.number,
          note.originalDocument.date, note.partyId, note.reason, ...amountValues(note.totals), note.voucherId, note.complianceStatus,
          note.createdBy, note.createdAt, note.idempotencyKey, note.summary,
          note.supplierCreditNote?.number ?? null, note.supplierCreditNote?.date ?? null],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw conflict('RETURN_NOTE_DUPLICATE', 'This return note has already been recorded.');
      throw error;
    }
    for (const line of note.lines) {
      await sql.query(
        `INSERT INTO return_note_lines (return_note_id, company_id, original_line_id, item_id, description, supply_kind, quantity_micro,
           quantity_unit, disposition, warehouse_id, batch_id, serial_numbers, replacement_serial_numbers, ${amountColumns},
           hsn_or_sac, rate_percent_times100, unit_price_paise, charge_kind)
         VALUES (${placeholders(1, 26)})`,
        [note.id, note.companyId, line.originalLineId, isChargeLine(line) ? null : line.itemId, line.description, line.supplyKind, line.quantity.scaled.toString(),
          line.quantity.unit, line.disposition, line.warehouseId, line.batchId, JSON.stringify(line.serialNumbers),
          JSON.stringify(line.replacementSerialNumbers), ...amountValues(line.amounts), line.hsnOrSac,
          line.ratePercentTimes100?.toString() ?? null, line.unitPrice?.minor.toString() ?? null,
          CHARGE.exec(line.itemId)?.[1] ?? null],
      );
    }
  }

  async findById(companyId: CompanyId, id: string): Promise<ReturnNote | null> {
    return (await this.#select(companyId, 'id = $2', [id]))[0] ?? null;
  }

  async findByIdempotencyKey(companyId: CompanyId, key: string): Promise<ReturnNote | null> {
    return (await this.#select(companyId, 'idempotency_key = $2', [key]))[0] ?? null;
  }

  async listForOriginal(companyId: CompanyId, originalDocumentId: string, page?: Page): Promise<ReturnNote[]> {
    return this.#select(companyId, 'original_document_id = $2', [originalDocumentId], page);
  }

  async list(companyId: CompanyId, page?: Page): Promise<ReturnNote[]> {
    return this.#select(companyId, 'true', [], page);
  }

  async setSupplierCreditNote(companyId: CompanyId, id: string, reference: SupplierCreditNoteRef): Promise<ReturnNote> {
    // Issue #366 — a write, so it joins the caller's unit of work and never commits on its own.
    const updated = await this.#store.writeSql(companyId).query(
      `UPDATE return_notes SET supplier_credit_note_number = $3, supplier_credit_note_date = $4
        WHERE company_id = $1 AND id = $2 AND kind = 'PURCHASE_RETURN' RETURNING id`,
      [companyId, id, reference.number, reference.date],
    );
    if (updated.rows.length === 0) throw notFound('RETURN_NOTE_NOT_FOUND', 'We could not find that return in this business.');
    const note = await this.findById(companyId, id);
    if (note === null) throw notFound('RETURN_NOTE_NOT_FOUND', 'We could not find that return in this business.');
    return note;
  }

  async #select(companyId: CompanyId, where: string, values: unknown[], page?: Page): Promise<ReturnNote[]> {
    // Without a page, every note in the order this store has always used; with one, keyset on id.
    let tail = 'ORDER BY document_date, number';
    if (page !== undefined) {
      const limit = pageLimit(page);
      if (page.after !== undefined && !UUID.test(page.after)) throw invalid('RETURN_PAGE_AFTER_INVALID', 'That page of returns does not exist.');
      if (page.after !== undefined) {
        values = [...values, page.after];
        where = `${where} AND id > $${values.length + 1}::uuid`;
      }
      tail = `ORDER BY id LIMIT ${limit}`;
    }
    return this.#store.withSql(companyId, async (sql: Sql) => {
      const notes = await sql.query(
        `SELECT ${NOTE_COLUMNS} FROM return_notes WHERE company_id = $1 AND ${where} ${tail}`,
        [companyId, ...values],
      );
      if (notes.rows.length === 0) return [];
      const lines = await sql.query(
        `SELECT ${LINE_COLUMNS} FROM return_note_lines WHERE company_id = $1 AND return_note_id = ANY($2::uuid[]) ORDER BY original_line_id`,
        [companyId, notes.rows.map((r) => r.id)],
      );
      return notes.rows.map((r): ReturnNote => ({
        id: String(r.id), companyId: r.company_id as CompanyId, kind: r.kind as ReturnNote['kind'], number: String(r.number),
        documentDate: r.document_date as IsoDate,
        originalDocument: { id: String(r.original_document_id), number: String(r.original_document_number), date: r.original_document_date as IsoDate },
        partyId: r.party_id as ReturnNote['partyId'], reason: String(r.reason),
        lines: lines.rows.filter((l) => l.return_note_id === r.id).map(toLine),
        totals: amountsOf(r), voucherId: r.voucher_id as ReturnNote['voucherId'],
        complianceStatus: r.compliance_status as ReturnNote['complianceStatus'], createdBy: r.created_by as ReturnNote['createdBy'],
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        idempotencyKey: String(r.idempotency_key), summary: String(r.summary),
        supplierCreditNote: r.supplier_credit_note_number === null || r.supplier_credit_note_number === undefined
          ? null
          : { number: String(r.supplier_credit_note_number), date: r.supplier_credit_note_date as IsoDate },
      }));
    });
  }
}

const orNull = <T>(value: unknown, as: (v: unknown) => T): T | null => (value === null || value === undefined ? null : as(value));

const toLine = (l: Row): ReturnNoteLine => ({
  originalLineId: String(l.original_line_id),
  itemId: l.charge_kind === null ? String(l.item_id) : `charge:${String(l.charge_kind)}`, description: String(l.description),
  supplyKind: l.supply_kind as ReturnNoteLine['supplyKind'],
  quantity: { scaled: BigInt(String(l.quantity_micro)), unit: String(l.quantity_unit) },
  disposition: l.disposition as ReturnNoteLine['disposition'],
  warehouseId: orNull(l.warehouse_id, String), batchId: orNull(l.batch_id, String),
  serialNumbers: l.serial_numbers as string[], replacementSerialNumbers: l.replacement_serial_numbers as string[],
  amounts: amountsOf(l), hsnOrSac: orNull(l.hsn_or_sac, String),
  ratePercentTimes100: orNull(l.rate_percent_times100, (v) => BigInt(String(v))),
  unitPrice: orNull(l.unit_price_paise, (v): Money => money(BigInt(String(v)))),
});
