// Issue #289, part 2b — the reverse-charge register in PostgreSQL, beside the in-memory store of the
// same port (reverse-charge-register.ts). The rules of docs/contracts/unit-of-work-v1.md: a write
// joins the transaction the command handler opened; a read goes through `tenantTransaction` and
// names `company_id` as well. Both tables are append-only (reverse-charge-migrations.ts).

import type { CompanyId, IsoDate } from "@invoice/kernel";
import type { TransactionalExecutor } from "../../platform/src/database.ts";
import {
  reverseChargeAlreadyRecorded, selfInvoiceAlreadyIssued, selfInvoiceNumberTaken,
  type RegisterParty, type ReverseChargeLine, type ReverseChargePurchase, type ReverseChargeRegisterRepository, type SelfInvoice,
} from "./reverse-charge-register.ts";

type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const instant = (value: unknown): string => (value instanceof Date ? value : new Date(String(value))).toISOString();

/** Lines go to `jsonb` with their paise as strings, and come back as `bigint`, never through a float. */
const linesJson = (lines: readonly ReverseChargeLine[]): string => JSON.stringify(lines.map((line) => ({
  ...line,
  taxableValuePaise: line.taxableValuePaise.toString(), cgstPaise: line.cgstPaise.toString(), sgstPaise: line.sgstPaise.toString(),
  igstPaise: line.igstPaise.toString(), cessPaise: line.cessPaise.toString(),
})));
const linesOf = (value: unknown): readonly ReverseChargeLine[] => (value as Record<string, unknown>[]).map((line) => ({
  lineNumber: Number(line.lineNumber), description: String(line.description), hsnSac: String(line.hsnSac),
  quantity: String(line.quantity), unit: String(line.unit), gstRateBasisPoints: Number(line.gstRateBasisPoints),
  taxableValuePaise: BigInt(String(line.taxableValuePaise)), cgstPaise: BigInt(String(line.cgstPaise)), sgstPaise: BigInt(String(line.sgstPaise)),
  igstPaise: BigInt(String(line.igstPaise)), cessPaise: BigInt(String(line.cessPaise)),
}));

/** A unique-key refusal becomes the in-memory store's error; anything else is rethrown untouched. */
const refuse = (constraint: (name: string) => Error) => (error: unknown): never => {
  const failure = error as { code?: string; constraint?: string };
  throw failure.code === "23505" ? constraint(failure.constraint ?? "") : error;
};

const PURCHASE = `company_id, bill_id, supplier_party_id, supplier, supplier_registered, supply_kind, invoice_number,
  invoice_date::text AS invoice_date, received_on::text AS received_on, entered_on::text AS entered_on, inter_state, lines,
  recorded_by, recorded_at`;
const INVOICE = `id, company_id, bill_id, number, financial_year, sequence, issued_on::text AS issued_on, received_on::text AS received_on,
  supplier, recipient, place_of_supply, inter_state, lines, taxable_value_paise, cgst_paise, sgst_paise, igst_paise, cess_paise,
  issued_by, issued_at, idempotency_key`;

const purchaseOf = (r: Row): ReverseChargePurchase => ({
  companyId: String(r.company_id) as CompanyId, billId: String(r.bill_id), supplierPartyId: String(r.supplier_party_id),
  supplier: r.supplier as RegisterParty, supplierRegistered: Boolean(r.supplier_registered),
  supplyKind: r.supply_kind as ReverseChargePurchase["supplyKind"], invoiceNumber: String(r.invoice_number),
  invoiceDate: String(r.invoice_date) as IsoDate, receivedOn: String(r.received_on) as IsoDate, enteredOn: String(r.entered_on) as IsoDate,
  interState: Boolean(r.inter_state), lines: linesOf(r.lines), recordedBy: String(r.recorded_by), recordedAt: instant(r.recorded_at),
});

const invoiceOf = (r: Row): SelfInvoice => ({
  id: String(r.id), companyId: String(r.company_id) as CompanyId, billId: String(r.bill_id), number: String(r.number),
  financialYear: String(r.financial_year), sequence: Number(r.sequence), issuedOn: String(r.issued_on) as IsoDate,
  receivedOn: String(r.received_on) as IsoDate, supplier: r.supplier as RegisterParty, recipient: r.recipient as RegisterParty,
  placeOfSupply: r.place_of_supply as SelfInvoice["placeOfSupply"], interState: Boolean(r.inter_state), lines: linesOf(r.lines),
  taxableValuePaise: BigInt(String(r.taxable_value_paise)), cgstPaise: BigInt(String(r.cgst_paise)), sgstPaise: BigInt(String(r.sgst_paise)),
  igstPaise: BigInt(String(r.igst_paise)), cessPaise: BigInt(String(r.cess_paise)), issuedBy: String(r.issued_by),
  issuedAt: instant(r.issued_at), idempotencyKey: String(r.idempotency_key),
});

export class PostgresReverseChargeRegister implements ReverseChargeRegisterRepository {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) { this.#db = db; }

  async insertPurchase(purchase: ReverseChargePurchase): Promise<void> {
    await this.#db.requireUnitOfWork(purchase.companyId).sql.query(
      `INSERT INTO purchase_reverse_charge (company_id, bill_id, supplier_party_id, supplier, supplier_registered, supply_kind, invoice_number,
         invoice_date, received_on, entered_on, inter_state, lines, recorded_by, recorded_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)`,
      [purchase.companyId, purchase.billId, purchase.supplierPartyId, JSON.stringify(purchase.supplier), purchase.supplierRegistered,
        purchase.supplyKind, purchase.invoiceNumber, purchase.invoiceDate, purchase.receivedOn, purchase.enteredOn, purchase.interState,
        linesJson(purchase.lines), purchase.recordedBy, purchase.recordedAt],
    ).catch(refuse(() => reverseChargeAlreadyRecorded()));
  }

  async purchaseFor(companyId: CompanyId, billId: string): Promise<ReverseChargePurchase | null> {
    if (!UUID.test(billId)) return null;
    return (await this.#purchases(companyId, "bill_id = $2", [billId]))[0] ?? null;
  }

  purchases(companyId: CompanyId): Promise<readonly ReverseChargePurchase[]> {
    return this.#purchases(companyId, "true", []);
  }

  async insertSelfInvoice(invoice: SelfInvoice): Promise<void> {
    await this.#db.requireUnitOfWork(invoice.companyId).sql.query(
      `INSERT INTO purchase_self_invoices (id, company_id, bill_id, number, financial_year, sequence, issued_on, received_on, supplier,
         recipient, place_of_supply, inter_state, lines, taxable_value_paise, cgst_paise, sgst_paise, igst_paise, cess_paise, issued_by,
         issued_at, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13::jsonb, $14, $15, $16, $17, $18, $19, $20, $21)`,
      [invoice.id, invoice.companyId, invoice.billId, invoice.number, invoice.financialYear, invoice.sequence, invoice.issuedOn,
        invoice.receivedOn, JSON.stringify(invoice.supplier), JSON.stringify(invoice.recipient), JSON.stringify(invoice.placeOfSupply),
        invoice.interState, linesJson(invoice.lines), invoice.taxableValuePaise.toString(), invoice.cgstPaise.toString(),
        invoice.sgstPaise.toString(), invoice.igstPaise.toString(), invoice.cessPaise.toString(), invoice.issuedBy, invoice.issuedAt,
        invoice.idempotencyKey],
    ).catch(refuse((constraint) => /sequence|number/.test(constraint) ? selfInvoiceNumberTaken() : selfInvoiceAlreadyIssued()));
  }

  async selfInvoiceFor(companyId: CompanyId, billId: string): Promise<SelfInvoice | null> {
    if (!UUID.test(billId)) return null;
    return (await this.#invoices(companyId, "bill_id = $2", [billId]))[0] ?? null;
  }

  async selfInvoiceByKey(companyId: CompanyId, idempotencyKey: string): Promise<SelfInvoice | null> {
    return (await this.#invoices(companyId, "idempotency_key = $2", [idempotencyKey]))[0] ?? null;
  }

  selfInvoices(companyId: CompanyId): Promise<readonly SelfInvoice[]> {
    return this.#invoices(companyId, "true", []);
  }

  lastSelfInvoiceSequence(companyId: CompanyId, financialYear: string): Promise<number> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const { rows } = await sql.query(
        `SELECT coalesce(max(sequence), 0) AS last FROM purchase_self_invoices WHERE company_id = $1 AND financial_year = $2`,
        [companyId, financialYear],
      );
      return Number(rows[0]?.last ?? 0);
    });
  }

  #purchases(companyId: CompanyId, where: string, values: readonly unknown[]): Promise<ReverseChargePurchase[]> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const { rows } = await sql.query(
        `SELECT ${PURCHASE} FROM purchase_reverse_charge WHERE company_id = $1 AND ${where} ORDER BY recorded_at, bill_id`,
        [companyId, ...values],
      );
      return rows.map(purchaseOf);
    });
  }

  #invoices(companyId: CompanyId, where: string, values: readonly unknown[]): Promise<SelfInvoice[]> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const { rows } = await sql.query(
        `SELECT ${INVOICE} FROM purchase_self_invoices WHERE company_id = $1 AND ${where} ORDER BY financial_year, sequence`,
        [companyId, ...values],
      );
      return rows.map(invoiceOf);
    });
  }
}
