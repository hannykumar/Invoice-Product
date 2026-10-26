/**
 * Issue #366 — payments, cheques, allocations and advances in PostgreSQL, over the tables of #365
 * (docs/contracts/sales-schema-v1.md, `migrations.ts` beside this file).
 *
 * Built on the platform's transaction executor (ADR 0363). A write joins the action's open unit of
 * work (`requireUnitOfWork`) and never commits on its own; a read joins it when one is open.
 *
 * What the database keeps by itself, and so is never written here:
 *  - `payments.allocated_paise` and `document_settlements.allocated_paise`, moved by the trigger on
 *    `payment_allocations`. A payment's `allocations` are those rows; one that falls away (a bounced
 *    cheque, an undone payment, a changed decision) is released with `released_at`, never deleted.
 *  - the frozen columns. A payment changes only its cheque state, its state and its reversal; an
 *    advance changes only its version, and gains its application and refund as rows of their own.
 */
import { conflict, invalid, money, notFound, type CompanyId, type IsoDate, type Money, type PartyId } from '@invoice/kernel';
import type { SqlExecutor, TransactionalExecutor } from '../../platform/src/database.ts';
import type { AdvanceReceipt, AdvanceRepository, AdvanceTax, TaxHeads } from './advance.ts';
import type { Allocation, BillSettlement, ChequeEvent, DocumentKind, Payment } from './model.ts';
import type { Page, PaymentRepository } from './ports.ts';

type Row = Record<string, unknown>;
const HEADS = ['cgst', 'sgst', 'utgst', 'igst', 'cess'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A lookup by an id that cannot be a uuid finds nothing, as it does in memory, instead of failing the cast. */
const isUuid = (value: string): boolean => UUID.test(value);

const paise = (value: unknown): Money => money(BigInt(String(value)));
const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
const heads = (r: Row, prefix = ''): TaxHeads =>
  Object.fromEntries(HEADS.map((h) => [h, paise(r[`${prefix}${h}_paise`])])) as unknown as TaxHeads;
const headValues = (h: TaxHeads): string[] => HEADS.map((k) => h[k].minor.toString());
const headColumns = (prefix = ''): string => HEADS.map((h) => `${prefix}${h}_paise`).join(', ');
const params = (from: number, count: number): string => Array.from({ length: count }, (_, i) => `$${from + i}`).join(', ');

/** The services use the branch `'main'` for a person with no branch; it is stored as NULL (sales-schema-v1, "Branch"). */
const branchIn = (branch: string | null): string | null => (branch === null || branch === 'main' ? null : branch);
const branchOut = (value: unknown): Payment['branchId'] => (text(value) ?? 'main') as Payment['branchId'];

/**
 * The allocation rows carry the kind of document; the domain's `Allocation` does not. Money in
 * settles a sales bill and money out a purchase bill — those are the only open documents any
 * `DocumentLedgerPort` offers today (#230 keeps each direction to its own side).
 */
const kindFor = (direction: Payment['direction']): DocumentKind => (direction === 'RECEIPT' ? 'SALES_INVOICE' : 'PURCHASE_INVOICE');

/**
 * Without a page: everything, oldest first (`created_at` is when the row was written, the nearest the
 * database has to the in-memory store's insertion order). With one: keyset pagination by id.
 */
const keysetClause = (page: Page | undefined, next: number, t = ''): { where: string; tail: string; values: unknown[] } =>
  page === undefined
    ? { where: '', tail: `ORDER BY ${t}created_at, ${t}id`, values: [] }
    : page.after === undefined
      ? { where: '', tail: `ORDER BY ${t}id LIMIT $${next}`, values: [page.limit] }
      : { where: ` AND ${t}id > $${next}::uuid`, tail: `ORDER BY ${t}id LIMIT $${next + 1}`, values: [page.after, page.limit] };

const groupBy = (rows: Row[], key: string): Map<string, Row[]> => {
  const by = new Map<string, Row[]>();
  for (const row of rows) {
    const list = by.get(String(row[key]));
    if (list === undefined) by.set(String(row[key]), [row]); else list.push(row);
  }
  return by;
};

/** The database refused a figure the service had checked: someone else's change got there first. */
const refusal = (error: unknown): Error => {
  const { code, constraint } = error as { code?: string; constraint?: string };
  if (code === '23514' && (constraint === 'payments_allocated_within_amount' || constraint === 'payments_refunded_within_amount')) {
    return invalid('ALLOCATION_EXCEEDS_PAYMENT', 'More has been put against bills than this payment brought in. Open it again to see what is already settled.');
  }
  if (code === '23514' && constraint === 'document_settlements_allocated_within_value') {
    return invalid('ALLOCATION_EXCEEDS_OUTSTANDING', 'That bill has already been paid by other money. Open it again to see what is left to pay.');
  }
  if (code === '23503' && constraint === 'payment_allocations_bill_is_issued') {
    return invalid('ALLOCATION_UNKNOWN_DOCUMENT', 'That bill was never issued, so this money cannot be put against it.');
  }
  if (code === '23514' && constraint === 'payment_settlements_payment_is_live') {
    return invalid('SETTLEMENT_ON_UNDONE_PAYMENT', 'This payment was undone while you were working on it, so nothing can be settled on it. Open it again to see what happened.');
  }
  if (code === '23503' && constraint === 'payment_settlements_bill_is_issued') {
    return invalid('SETTLEMENT_UNKNOWN_DOCUMENT', 'That bill was never issued, so nothing can be settled on it.');
  }
  return error as Error;
};

// ------------------------------------------------------------------------------------ payments

const PAYMENT_COLUMNS = `id, company_id, branch_id, direction, party_id, mode, amount_paise, payment_date::text AS payment_date, reference,
  bank_account_code, refund_of, advance_to_supplier, advance_purchase_order_number, advance_purchase_order_date::text AS advance_purchase_order_date,
  advance_supplier_receipt_number, advance_supplier_receipt_date::text AS advance_supplier_receipt_date, cheque_number,
  cheque_date::text AS cheque_date, cheque_bank_name, state, voucher_id, reversal_voucher_id, reversal_reason, narration,
  recorded_by, recorded_at, idempotency_key, version`;

const reference = (number: unknown, date: unknown) => (number === null ? null : { number: String(number), date: date as IsoDate });

export class PostgresPaymentRepository implements PaymentRepository {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) { this.#db = db; }

  async insert(payment: Payment): Promise<void> {
    const sql = this.#db.requireUnitOfWork(payment.companyId).sql;
    const cheque = payment.cheque;
    const particulars = payment.advanceParticulars;
    try {
      // Only the columns the application may write: allocated_paise is the database's.
      await sql.query(
        `INSERT INTO payments (id, company_id, branch_id, direction, party_id, mode, amount_paise, payment_date, reference, bank_account_code,
           refund_of, advance_to_supplier, advance_purchase_order_number, advance_purchase_order_date, advance_supplier_receipt_number,
           advance_supplier_receipt_date, cheque_number, cheque_date, cheque_bank_name, cheque_state, state, voucher_id, reversal_voucher_id,
           reversal_reason, narration, recorded_by, recorded_at, idempotency_key, version)
         VALUES (${params(1, 29)})`,
        [payment.id, payment.companyId, branchIn(payment.branchId), payment.direction, payment.partyId, payment.mode, payment.amount.minor.toString(),
          payment.date, payment.reference, payment.bankAccountCode, payment.refundOf, payment.advanceToSupplier === true,
          particulars?.purchaseOrder?.number ?? null, particulars?.purchaseOrder?.date ?? null,
          particulars?.supplierReceiptVoucher?.number ?? null, particulars?.supplierReceiptVoucher?.date ?? null,
          cheque?.number ?? null, cheque?.chequeDate ?? null, cheque?.bankName ?? null, cheque === null ? null : (cheque.history.at(-1) as ChequeEvent).state,
          payment.state, payment.voucherId, payment.reversalVoucherId, payment.reversalReason, payment.narration, payment.recordedBy,
          payment.recordedAt, payment.idempotencyKey, payment.version],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw conflict('PAYMENT_DUPLICATE', 'This payment was already recorded.');
      // Issue #367 — a refund racing an allocation or another refund of the same receipt: the database
      // counted what is left, after the other one, and found too little.
      const { code, constraint } = error as { code?: string; constraint?: string };
      if (code === '23514' && constraint === 'payments_refunded_within_amount') {
        throw invalid('PAYMENT_REFUND_EXCEEDS', 'Some of that receipt was used or paid back while you were working on this, so this refund would be more than is left. Open it again to see what is unused.');
      }
      throw error;
    }
    await this.#appendCheque(sql, payment, 0);
    await this.#allocate(sql, payment, []);
    await this.#settle(sql, payment, []);
  }

  async update(payment: Payment, expectedVersion: number): Promise<void> {
    const sql = this.#db.requireUnitOfWork(payment.companyId).sql;
    const cheque = payment.cheque;
    // Only the columns the application may change; the rest of a payment is frozen (#368).
    const updated = await sql.query(
      `UPDATE payments SET cheque_state = $4, state = $5, reversal_voucher_id = $6, reversal_reason = $7, version = $8, updated_at = now()
        WHERE company_id = $1 AND id = $2 AND version = $3 RETURNING id`,
      [payment.companyId, payment.id, expectedVersion, cheque === null ? null : (cheque.history.at(-1) as ChequeEvent).state,
        payment.state, payment.reversalVoucherId, payment.reversalReason, payment.version],
    );
    if (updated.rows.length === 0) {
      if ((await this.findById(payment.companyId, payment.id)) === null) throw notFound('PAYMENT_NOT_FOUND', 'That payment does not exist in this business.');
      throw conflict('PAYMENT_CONCURRENT_EDIT', 'Someone else changed this payment while you were working on it. Open it again to see their changes.');
    }
    const steps = await sql.query('SELECT count(*)::int AS n FROM cheque_events WHERE company_id = $1 AND payment_id = $2', [payment.companyId, payment.id]);
    await this.#appendCheque(sql, payment, Number(steps.rows[0]?.n ?? 0));
    const live = await sql.query(
      `SELECT id, document_id, document_number, amount_paise, adjusted_from_advance FROM payment_allocations
        WHERE company_id = $1 AND payment_id = $2 AND released_at IS NULL ORDER BY created_at, id`,
      [payment.companyId, payment.id],
    );
    await this.#allocate(sql, payment, live.rows);
    const liveSettlements = await sql.query(
      `SELECT id, document_id, document_number, kind, amount_paise, tds_section, tds_quarter, tds_certificate FROM payment_settlements
        WHERE company_id = $1 AND payment_id = $2 AND released_at IS NULL ORDER BY created_at, id`,
      [payment.companyId, payment.id],
    );
    await this.#settle(sql, payment, liveSettlements.rows);
  }

  /** A cheque's history is only added to: the steps after the first `known` are new. */
  async #appendCheque(sql: SqlExecutor, payment: Payment, known: number): Promise<void> {
    const history = payment.cheque?.history ?? [];
    for (let seq = known + 1; seq <= history.length; seq += 1) {
      const event = history[seq - 1] as ChequeEvent;
      await sql.query(
        'INSERT INTO cheque_events (company_id, payment_id, seq, state, on_date, recorded_by, recorded_at, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [payment.companyId, payment.id, seq, event.state, event.on, event.by, event.at, event.note],
      );
    }
  }

  /**
   * Makes the live allocation rows match `payment.allocations`: a row no longer wanted is released,
   * a new one inserted, one that is unchanged is left alone. Releases go first, because the payment's
   * CHECK on what it has settled holds after every statement and `allocate()` replaces the whole set.
   */
  async #allocate(sql: SqlExecutor, payment: Payment, live: Row[]): Promise<void> {
    const same = (row: Row, a: Allocation) => row.document_id === a.documentId && row.document_number === a.documentNumber
      && BigInt(String(row.amount_paise)) === a.amount.minor && row.adjusted_from_advance === (a.adjustedFromAdvance === true);
    const unmatched = [...live];
    const added: Allocation[] = [];
    for (const allocation of payment.allocations) {
      const at = unmatched.findIndex((row) => same(row, allocation));
      if (at === -1) added.push(allocation); else unmatched.splice(at, 1);
    }
    try {
      if (unmatched.length > 0) {
        await sql.query('UPDATE payment_allocations SET released_at = now(), updated_at = now() WHERE company_id = $1 AND id = ANY($2::uuid[]) AND released_at IS NULL',
          [payment.companyId, unmatched.map((row) => row.id)]);
      }
      for (const allocation of added) {
        // One statement each, stamped with the clock, so they read back in the order they were given.
        await sql.query(
          `INSERT INTO payment_allocations (company_id, payment_id, document_kind, document_id, document_number, amount_paise, adjusted_from_advance, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp())`,
          [payment.companyId, payment.id, kindFor(payment.direction), allocation.documentId, allocation.documentNumber,
            allocation.amount.minor.toString(), allocation.adjustedFromAdvance === true],
        );
      }
    } catch (error) {
      throw refusal(error);
    }
  }

  /**
   * Issue #295 — makes the live settlement rows match `payment.settlements`, exactly like
   * `#allocate`: released when they fall away, inserted when new, left alone when unchanged.
   */
  async #settle(sql: SqlExecutor, payment: Payment, live: Row[]): Promise<void> {
    const same = (row: Row, s: BillSettlement) => row.document_id === s.documentId && row.document_number === s.documentNumber
      && row.kind === s.kind && BigInt(String(row.amount_paise)) === s.amount.minor
      && row.tds_section === (s.tdsSection ?? null) && row.tds_quarter === (s.tdsQuarter ?? null) && row.tds_certificate === (s.tdsCertificate ?? null);
    const unmatched = [...live];
    const added: BillSettlement[] = [];
    for (const settlement of payment.settlements ?? []) {
      const at = unmatched.findIndex((row) => same(row, settlement));
      if (at === -1) added.push(settlement); else unmatched.splice(at, 1);
    }
    try {
      if (unmatched.length > 0) {
        await sql.query('UPDATE payment_settlements SET released_at = now(), updated_at = now() WHERE company_id = $1 AND id = ANY($2::uuid[]) AND released_at IS NULL',
          [payment.companyId, unmatched.map((row) => row.id)]);
      }
      for (const settlement of added) {
        await sql.query(
          `INSERT INTO payment_settlements (company_id, payment_id, document_kind, document_id, document_number, kind, amount_paise, tds_section, tds_quarter, tds_certificate, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, clock_timestamp())`,
          [payment.companyId, payment.id, kindFor(payment.direction), settlement.documentId, settlement.documentNumber,
            settlement.kind, settlement.amount.minor.toString(), settlement.tdsSection ?? null, settlement.tdsQuarter ?? null, settlement.tdsCertificate ?? null],
        );
      }
    } catch (error) {
      throw refusal(error);
    }
  }

  async findById(companyId: CompanyId, id: string): Promise<Payment | null> {
    if (!isUuid(id)) return null;
    return (await this.#select(companyId, 'id = $2', [id], undefined))[0] ?? null;
  }

  async findByIdempotencyKey(companyId: CompanyId, key: string): Promise<Payment | null> {
    return (await this.#select(companyId, 'idempotency_key = $2', [key], undefined))[0] ?? null;
  }

  async listForParty(companyId: CompanyId, partyId: PartyId, page?: Page): Promise<Payment[]> {
    if (!isUuid(partyId)) return [];
    return this.#select(companyId, 'party_id = $2', [partyId], page);
  }

  list(companyId: CompanyId, page?: Page): Promise<Payment[]> {
    return this.#select(companyId, 'true', [], page);
  }

  /** Three queries whatever the number of payments: the payments, then all their cheque steps, then all their allocations. */
  #select(companyId: CompanyId, where: string, values: unknown[], page: Page | undefined): Promise<Payment[]> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const keyset = keysetClause(page, values.length + 2);
      const payments = await sql.query(
        `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE company_id = $1 AND ${where}${keyset.where} ${keyset.tail}`,
        [companyId, ...values, ...keyset.values],
      );
      if (payments.rows.length === 0) return [];
      const ids = payments.rows.map((r) => r.id);
      const events = await sql.query(
        `SELECT payment_id, state, on_date::text AS on_date, recorded_by, recorded_at, note FROM cheque_events
          WHERE company_id = $1 AND payment_id = ANY($2::uuid[]) ORDER BY payment_id, seq`,
        [companyId, ids],
      );
      const allocations = await sql.query(
        `SELECT payment_id, document_id, document_number, amount_paise, adjusted_from_advance FROM payment_allocations
          WHERE company_id = $1 AND payment_id = ANY($2::uuid[]) AND released_at IS NULL ORDER BY payment_id, created_at, id`,
        [companyId, ids],
      );
      const settlements = await sql.query(
        `SELECT payment_id, document_id, document_number, kind, amount_paise, tds_section, tds_quarter, tds_certificate FROM payment_settlements
          WHERE company_id = $1 AND payment_id = ANY($2::uuid[]) AND released_at IS NULL ORDER BY payment_id, created_at, id`,
        [companyId, ids],
      );
      const eventsOf = groupBy(events.rows, 'payment_id');
      const allocationsOf = groupBy(allocations.rows, 'payment_id');
      const settlementsOf = groupBy(settlements.rows, 'payment_id');
      return payments.rows.map((r) => toPayment(r, eventsOf.get(String(r.id)) ?? [], allocationsOf.get(String(r.id)) ?? [], settlementsOf.get(String(r.id)) ?? []));
    });
  }
}

const toPayment = (r: Row, events: Row[], allocations: Row[], settlements: Row[]): Payment => ({
  id: String(r.id),
  companyId: r.company_id as CompanyId,
  branchId: branchOut(r.branch_id),
  direction: r.direction as Payment['direction'],
  partyId: r.party_id as PartyId,
  mode: r.mode as Payment['mode'],
  amount: paise(r.amount_paise),
  date: r.payment_date as IsoDate,
  reference: text(r.reference),
  bankAccountCode: text(r.bank_account_code),
  cheque: r.cheque_number === null ? null : {
    number: String(r.cheque_number),
    chequeDate: r.cheque_date as IsoDate,
    bankName: text(r.cheque_bank_name),
    history: events.map((e): ChequeEvent => ({ state: e.state as ChequeEvent['state'], on: e.on_date as IsoDate, by: e.recorded_by as ChequeEvent['by'], at: iso(e.recorded_at), note: text(e.note) })),
  },
  allocations: allocations.map((a): Allocation => ({
    documentId: String(a.document_id), documentNumber: String(a.document_number), amount: paise(a.amount_paise),
    ...(a.adjusted_from_advance === true ? { adjustedFromAdvance: true } : {}),
  })),
  settlements: settlements.map((s): BillSettlement => ({
    documentId: String(s.document_id), documentNumber: String(s.document_number), kind: s.kind as BillSettlement['kind'], amount: paise(s.amount_paise),
    tdsSection: text(s.tds_section), tdsQuarter: text(s.tds_quarter), tdsCertificate: text(s.tds_certificate),
  })),
  refundOf: text(r.refund_of),
  // Absent means false, as the service writes it. Particulars are kept on an advance only.
  ...(r.advance_to_supplier === true ? {
    advanceToSupplier: true,
    advanceParticulars: {
      purchaseOrder: reference(r.advance_purchase_order_number, r.advance_purchase_order_date),
      supplierReceiptVoucher: reference(r.advance_supplier_receipt_number, r.advance_supplier_receipt_date),
    },
  } : {}),
  state: r.state as Payment['state'],
  voucherId: text(r.voucher_id) as Payment['voucherId'],
  reversalVoucherId: text(r.reversal_voucher_id) as Payment['reversalVoucherId'],
  reversalReason: text(r.reversal_reason),
  narration: text(r.narration),
  recordedBy: r.recorded_by as Payment['recordedBy'],
  recordedAt: iso(r.recorded_at),
  idempotencyKey: String(r.idempotency_key),
  version: Number(r.version),
});

// ------------------------------------------------------------------------------------ advances

const ADVANCE_COLUMNS = `a.id, a.company_id, a.branch_id, a.number, a.financial_year, a.receipt_date::text AS receipt_date, a.proforma_id,
  a.proforma_number, a.party_id, a.supply_kind, a.place_of_supply_state_code, a.description, a.amount_paise, a.taxable_value_paise,
  ${HEADS.map((h) => `a.${h}_paise`).join(', ')}, a.total_tax_paise, a.payment_id, a.tax_voucher_id, a.recorded_by, a.recorded_at,
  a.idempotency_key, a.version,
  p.advance_id AS applied, p.invoice_id, p.invoice_number, p.invoice_date::text AS invoice_date, p.amount_paise AS applied_paise,
  ${HEADS.map((h) => `p.set_off_${h}_paise`).join(', ')}, p.voucher_id AS applied_voucher_id, p.applied_by, p.applied_at,
  f.advance_id AS refunded, f.number AS refund_number, f.refund_date::text AS refund_date, f.amount_paise AS refund_paise,
  ${HEADS.map((h) => `f.refunded_${h}_paise`).join(', ')}, f.payment_id AS refund_payment_id, f.voucher_id AS refund_voucher_id,
  f.reason AS refund_reason, f.refunded_by, f.refunded_at`;

export class PostgresAdvanceRepository implements AdvanceRepository {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) { this.#db = db; }

  async insert(advance: AdvanceReceipt): Promise<void> {
    const sql = this.#db.requireUnitOfWork(advance.companyId).sql;
    const tax = advance.tax;
    try {
      await sql.query(
        `INSERT INTO advance_receipts (id, company_id, branch_id, number, financial_year, receipt_date, proforma_id, proforma_number, party_id,
           supply_kind, place_of_supply_state_code, description, amount_paise, line_count, taxable_value_paise, ${headColumns()}, total_tax_paise,
           payment_id, tax_voucher_id, recorded_by, recorded_at, idempotency_key, version)
         VALUES (${params(1, 27)})`,
        [advance.id, advance.companyId, branchIn(advance.branchId), advance.number, advance.financialYear, advance.date, advance.proformaId,
          advance.proformaNumber, advance.partyId, advance.supplyKind, advance.placeOfSupplyStateCode, advance.description,
          advance.amount.minor.toString(), tax?.lines.length ?? 0, tax?.taxableValue.minor.toString() ?? null,
          ...(tax === null ? HEADS.map(() => null) : headValues(tax)), tax?.totalTax.minor.toString() ?? null,
          advance.paymentId, advance.taxVoucherId, advance.recordedBy, advance.recordedAt, advance.idempotencyKey, advance.version],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw conflict('ADVANCE_DUPLICATE', 'This advance was already recorded.');
      throw error;
    }
    for (const [i, line] of (tax?.lines ?? []).entries()) {
      await sql.query(
        `INSERT INTO advance_tax_lines (company_id, advance_id, line_no, rate_bp, reverse_charge, taxable_value_paise, ${headColumns()})
         VALUES (${params(1, 11)})`,
        [advance.companyId, advance.id, i + 1, line.ratePercentTimes100?.toString() ?? null, line.reverseCharge, line.taxableValue.minor.toString(), ...headValues(line)],
      );
    }
    await this.#children(sql, advance, { applied: false, refunded: false });
  }

  async update(advance: AdvanceReceipt, expectedVersion: number): Promise<void> {
    const sql = this.#db.requireUnitOfWork(advance.companyId).sql;
    // The receipt itself is frozen but for its version; what changes are the rows beside it.
    const updated = await sql.query(
      'UPDATE advance_receipts SET version = $4, updated_at = now() WHERE company_id = $1 AND id = $2 AND version = $3 RETURNING id',
      [advance.companyId, advance.id, expectedVersion, advance.version],
    );
    if (updated.rows.length === 0) {
      if ((await this.findById(advance.companyId, advance.id)) === null) throw notFound('ADVANCE_NOT_FOUND', 'That advance does not exist in this business.');
      throw conflict('ADVANCE_CONCURRENT_EDIT', 'Someone else changed this advance while you were working on it. Open it again to see their change.');
    }
    const kept = await sql.query(
      `SELECT EXISTS (SELECT FROM advance_applications WHERE company_id = $1 AND advance_id = $2) AS applied,
              EXISTS (SELECT FROM refund_vouchers WHERE company_id = $1 AND advance_id = $2) AS refunded`,
      [advance.companyId, advance.id],
    );
    await this.#children(sql, advance, kept.rows[0] as { applied: boolean; refunded: boolean });
  }

  /** Writes the application and the refund the first time they appear. Once written they are frozen. */
  async #children(sql: SqlExecutor, advance: AdvanceReceipt, kept: { applied: boolean; refunded: boolean }): Promise<void> {
    const { application, refund } = advance;
    if (application !== null && !kept.applied) {
      await sql.query(
        `INSERT INTO advance_applications (company_id, advance_id, invoice_id, invoice_number, invoice_date, amount_paise, ${headColumns('set_off_')},
           voucher_id, applied_by, applied_at)
         VALUES (${params(1, 14)})`,
        [advance.companyId, advance.id, application.invoiceId, application.invoiceNumber, application.invoiceDate, application.amount.minor.toString(),
          ...headValues(application.taxSetOff), application.voucherId, application.by, application.at],
      );
    }
    if (refund !== null && !kept.refunded) {
      try {
        await sql.query(
          `INSERT INTO refund_vouchers (company_id, advance_id, number, refund_date, amount_paise, ${headColumns('refunded_')}, payment_id, voucher_id,
             reason, refunded_by, refunded_at)
           VALUES (${params(1, 15)})`,
          [advance.companyId, advance.id, refund.number, refund.date, refund.amount.minor.toString(), ...headValues(refund.taxRefunded),
            refund.paymentId, refund.voucherId, refund.reason, refund.by, refund.at],
        );
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw conflict('ADVANCE_DUPLICATE', 'This refund voucher number was already used.');
        throw error;
      }
    }
  }

  async findById(companyId: CompanyId, id: string): Promise<AdvanceReceipt | null> {
    if (!isUuid(id)) return null;
    return (await this.#select(companyId, 'a.id = $2', [id], undefined))[0] ?? null;
  }

  async findByIdempotencyKey(companyId: CompanyId, key: string): Promise<AdvanceReceipt | null> {
    return (await this.#select(companyId, 'a.idempotency_key = $2', [key], undefined))[0] ?? null;
  }

  async list(companyId: CompanyId, filter: { proformaId?: string } = {}, page?: Page): Promise<AdvanceReceipt[]> {
    if (filter.proformaId === undefined) return this.#select(companyId, 'true', [], page);
    if (!isUuid(filter.proformaId)) return [];
    return this.#select(companyId, 'a.proforma_id = $2', [filter.proformaId], page);
  }

  /** Two queries: the receipts with their application and refund (at most one of each), then all their tax lines. */
  #select(companyId: CompanyId, where: string, values: unknown[], page: Page | undefined): Promise<AdvanceReceipt[]> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const keyset = keysetClause(page, values.length + 2, 'a.');
      const advances = await sql.query(
        `SELECT ${ADVANCE_COLUMNS} FROM advance_receipts a
           LEFT JOIN advance_applications p ON p.company_id = a.company_id AND p.advance_id = a.id
           LEFT JOIN refund_vouchers f ON f.company_id = a.company_id AND f.advance_id = a.id
          WHERE a.company_id = $1 AND ${where}${keyset.where} ${keyset.tail}`,
        [companyId, ...values, ...keyset.values],
      );
      if (advances.rows.length === 0) return [];
      const lines = await sql.query(
        `SELECT advance_id, rate_bp, reverse_charge, taxable_value_paise, ${headColumns()} FROM advance_tax_lines
          WHERE company_id = $1 AND advance_id = ANY($2::uuid[]) ORDER BY advance_id, line_no`,
        [companyId, advances.rows.map((r) => r.id)],
      );
      const linesOf = groupBy(lines.rows, 'advance_id');
      return advances.rows.map((r) => toAdvance(r, linesOf.get(String(r.id)) ?? []));
    });
  }
}

const toAdvance = (r: Row, lines: Row[]): AdvanceReceipt => {
  const tax: AdvanceTax | null = r.taxable_value_paise === null ? null : {
    lines: lines.map((l) => ({
      ratePercentTimes100: l.rate_bp === null ? null : BigInt(String(l.rate_bp)), reverseCharge: Boolean(l.reverse_charge),
      taxableValue: paise(l.taxable_value_paise), ...heads(l),
    })),
    taxableValue: paise(r.taxable_value_paise), ...heads(r), totalTax: paise(r.total_tax_paise),
  };
  return {
    id: String(r.id), companyId: r.company_id as CompanyId, branchId: branchOut(r.branch_id), number: String(r.number),
    financialYear: String(r.financial_year), date: r.receipt_date as IsoDate, proformaId: String(r.proforma_id),
    proformaNumber: String(r.proforma_number), partyId: r.party_id as PartyId, supplyKind: r.supply_kind as AdvanceReceipt['supplyKind'],
    placeOfSupplyStateCode: String(r.place_of_supply_state_code), description: String(r.description), amount: paise(r.amount_paise), tax,
    paymentId: String(r.payment_id), taxVoucherId: text(r.tax_voucher_id) as AdvanceReceipt['taxVoucherId'],
    application: r.applied === null ? null : {
      invoiceId: String(r.invoice_id), invoiceNumber: String(r.invoice_number), invoiceDate: r.invoice_date as IsoDate,
      amount: paise(r.applied_paise), taxSetOff: heads(r, 'set_off_'), voucherId: text(r.applied_voucher_id) as AdvanceReceipt['taxVoucherId'],
      by: r.applied_by as AdvanceReceipt['recordedBy'], at: iso(r.applied_at),
    },
    refund: r.refunded === null ? null : {
      number: String(r.refund_number), date: r.refund_date as IsoDate, amount: paise(r.refund_paise), taxRefunded: heads(r, 'refunded_'),
      paymentId: String(r.refund_payment_id), voucherId: text(r.refund_voucher_id) as AdvanceReceipt['taxVoucherId'],
      reason: String(r.refund_reason), by: r.refunded_by as AdvanceReceipt['recordedBy'], at: iso(r.refunded_at),
    },
    recordedBy: r.recorded_by as AdvanceReceipt['recordedBy'], recordedAt: iso(r.recorded_at),
    idempotencyKey: String(r.idempotency_key), version: Number(r.version),
  };
};
