// Issue #366 — the purchase lane's records in PostgreSQL: bills (#17), orders, deliveries and
// match approvals (#18), supplier checks (#19).
//
// Each class sits beside the in-memory store of the same port and behaves the same; one contract
// suite (test/purchasing-contract.ts) runs against both.
//
// The rules of docs/contracts/unit-of-work-v1.md, as they apply here:
//   - a write joins the transaction the command handler opened (`requireUnitOfWork`), and throws
//     `NO_UNIT_OF_WORK` when there is none. Nothing here opens a transaction of its own;
//   - a read goes through `tenantTransaction`, so row-level security is in force, and every query
//     names `company_id` as well;
//   - a document and its lines are read with one query per table, never one per document.
//
// And of docs/contracts/database-immutability-v1.md: an `update` sets only the columns a finished
// record may still change. A posted bill's figures and a confirmed delivery's lines are never
// sent back to the database, so a careless caller cannot even ask for them to change.

import type { CompanyId } from "@invoice/kernel";
import type { SqlExecutor, TransactionalExecutor } from "../../platform/src/database.ts";
import type { Id, IsoDate } from "../../masters/src/types.ts";
import { pageLimit, type Page } from "./paging.ts";
import { billAlreadyRecorded, billNotFound } from "./posting-adapters.ts";
import {
  matchAlreadyApproved, orderNotFound, orderNumberTaken, receiptNotFound, receiptNumberTaken,
} from "./matching-adapters.ts";
import { assessmentAlreadyRecorded, warningAlreadyAccepted } from "./supplier-risk-adapters.ts";
import type { PurchaseBillRepository } from "./posting-ports.ts";
import type { PurchaseBill, PurchaseBillLineSnapshot, PurchaseBillReceipt } from "./posting-types.ts";
import type {
  GoodsReceiptRepository, MatchApprovalRepository, MatchTolerancePort, PurchaseOrderRepository,
} from "./matching-ports.ts";
import {
  DEFAULT_MATCH_TOLERANCE, type GoodsReceipt, type GoodsReceiptLine, type GoodsReceiptMovement, type MatchApproval,
  type MatchResult, type MatchTolerancePolicy, type PurchaseOrder, type PurchaseOrderLine,
} from "./matching-types.ts";
import type {
  GstinCacheRepository, RiskAcknowledgementRepository, RiskAssessmentRepository, RiskPolicyPort,
} from "./supplier-risk-ports.ts";
import {
  DEFAULT_RISK_POLICY, type GstinLookupOutcome, type RiskAcknowledgement, type RiskPolicy, type SupplierRiskAssessment,
} from "./supplier-risk-types.ts";

// ------------------------------------------------------------------------ reading a row

type Row = Record<string, unknown>;

/** `bigint` columns arrive as strings; paise and micro-units never pass through a float. */
const big = (value: unknown): bigint => BigInt(String(value));
const instant = (value: unknown): string => (value instanceof Date ? value : new Date(String(value))).toISOString();
/** An optional field is left off the record when the column is empty, as the service builds it. */
const opt = <K extends string, V>(key: K, value: V | null | undefined): Partial<Record<K, V>> =>
  (value === null || value === undefined ? {} : { [key]: value } as Record<K, V>);
const text = (value: unknown): string | undefined => (value === null || value === undefined ? undefined : String(value));
/** A list column holds `[]` for "none"; the record leaves the field off. */
const some = <T>(value: unknown): readonly T[] | undefined => ((value as T[]).length === 0 ? undefined : (value as T[]));
const json = (value: unknown): string => JSON.stringify(value ?? []);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An id that is not an id finds nothing, as in memory, instead of failing inside PostgreSQL. */
const isUuid = (value: string): boolean => UUID.test(value);

const byParent = (rows: readonly Row[], key: string): Map<string, Row[]> => {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) grouped.set(String(row[key]), [...(grouped.get(String(row[key])) ?? []), row]);
  return grouped;
};

// ------------------------------------------------------------------------ writing rows

/** A unique-key refusal becomes the error the in-memory store raises; anything else is rethrown untouched. */
const refuse = (duplicate: () => Error) => (error: unknown): never => {
  throw (error as { code?: string }).code === "23505" ? duplicate() : error;
};

/** All the lines of a document in one statement. A column written `name::jsonb` is cast on the way in. */
const insertRows = async (
  sql: SqlExecutor, table: string, columns: readonly string[], rows: readonly (readonly unknown[])[], suffix = "",
): Promise<void> => {
  if (rows.length === 0) return;
  const names = columns.map((column) => column.split("::")[0]).join(", ");
  const values = rows.map((_, row) => `(${columns.map((column, index) =>
    `$${row * columns.length + index + 1}${column.includes("::") ? `::${column.split("::")[1]}` : ""}`).join(", ")})`).join(", ");
  await sql.query(`INSERT INTO ${table} (${names}) VALUES ${values} ${suffix}`, rows.flat());
};

/**
 * The end of a list query: oldest first, then by key, and — when a page is asked for — only the
 * rows after the one the cursor names. Appends its own parameters to `values`.
 */
const keyset = (table: string, at: string, key: string, keyType: string, page: Page | undefined, values: unknown[]): string => {
  const order = `ORDER BY ${at}, ${key}`;
  if (page === undefined) return order;
  values.push(pageLimit(page));
  const limit = `LIMIT $${values.length}`;
  if (page.after === undefined) return `${order} ${limit}`;
  values.push(page.after);
  return `AND (${at}, ${key}) > (SELECT ${at}, ${key} FROM ${table} WHERE company_id = $1 AND ${key} = $${values.length}::${keyType}) ${order} ${limit}`;
};
const cursorIsUsable = (page: Page | undefined): boolean => page?.after === undefined || isUuid(page.after);

// ============================================================================ bills (#17)

const BILL = `id, company_id, purchase_id, source_document_id, supplier_party_id, supplier_name, invoice_number,
  invoice_date::text AS invoice_date, due_date::text AS due_date, total_paise, taxable_value_paise, cgst_paise, sgst_paise,
  igst_paise, cess_paise, ineligible_itc_paise, intra_state, reverse_charge, rule_set_version, rule_id, state, voucher_id,
  reversed_by_voucher_id, reversal_reason, summary, posted_by, posted_at, idempotency_key, received_by_receipt_ids`;

export class PostgresPurchaseBillRepository implements PurchaseBillRepository {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) { this.#db = db; }

  async insert(bill: PurchaseBill): Promise<void> {
    const sql = this.#db.requireUnitOfWork(bill.companyId).sql;
    await sql.query(
      `INSERT INTO purchase_bills (id, company_id, purchase_id, source_document_id, supplier_party_id, supplier_name, invoice_number,
         invoice_date, due_date, total_paise, taxable_value_paise, cgst_paise, sgst_paise, igst_paise, cess_paise, ineligible_itc_paise,
         intra_state, reverse_charge, rule_set_version, rule_id, state, voucher_id, reversed_by_voucher_id, reversal_reason, summary,
         posted_by, posted_at, idempotency_key, received_by_receipt_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29::jsonb)`,
      [bill.id, bill.companyId, bill.purchaseId, bill.sourceDocumentId, bill.supplierPartyId, bill.supplierName, bill.invoiceNumber,
        bill.invoiceDate, bill.dueDate, bill.totalPaise.toString(), bill.tax.taxableValuePaise.toString(), bill.tax.cgstPaise.toString(),
        bill.tax.sgstPaise.toString(), bill.tax.igstPaise.toString(), bill.tax.cessPaise.toString(), bill.tax.ineligibleItcPaise.toString(),
        bill.tax.intraState, bill.tax.reverseCharge, bill.tax.ruleSetVersion ?? null, bill.tax.ruleId ?? null, bill.state, bill.voucherId,
        bill.reversedByVoucherId ?? null, bill.reversalReason ?? null, bill.summary, bill.postedBy, bill.postedAt, bill.idempotencyKey,
        json(bill.receivedByReceiptIds)],
    ).catch(refuse(billAlreadyRecorded));
    await insertRows(sql, "purchase_bill_lines",
      ["bill_id", "line_number", "company_id", "item_id", "description", "supply_kind", "quantity_micro", "quantity_unit", "warehouse_id",
        "batch_id", "serial_numbers::jsonb", "taxable_value_paise", "cgst_paise", "sgst_paise", "igst_paise", "cess_paise",
        "ineligible_itc_paise", "supplier_value_paise"],
      bill.lines.map((line) => [bill.id, line.lineNumber, bill.companyId, line.itemId, line.description, line.supplyKind,
        line.quantity.scaled.toString(), line.quantity.unit, line.warehouseId ?? null, line.batchId ?? null, json(line.serialNumbers),
        line.taxableValuePaise.toString(), line.cgstPaise.toString(), line.sgstPaise.toString(), line.igstPaise.toString(),
        line.cessPaise.toString(), line.ineligibleItcPaise.toString(), line.supplierValuePaise.toString()]));
    await insertRows(sql, "purchase_bill_receipts",
      ["bill_id", "line_number", "company_id", "stock_movement_id", "item_id", "warehouse_id", "batch_id", "serial_numbers::jsonb",
        "quantity_micro", "quantity_unit", "value_paise"],
      bill.receipts.map((receipt) => [bill.id, receipt.lineNumber, bill.companyId, receipt.stockMovementId, receipt.itemId,
        receipt.warehouseId, receipt.batchId ?? null, json(receipt.serialNumbers), receipt.quantity.scaled.toString(),
        receipt.quantity.unit, receipt.valuePaise.toString()]));
  }

  /**
   * A posted bill changes in exactly one way: it is reversed. Only the reversal's own columns are
   * written — the same four #368's rule allows — so the figures cannot be touched from here.
   */
  async update(bill: PurchaseBill): Promise<void> {
    const { rows } = await this.#db.requireUnitOfWork(bill.companyId).sql.query(
      `UPDATE purchase_bills SET state = $3, reversed_by_voucher_id = $4, reversal_reason = $5, summary = $6
        WHERE company_id = $1 AND id = $2 RETURNING id`,
      [bill.companyId, bill.id, bill.state, bill.reversedByVoucherId ?? null, bill.reversalReason ?? null, bill.summary],
    );
    if (rows.length === 0) throw billNotFound();
  }

  async findById(companyId: CompanyId, id: string): Promise<PurchaseBill | null> {
    if (!isUuid(id)) return null;
    return (await this.#select(companyId, "id = $2", [id]))[0] ?? null;
  }

  /** The earliest bill for the purchase, as the in-memory store answers. There is at most one live. */
  async findByPurchaseId(companyId: CompanyId, purchaseId: string): Promise<PurchaseBill | null> {
    return (await this.#select(companyId, "purchase_id = $2", [purchaseId]))[0] ?? null;
  }

  async listForParty(companyId: CompanyId, partyId: string, page?: Page): Promise<PurchaseBill[]> {
    if (!isUuid(partyId)) return [];
    return this.#select(companyId, "supplier_party_id = $2", [partyId], page);
  }

  list(companyId: CompanyId, page?: Page): Promise<PurchaseBill[]> {
    return this.#select(companyId, "true", [], page);
  }

  async #select(companyId: CompanyId, where: string, values: readonly unknown[], page?: Page): Promise<PurchaseBill[]> {
    if (!cursorIsUsable(page)) return [];
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const params: unknown[] = [companyId, ...values];
      const tail = keyset("purchase_bills", "posted_at", "id", "uuid", page, params);
      const bills = (await sql.query(`SELECT ${BILL} FROM purchase_bills WHERE company_id = $1 AND ${where} ${tail}`, params)).rows;
      if (bills.length === 0) return [];
      const ids = bills.map((row) => row.id);
      const lines = byParent((await sql.query(
        `SELECT bill_id, line_number, item_id, description, supply_kind, quantity_micro, quantity_unit, warehouse_id, batch_id,
                serial_numbers, taxable_value_paise, cgst_paise, sgst_paise, igst_paise, cess_paise, ineligible_itc_paise, supplier_value_paise
           FROM purchase_bill_lines WHERE company_id = $1 AND bill_id = ANY($2::uuid[]) ORDER BY bill_id, line_number`,
        [companyId, ids],
      )).rows, "bill_id");
      const receipts = byParent((await sql.query(
        `SELECT bill_id, line_number, stock_movement_id, item_id, warehouse_id, batch_id, serial_numbers, quantity_micro, quantity_unit, value_paise
           FROM purchase_bill_receipts WHERE company_id = $1 AND bill_id = ANY($2::uuid[]) ORDER BY bill_id, line_number`,
        [companyId, ids],
      )).rows, "bill_id");
      return bills.map((r): PurchaseBill => ({
        id: String(r.id), companyId: String(r.company_id), purchaseId: String(r.purchase_id), sourceDocumentId: String(r.source_document_id),
        supplierPartyId: String(r.supplier_party_id), supplierName: String(r.supplier_name), invoiceNumber: String(r.invoice_number),
        invoiceDate: String(r.invoice_date), dueDate: String(r.due_date), totalPaise: big(r.total_paise),
        tax: {
          taxableValuePaise: big(r.taxable_value_paise), cgstPaise: big(r.cgst_paise), sgstPaise: big(r.sgst_paise),
          igstPaise: big(r.igst_paise), cessPaise: big(r.cess_paise), ineligibleItcPaise: big(r.ineligible_itc_paise),
          intraState: r.intra_state === true, reverseCharge: r.reverse_charge === true,
          ...opt("ruleSetVersion", text(r.rule_set_version)), ...opt("ruleId", text(r.rule_id)),
        },
        state: r.state as PurchaseBill["state"], voucherId: String(r.voucher_id),
        lines: (lines.get(String(r.id)) ?? []).map((l): PurchaseBillLineSnapshot => ({
          lineNumber: Number(l.line_number), itemId: String(l.item_id), description: String(l.description),
          supplyKind: l.supply_kind as PurchaseBillLineSnapshot["supplyKind"],
          quantity: { scaled: big(l.quantity_micro), unit: String(l.quantity_unit) },
          ...opt("warehouseId", text(l.warehouse_id)), ...opt("batchId", text(l.batch_id)), ...opt("serialNumbers", some<string>(l.serial_numbers)),
          taxableValuePaise: big(l.taxable_value_paise), cgstPaise: big(l.cgst_paise), sgstPaise: big(l.sgst_paise),
          igstPaise: big(l.igst_paise), cessPaise: big(l.cess_paise), ineligibleItcPaise: big(l.ineligible_itc_paise),
          supplierValuePaise: big(l.supplier_value_paise),
        })),
        receipts: (receipts.get(String(r.id)) ?? []).map((m): PurchaseBillReceipt => ({
          lineNumber: Number(m.line_number), itemId: String(m.item_id), warehouseId: String(m.warehouse_id),
          ...opt("batchId", text(m.batch_id)), ...opt("serialNumbers", some<string>(m.serial_numbers)),
          quantity: { scaled: big(m.quantity_micro), unit: String(m.quantity_unit) }, valuePaise: big(m.value_paise),
          stockMovementId: String(m.stock_movement_id),
        })),
        ...opt("receivedByReceiptIds", some<Id>(r.received_by_receipt_ids)),
        postedBy: String(r.posted_by), postedAt: instant(r.posted_at), idempotencyKey: String(r.idempotency_key),
        ...opt("reversedByVoucherId", text(r.reversed_by_voucher_id)), ...opt("reversalReason", text(r.reversal_reason)),
        summary: String(r.summary),
      }));
    });
  }
}

// =========================================================================== orders (#18)

const ORDER = `id, company_id, order_number, supplier_party_id, supplier_name, order_date::text AS order_date,
  expected_date::text AS expected_date, state, ordered_value_paise, placed_by, placed_at, closed_reason, cancelled_reason, summary,
  created_by, created_at`;

export class PostgresPurchaseOrderRepository implements PurchaseOrderRepository {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) { this.#db = db; }

  async insert(order: PurchaseOrder): Promise<void> {
    const sql = this.#db.requireUnitOfWork(order.companyId).sql;
    await sql.query(
      `INSERT INTO purchase_orders (id, company_id, order_number, supplier_party_id, supplier_name, order_date, expected_date, state,
         ordered_value_paise, placed_by, placed_at, closed_reason, cancelled_reason, summary, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [order.id, order.companyId, order.orderNumber, order.supplierPartyId, order.supplierName, order.orderDate, order.expectedDate ?? null,
        order.state, order.orderedValuePaise.toString(), order.placedBy ?? null, order.placedAt ?? null, order.closedReason ?? null,
        order.cancelledReason ?? null, order.summary, order.createdBy, order.createdAt],
    ).catch(refuse(() => orderNumberTaken(order.orderNumber)));
    await insertRows(sql, "purchase_order_lines",
      ["order_id", "line_number", "company_id", "item_id", "description", "hsn_sac", "supply_kind", "quantity_micro", "quantity_unit",
        "rate_paise", "gst_rate_basis_points", "cess_rate_basis_points", "warehouse_id"],
      order.lines.map((line) => [order.id, line.lineNumber, order.companyId, line.itemId, line.description, line.hsnSac, line.supplyKind,
        line.quantity.scaled.toString(), line.quantity.unit, line.ratePaise.toString(), line.gstRateBasisPoints,
        line.cessRateBasisPoints ?? null, line.warehouseId ?? null]));
  }

  /** An order moves through its states and gathers reasons; what was ordered is never rewritten. */
  async update(order: PurchaseOrder): Promise<void> {
    const { rows } = await this.#db.requireUnitOfWork(order.companyId).sql.query(
      `UPDATE purchase_orders SET state = $3, placed_by = $4, placed_at = $5, closed_reason = $6, cancelled_reason = $7, summary = $8
        WHERE company_id = $1 AND id = $2 RETURNING id`,
      [order.companyId, order.id, order.state, order.placedBy ?? null, order.placedAt ?? null, order.closedReason ?? null,
        order.cancelledReason ?? null, order.summary],
    );
    if (rows.length === 0) throw orderNotFound();
  }

  async findById(companyId: CompanyId, id: string): Promise<PurchaseOrder | null> {
    if (!isUuid(id)) return null;
    return (await this.#select(companyId, "id = $2", [id]))[0] ?? null;
  }

  async findByNumber(companyId: CompanyId, orderNumber: string): Promise<PurchaseOrder | null> {
    return (await this.#select(companyId, "order_number = $2", [orderNumber]))[0] ?? null;
  }

  async listForParty(companyId: CompanyId, partyId: string, page?: Page): Promise<PurchaseOrder[]> {
    if (!isUuid(partyId)) return [];
    return this.#select(companyId, "supplier_party_id = $2", [partyId], page);
  }

  list(companyId: CompanyId, page?: Page): Promise<PurchaseOrder[]> {
    return this.#select(companyId, "true", [], page);
  }

  async #select(companyId: CompanyId, where: string, values: readonly unknown[], page?: Page): Promise<PurchaseOrder[]> {
    if (!cursorIsUsable(page)) return [];
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const params: unknown[] = [companyId, ...values];
      const tail = keyset("purchase_orders", "created_at", "id", "uuid", page, params);
      const orders = (await sql.query(`SELECT ${ORDER} FROM purchase_orders WHERE company_id = $1 AND ${where} ${tail}`, params)).rows;
      if (orders.length === 0) return [];
      const lines = byParent((await sql.query(
        `SELECT order_id, line_number, item_id, description, hsn_sac, supply_kind, quantity_micro, quantity_unit, rate_paise,
                gst_rate_basis_points, cess_rate_basis_points, warehouse_id
           FROM purchase_order_lines WHERE company_id = $1 AND order_id = ANY($2::uuid[]) ORDER BY order_id, line_number`,
        [companyId, orders.map((row) => row.id)],
      )).rows, "order_id");
      return orders.map((r): PurchaseOrder => ({
        id: String(r.id), companyId: String(r.company_id), orderNumber: String(r.order_number),
        supplierPartyId: String(r.supplier_party_id), supplierName: String(r.supplier_name), orderDate: String(r.order_date),
        ...opt("expectedDate", text(r.expected_date)),
        lines: (lines.get(String(r.id)) ?? []).map((l): PurchaseOrderLine => ({
          lineNumber: Number(l.line_number), itemId: String(l.item_id), description: String(l.description), hsnSac: String(l.hsn_sac),
          quantity: { scaled: big(l.quantity_micro), unit: String(l.quantity_unit) }, ratePaise: big(l.rate_paise),
          gstRateBasisPoints: Number(l.gst_rate_basis_points),
          ...opt("cessRateBasisPoints", l.cess_rate_basis_points === null ? undefined : Number(l.cess_rate_basis_points)),
          supplyKind: l.supply_kind as PurchaseOrderLine["supplyKind"], ...opt("warehouseId", text(l.warehouse_id)),
        })),
        state: r.state as PurchaseOrder["state"], orderedValuePaise: big(r.ordered_value_paise),
        ...opt("placedBy", text(r.placed_by)), ...opt("placedAt", r.placed_at === null ? undefined : instant(r.placed_at)),
        ...opt("closedReason", text(r.closed_reason)), ...opt("cancelledReason", text(r.cancelled_reason)),
        createdBy: String(r.created_by), createdAt: instant(r.created_at), summary: String(r.summary),
      }));
    });
  }
}

// ======================================================================= deliveries (#18)

const RECEIPT = `id, company_id, receipt_number, order_id, supplier_party_id, supplier_name, receipt_date::text AS receipt_date,
  delivery_note, vehicle_number, state, confirmed_by, confirmed_at, cancelled_reason, summary, created_by, created_at`;

const MOVEMENT_COLUMNS = ["receipt_id", "line_number", "company_id", "stock_movement_id", "item_id", "warehouse_id", "batch_id",
  "serial_numbers::jsonb", "quantity_micro", "quantity_unit", "value_paise"] as const;
const movementRows = (receipt: GoodsReceipt): unknown[][] => receipt.movements.map((movement) => [
  receipt.id, movement.lineNumber, receipt.companyId, movement.stockMovementId, movement.itemId, movement.warehouseId,
  movement.batchId ?? null, json(movement.serialNumbers), movement.quantity.scaled.toString(), movement.quantity.unit,
  movement.valuePaise.toString()]);

export class PostgresGoodsReceiptRepository implements GoodsReceiptRepository {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) { this.#db = db; }

  async insert(receipt: GoodsReceipt): Promise<void> {
    const sql = this.#db.requireUnitOfWork(receipt.companyId).sql;
    await sql.query(
      `INSERT INTO goods_receipts (id, company_id, receipt_number, order_id, supplier_party_id, supplier_name, receipt_date, delivery_note,
         vehicle_number, state, confirmed_by, confirmed_at, cancelled_reason, summary, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [receipt.id, receipt.companyId, receipt.receiptNumber, receipt.orderId ?? null, receipt.supplierPartyId, receipt.supplierName,
        receipt.receiptDate, receipt.deliveryNote ?? null, receipt.vehicleNumber ?? null, receipt.state, receipt.confirmedBy ?? null,
        receipt.confirmedAt ?? null, receipt.cancelledReason ?? null, receipt.summary, receipt.createdBy, receipt.createdAt],
    ).catch(refuse(() => receiptNumberTaken(receipt.receiptNumber)));
    await insertRows(sql, "goods_receipt_lines",
      ["receipt_id", "line_number", "company_id", "order_line_number", "item_id", "description", "warehouse_id", "batch_id",
        "serial_numbers::jsonb", "received_quantity_micro", "accepted_quantity_micro", "quantity_unit", "rate_paise", "rejection_reason",
        "rejection_note", "quality_checked_by", "quality_checked_at", "quality_note", "quality_photo_ids::jsonb", "quality_document_ids::jsonb"],
      receipt.lines.map((line) => [receipt.id, line.lineNumber, receipt.companyId, line.orderLineNumber ?? null, line.itemId, line.description,
        line.warehouseId, line.batchId ?? null, json(line.serialNumbers), line.receivedQuantity.scaled.toString(),
        line.acceptedQuantity.scaled.toString(), line.receivedQuantity.unit, line.ratePaise.toString(), line.rejectionReason ?? null,
        line.rejectionNote ?? null, line.evidence?.checkedBy ?? null, line.evidence?.checkedAt ?? null, line.evidence?.note ?? null,
        json(line.evidence?.photoIds), json(line.evidence?.documentIds)]));
    await insertRows(sql, "goods_receipt_movements", MOVEMENT_COLUMNS, movementRows(receipt));
  }

  /**
   * A delivery is confirmed, or cancelled. Its lines were written once and are not sent again:
   * after confirmation #368 freezes them, and the service never changes them before it.
   *
   * What the confirmation put on the shelf is added here, once. A cancellation carries the same
   * movements again, and those are already on record — hence "do nothing" for a line that is.
   */
  async update(receipt: GoodsReceipt): Promise<void> {
    const sql = this.#db.requireUnitOfWork(receipt.companyId).sql;
    const { rows } = await sql.query(
      `UPDATE goods_receipts SET state = $3, confirmed_by = $4, confirmed_at = $5, cancelled_reason = $6, summary = $7
        WHERE company_id = $1 AND id = $2 RETURNING id`,
      [receipt.companyId, receipt.id, receipt.state, receipt.confirmedBy ?? null, receipt.confirmedAt ?? null,
        receipt.cancelledReason ?? null, receipt.summary],
    );
    if (rows.length === 0) throw receiptNotFound();
    await insertRows(sql, "goods_receipt_movements", MOVEMENT_COLUMNS, movementRows(receipt), "ON CONFLICT (receipt_id, line_number) DO NOTHING");
  }

  async findById(companyId: CompanyId, id: string): Promise<GoodsReceipt | null> {
    if (!isUuid(id)) return null;
    return (await this.#select(companyId, "id = $2", [id]))[0] ?? null;
  }

  async findByNumber(companyId: CompanyId, receiptNumber: string): Promise<GoodsReceipt | null> {
    return (await this.#select(companyId, "receipt_number = $2", [receiptNumber]))[0] ?? null;
  }

  async listForOrder(companyId: CompanyId, orderId: string, page?: Page): Promise<GoodsReceipt[]> {
    if (!isUuid(orderId)) return [];
    return this.#select(companyId, "order_id = $2", [orderId], page);
  }

  async listForParty(companyId: CompanyId, partyId: string, page?: Page): Promise<GoodsReceipt[]> {
    if (!isUuid(partyId)) return [];
    return this.#select(companyId, "supplier_party_id = $2", [partyId], page);
  }

  list(companyId: CompanyId, page?: Page): Promise<GoodsReceipt[]> {
    return this.#select(companyId, "true", [], page);
  }

  async #select(companyId: CompanyId, where: string, values: readonly unknown[], page?: Page): Promise<GoodsReceipt[]> {
    if (!cursorIsUsable(page)) return [];
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const params: unknown[] = [companyId, ...values];
      const tail = keyset("goods_receipts", "created_at", "id", "uuid", page, params);
      const found = (await sql.query(`SELECT ${RECEIPT} FROM goods_receipts WHERE company_id = $1 AND ${where} ${tail}`, params)).rows;
      if (found.length === 0) return [];
      const ids = found.map((row) => row.id);
      const lines = byParent((await sql.query(
        `SELECT receipt_id, line_number, order_line_number, item_id, description, warehouse_id, batch_id, serial_numbers,
                received_quantity_micro, accepted_quantity_micro, quantity_unit, rate_paise, rejection_reason, rejection_note,
                quality_checked_by, quality_checked_at, quality_note, quality_photo_ids, quality_document_ids
           FROM goods_receipt_lines WHERE company_id = $1 AND receipt_id = ANY($2::uuid[]) ORDER BY receipt_id, line_number`,
        [companyId, ids],
      )).rows, "receipt_id");
      const movements = byParent((await sql.query(
        `SELECT receipt_id, line_number, stock_movement_id, item_id, warehouse_id, batch_id, serial_numbers, quantity_micro, quantity_unit, value_paise
           FROM goods_receipt_movements WHERE company_id = $1 AND receipt_id = ANY($2::uuid[]) ORDER BY receipt_id, line_number`,
        [companyId, ids],
      )).rows, "receipt_id");
      return found.map((r): GoodsReceipt => ({
        id: String(r.id), companyId: String(r.company_id), receiptNumber: String(r.receipt_number), ...opt("orderId", text(r.order_id)),
        supplierPartyId: String(r.supplier_party_id), supplierName: String(r.supplier_name), receiptDate: String(r.receipt_date),
        ...opt("deliveryNote", text(r.delivery_note)), ...opt("vehicleNumber", text(r.vehicle_number)),
        lines: (lines.get(String(r.id)) ?? []).map((l): GoodsReceiptLine => ({
          lineNumber: Number(l.line_number), ...opt("orderLineNumber", l.order_line_number === null ? undefined : Number(l.order_line_number)),
          itemId: String(l.item_id), description: String(l.description), warehouseId: String(l.warehouse_id),
          ...opt("batchId", text(l.batch_id)), ...opt("serialNumbers", some<string>(l.serial_numbers)),
          receivedQuantity: { scaled: big(l.received_quantity_micro), unit: String(l.quantity_unit) },
          acceptedQuantity: { scaled: big(l.accepted_quantity_micro), unit: String(l.quantity_unit) },
          ...opt("rejectionReason", (l.rejection_reason ?? undefined) as GoodsReceiptLine["rejectionReason"]),
          ...opt("rejectionNote", text(l.rejection_note)), ratePaise: big(l.rate_paise),
          ...(l.quality_checked_by === null ? {} : { evidence: {
            checkedBy: String(l.quality_checked_by), checkedAt: instant(l.quality_checked_at), ...opt("note", text(l.quality_note)),
            ...opt("photoIds", some<string>(l.quality_photo_ids)), ...opt("documentIds", some<string>(l.quality_document_ids)),
          } }),
        })),
        state: r.state as GoodsReceipt["state"],
        movements: (movements.get(String(r.id)) ?? []).map((m): GoodsReceiptMovement => ({
          lineNumber: Number(m.line_number), itemId: String(m.item_id), warehouseId: String(m.warehouse_id),
          ...opt("batchId", text(m.batch_id)), ...opt("serialNumbers", some<string>(m.serial_numbers)),
          quantity: { scaled: big(m.quantity_micro), unit: String(m.quantity_unit) }, valuePaise: big(m.value_paise),
          stockMovementId: String(m.stock_movement_id),
        })),
        ...opt("confirmedBy", text(r.confirmed_by)), ...opt("confirmedAt", r.confirmed_at === null ? undefined : instant(r.confirmed_at)),
        ...opt("cancelledReason", text(r.cancelled_reason)),
        createdBy: String(r.created_by), createdAt: instant(r.created_at), summary: String(r.summary),
      }));
    });
  }
}

// ================================================================== match approvals (#18)

export class PostgresMatchApprovalRepository implements MatchApprovalRepository {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) { this.#db = db; }

  async insert(companyId: CompanyId, approval: MatchApproval, match: Pick<MatchResult, "purchaseId" | "invoiceNumber">): Promise<void> {
    await this.#db.requireUnitOfWork(companyId).sql.query(
      `INSERT INTO purchase_match_approvals (company_id, match_fingerprint, purchase_id, invoice_number, accepted_codes, reason, approved_by, approved_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [companyId, approval.matchFingerprint, match.purchaseId, match.invoiceNumber, json(approval.accepted), approval.reason,
        approval.approvedBy, approval.approvedAt],
    ).catch(refuse(matchAlreadyApproved));
  }

  findByFingerprint(companyId: CompanyId, fingerprint: string): Promise<MatchApproval | null> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const r = (await sql.query(
        `SELECT match_fingerprint, approved_by, approved_at, reason, accepted_codes
           FROM purchase_match_approvals WHERE company_id = $1 AND match_fingerprint = $2`,
        [companyId, fingerprint],
      )).rows[0];
      return r === undefined ? null : {
        matchFingerprint: String(r.match_fingerprint), approvedBy: String(r.approved_by), approvedAt: instant(r.approved_at),
        reason: String(r.reason), accepted: r.accepted_codes as MatchApproval["accepted"],
      };
    });
  }
}

/** Effective-dated tolerances: the one in force on the date asked for, or the product's default. */
export class PostgresMatchTolerances implements MatchTolerancePort {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) { this.#db = db; }

  /** Setting the tolerance for a date again replaces it, as in memory. `setBy` is who decided. */
  async set(companyId: CompanyId, policy: MatchTolerancePolicy, setBy: Id): Promise<void> {
    await this.#db.requireUnitOfWork(companyId).sql.query(
      `INSERT INTO purchase_match_tolerances (company_id, effective_from, quantity_basis_points, quantity_absolute_micro, price_basis_points,
         price_absolute_paise, tax_absolute_paise, allow_over_delivery, set_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (company_id, effective_from) DO UPDATE SET quantity_basis_points = EXCLUDED.quantity_basis_points,
         quantity_absolute_micro = EXCLUDED.quantity_absolute_micro, price_basis_points = EXCLUDED.price_basis_points,
         price_absolute_paise = EXCLUDED.price_absolute_paise, tax_absolute_paise = EXCLUDED.tax_absolute_paise,
         allow_over_delivery = EXCLUDED.allow_over_delivery, set_by = EXCLUDED.set_by, set_at = now()`,
      [companyId, policy.effectiveFrom, policy.quantityBasisPoints, policy.quantityAbsoluteMicro.toString(), policy.priceBasisPoints,
        policy.priceAbsolutePaise.toString(), policy.taxAbsolutePaise.toString(), policy.allowOverDelivery, setBy],
    );
  }

  policyFor(companyId: CompanyId, on: string): Promise<MatchTolerancePolicy> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const r = (await sql.query(
        `SELECT effective_from::text AS effective_from, quantity_basis_points, quantity_absolute_micro, price_basis_points,
                price_absolute_paise, tax_absolute_paise, allow_over_delivery
           FROM purchase_match_tolerances WHERE company_id = $1 AND effective_from <= $2::date ORDER BY effective_from DESC LIMIT 1`,
        [companyId, on],
      )).rows[0];
      return r === undefined ? DEFAULT_MATCH_TOLERANCE : {
        quantityBasisPoints: Number(r.quantity_basis_points), quantityAbsoluteMicro: big(r.quantity_absolute_micro),
        priceBasisPoints: Number(r.price_basis_points), priceAbsolutePaise: big(r.price_absolute_paise),
        taxAbsolutePaise: big(r.tax_absolute_paise), allowOverDelivery: r.allow_over_delivery === true,
        effectiveFrom: String(r.effective_from),
      };
    });
  }
}

// ==================================================================== supplier checks (#19)

export class PostgresRiskAssessmentRepository implements RiskAssessmentRepository {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) { this.#db = db; }

  async insert(assessment: SupplierRiskAssessment, assessedBy: Id): Promise<void> {
    await this.#db.requireUnitOfWork(assessment.companyId).sql.query(
      `INSERT INTO supplier_risk_assessments (company_id, fingerprint, supplier_party_id, supplier_name, gstin, invoice_number, invoice_date,
         level, confidence, warnings, sources, policy, lights, summary, assessed_by, assessed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14, $15, $16)`,
      [assessment.companyId, assessment.fingerprint, assessment.supplierPartyId, assessment.supplierName, assessment.gstin ?? null,
        assessment.invoiceNumber ?? null, assessment.invoiceDate ?? null, assessment.level, assessment.confidence, json(assessment.warnings),
        json(assessment.sources), JSON.stringify(assessment.policy), json(assessment.lights), assessment.summary, assessedBy,
        assessment.assessedAt],
    ).catch(refuse(assessmentAlreadyRecorded));
  }

  async findByFingerprint(companyId: CompanyId, fingerprint: string): Promise<SupplierRiskAssessment | null> {
    return (await this.#select(companyId, "fingerprint = $2", [fingerprint]))[0] ?? null;
  }

  async listForParty(companyId: CompanyId, partyId: Id, page?: Page): Promise<SupplierRiskAssessment[]> {
    if (!isUuid(partyId)) return [];
    return this.#select(companyId, "supplier_party_id = $2", [partyId], page);
  }

  #select(companyId: CompanyId, where: string, values: readonly unknown[], page?: Page): Promise<SupplierRiskAssessment[]> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const params: unknown[] = [companyId, ...values];
      // Byte order, not the database's language rules, so the pages fall where the in-memory store puts them.
      const tail = keyset("supplier_risk_assessments", "assessed_at", `fingerprint COLLATE "C"`, "text", page, params);
      const { rows } = await sql.query(
        `SELECT company_id, fingerprint, supplier_party_id, supplier_name, gstin, invoice_number, invoice_date::text AS invoice_date,
                level, confidence, warnings, sources, policy, lights, summary, assessed_at
           FROM supplier_risk_assessments WHERE company_id = $1 AND ${where} ${tail}`,
        params,
      );
      return rows.map((r): SupplierRiskAssessment => ({
        companyId: String(r.company_id), supplierPartyId: String(r.supplier_party_id), supplierName: String(r.supplier_name),
        ...opt("gstin", text(r.gstin)), ...opt("invoiceNumber", text(r.invoice_number)), ...opt("invoiceDate", text(r.invoice_date)),
        level: r.level as SupplierRiskAssessment["level"], warnings: r.warnings as SupplierRiskAssessment["warnings"],
        lights: r.lights as SupplierRiskAssessment["lights"], sources: r.sources as SupplierRiskAssessment["sources"],
        confidence: r.confidence as SupplierRiskAssessment["confidence"], policy: r.policy as RiskPolicy,
        fingerprint: String(r.fingerprint), summary: String(r.summary), assessedAt: instant(r.assessed_at),
      }));
    });
  }
}

export class PostgresRiskAcknowledgementRepository implements RiskAcknowledgementRepository {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) { this.#db = db; }

  async insert(companyId: CompanyId, acknowledgement: RiskAcknowledgement): Promise<void> {
    await this.#db.requireUnitOfWork(companyId).sql.query(
      `INSERT INTO supplier_risk_acknowledgements (company_id, assessment_fingerprint, supplier_party_id, accepted_codes, reason,
         acknowledged_by, acknowledged_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
      [companyId, acknowledgement.assessmentFingerprint, acknowledgement.supplierPartyId, json(acknowledgement.accepted),
        acknowledgement.reason, acknowledgement.acknowledgedBy, acknowledgement.acknowledgedAt],
    ).catch(refuse(warningAlreadyAccepted));
  }

  findByFingerprint(companyId: CompanyId, fingerprint: string): Promise<RiskAcknowledgement | null> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const r = (await sql.query(
        `SELECT assessment_fingerprint, supplier_party_id, acknowledged_by, acknowledged_at, reason, accepted_codes
           FROM supplier_risk_acknowledgements WHERE company_id = $1 AND assessment_fingerprint = $2`,
        [companyId, fingerprint],
      )).rows[0];
      return r === undefined ? null : {
        assessmentFingerprint: String(r.assessment_fingerprint), supplierPartyId: String(r.supplier_party_id),
        acknowledgedBy: String(r.acknowledged_by), acknowledgedAt: instant(r.acknowledged_at), reason: String(r.reason),
        accepted: r.accepted_codes as RiskAcknowledgement["accepted"],
      };
    });
  }
}

/** Effective-dated freshness rules, exactly as the tolerances above are kept. */
export class PostgresRiskPolicies implements RiskPolicyPort {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) { this.#db = db; }

  async set(companyId: CompanyId, policy: RiskPolicy, setBy: Id): Promise<void> {
    await this.#db.requireUnitOfWork(companyId).sql.query(
      `INSERT INTO supplier_risk_policies (company_id, effective_from, government_data_stale_after_days, new_registration_days,
         bank_change_recent_days, missed_return_periods, set_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (company_id, effective_from) DO UPDATE SET government_data_stale_after_days = EXCLUDED.government_data_stale_after_days,
         new_registration_days = EXCLUDED.new_registration_days, bank_change_recent_days = EXCLUDED.bank_change_recent_days,
         missed_return_periods = EXCLUDED.missed_return_periods, set_by = EXCLUDED.set_by, set_at = now()`,
      [companyId, policy.effectiveFrom, policy.governmentDataStaleAfterDays, policy.newRegistrationDays, policy.bankChangeRecentDays,
        policy.missedReturnPeriods, setBy],
    );
  }

  policyFor(companyId: CompanyId, on: IsoDate): Promise<RiskPolicy> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const r = (await sql.query(
        `SELECT effective_from::text AS effective_from, government_data_stale_after_days, new_registration_days, bank_change_recent_days,
                missed_return_periods
           FROM supplier_risk_policies WHERE company_id = $1 AND effective_from <= $2::date ORDER BY effective_from DESC LIMIT 1`,
        [companyId, on],
      )).rows[0];
      return r === undefined ? DEFAULT_RISK_POLICY : {
        governmentDataStaleAfterDays: Number(r.government_data_stale_after_days), newRegistrationDays: Number(r.new_registration_days),
        bankChangeRecentDays: Number(r.bank_change_recent_days), missedReturnPeriods: Number(r.missed_return_periods),
        effectiveFrom: String(r.effective_from),
      };
    });
  }
}

/**
 * The last thing the GST department told us about a number, one row per number.
 *
 * `put` is a write like any other and needs an open unit of work. It is called by
 * `gstinStatusAdapter` straight after the department answers, and a unit of work must never be
 * held open across that call — so whoever composes the adapter (#340) wraps this `put`, and only
 * this `put`, in its own short `db.unitOfWork`.
 */
export class PostgresGstinCache implements GstinCacheRepository {
  readonly #db: TransactionalExecutor;

  constructor(db: TransactionalExecutor) { this.#db = db; }

  get(companyId: CompanyId, gstin: string): Promise<GstinLookupOutcome | null> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      const r = (await sql.query(
        `SELECT gstin, status, legal_name, trade_name, state_code, registered_on::text AS registered_on,
                status_changed_on::text AS status_changed_on, e_invoice_enabled, filings, observed_at
           FROM supplier_gstin_readings WHERE company_id = $1 AND gstin = $2`,
        [companyId, gstin],
      )).rows[0];
      if (r === undefined) return null;
      return { kind: "FOUND", record: {
        gstin: String(r.gstin), status: r.status as GstinRecordStatus, ...opt("legalName", text(r.legal_name)),
        ...opt("tradeName", text(r.trade_name)), ...opt("stateCode", text(r.state_code)), ...opt("registeredOn", text(r.registered_on)),
        ...opt("statusChangedOn", text(r.status_changed_on)), filings: r.filings as FoundRecord["filings"],
        ...opt("eInvoiceEnabled", (r.e_invoice_enabled ?? undefined) as boolean | undefined), observedAt: instant(r.observed_at),
      } };
    });
  }

  /** Only an answer is kept; "could not ask" is not a reading. A newer answer replaces the older one. */
  async put(companyId: CompanyId, outcome: GstinLookupOutcome): Promise<void> {
    if (outcome.kind !== "FOUND") return;
    const record = outcome.record;
    await this.#db.requireUnitOfWork(companyId).sql.query(
      `INSERT INTO supplier_gstin_readings (company_id, gstin, status, legal_name, trade_name, state_code, registered_on, status_changed_on,
         e_invoice_enabled, filings, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
       ON CONFLICT (company_id, gstin) DO UPDATE SET status = EXCLUDED.status, legal_name = EXCLUDED.legal_name,
         trade_name = EXCLUDED.trade_name, state_code = EXCLUDED.state_code, registered_on = EXCLUDED.registered_on,
         status_changed_on = EXCLUDED.status_changed_on, e_invoice_enabled = EXCLUDED.e_invoice_enabled, filings = EXCLUDED.filings,
         observed_at = EXCLUDED.observed_at`,
      [companyId, record.gstin, record.status, record.legalName ?? null, record.tradeName ?? null, record.stateCode ?? null,
        record.registeredOn ?? null, record.statusChangedOn ?? null, record.eInvoiceEnabled ?? null, json(record.filings), record.observedAt],
    );
  }
}

type FoundRecord = Extract<GstinLookupOutcome, { kind: "FOUND" }>["record"];
type GstinRecordStatus = FoundRecord["status"];
