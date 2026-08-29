/**
 * Issue #18 [E18] — the same Bengaluru trader as #17, now buying against an order.
 *
 * Sampoorna Traders orders 100 boxes of soap from Shree Ram Steels; 90 arrive fit to sell, 10 are
 * soaked; the bill charges for all 100. Synthetic throughout — the GSTIN comes from
 * `syntheticGstin`, so no real taxpayer appears here.
 */
import { fixedClock, isoDate, quantityFromString } from "@invoice/kernel";
import {
  InMemoryAuditPort, InMemoryLedgerStore, LedgerService, buildDefaultChart, defaultChartIdFactory,
  permissionPortFromActor,
} from "@invoice/ledger";
import { InMemoryInventoryStore } from "../../inventory/src/repository.ts";
import { InventoryService } from "../../inventory/src/service.ts";
import { Masters, COMPANY, SUPPLIER, actorWith } from "./posting-fixtures.ts";
import { purchaseInventoryPort } from "./posting-adapters.ts";
import {
  InMemoryGoodsReceiptStore, InMemoryMatchApprovalStore, InMemoryMatchTolerances,
  InMemoryPurchaseOrderStore,
} from "./matching-adapters.ts";
import { ThreeWayMatchingService } from "./matching-service.ts";
import type { GoodsReceiptLine, PurchaseOrderLine } from "./matching-types.ts";
import type { MatchInvoice, MatchInvoiceLine } from "./matching.ts";

export { COMPANY, SUPPLIER, actorWith } from "./posting-fixtures.ts";

/** Everything #18 needs, plus the permissions a buyer and a godown keeper actually hold. */
export const MATCHING_PERMISSIONS = [
  "purchase.order.write", "purchase.order.cancel", "purchase.receipt.write", "purchase.match.approve",
  "inventory.move", "inventory.adjust", "inventory.override_negative",
  "ledger.setup", "ledger.post.purchase", "ledger.reverse",
];

let counter = 0;

/** A working yard: a ledger, a godown and the matching service wired to both. */
export const makeYard = async (options: { permissions?: readonly string[] } = {}) => {
  const store = new InMemoryLedgerStore();
  const inventory = new InMemoryInventoryStore();
  const orders = new InMemoryPurchaseOrderStore();
  const receipts = new InMemoryGoodsReceiptStore();
  const approvals = new InMemoryMatchApprovalStore();
  store.join(inventory).join(orders).join(receipts).join(approvals);
  const audit = new InMemoryAuditPort();
  const clock = fixedClock("2026-08-29T10:00:00.000Z");
  const tolerances = new InMemoryMatchTolerances();
  counter += 1;
  let n = 0;

  const masters = new Masters();
  const ledger = new LedgerService({ store, permissions: permissionPortFromActor, audit, clock });
  const inventoryService = new InventoryService({
    store, inventory, masterData: new Masters(), permissions: permissionPortFromActor, audit, clock,
    policy: { negativeStock: "BLOCK", reservationMinutes: 120, valuationMethod: "WEIGHTED_AVERAGE" },
    idFactory: () => `mv${counter}-${String((n += 1)).padStart(4, "0")}`,
  });
  const matching = new ThreeWayMatchingService({
    store, inventory: purchaseInventoryPort(inventoryService, masters), orders, receipts, approvals,
    audit, clock, tolerance: tolerances,
    idFactory: () => `doc${counter}-${String((n += 1)).padStart(4, "0")}`,
  });

  const setup = actorWith(MATCHING_PERMISSIONS);
  await ledger.initialiseCompany(setup, {
    booksStartDate: isoDate("2026-04-01"),
    accounts: buildDefaultChart(COMPANY, defaultChartIdFactory(COMPANY)),
  });
  await ledger.openPartyAccount(setup, { partyId: SUPPLIER, name: "Shree Ram Steels Private Limited", kind: "SUPPLIER" });

  return {
    store, inventory, inventoryService, orders, receipts, approvals, audit, ledger, matching, tolerances,
    actor: actorWith(options.permissions ?? MATCHING_PERMISSIONS),
  };
};

/** Overrides may name a field as `undefined` to leave it off entirely, as #17's fixtures do. */
type Overrides<T> = { [K in keyof T]?: T[K] | undefined };

const drop = <T>(value: object): T => {
  const out: Record<string, unknown> = { ...value };
  for (const [key, item] of Object.entries(out)) if (item === undefined) delete out[key];
  return out as T;
};

/** One hundred boxes of soap at ₹240 a box, 18% GST, into the Peenya godown. */
export const soapOrderLine = (over: Overrides<PurchaseOrderLine> = {}): PurchaseOrderLine => drop<PurchaseOrderLine>({
  lineNumber: 1, itemId: "SOAP", description: "Herbal Bath Soap 100g", hsnSac: "34011190",
  quantity: quantityFromString("100", "BOX"), ratePaise: 240_00n, gstRateBasisPoints: 1800,
  supplyKind: "GOODS", warehouseId: "wh-main", ...over,
} as PurchaseOrderLine);

/** Ninety kept, ten soaked. The delivery in the issue's own example. */
export const soapReceiptLine = (over: Overrides<GoodsReceiptLine> = {}): GoodsReceiptLine => drop<GoodsReceiptLine>({
  lineNumber: 1, orderLineNumber: 1, itemId: "SOAP", description: "Herbal Bath Soap 100g",
  warehouseId: "wh-main", batchId: "batch-aug",
  receivedQuantity: quantityFromString("100", "BOX"),
  acceptedQuantity: quantityFromString("90", "BOX"),
  rejectionReason: "DAMAGED",
  rejectionNote: "10 boxes soaked in the rain, cartons torn",
  ratePaise: 240_00n,
  evidence: {
    checkedBy: "ravi", checkedAt: "2026-08-20T09:30:00.000Z",
    note: "Counted at the gate with the lorry driver present.",
    photoIds: ["photo-grn-1", "photo-grn-2"],
    documentIds: ["challan-SRS-8891"],
  },
  ...over,
});

export const soapInvoiceLine = (over: Overrides<MatchInvoiceLine> = {}): MatchInvoiceLine => drop<MatchInvoiceLine>({
  lineNumber: 1, itemId: "SOAP", description: "Herbal Bath Soap 100g",
  quantity: quantityFromString("100", "BOX"), ratePaise: 240_00n, gstRateBasisPoints: 1800, ...over,
} as MatchInvoiceLine);

export const soapInvoice = (over: Partial<MatchInvoice> = {}): MatchInvoice => ({
  purchaseId: "pur-soap-1",
  invoiceNumber: "SRS/2026/0088",
  supplierPartyId: SUPPLIER,
  lines: [soapInvoiceLine()],
  ...over,
});

export const ORDER_INPUT = {
  orderNumber: "PO/2026/0117",
  supplierPartyId: SUPPLIER,
  supplierName: "Shree Ram Steels Private Limited",
  orderDate: "2026-08-15",
  expectedDate: "2026-08-20",
  lines: [soapOrderLine()],
};

export const RECEIPT_INPUT = {
  receiptNumber: "GRN/2026/0304",
  supplierPartyId: SUPPLIER,
  supplierName: "Shree Ram Steels Private Limited",
  receiptDate: "2026-08-20",
  deliveryNote: "Challan SRS-8891",
  vehicleNumber: "KA51AB1234",
  lines: [soapReceiptLine()],
};
