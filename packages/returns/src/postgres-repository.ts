/**
 * Issue #201 — return notes in PostgreSQL (`return_notes`, `return_note_lines`).
 *
 * Writes go through the ledger store's open transaction (`PostgresLedgerStore.withSql`), so a note,
 * its number and the voucher it posts are saved together or not at all — the database's version of
 * what `InMemoryReturnNoteRepository` does by joining the in-memory store.
 */
import { conflict, money, type CompanyId, type IsoDate, type Money } from '@invoice/kernel';
import type { PostgresLedgerStore, Sql } from '@invoice/ledger';
import type { ReturnNote, ReturnNoteLine, ReturnTaxAmounts } from './model.ts';
import type { ReturnNoteRepository } from './ports.ts';

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
  created_by, created_at, idempotency_key, summary`;

export class PostgresReturnNoteRepository implements ReturnNoteRepository {
  readonly #store: PostgresLedgerStore;

  constructor(store: PostgresLedgerStore) { this.#store = store; }

  insert(note: ReturnNote): Promise<void> {
    return this.#store.withSql(note.companyId, async (sql) => {
      try {
        await sql.query(
          `INSERT INTO return_notes (id, company_id, kind, number, document_date, original_document_id, original_document_number,
             original_document_date, party_id, reason, ${amountColumns}, voucher_id, compliance_status, created_by, created_at,
             idempotency_key, summary)
           VALUES (${placeholders(1, 25)})`,
          [note.id, note.companyId, note.kind, note.number, note.documentDate, note.originalDocument.id, note.originalDocument.number,
            note.originalDocument.date, note.partyId, note.reason, ...amountValues(note.totals), note.voucherId, note.complianceStatus,
            note.createdBy, note.createdAt, note.idempotencyKey, note.summary],
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw conflict('RETURN_NOTE_DUPLICATE', 'This return note has already been recorded.');
        throw error;
      }
      for (const line of note.lines) {
        await sql.query(
          `INSERT INTO return_note_lines (return_note_id, company_id, original_line_id, item_id, description, supply_kind, quantity_micro,
             quantity_unit, disposition, warehouse_id, batch_id, serial_numbers, replacement_serial_numbers, ${amountColumns},
             hsn_or_sac, rate_percent_times100, unit_price_paise)
           VALUES (${placeholders(1, 25)})`,
          [note.id, note.companyId, line.originalLineId, line.itemId, line.description, line.supplyKind, line.quantity.scaled.toString(),
            line.quantity.unit, line.disposition, line.warehouseId, line.batchId, JSON.stringify(line.serialNumbers),
            JSON.stringify(line.replacementSerialNumbers), ...amountValues(line.amounts), line.hsnOrSac,
            line.ratePercentTimes100?.toString() ?? null, line.unitPrice?.minor.toString() ?? null],
        );
      }
    });
  }

  async findById(companyId: CompanyId, id: string): Promise<ReturnNote | null> {
    return (await this.#select(companyId, 'id = $2', [id]))[0] ?? null;
  }

  async findByIdempotencyKey(companyId: CompanyId, key: string): Promise<ReturnNote | null> {
    return (await this.#select(companyId, 'idempotency_key = $2', [key]))[0] ?? null;
  }

  listForOriginal(companyId: CompanyId, originalDocumentId: string): Promise<ReturnNote[]> {
    return this.#select(companyId, 'original_document_id = $2', [originalDocumentId]);
  }

  list(companyId: CompanyId): Promise<ReturnNote[]> {
    return this.#select(companyId, 'true', []);
  }

  #select(companyId: CompanyId, where: string, values: unknown[]): Promise<ReturnNote[]> {
    return this.#store.withSql(companyId, async (sql: Sql) => {
      const notes = await sql.query(
        `SELECT ${NOTE_COLUMNS} FROM return_notes WHERE company_id = $1 AND ${where} ORDER BY document_date, number`,
        [companyId, ...values],
      );
      if (notes.rows.length === 0) return [];
      const lines = await sql.query(
        `SELECT * FROM return_note_lines WHERE company_id = $1 AND return_note_id = ANY($2::uuid[]) ORDER BY original_line_id`,
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
      }));
    });
  }
}

const orNull = <T>(value: unknown, as: (v: unknown) => T): T | null => (value === null || value === undefined ? null : as(value));

const toLine = (l: Row): ReturnNoteLine => ({
  originalLineId: String(l.original_line_id), itemId: String(l.item_id), description: String(l.description),
  supplyKind: l.supply_kind as ReturnNoteLine['supplyKind'],
  quantity: { scaled: BigInt(String(l.quantity_micro)), unit: String(l.quantity_unit) },
  disposition: l.disposition as ReturnNoteLine['disposition'],
  warehouseId: orNull(l.warehouse_id, String), batchId: orNull(l.batch_id, String),
  serialNumbers: l.serial_numbers as string[], replacementSerialNumbers: l.replacement_serial_numbers as string[],
  amounts: amountsOf(l), hsnOrSac: orNull(l.hsn_or_sac, String),
  ratePercentTimes100: orNull(l.rate_percent_times100, (v) => BigInt(String(v))),
  unitPrice: orNull(l.unit_price_paise, (v): Money => money(BigInt(String(v)))),
});
