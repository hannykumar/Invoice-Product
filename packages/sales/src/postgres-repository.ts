/**
 * Issue #366 — bills, quotations, proforma invoices and delivery challans in PostgreSQL, on the
 * tables of #365 (docs/contracts/sales-schema-v1.md). Each class behaves as its in-memory twin.
 *
 *  - Writes join the action's unit of work (`requireUnitOfWork`); a write outside one throws
 *    `NO_UNIT_OF_WORK`. Reads use `tenantTransaction`, which joins an open unit of work too.
 *  - Every computed line is written, freight and other charges included (`kind = 'CHARGE'`), with
 *    the header's totals and `line_count`, so the database's "lines add up" check holds. The whole
 *    `InvoicePricing` is kept in `pricing jsonb`, so a bill reads back exactly as it was issued.
 *  - The application may not delete. A draft's lines are replaced, and a draft discarded, through
 *    `sales_discard_draft`, which refuses an issued bill.
 *  - A bill issued here gets its `document_settlements` row in the same unit of work (what the
 *    customer owes on it), and a cancelled bill's row is marked cancelled. The repository is the one
 *    place every move to FINAL or CANCELLED passes through, so the row cannot be forgotten.
 */
import { conflict, money, notFound, type CompanyId, type IsoDate, type Money } from '@invoice/kernel';
import type { SqlExecutor, TransactionalExecutor } from '../../platform/src/database.ts';
import type { ChallanEwayBill, ChallanLine, ChallanState, DeliveryChallan } from './challan-model.ts';
import type { ChallanRepository } from './challan-repository.ts';
import type { InvoicePricing, SalesInvoice, SalesInvoiceLineInput } from './model.ts';
import type { Page, SalesRepository } from './ports.ts';
import type { PreSaleDocument } from './presale-model.ts';
import type { PreSaleFilter, PreSaleRepository } from './presale-repository.ts';

type Row = Record<string, unknown>;

// bigint inside jsonb is kept as {"$bigint": "…"} so it comes back as exactly the same bigint.
const toJson = (value: unknown): string | null =>
  value === null || value === undefined ? null : JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v));
const fromJson = <T>(value: unknown): T =>
  JSON.parse(JSON.stringify(value), (_k, v: unknown) => (v !== null && typeof v === 'object' && '$bigint' in v ? BigInt((v as { $bigint: string }).$bigint) : v)) as T;

const big = (v: unknown): bigint => BigInt(String(v));
const inr = (v: unknown): Money => money(big(v));
const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const time = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));
const paise = (m: Money): string => m.minor.toString();
const optional = <K extends string, V>(key: K, value: V | null): { [P in K]?: V } => (value === null ? {} : ({ [key]: value } as { [P in K]: V }));
/** The services call a person's own shop `'main'`; the table has no such branch, so it is stored as NULL. */
const branchIn = (branchId: string): string | null => (branchId === 'main' ? null : branchId);
const branchOut = <T>(v: unknown): T => (v === null ? 'main' : String(v)) as T;
const errorOf = (error: unknown): { code?: string; constraint?: string } => error as { code?: string; constraint?: string };

/** Column lists: `name::cast` sends the value through a cast (jsonb). */
const nameOf = (field: string): string => field.split('::')[0] as string;
const castOf = (field: string): string => (field.includes('::') ? `::${field.split('::')[1]}` : '');
const insertSql = (table: string, fields: readonly string[]): string =>
  `INSERT INTO ${table} (${fields.map(nameOf).join(', ')}) VALUES (${fields.map((f, i) => `$${i + 1}${castOf(f)}`).join(', ')})`;
/** `$1` company, `$2` id, `$3` the version the caller read; the fields follow from `$4`. */
const updateSql = (table: string, fields: readonly string[]): string =>
  `UPDATE ${table} SET ${fields.map((f, i) => `${nameOf(f)} = $${i + 4}${castOf(f)}`).join(', ')}, updated_at = now()
    WHERE company_id = $1 AND id = $2 AND version = $3 RETURNING id`;

/** Many rows in one statement. */
const insertRows = async (sql: SqlExecutor, table: string, columns: readonly string[], rows: readonly (readonly unknown[])[]): Promise<void> => {
  if (rows.length === 0) return;
  const values = rows.map((row, r) => `(${row.map((_v, c) => `$${r * columns.length + c + 1}`).join(', ')})`).join(', ');
  await sql.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${values}`, rows.flat());
};

/** One keyset page of `table` in id order. `$1` is always the company. */
const pageSql = (where: string, values: unknown[], page: Page | undefined): { where: string; values: unknown[]; tail: string } => {
  if (page === undefined) return { where, values, tail: 'ORDER BY id' };
  const after = page.after === undefined ? '' : ` AND id > $${values.length + 1}::uuid`;
  const next = page.after === undefined ? values : [...values, page.after];
  return { where: `${where}${after}`, values: [...next, page.limit], tail: `ORDER BY id LIMIT $${next.length + 1}` };
};

// --- The lines of a bill, quotation or proforma (the same table shape for both) ---------------

const SALE_LINE_COLUMNS = ['company_id', 'line_id', 'line_no', 'kind', 'charge_kind', 'item_id', 'warehouse_id', 'quantity_micro', 'unit_code',
  'unit_price_paise', 'price_basis', 'discount_kind', 'discount_bp', 'discount_paise', 'note', 'item_name', 'hsn_or_sac', 'rate_bp',
  'taxable_value_paise', 'cgst_paise', 'sgst_paise', 'utgst_paise', 'igst_paise', 'cess_paise', 'reverse_charge'] as const;
const SALE_LINE_READ = 'line_id, item_id, warehouse_id, quantity_micro, unit_code, unit_price_paise, price_basis, discount_kind, discount_bp, discount_paise, note';

type Computed = InvoicePricing['lines'][number];
const computedColumns = (c: Computed | undefined): unknown[] =>
  c === undefined
    ? [null, null, null, null, '0', '0', '0', '0', '0', false]
    : [c.itemName, c.hsnOrSac, c.ratePercentTimes100?.toString() ?? null, paise(c.taxableValue), paise(c.cgst), paise(c.sgst), paise(c.utgst), paise(c.igst), paise(c.cess), c.reverseCharge];

/**
 * A row for every line as it was typed, carrying what the calculator made of it, then a row for
 * every charge the calculator added. A draft whose lines changed since it was priced keeps the
 * typed lines; their figures are filled in when it is priced again.
 */
const saleLineRows = (companyId: string, parentId: string, lines: readonly SalesInvoiceLineInput[], pricing: InvoicePricing | null): unknown[][] => {
  const computed = new Map((pricing?.lines ?? []).filter((l) => l.kind === 'GOODS').map((l) => [l.lineId, l]));
  const goods = lines.map((l, i) => [companyId, parentId, l.lineId, i + 1, 'GOODS', null, l.itemId, l.warehouseId ?? null, l.quantity.scaled.toString(), l.quantity.unit,
    paise(l.unitPrice), l.priceBasis, l.discount?.kind ?? null, l.discount?.kind === 'PERCENT' ? l.discount.percentTimes100.toString() : null,
    l.discount?.kind === 'AMOUNT' ? paise(l.discount.amount) : null, l.note ?? null, ...computedColumns(computed.get(l.lineId))]);
  const charges = (pricing?.lines ?? []).filter((l) => l.kind === 'CHARGE').map((c, i) => [companyId, parentId, c.lineId, lines.length + i + 1, 'CHARGE', c.chargeKind, null, null,
    c.quantity.scaled.toString(), c.quantity.unit, paise(c.unitPrice), null, null, null, null, null, ...computedColumns(c)]);
  return [...goods, ...charges];
};

const insertSaleLines = (sql: SqlExecutor, table: string, foreignKey: string, rows: unknown[][]): Promise<void> =>
  insertRows(sql, table, [SALE_LINE_COLUMNS[0], foreignKey, ...SALE_LINE_COLUMNS.slice(1)], rows);

const toLineInput = (r: Row): SalesInvoiceLineInput => ({
  lineId: String(r.line_id),
  itemId: String(r.item_id),
  quantity: { scaled: big(r.quantity_micro), unit: String(r.unit_code) },
  unitPrice: inr(r.unit_price_paise),
  priceBasis: r.price_basis as SalesInvoiceLineInput['priceBasis'],
  ...(r.discount_kind === 'PERCENT' ? { discount: { kind: 'PERCENT' as const, percentTimes100: big(r.discount_bp) } } : {}),
  ...(r.discount_kind === 'AMOUNT' ? { discount: { kind: 'AMOUNT' as const, amount: inr(r.discount_paise) } } : {}),
  ...optional('warehouseId', text(r.warehouse_id)),
  ...optional('note', text(r.note)),
});

/** The typed lines of many documents in one query, grouped by document. */
const typedLines = async (sql: SqlExecutor, table: string, foreignKey: string, companyId: string, ids: readonly unknown[]): Promise<Map<string, SalesInvoiceLineInput[]>> => {
  const grouped = new Map<string, SalesInvoiceLineInput[]>();
  if (ids.length === 0) return grouped;
  const { rows } = await sql.query(
    `SELECT ${foreignKey} AS parent, ${SALE_LINE_READ} FROM ${table} WHERE company_id = $1 AND ${foreignKey} = ANY($2::uuid[]) AND kind = 'GOODS' ORDER BY ${foreignKey}, line_no`,
    [companyId, ids],
  );
  for (const r of rows) grouped.set(String(r.parent), [...(grouped.get(String(r.parent)) ?? []), toLineInput(r)]);
  return grouped;
};

/** taxable value, the five heads, tax, reverse-charge tax, round-off and value: the figures the header repeats from the pricing. */
const PRICED_FIELDS = ['pricing::jsonb', 'line_count', 'taxable_value_paise', 'cgst_paise', 'sgst_paise', 'utgst_paise', 'igst_paise', 'cess_paise',
  'total_tax_paise', 'reverse_charge_tax_paise', 'round_off_paise', 'invoice_value_paise'] as const;
const pricedValues = (pricing: InvoicePricing | null, lineCount: number): unknown[] => {
  if (pricing === null) return [null, lineCount, ...Array<null>(10).fill(null)];
  const t = pricing.totals;
  return [toJson(pricing), lineCount, ...[t.taxableValue, t.cgst, t.sgst, t.utgst, t.igst, t.cess, t.totalTax, t.reverseChargeTax, t.roundOff, t.invoiceValue].map(paise)];
};

// --- Sales invoices ------------------------------------------------------------------------------

const INVOICE_KEYS = ['id', 'company_id', 'created_by', 'created_at', 'idempotency_key'] as const;
const INVOICE_FIELDS = ['branch_id', 'state', 'number', 'financial_year', 'document_date', 'due_date', 'party_id', 'customer_type', 'supply_kind',
  'delivery_state_code', 'place_of_supply_state_code', 'freight_paise', 'other_charges_paise', 'round_to_whole_rupee', 'narration', ...PRICED_FIELDS,
  'zero_rated', 'problems::jsonb', 'voucher_id', 'cancellation_voucher_id', 'finalised_by', 'finalised_at', 'approved_by', 'approved_at',
  'cancelled_by', 'cancelled_at', 'cancel_reason', 'version'] as const;
const INVOICE_READ = `id, company_id, branch_id, state, number, financial_year, document_date::text AS document_date, due_date::text AS due_date,
  party_id, customer_type, supply_kind, delivery_state_code, place_of_supply_state_code, freight_paise, other_charges_paise, round_to_whole_rupee,
  narration, pricing, zero_rated, problems, voucher_id, cancellation_voucher_id, created_by, created_at, finalised_by, finalised_at,
  cancelled_by, cancelled_at, cancel_reason, approved_by, approved_at, idempotency_key, version`;

const invoiceFields = (i: SalesInvoice, lineCount: number): unknown[] => [
  branchIn(i.branchId), i.state, i.number, i.financialYear, i.documentDate, i.dueDate, i.partyId, i.customerType, i.supplyKind,
  i.deliveryStateCode, i.placeOfSupplyStateCode, paise(i.freight), paise(i.otherCharges), i.roundToWholeRupee, i.narration,
  ...pricedValues(i.pricing, lineCount), i.zeroRated ?? null, toJson(i.problems), i.voucherId, i.cancellationVoucherId,
  i.finalisedBy, i.finalisedAt, i.approvedBy, i.approvedAt, i.cancelledBy, i.cancelledAt, i.cancelReason, i.version,
];

const toInvoice = (r: Row, lines: readonly SalesInvoiceLineInput[]): SalesInvoice => ({
  id: String(r.id),
  companyId: r.company_id as SalesInvoice['companyId'],
  branchId: branchOut(r.branch_id),
  state: r.state as SalesInvoice['state'],
  number: text(r.number),
  financialYear: text(r.financial_year),
  documentDate: r.document_date as IsoDate,
  dueDate: text(r.due_date) as IsoDate | null,
  partyId: r.party_id as SalesInvoice['partyId'],
  customerType: r.customer_type as SalesInvoice['customerType'],
  supplyKind: r.supply_kind as SalesInvoice['supplyKind'],
  deliveryStateCode: text(r.delivery_state_code),
  placeOfSupplyStateCode: text(r.place_of_supply_state_code),
  lines,
  freight: inr(r.freight_paise),
  otherCharges: inr(r.other_charges_paise),
  roundToWholeRupee: Boolean(r.round_to_whole_rupee),
  narration: text(r.narration),
  ...(r.zero_rated === null ? {} : { zeroRated: r.zero_rated as 'WITH_TAX' | 'WITHOUT_TAX' }),
  pricing: r.pricing === null ? null : fromJson<InvoicePricing>(r.pricing),
  problems: fromJson<SalesInvoice['problems']>(r.problems),
  voucherId: text(r.voucher_id) as SalesInvoice['voucherId'],
  cancellationVoucherId: text(r.cancellation_voucher_id) as SalesInvoice['cancellationVoucherId'],
  createdBy: r.created_by as SalesInvoice['createdBy'],
  createdAt: time(r.created_at) as string,
  finalisedBy: text(r.finalised_by) as SalesInvoice['finalisedBy'],
  finalisedAt: time(r.finalised_at),
  cancelledBy: text(r.cancelled_by) as SalesInvoice['cancelledBy'],
  cancelledAt: time(r.cancelled_at),
  cancelReason: text(r.cancel_reason),
  approvedBy: text(r.approved_by) as SalesInvoice['approvedBy'],
  approvedAt: time(r.approved_at),
  idempotencyKey: String(r.idempotency_key),
  version: Number(r.version),
});

const salesDuplicate = (error: unknown, number: string | null): unknown => {
  const { code, constraint } = errorOf(error);
  if (code !== '23505') return error;
  return constraint === 'sales_invoices_company_id_number_key'
    ? conflict('SALES_DUPLICATE_NUMBER', `Bill number ${number} has already been used.`)
    : conflict('SALES_DUPLICATE_INVOICE', 'This bill was already started.');
};

export class PostgresSalesRepository implements SalesRepository {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  async #select(companyId: CompanyId, where: string, values: unknown[], page?: Page): Promise<SalesInvoice[]> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const q = pageSql(`company_id = $1 AND ${where}`, [companyId, ...values], page);
      const { rows } = await sql.query(`SELECT ${INVOICE_READ} FROM sales_invoices WHERE ${q.where} ${q.tail}`, q.values);
      const lines = await typedLines(sql, 'sales_invoice_lines', 'invoice_id', companyId, rows.map((r) => r.id));
      return rows.map((r) => toInvoice(r, lines.get(String(r.id)) ?? []));
    });
  }

  async findById(companyId: CompanyId, id: string): Promise<SalesInvoice | null> {
    return (await this.#select(companyId, 'id = $2', [id]))[0] ?? null;
  }

  async findByNumber(companyId: CompanyId, number: string): Promise<SalesInvoice | null> {
    return (await this.#select(companyId, 'number = $2', [number]))[0] ?? null;
  }

  async findByIdempotencyKey(companyId: CompanyId, key: string): Promise<SalesInvoice | null> {
    return (await this.#select(companyId, 'idempotency_key = $2', [key]))[0] ?? null;
  }

  list(companyId: CompanyId, filter: { partyId?: string; state?: SalesInvoice['state'] } = {}, page?: Page): Promise<SalesInvoice[]> {
    return this.#select(companyId, '($2::uuid IS NULL OR party_id = $2) AND ($3::text IS NULL OR state = $3)', [filter.partyId ?? null, filter.state ?? null], page);
  }

  async insert(invoice: SalesInvoice): Promise<void> {
    const sql = this.#db.requireUnitOfWork(invoice.companyId).sql;
    const lines = saleLineRows(invoice.companyId, invoice.id, invoice.lines, invoice.pricing);
    try {
      await sql.query(insertSql('sales_invoices', [...INVOICE_KEYS, ...INVOICE_FIELDS]),
        [invoice.id, invoice.companyId, invoice.createdBy, invoice.createdAt, invoice.idempotencyKey, ...invoiceFields(invoice, lines.length)]);
    } catch (error) {
      throw salesDuplicate(error, invoice.number);
    }
    await insertSaleLines(sql, 'sales_invoice_lines', 'invoice_id', lines);
    await this.#settle(sql, invoice, null);
  }

  async update(invoice: SalesInvoice, expectedVersion: number): Promise<void> {
    const sql = this.#db.requireUnitOfWork(invoice.companyId).sql;
    // Locked, so the version read here is still the version when the row is written.
    const { rows } = await sql.query('SELECT state, version FROM sales_invoices WHERE company_id = $1 AND id = $2 FOR UPDATE', [invoice.companyId, invoice.id]);
    const current = rows[0];
    if (current === undefined) throw notFound('SALES_INVOICE_NOT_FOUND', 'That bill does not exist in this business.');
    if (Number(current.version) !== expectedVersion) {
      throw conflict('SALES_CONCURRENT_EDIT', 'Someone else changed this bill while you were working on it. Open it again to see their changes.');
    }
    const was = String(current.state);
    const issued = was === 'FINAL' || was === 'CANCELLED';
    const lines = saleLineRows(invoice.companyId, invoice.id, invoice.lines, invoice.pricing);
    // An issued bill's lines are frozen; a draft's are written again, before it can become issued.
    if (!issued) {
      await sql.query('SELECT sales_discard_draft($1, true)', [invoice.id]);
      await insertSaleLines(sql, 'sales_invoice_lines', 'invoice_id', lines);
    }
    try {
      await sql.query(updateSql('sales_invoices', INVOICE_FIELDS), [invoice.companyId, invoice.id, expectedVersion, ...invoiceFields(invoice, lines.length)]);
    } catch (error) {
      throw salesDuplicate(error, invoice.number);
    }
    await this.#settle(sql, invoice, was);
  }

  /** What the customer owes on an issued bill (sales-schema-v1, "Settlements"). */
  async #settle(sql: SqlExecutor, invoice: SalesInvoice, was: string | null): Promise<void> {
    if (invoice.state === 'FINAL' && was !== 'FINAL') {
      await sql.query(
        `INSERT INTO document_settlements (id, company_id, document_kind, document_id, document_number, party_id, side, document_date, due_date, value_paise)
         VALUES ($1, $2, 'SALES_INVOICE', $3, $4, $5, 'RECEIVABLE', $6, $7, $8)`,
        [crypto.randomUUID(), invoice.companyId, invoice.id, invoice.number, invoice.partyId, invoice.documentDate, invoice.dueDate,
          paise((invoice.pricing as InvoicePricing).totals.invoiceValue)],
      );
    }
    if (invoice.state === 'CANCELLED' && was !== 'CANCELLED') {
      await sql.query(
        "UPDATE document_settlements SET cancelled = true, updated_at = now() WHERE company_id = $1 AND document_kind = 'SALES_INVOICE' AND document_id = $2",
        [invoice.companyId, invoice.id],
      );
    }
  }

  async remove(companyId: CompanyId, id: string): Promise<void> {
    const sql = this.#db.requireUnitOfWork(companyId).sql;
    const current = (await sql.query('SELECT number, voucher_id FROM sales_invoices WHERE company_id = $1 AND id = $2 FOR UPDATE', [companyId, id])).rows[0];
    if (current === undefined) return;
    // Issue #256 — a numbered or posted bill is part of the books and is never removed.
    if (current.number !== null || current.voucher_id !== null) {
      throw conflict('SALES_ISSUED_NOT_REMOVABLE', `${text(current.number) ?? 'This bill'} has been issued, so it stays on record.`);
    }
    await sql.query('SELECT sales_discard_draft($1, false)', [id]);
  }
}

// --- Quotations and proforma invoices ------------------------------------------------------------

const PRESALE_KEYS = ['id', 'company_id', 'kind', 'created_by', 'created_at', 'idempotency_key'] as const;
const PRESALE_FIELDS = ['branch_id', 'state', 'number', 'financial_year', 'document_date', 'valid_until', 'party_id', 'customer_type', 'supply_kind',
  'delivery_state_code', 'place_of_supply_state_code', 'freight_paise', 'other_charges_paise', 'round_to_whole_rupee', 'narration', ...PRICED_FIELDS,
  'declared_rate_notice::jsonb', 'terms', 'purpose', 'buyer_order_number', 'payment_terms', 'converted_invoice_id', 'converted_by', 'converted_at',
  'invoice_id', 'invoice_number', 'invoice_date', 'linked_by', 'linked_at', 'link_differences::jsonb', 'cancelled_by', 'cancelled_at', 'cancel_reason', 'version'] as const;
const PRESALE_READ = `id, company_id, branch_id, kind, state, number, financial_year, document_date::text AS document_date, valid_until::text AS valid_until,
  party_id, customer_type, supply_kind, delivery_state_code, place_of_supply_state_code, freight_paise, other_charges_paise, round_to_whole_rupee,
  narration, pricing, declared_rate_notice, terms, purpose, buyer_order_number, payment_terms, converted_invoice_id, converted_by, converted_at,
  invoice_id, invoice_number, invoice_date::text AS invoice_date, linked_by, linked_at, link_differences, cancelled_by, cancelled_at, cancel_reason,
  created_by, created_at, idempotency_key, version`;

const presaleFields = (d: PreSaleDocument, lineCount: number): unknown[] => [
  branchIn(d.branchId), d.state, d.number, d.financialYear, d.documentDate, d.validUntil, d.partyId, d.customerType, d.supplyKind,
  d.deliveryStateCode, d.placeOfSupplyStateCode, paise(d.freight), paise(d.otherCharges), d.roundToWholeRupee, d.narration,
  ...pricedValues(d.pricing, lineCount), toJson(d.declaredRateNotice), d.terms, d.purpose, d.buyerOrderNumber, d.paymentTerms,
  d.sale?.invoiceId ?? null, d.sale?.convertedBy ?? null, d.sale?.convertedAt ?? null,
  d.invoice?.invoiceId ?? null, d.invoice?.invoiceNumber ?? null, d.invoice?.invoiceDate ?? null, d.invoice?.linkedBy ?? null, d.invoice?.linkedAt ?? null,
  toJson(d.invoice?.differences ?? null), d.cancelledBy, d.cancelledAt, d.cancelReason, d.version,
];

const toPreSale = (r: Row, lines: readonly SalesInvoiceLineInput[]): PreSaleDocument => ({
  id: String(r.id),
  companyId: r.company_id as PreSaleDocument['companyId'],
  branchId: branchOut(r.branch_id),
  kind: r.kind as PreSaleDocument['kind'],
  state: r.state as PreSaleDocument['state'],
  number: String(r.number),
  financialYear: String(r.financial_year),
  documentDate: r.document_date as IsoDate,
  validUntil: text(r.valid_until) as IsoDate | null,
  partyId: r.party_id as PreSaleDocument['partyId'],
  customerType: r.customer_type as PreSaleDocument['customerType'],
  supplyKind: r.supply_kind as PreSaleDocument['supplyKind'],
  deliveryStateCode: text(r.delivery_state_code),
  placeOfSupplyStateCode: text(r.place_of_supply_state_code),
  lines,
  freight: inr(r.freight_paise),
  otherCharges: inr(r.other_charges_paise),
  roundToWholeRupee: Boolean(r.round_to_whole_rupee),
  pricing: fromJson<InvoicePricing>(r.pricing),
  declaredRateNotice: r.declared_rate_notice === null ? null : fromJson<PreSaleDocument['declaredRateNotice']>(r.declared_rate_notice),
  terms: text(r.terms),
  narration: text(r.narration),
  purpose: text(r.purpose),
  buyerOrderNumber: text(r.buyer_order_number),
  paymentTerms: text(r.payment_terms),
  sale: r.converted_invoice_id === null ? null : {
    invoiceId: String(r.converted_invoice_id), convertedBy: r.converted_by as PreSaleDocument['createdBy'], convertedAt: time(r.converted_at) as string,
  },
  invoice: r.invoice_id === null ? null : {
    invoiceId: String(r.invoice_id), invoiceNumber: String(r.invoice_number), invoiceDate: r.invoice_date as IsoDate,
    linkedBy: r.linked_by as PreSaleDocument['createdBy'], linkedAt: time(r.linked_at) as string, differences: fromJson<string[]>(r.link_differences),
  },
  createdBy: r.created_by as PreSaleDocument['createdBy'],
  createdAt: time(r.created_at) as string,
  cancelledBy: text(r.cancelled_by) as PreSaleDocument['cancelledBy'],
  cancelledAt: time(r.cancelled_at),
  cancelReason: text(r.cancel_reason),
  idempotencyKey: String(r.idempotency_key),
  version: Number(r.version),
});

export class PostgresPreSaleRepository implements PreSaleRepository {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  async #select(companyId: CompanyId, where: string, values: unknown[], page?: Page): Promise<PreSaleDocument[]> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const q = pageSql(`company_id = $1 AND ${where}`, [companyId, ...values], page);
      const { rows } = await sql.query(`SELECT ${PRESALE_READ} FROM presale_documents WHERE ${q.where} ${q.tail}`, q.values);
      const lines = await typedLines(sql, 'presale_document_lines', 'document_id', companyId, rows.map((r) => r.id));
      return rows.map((r) => toPreSale(r, lines.get(String(r.id)) ?? []));
    });
  }

  async findById(companyId: CompanyId, id: string): Promise<PreSaleDocument | null> {
    return (await this.#select(companyId, 'id = $2', [id]))[0] ?? null;
  }

  async findByIdempotencyKey(companyId: CompanyId, key: string): Promise<PreSaleDocument | null> {
    return (await this.#select(companyId, 'idempotency_key = $2', [key]))[0] ?? null;
  }

  list(companyId: CompanyId, filter: PreSaleFilter = {}, page?: Page): Promise<PreSaleDocument[]> {
    return this.#select(companyId,
      '($2::text IS NULL OR kind = $2) AND ($3::text IS NULL OR state = $3) AND ($4::uuid IS NULL OR party_id = $4) AND ($5::uuid IS NULL OR invoice_id = $5 OR converted_invoice_id = $5)',
      [filter.kind ?? null, filter.state ?? null, filter.partyId ?? null, filter.invoiceId ?? null], page);
  }

  async insert(document: PreSaleDocument): Promise<void> {
    const sql = this.#db.requireUnitOfWork(document.companyId).sql;
    const lines = saleLineRows(document.companyId, document.id, document.lines, document.pricing);
    try {
      await sql.query(insertSql('presale_documents', [...PRESALE_KEYS, ...PRESALE_FIELDS]),
        [document.id, document.companyId, document.kind, document.createdBy, document.createdAt, document.idempotencyKey, ...presaleFields(document, lines.length)]);
    } catch (error) {
      const { code, constraint } = errorOf(error);
      if (code !== '23505') throw error;
      throw constraint === 'presale_documents_company_id_number_key'
        ? conflict('PRESALE_DUPLICATE_NUMBER', `Number ${document.number} has already been used.`)
        : conflict('PRESALE_DUPLICATE', 'This document was already issued.');
    }
    await insertSaleLines(sql, 'presale_document_lines', 'document_id', lines);
  }

  /** A quotation or proforma is issued when it is written: only its links and cancellation change, so its lines are never rewritten. */
  async update(document: PreSaleDocument, expectedVersion: number): Promise<void> {
    const sql = this.#db.requireUnitOfWork(document.companyId).sql;
    const lineCount = saleLineRows(document.companyId, document.id, document.lines, document.pricing).length;
    const { rows } = await sql.query(updateSql('presale_documents', PRESALE_FIELDS), [document.companyId, document.id, expectedVersion, ...presaleFields(document, lineCount)]);
    if (rows.length > 0) return;
    const exists = await sql.query('SELECT 1 FROM presale_documents WHERE company_id = $1 AND id = $2', [document.companyId, document.id]);
    if (exists.rows.length === 0) throw notFound('PRESALE_NOT_FOUND', 'That quotation or proforma does not exist in this business.');
    throw conflict('PRESALE_CONCURRENT_EDIT', 'Someone else changed this document while you were working on it. Open it again to see their change.');
  }
}

// --- Delivery challans ---------------------------------------------------------------------------

const CHALLAN_KEYS = ['id', 'company_id', 'created_by', 'created_at', 'idempotency_key'] as const;
const CHALLAN_FIELDS = ['branch_id', 'state', 'number', 'financial_year', 'document_date', 'party_id', 'reason', 'reason_note', 'delivery_state_code',
  'from_state_code', 'to_state_code', 'inter_state', 'place_of_supply_state_code', 'shows_tax', 'split', 'line_count', 'taxable_value_paise',
  'cgst_paise', 'sgst_paise', 'utgst_paise', 'igst_paise', 'cess_paise', 'total_tax_paise', 'declared_rate_notice::jsonb', 'narration',
  'eway_bill_number', 'eway_bill_date', 'eway_bill_transporter', 'eway_bill_vehicle_number', 'eway_bill_source', 'eway_bill_recorded_by', 'eway_bill_recorded_at',
  'invoice_id', 'invoice_number', 'invoice_date', 'linked_by', 'linked_at', 'link_differences::jsonb', 'cancelled_by', 'cancelled_at', 'cancel_reason', 'version'] as const;
const CHALLAN_READ = `id, company_id, branch_id, state, number, financial_year, document_date::text AS document_date, party_id, reason, reason_note,
  delivery_state_code, from_state_code, to_state_code, inter_state, place_of_supply_state_code, shows_tax, split, taxable_value_paise,
  cgst_paise, sgst_paise, utgst_paise, igst_paise, cess_paise, total_tax_paise, declared_rate_notice, narration, eway_bill_number,
  eway_bill_date::text AS eway_bill_date, eway_bill_transporter, eway_bill_vehicle_number, eway_bill_source, eway_bill_recorded_by, eway_bill_recorded_at,
  invoice_id, invoice_number, invoice_date::text AS invoice_date, linked_by, linked_at, link_differences, cancelled_by, cancelled_at, cancel_reason,
  created_by, created_at, idempotency_key, version`;
const HEADS = ['cgst', 'sgst', 'utgst', 'igst', 'cess'] as const;
const CHALLAN_LINE_COLUMNS = ['company_id', 'challan_id', 'line_id', 'line_no', 'item_id', 'item_name', 'hsn_or_sac', 'quantity_micro', 'unit_code',
  'quantity_provisional', 'unit_price_paise', 'taxable_value_paise', 'rate_bp', 'cgst_paise', 'sgst_paise', 'utgst_paise', 'igst_paise', 'cess_paise',
  'exempt_supply', 'warehouse_id'] as const;

const challanFields = (c: DeliveryChallan): unknown[] => [
  branchIn(c.branchId), c.state, c.number, c.financialYear, c.documentDate, c.partyId, c.reason, c.reasonNote, c.deliveryStateCode,
  c.fromStateCode, c.toStateCode, c.interState, c.placeOfSupplyStateCode, c.showsTax, c.split, c.lines.length, paise(c.totals.taxableValue),
  ...HEADS.map((h) => paise(c.totals[h])), paise(c.totals.totalTax), toJson(c.declaredRateNotice), c.narration,
  c.ewayBill?.number ?? null, c.ewayBill?.date ?? null, c.ewayBill?.transporter ?? null, c.ewayBill?.vehicleNumber ?? null,
  c.ewayBill?.source ?? null, c.ewayBill?.recordedBy ?? null, c.ewayBill?.recordedAt ?? null,
  c.invoice?.invoiceId ?? null, c.invoice?.invoiceNumber ?? null, c.invoice?.invoiceDate ?? null, c.invoice?.linkedBy ?? null, c.invoice?.linkedAt ?? null,
  toJson(c.invoice?.differences ?? null), c.cancelledBy, c.cancelledAt, c.cancelReason, c.version,
];

const toChallanLine = (r: Row): ChallanLine => ({
  lineId: String(r.line_id),
  itemId: String(r.item_id),
  itemName: String(r.item_name),
  hsnOrSac: String(r.hsn_or_sac),
  quantity: { scaled: big(r.quantity_micro), unit: String(r.unit_code) },
  quantityProvisional: Boolean(r.quantity_provisional),
  unitPrice: inr(r.unit_price_paise),
  taxableValue: inr(r.taxable_value_paise),
  ratePercentTimes100: r.rate_bp === null ? null : big(r.rate_bp),
  cgst: inr(r.cgst_paise), sgst: inr(r.sgst_paise), utgst: inr(r.utgst_paise), igst: inr(r.igst_paise), cess: inr(r.cess_paise),
  exemptSupply: Boolean(r.exempt_supply),
  warehouseId: text(r.warehouse_id),
});

const toChallan = (r: Row, lines: readonly ChallanLine[]): DeliveryChallan => ({
  id: String(r.id),
  companyId: r.company_id as DeliveryChallan['companyId'],
  branchId: branchOut(r.branch_id),
  state: r.state as ChallanState,
  number: String(r.number),
  financialYear: String(r.financial_year),
  documentDate: r.document_date as IsoDate,
  partyId: r.party_id as DeliveryChallan['partyId'],
  reason: r.reason as DeliveryChallan['reason'],
  reasonNote: text(r.reason_note),
  deliveryStateCode: text(r.delivery_state_code),
  fromStateCode: String(r.from_state_code),
  toStateCode: text(r.to_state_code),
  interState: Boolean(r.inter_state),
  placeOfSupplyStateCode: text(r.place_of_supply_state_code),
  showsTax: Boolean(r.shows_tax),
  split: text(r.split) as DeliveryChallan['split'],
  lines,
  totals: {
    taxableValue: inr(r.taxable_value_paise),
    cgst: inr(r.cgst_paise), sgst: inr(r.sgst_paise), utgst: inr(r.utgst_paise), igst: inr(r.igst_paise), cess: inr(r.cess_paise),
    totalTax: inr(r.total_tax_paise),
  },
  declaredRateNotice: r.declared_rate_notice === null ? null : fromJson<DeliveryChallan['declaredRateNotice']>(r.declared_rate_notice),
  narration: text(r.narration),
  ewayBill: r.eway_bill_number === null ? null : {
    number: String(r.eway_bill_number), date: text(r.eway_bill_date) as IsoDate | null, transporter: text(r.eway_bill_transporter),
    vehicleNumber: text(r.eway_bill_vehicle_number), source: r.eway_bill_source as ChallanEwayBill['source'],
    recordedBy: r.eway_bill_recorded_by as ChallanEwayBill['recordedBy'], recordedAt: time(r.eway_bill_recorded_at) as string,
  },
  invoice: r.invoice_id === null ? null : {
    invoiceId: String(r.invoice_id), invoiceNumber: String(r.invoice_number), invoiceDate: r.invoice_date as IsoDate,
    linkedBy: r.linked_by as DeliveryChallan['createdBy'], linkedAt: time(r.linked_at) as string, differences: fromJson<string[]>(r.link_differences),
  },
  createdBy: r.created_by as DeliveryChallan['createdBy'],
  createdAt: time(r.created_at) as string,
  cancelledBy: text(r.cancelled_by) as DeliveryChallan['cancelledBy'],
  cancelledAt: time(r.cancelled_at),
  cancelReason: text(r.cancel_reason),
  idempotencyKey: String(r.idempotency_key),
  version: Number(r.version),
});

export class PostgresChallanRepository implements ChallanRepository {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  async #select(companyId: CompanyId, where: string, values: unknown[], page?: Page): Promise<DeliveryChallan[]> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const q = pageSql(`company_id = $1 AND ${where}`, [companyId, ...values], page);
      const { rows } = await sql.query(`SELECT ${CHALLAN_READ} FROM delivery_challans WHERE ${q.where} ${q.tail}`, q.values);
      const grouped = new Map<string, ChallanLine[]>();
      if (rows.length > 0) {
        const lines = await sql.query(
          `SELECT challan_id, ${CHALLAN_LINE_COLUMNS.slice(2).join(', ')} FROM delivery_challan_lines
            WHERE company_id = $1 AND challan_id = ANY($2::uuid[]) ORDER BY challan_id, line_no`,
          [companyId, rows.map((r) => r.id)],
        );
        for (const l of lines.rows) grouped.set(String(l.challan_id), [...(grouped.get(String(l.challan_id)) ?? []), toChallanLine(l)]);
      }
      return rows.map((r) => toChallan(r, grouped.get(String(r.id)) ?? []));
    });
  }

  async findById(companyId: CompanyId, id: string): Promise<DeliveryChallan | null> {
    return (await this.#select(companyId, 'id = $2', [id]))[0] ?? null;
  }

  async findByNumber(companyId: CompanyId, number: string): Promise<DeliveryChallan | null> {
    return (await this.#select(companyId, 'number = $2', [number]))[0] ?? null;
  }

  async findByIdempotencyKey(companyId: CompanyId, key: string): Promise<DeliveryChallan | null> {
    return (await this.#select(companyId, 'idempotency_key = $2', [key]))[0] ?? null;
  }

  list(companyId: CompanyId, filter: { partyId?: string; state?: ChallanState; invoiceId?: string } = {}, page?: Page): Promise<DeliveryChallan[]> {
    return this.#select(companyId, '($2::uuid IS NULL OR party_id = $2) AND ($3::text IS NULL OR state = $3) AND ($4::uuid IS NULL OR invoice_id = $4)',
      [filter.partyId ?? null, filter.state ?? null, filter.invoiceId ?? null], page);
  }

  async insert(challan: DeliveryChallan): Promise<void> {
    const sql = this.#db.requireUnitOfWork(challan.companyId).sql;
    try {
      await sql.query(insertSql('delivery_challans', [...CHALLAN_KEYS, ...CHALLAN_FIELDS]),
        [challan.id, challan.companyId, challan.createdBy, challan.createdAt, challan.idempotencyKey, ...challanFields(challan)]);
    } catch (error) {
      const { code, constraint } = errorOf(error);
      if (code !== '23505') throw error;
      throw constraint === 'delivery_challans_company_id_number_key'
        ? conflict('CHALLAN_DUPLICATE_NUMBER', `Challan number ${challan.number} has already been used.`)
        : conflict('CHALLAN_DUPLICATE', 'This challan was already issued.');
    }
    await insertRows(sql, 'delivery_challan_lines', CHALLAN_LINE_COLUMNS, challan.lines.map((l, i) => [
      challan.companyId, challan.id, l.lineId, i + 1, l.itemId, l.itemName, l.hsnOrSac, l.quantity.scaled.toString(), l.quantity.unit,
      l.quantityProvisional, paise(l.unitPrice), paise(l.taxableValue), l.ratePercentTimes100?.toString() ?? null, ...HEADS.map((h) => paise(l[h])),
      l.exemptSupply, l.warehouseId,
    ]));
  }

  /** A challan is issued when it is written: only its e-way bill, bill link and cancellation change, so its lines are never rewritten. */
  async update(challan: DeliveryChallan, expectedVersion: number): Promise<void> {
    const sql = this.#db.requireUnitOfWork(challan.companyId).sql;
    const { rows } = await sql.query(updateSql('delivery_challans', CHALLAN_FIELDS), [challan.companyId, challan.id, expectedVersion, ...challanFields(challan)]);
    if (rows.length > 0) return;
    const exists = await sql.query('SELECT 1 FROM delivery_challans WHERE company_id = $1 AND id = $2', [challan.companyId, challan.id]);
    if (exists.rows.length === 0) throw notFound('CHALLAN_NOT_FOUND', 'That challan does not exist in this business.');
    throw conflict('CHALLAN_CONCURRENT_EDIT', 'Someone else changed this challan while you were working on it. Open it again to see their change.');
  }
}
