/**
 * Issue #366 — one contract suite for the purchase lane's stores, run against the in-memory
 * classes (purchasing-contract.test.ts) and against PostgreSQL as the application role
 * (purchasing-contract.integration.test.ts).
 *
 * Every test makes its own company, so files can run side by side against one database.
 * Everything here is invented: no real business, GST number or person.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { syntheticGstin } from "../../masters/src/fixtures.ts";
import type { CompanyId } from "@invoice/kernel";
import type { Id } from "../../masters/src/types.ts";
import { DEFAULT_MATCH_TOLERANCE, type GoodsReceipt, type MatchApproval, type MatchTolerancePolicy, type PurchaseOrder } from "../src/matching-types.ts";
import type { GoodsReceiptRepository, MatchApprovalRepository, MatchTolerancePort, PurchaseOrderRepository } from "../src/matching-ports.ts";
import type { PurchaseBillRepository } from "../src/posting-ports.ts";
import type { PurchaseBill } from "../src/posting-types.ts";
import type { GstinCacheRepository, RiskAcknowledgementRepository, RiskAssessmentRepository, RiskPolicyPort } from "../src/supplier-risk-ports.ts";
import { DEFAULT_RISK_POLICY, type GstinLookupOutcome, type RiskAcknowledgement, type RiskPolicy, type SupplierRiskAssessment } from "../src/supplier-risk-types.ts";

export interface Scene {
  readonly companyId: CompanyId; readonly userId: Id; readonly partyId: Id; readonly itemId: Id; readonly warehouseId: Id; readonly batchId: Id;
}

export interface PurchasingHarness {
  readonly bills: PurchaseBillRepository;
  readonly orders: PurchaseOrderRepository;
  readonly receipts: GoodsReceiptRepository;
  readonly approvals: MatchApprovalRepository;
  readonly tolerances: MatchTolerancePort & { set(companyId: CompanyId, policy: MatchTolerancePolicy, setBy: Id): void | Promise<void> };
  readonly assessments: RiskAssessmentRepository;
  readonly acknowledgements: RiskAcknowledgementRepository;
  readonly policies: RiskPolicyPort & { set(companyId: CompanyId, policy: RiskPolicy, setBy: Id): void | Promise<void> };
  readonly cache: GstinCacheRepository;
  /** A company, a person and the masters a purchase points at, wherever the implementation keeps them. */
  scene(): Promise<Scene>;
  /** One business action: committed when `work` resolves, nothing left when it throws. */
  write<T>(companyId: CompanyId, work: () => Promise<T>): Promise<T>;
  /** True where a write outside `write` must be refused (PostgreSQL). */
  readonly requiresUnitOfWork: boolean;
}

const code = (...expected: string[]) => (error: unknown) => expected.includes((error as { code?: string }).code ?? "");
/** Above 2^53, so a figure that went through a float would come back wrong. */
const HUGE = 9_007_199_254_740_993n;
const at = (second: number) => new Date(Date.UTC(2026, 6, 1, 10, 0, second, 123)).toISOString();

export const billFor = (s: Scene, n: number, extra: Partial<PurchaseBill> = {}): PurchaseBill => ({
  id: crypto.randomUUID(), companyId: s.companyId, purchaseId: `purchase-${n}-${crypto.randomUUID()}`, sourceDocumentId: `doc-${n}`,
  supplierPartyId: s.partyId, supplierName: "Synthetic Steel Traders", invoiceNumber: `SST/26-27/${String(n).padStart(4, "0")}`,
  invoiceDate: "2026-07-01", dueDate: "2026-07-31", totalPaise: HUGE,
  tax: { taxableValuePaise: 100_000n, cgstPaise: 9_000n, sgstPaise: 9_000n, igstPaise: 0n, cessPaise: 0n, ineligibleItcPaise: 0n,
    intraState: true, reverseCharge: false, ruleSetVersion: "2026.07", ruleId: "intra-state" },
  state: "POSTED", voucherId: crypto.randomUUID(),
  lines: [
    { lineNumber: 1, itemId: s.itemId, description: "TMT bars 12 mm", supplyKind: "GOODS", quantity: { scaled: 1_500_000n, unit: "KGS" },
      warehouseId: s.warehouseId, batchId: s.batchId, serialNumbers: ["SN-1", "SN-2"], taxableValuePaise: 90_000n, cgstPaise: 8_100n,
      sgstPaise: 8_100n, igstPaise: 0n, cessPaise: 0n, ineligibleItcPaise: 0n, supplierValuePaise: 106_200n },
    { lineNumber: 2, itemId: s.itemId, description: "Cutting charges", supplyKind: "SERVICES", quantity: { scaled: 1_000_000n, unit: "NOS" },
      taxableValuePaise: 10_000n, cgstPaise: 900n, sgstPaise: 900n, igstPaise: 0n, cessPaise: 0n, ineligibleItcPaise: 0n, supplierValuePaise: 11_800n },
  ],
  receipts: [{ lineNumber: 1, itemId: s.itemId, warehouseId: s.warehouseId, batchId: s.batchId, serialNumbers: ["SN-1", "SN-2"],
    quantity: { scaled: 1_500_000n, unit: "KGS" }, valuePaise: 90_000n, stockMovementId: crypto.randomUUID() }],
  receivedByReceiptIds: [crypto.randomUUID()],
  postedBy: s.userId, postedAt: at(n), idempotencyKey: `post-${n}`,
  summary: "₹1,180 is now owed to Synthetic Steel Traders.", ...extra,
});

export const orderFor = (s: Scene, n: number, extra: Partial<PurchaseOrder> = {}): PurchaseOrder => ({
  id: crypto.randomUUID(), companyId: s.companyId, orderNumber: `PO/2026/${n}`, supplierPartyId: s.partyId, supplierName: "Synthetic Steel Traders",
  orderDate: "2026-06-20", expectedDate: "2026-06-30",
  lines: [
    { lineNumber: 1, itemId: s.itemId, description: "TMT bars 12 mm", hsnSac: "7214", quantity: { scaled: 2_000_000n, unit: "KGS" },
      ratePaise: HUGE, gstRateBasisPoints: 1800, cessRateBasisPoints: 100, supplyKind: "GOODS", warehouseId: s.warehouseId },
    { lineNumber: 2, itemId: s.itemId, description: "Cutting", hsnSac: "9988", quantity: { scaled: 1_000_000n, unit: "NOS" },
      ratePaise: 500n, gstRateBasisPoints: 1800, supplyKind: "SERVICES" },
  ],
  state: "DRAFT", orderedValuePaise: HUGE, createdBy: s.userId, createdAt: at(n), summary: `Order PO/2026/${n}.`, ...extra,
});

export const receiptFor = (s: Scene, n: number, extra: Partial<GoodsReceipt> = {}): GoodsReceipt => ({
  id: crypto.randomUUID(), companyId: s.companyId, receiptNumber: `GRN/2026/${n}`, supplierPartyId: s.partyId, supplierName: "Synthetic Steel Traders",
  receiptDate: "2026-06-28", deliveryNote: "Challan 77", vehicleNumber: "KA01AB1234",
  lines: [
    { lineNumber: 1, orderLineNumber: 1, itemId: s.itemId, description: "TMT bars 12 mm", warehouseId: s.warehouseId, batchId: s.batchId,
      serialNumbers: ["SN-9"], receivedQuantity: { scaled: 2_000_000n, unit: "KGS" }, acceptedQuantity: { scaled: 1_800_000n, unit: "KGS" },
      rejectionReason: "DAMAGED", rejectionNote: "Rusted", ratePaise: HUGE,
      evidence: { checkedBy: s.userId, checkedAt: at(50), note: "Two bundles rusted", photoIds: ["photo-1"], documentIds: ["slip-1"] } },
    { lineNumber: 2, itemId: s.itemId, description: "Binding wire", warehouseId: s.warehouseId,
      receivedQuantity: { scaled: 1_000_000n, unit: "KGS" }, acceptedQuantity: { scaled: 1_000_000n, unit: "KGS" }, ratePaise: 7_000n },
  ],
  state: "DRAFT", movements: [], createdBy: s.userId, createdAt: at(n), summary: `Delivery GRN/2026/${n}.`, ...extra,
});

export const assessmentFor = (s: Scene, n: number, extra: Partial<SupplierRiskAssessment> = {}): SupplierRiskAssessment => ({
  companyId: s.companyId, supplierPartyId: s.partyId, supplierName: "Synthetic Steel Traders", gstin: syntheticGstin("29", `SYNTH${String(n).padStart(4, "0")}Q`),
  invoiceNumber: `SST/${n}`, invoiceDate: "2026-07-01", level: "SERIOUS",
  warnings: [{ code: "GSTIN_CANCELLED_BEFORE_INVOICE", level: "SERIOUS", message: "The GST department lists this registration as cancelled.",
    suggestedAction: "Check with the supplier before you pay.",
    evidence: [{ source: "GST_PORTAL", statement: "Status: cancelled", effectiveFrom: "2026-06-01", observedAt: at(1), ageInDays: 0, stale: false }] }],
  lights: [
    { scope: "GOVERNMENT", colour: "RED", title: "The GST department's records", headline: "Stop and check before you pay", detail: "Cancelled.", warningCount: 1 },
    { scope: "OUR_RECORDS", colour: "GREEN", title: "Our own books", headline: "Nothing to flag", detail: "No concerns.", warningCount: 0 },
  ],
  sources: [{ source: "GST_PORTAL", consulted: true, answered: true, stale: false, observedAt: at(1), note: "Answered." }],
  confidence: "PARTIAL", policy: DEFAULT_RISK_POLICY, fingerprint: `fp-${n}-${crypto.randomUUID()}`, summary: "Check before you pay.",
  assessedAt: at(n), ...extra,
});

export function purchasingContract(label: string, harness: () => PurchasingHarness, skip: false | string = false): void {
  const t = (name: string, body: () => Promise<void>) => test(`${label}: ${name}`, { skip }, body);
  const setUp = async () => { const h = harness(); return { h, s: await h.scene() }; };

  // ------------------------------------------------------------------------------ bills

  t("a bill comes back exactly as it went in, by id, by purchase and in lists", async () => {
    const { h, s } = await setUp();
    const bill = billFor(s, 1);
    await h.write(s.companyId, () => h.bills.insert(bill));
    assert.deepEqual(await h.bills.findById(s.companyId, bill.id), bill);
    assert.deepEqual(await h.bills.findByPurchaseId(s.companyId, bill.purchaseId), bill);
    assert.deepEqual(await h.bills.list(s.companyId), [bill]);
    assert.deepEqual(await h.bills.listForParty(s.companyId, s.partyId), [bill]);
    assert.deepEqual(await h.bills.listForParty(s.companyId, crypto.randomUUID()), []);
  });

  t("a bill without the optional parts keeps them absent, not empty", async () => {
    const { h, s } = await setUp();
    const full = billFor(s, 2);
    const { ruleSetVersion: _v, ruleId: _r, ...tax } = full.tax;
    const { receivedByReceiptIds: _ids, ...rest } = full;
    const bare: PurchaseBill = { ...rest, tax, lines: [full.lines[1]!], receipts: [] };
    await h.write(s.companyId, () => h.bills.insert(bare));
    assert.deepEqual(await h.bills.findById(s.companyId, bare.id), bare);
  });

  t("reversing a bill keeps its figures and records the reversal", async () => {
    const { h, s } = await setUp();
    const bill = billFor(s, 3);
    await h.write(s.companyId, () => h.bills.insert(bill));
    const reversed: PurchaseBill = { ...bill, state: "REVERSED", reversedByVoucherId: crypto.randomUUID(), reversalReason: "Entered twice", summary: "Reversed." };
    await h.write(s.companyId, () => h.bills.update(reversed));
    assert.deepEqual(await h.bills.findById(s.companyId, bill.id), reversed);
  });

  t("a bill is never recorded twice, but a reversed one may be approved afresh", async () => {
    const { h, s } = await setUp();
    const bill = billFor(s, 4);
    await h.write(s.companyId, () => h.bills.insert(bill));
    await assert.rejects(h.write(s.companyId, () => h.bills.insert({ ...bill, id: crypto.randomUUID(), invoiceNumber: "OTHER/1" })), code("PURCHASE_DUPLICATE"), "same purchase");
    await assert.rejects(h.write(s.companyId, () => h.bills.insert({ ...billFor(s, 4), invoiceNumber: bill.invoiceNumber })), code("PURCHASE_DUPLICATE"), "same supplier bill number");
    await h.write(s.companyId, () => h.bills.update({ ...bill, state: "REVERSED", reversedByVoucherId: crypto.randomUUID(), reversalReason: "Wrong grade", summary: "Reversed." }));
    const again = { ...billFor(s, 5), invoiceNumber: bill.invoiceNumber };
    await h.write(s.companyId, () => h.bills.insert(again));
    assert.equal((await h.bills.listForParty(s.companyId, s.partyId)).length, 2);
  });

  t("a bill that does not exist is not found and cannot be updated", async () => {
    const { h, s } = await setUp();
    assert.equal(await h.bills.findById(s.companyId, crypto.randomUUID()), null);
    assert.equal(await h.bills.findById(s.companyId, "not-an-id"), null);
    assert.equal(await h.bills.findByPurchaseId(s.companyId, "nothing"), null);
    await assert.rejects(h.write(s.companyId, () => h.bills.update(billFor(s, 6))), code("PURCHASE_BILL_UNKNOWN"));
  });

  // ----------------------------------------------------------------------------- orders

  t("an order comes back exactly as it went in, and moves through its states", async () => {
    const { h, s } = await setUp();
    const order = orderFor(s, 1);
    await h.write(s.companyId, () => h.orders.insert(order));
    assert.deepEqual(await h.orders.findById(s.companyId, order.id), order);
    assert.deepEqual(await h.orders.findByNumber(s.companyId, order.orderNumber), order);
    assert.deepEqual(await h.orders.list(s.companyId), [order]);
    assert.deepEqual(await h.orders.listForParty(s.companyId, s.partyId), [order]);
    const placed: PurchaseOrder = { ...order, state: "PLACED", placedBy: s.userId, placedAt: at(9), summary: "Placed." };
    await h.write(s.companyId, () => h.orders.update(placed));
    const closed: PurchaseOrder = { ...placed, state: "CLOSED", closedReason: "Rest not needed", summary: "Closed." };
    await h.write(s.companyId, () => h.orders.update(closed));
    assert.deepEqual(await h.orders.findById(s.companyId, order.id), closed);
    const { expectedDate: _e, ...bare } = orderFor(s, 2);
    await h.write(s.companyId, () => h.orders.insert(bare));
    assert.deepEqual(await h.orders.findById(s.companyId, bare.id), bare);
  });

  t("one order number is one order, and an unknown order is not found", async () => {
    const { h, s } = await setUp();
    const order = orderFor(s, 3);
    await h.write(s.companyId, () => h.orders.insert(order));
    await assert.rejects(h.write(s.companyId, () => h.orders.insert({ ...orderFor(s, 3) })), code("ORDER_NUMBER_TAKEN"));
    assert.equal(await h.orders.findById(s.companyId, crypto.randomUUID()), null);
    assert.equal(await h.orders.findByNumber(s.companyId, "PO/none"), null);
    await assert.rejects(h.write(s.companyId, () => h.orders.update(orderFor(s, 4))), code("ORDER_UNKNOWN"));
  });

  // ------------------------------------------------------------------------- deliveries

  t("a delivery keeps its lines and evidence, is confirmed with what it moved, then cancelled", async () => {
    const { h, s } = await setUp();
    const order = orderFor(s, 5);
    await h.write(s.companyId, () => h.orders.insert(order));
    const receipt = receiptFor(s, 1, { orderId: order.id });
    await h.write(s.companyId, () => h.receipts.insert(receipt));
    assert.deepEqual(await h.receipts.findById(s.companyId, receipt.id), receipt);
    const confirmed: GoodsReceipt = {
      ...receipt, state: "CONFIRMED", confirmedBy: s.userId, confirmedAt: at(20), summary: "Confirmed.",
      movements: [
        { lineNumber: 1, itemId: s.itemId, warehouseId: s.warehouseId, batchId: s.batchId, serialNumbers: ["SN-9"], quantity: { scaled: 1_800_000n, unit: "KGS" }, valuePaise: HUGE, stockMovementId: crypto.randomUUID() },
        { lineNumber: 2, itemId: s.itemId, warehouseId: s.warehouseId, quantity: { scaled: 1_000_000n, unit: "KGS" }, valuePaise: 7_000n, stockMovementId: crypto.randomUUID() },
      ],
    };
    await h.write(s.companyId, () => h.receipts.update(confirmed));
    assert.deepEqual(await h.receipts.findById(s.companyId, receipt.id), confirmed);
    const cancelled: GoodsReceipt = { ...confirmed, state: "CANCELLED", cancelledReason: "Wrong supplier", summary: "Cancelled." };
    await h.write(s.companyId, () => h.receipts.update(cancelled));
    assert.deepEqual(await h.receipts.findById(s.companyId, receipt.id), cancelled);
    assert.deepEqual(await h.receipts.findByNumber(s.companyId, receipt.receiptNumber), cancelled);
    assert.deepEqual(await h.receipts.listForOrder(s.companyId, order.id), [cancelled]);
    assert.deepEqual(await h.receipts.listForParty(s.companyId, s.partyId), [cancelled]);
    assert.deepEqual(await h.receipts.list(s.companyId), [cancelled]);
  });

  t("one delivery number is one delivery, and an unknown delivery is not found", async () => {
    const { h, s } = await setUp();
    const { deliveryNote: _d, vehicleNumber: _v, ...bare } = receiptFor(s, 2);
    await h.write(s.companyId, () => h.receipts.insert(bare));
    assert.deepEqual(await h.receipts.findById(s.companyId, bare.id), bare);
    await assert.rejects(h.write(s.companyId, () => h.receipts.insert(receiptFor(s, 2))), code("RECEIPT_NUMBER_TAKEN"));
    assert.equal(await h.receipts.findById(s.companyId, "GRN-1"), null);
    assert.deepEqual(await h.receipts.listForOrder(s.companyId, crypto.randomUUID()), []);
    await assert.rejects(h.write(s.companyId, () => h.receipts.update(receiptFor(s, 3))), code("RECEIPT_UNKNOWN"));
  });

  // --------------------------------------------------------------- approvals and tolerances

  t("a match approval is kept once, against its fingerprint", async () => {
    const { h, s } = await setUp();
    const approval: MatchApproval = { matchFingerprint: `match-${crypto.randomUUID()}`, approvedBy: s.userId, approvedAt: at(30),
      reason: "Agreed on the phone", accepted: ["INVOICED_ABOVE_ACCEPTED", "PRICE_ABOVE_ORDER"] };
    const about = { purchaseId: "purchase-77", invoiceNumber: "SST/77" };
    await h.write(s.companyId, () => h.approvals.insert(s.companyId, approval, about));
    assert.deepEqual(await h.approvals.findByFingerprint(s.companyId, approval.matchFingerprint), approval);
    assert.equal(await h.approvals.findByFingerprint(s.companyId, "nothing"), null);
    await assert.rejects(h.write(s.companyId, () => h.approvals.insert(s.companyId, approval, about)), code("MATCH_ALREADY_APPROVED"));
  });

  t("the tolerance in force on a date is the latest one that had started, else the default", async () => {
    const { h, s } = await setUp();
    assert.deepEqual(await h.tolerances.policyFor(s.companyId, "2026-07-01"), DEFAULT_MATCH_TOLERANCE);
    const april = { ...DEFAULT_MATCH_TOLERANCE, quantityAbsoluteMicro: HUGE, effectiveFrom: "2026-04-01" };
    const july = { ...DEFAULT_MATCH_TOLERANCE, priceBasisPoints: 200, allowOverDelivery: true, effectiveFrom: "2026-07-01" };
    await h.write(s.companyId, async () => { await h.tolerances.set(s.companyId, april, s.userId); await h.tolerances.set(s.companyId, july, s.userId); });
    assert.deepEqual(await h.tolerances.policyFor(s.companyId, "2026-06-30"), april);
    assert.deepEqual(await h.tolerances.policyFor(s.companyId, "2026-07-01"), july);
    const replaced = { ...july, taxAbsolutePaise: 500n };
    await h.write(s.companyId, async () => h.tolerances.set(s.companyId, replaced, s.userId));
    assert.deepEqual(await h.tolerances.policyFor(s.companyId, "2026-08-01"), replaced);
  });

  // --------------------------------------------------------------------- supplier checks

  t("a supplier check comes back exactly as it was shown, once per fingerprint", async () => {
    const { h, s } = await setUp();
    const assessment = assessmentFor(s, 1);
    await h.write(s.companyId, () => h.assessments.insert(assessment, s.userId));
    assert.deepEqual(await h.assessments.findByFingerprint(s.companyId, assessment.fingerprint), assessment);
    assert.deepEqual(await h.assessments.listForParty(s.companyId, s.partyId), [assessment]);
    const { gstin: _g, invoiceNumber: _n, invoiceDate: _d, ...bare } = assessmentFor(s, 2);
    await h.write(s.companyId, () => h.assessments.insert(bare, s.userId));
    assert.deepEqual(await h.assessments.findByFingerprint(s.companyId, bare.fingerprint), bare);
    assert.equal(await h.assessments.findByFingerprint(s.companyId, "nothing"), null);
    await assert.rejects(h.write(s.companyId, () => h.assessments.insert(assessment, s.userId)), code("SUPPLIER_RISK_ALREADY_RECORDED"));
  });

  t("going ahead despite a warning is kept once, against the assessment", async () => {
    const { h, s } = await setUp();
    const ack: RiskAcknowledgement = { assessmentFingerprint: `fp-${crypto.randomUUID()}`, supplierPartyId: s.partyId, acknowledgedBy: s.userId,
      acknowledgedAt: at(40), reason: "Supplier showed the revocation order", accepted: ["GSTIN_CANCELLED_BEFORE_INVOICE"] };
    await h.write(s.companyId, () => h.acknowledgements.insert(s.companyId, ack));
    assert.deepEqual(await h.acknowledgements.findByFingerprint(s.companyId, ack.assessmentFingerprint), ack);
    assert.equal(await h.acknowledgements.findByFingerprint(s.companyId, "nothing"), null);
    await assert.rejects(h.write(s.companyId, () => h.acknowledgements.insert(s.companyId, ack)), code("SUPPLIER_RISK_ALREADY_ACCEPTED"));
  });

  t("the freshness rules in force on a date are the latest that had started, else the default", async () => {
    const { h, s } = await setUp();
    assert.deepEqual(await h.policies.policyFor(s.companyId, "2026-07-01"), DEFAULT_RISK_POLICY);
    const strict = { ...DEFAULT_RISK_POLICY, governmentDataStaleAfterDays: 2, effectiveFrom: "2026-06-01" };
    await h.write(s.companyId, async () => h.policies.set(s.companyId, strict, s.userId));
    assert.deepEqual(await h.policies.policyFor(s.companyId, "2026-05-31"), DEFAULT_RISK_POLICY);
    assert.deepEqual(await h.policies.policyFor(s.companyId, "2026-06-01"), strict);
    const replaced = { ...strict, missedReturnPeriods: 4 };
    await h.write(s.companyId, async () => h.policies.set(s.companyId, replaced, s.userId));
    assert.deepEqual(await h.policies.policyFor(s.companyId, "2026-07-01"), replaced);
  });

  t("the last answer from the GST department is kept, replaced by a newer one, and an outage is not kept", async () => {
    const { h, s } = await setUp();
    const gstin = syntheticGstin("27", `SYNTH${String(3).padStart(4, "0")}Q`);
    assert.equal(await h.cache.get(s.companyId, gstin), null);
    const first: GstinLookupOutcome = { kind: "FOUND", record: { gstin, status: "ACTIVE", legalName: "Synthetic Steel Traders", tradeName: "SST",
      stateCode: "27", registeredOn: "2020-01-15", filings: [{ period: "06-2026", returnType: "GSTR3B", filedOn: "2026-07-20", status: "FILED" }],
      eInvoiceEnabled: true, observedAt: at(1) } };
    await h.write(s.companyId, () => h.cache.put(s.companyId, first));
    assert.deepEqual(await h.cache.get(s.companyId, gstin), first);
    const later: GstinLookupOutcome = { kind: "FOUND", record: { gstin, status: "CANCELLED", statusChangedOn: "2026-06-01", filings: [], observedAt: at(2) } };
    await h.write(s.companyId, () => h.cache.put(s.companyId, later));
    assert.deepEqual(await h.cache.get(s.companyId, gstin), later);
    await h.write(s.companyId, () => h.cache.put(s.companyId, { kind: "UNAVAILABLE", reason: "TIMEOUT", retryable: true, explanation: "No answer." }));
    assert.deepEqual(await h.cache.get(s.companyId, gstin), later);
  });

  // -------------------------------------------------------------------------- isolation

  t("one business can neither read nor change another's records", async () => {
    const h = harness();
    const a = await h.scene();
    const b = await h.scene();
    const bill = billFor(a, 1); const order = orderFor(a, 1); const receipt = receiptFor(a, 1); const assessment = assessmentFor(a, 1);
    const approval: MatchApproval = { matchFingerprint: `m-${crypto.randomUUID()}`, approvedBy: a.userId, approvedAt: at(1), reason: "ok", accepted: [] };
    const ack: RiskAcknowledgement = { assessmentFingerprint: assessment.fingerprint, supplierPartyId: a.partyId, acknowledgedBy: a.userId, acknowledgedAt: at(1), reason: "ok", accepted: [] };
    const gstin = syntheticGstin("29", `SYNTH${String(8).padStart(4, "0")}Q`);
    await h.write(a.companyId, async () => {
      await h.bills.insert(bill); await h.orders.insert(order); await h.receipts.insert(receipt);
      await h.approvals.insert(a.companyId, approval, { purchaseId: "p", invoiceNumber: "n" });
      await h.assessments.insert(assessment, a.userId); await h.acknowledgements.insert(a.companyId, ack);
      await h.tolerances.set(a.companyId, { ...DEFAULT_MATCH_TOLERANCE, priceBasisPoints: 999 }, a.userId);
      await h.policies.set(a.companyId, { ...DEFAULT_RISK_POLICY, missedReturnPeriods: 9 }, a.userId);
      await h.cache.put(a.companyId, { kind: "FOUND", record: { gstin, status: "ACTIVE", filings: [], observedAt: at(1) } });
    });
    assert.equal(await h.bills.findById(b.companyId, bill.id), null);
    assert.equal(await h.bills.findByPurchaseId(b.companyId, bill.purchaseId), null);
    assert.deepEqual(await h.bills.list(b.companyId), []);
    assert.deepEqual(await h.bills.listForParty(b.companyId, a.partyId), []);
    assert.equal(await h.orders.findById(b.companyId, order.id), null);
    assert.equal(await h.orders.findByNumber(b.companyId, order.orderNumber), null);
    assert.deepEqual(await h.orders.list(b.companyId), []);
    assert.equal(await h.receipts.findById(b.companyId, receipt.id), null);
    assert.deepEqual(await h.receipts.list(b.companyId), []);
    assert.equal(await h.approvals.findByFingerprint(b.companyId, approval.matchFingerprint), null);
    assert.equal(await h.assessments.findByFingerprint(b.companyId, assessment.fingerprint), null);
    assert.deepEqual(await h.assessments.listForParty(b.companyId, a.partyId), []);
    assert.equal(await h.acknowledgements.findByFingerprint(b.companyId, ack.assessmentFingerprint), null);
    assert.deepEqual(await h.tolerances.policyFor(b.companyId, "2026-07-01"), DEFAULT_MATCH_TOLERANCE);
    assert.deepEqual(await h.policies.policyFor(b.companyId, "2026-07-01"), DEFAULT_RISK_POLICY);
    assert.equal(await h.cache.get(b.companyId, gstin), null);
    // Changing A's records while acting for B finds nothing to change.
    await assert.rejects(h.write(b.companyId, () => h.bills.update({ ...bill, companyId: b.companyId, state: "REVERSED" })), code("PURCHASE_BILL_UNKNOWN"));
    await assert.rejects(h.write(b.companyId, () => h.orders.update({ ...order, companyId: b.companyId, state: "CANCELLED" })), code("ORDER_UNKNOWN"));
    await assert.rejects(h.write(b.companyId, () => h.receipts.update({ ...receipt, companyId: b.companyId, state: "CANCELLED" })), code("RECEIPT_UNKNOWN"));
    assert.equal((await h.orders.findById(a.companyId, order.id))?.state, "DRAFT");
  });

  // ---------------------------------------------------------------- transactions

  t("an action that fails part-way leaves nothing behind", async () => {
    const { h, s } = await setUp();
    const bill = billFor(s, 1); const order = orderFor(s, 1); const receipt = receiptFor(s, 1); const assessment = assessmentFor(s, 1);
    const fingerprint = `m-${crypto.randomUUID()}`;
    await assert.rejects(h.write(s.companyId, async () => {
      await h.bills.insert(bill); await h.orders.insert(order); await h.receipts.insert(receipt);
      await h.approvals.insert(s.companyId, { matchFingerprint: fingerprint, approvedBy: s.userId, approvedAt: at(1), reason: "ok", accepted: [] }, { purchaseId: "p", invoiceNumber: "n" });
      await h.assessments.insert(assessment, s.userId);
      await h.acknowledgements.insert(s.companyId, { assessmentFingerprint: assessment.fingerprint, supplierPartyId: s.partyId, acknowledgedBy: s.userId, acknowledgedAt: at(1), reason: "ok", accepted: [] });
      throw new Error("the godown refused the third line");
    }), /godown refused/);
    assert.deepEqual(await h.bills.list(s.companyId), []);
    assert.deepEqual(await h.orders.list(s.companyId), []);
    assert.deepEqual(await h.receipts.list(s.companyId), []);
    assert.equal(await h.approvals.findByFingerprint(s.companyId, fingerprint), null);
    assert.deepEqual(await h.assessments.listForParty(s.companyId, s.partyId), []);
    assert.equal(await h.acknowledgements.findByFingerprint(s.companyId, assessment.fingerprint), null);
  });

  // -------------------------------------------------------------------- pagination

  t("pages return every row exactly once, oldest first", async () => {
    const { h, s } = await setUp();
    // Two rows share a moment, so the tie is broken by key.
    const seconds = [5, 1, 3, 3, 9];
    const bills = seconds.map((second, i) => billFor(s, 10 + i, { postedAt: at(second) }));
    const orders = seconds.map((second, i) => orderFor(s, 10 + i, { createdAt: at(second) }));
    const receipts = seconds.map((second, i) => receiptFor(s, 10 + i, { createdAt: at(second) }));
    const assessments = seconds.map((second, i) => assessmentFor(s, 10 + i, { assessedAt: at(second) }));
    await h.write(s.companyId, async () => {
      for (const row of bills) await h.bills.insert(row);
      for (const row of orders) await h.orders.insert(row);
      for (const row of receipts) await h.receipts.insert(row);
      for (const row of assessments) await h.assessments.insert(row, s.userId);
    });
    const walk = async <T>(fetch: (page: { limit: number; after?: string }) => Promise<T[]>, key: (row: T) => string): Promise<string[]> => {
      const seen: string[] = [];
      for (let after: string | undefined; ;) {
        const page = await fetch(after === undefined ? { limit: 2 } : { limit: 2, after });
        seen.push(...page.map(key));
        if (page.length < 2) return seen;
        after = key(page.at(-1)!);
      }
    };
    const expected = <T>(rows: T[], when: (row: T) => string, key: (row: T) => string) =>
      [...rows].sort((l, r) => when(l) < when(r) ? -1 : when(l) > when(r) ? 1 : key(l) < key(r) ? -1 : 1).map(key);
    const id = (row: { id: string }) => row.id;
    assert.deepEqual(await walk((p) => h.bills.list(s.companyId, p), id), expected(bills, (b) => b.postedAt, id));
    assert.deepEqual(await walk((p) => h.bills.listForParty(s.companyId, s.partyId, p), id), expected(bills, (b) => b.postedAt, id));
    assert.deepEqual(await walk((p) => h.orders.list(s.companyId, p), id), expected(orders, (o) => o.createdAt, id));
    assert.deepEqual(await walk((p) => h.orders.listForParty(s.companyId, s.partyId, p), id), expected(orders, (o) => o.createdAt, id));
    assert.deepEqual(await walk((p) => h.receipts.list(s.companyId, p), id), expected(receipts, (r) => r.createdAt, id));
    assert.deepEqual(await walk((p) => h.receipts.listForParty(s.companyId, s.partyId, p), id), expected(receipts, (r) => r.createdAt, id));
    const fp = (row: SupplierRiskAssessment) => row.fingerprint;
    assert.deepEqual(await walk((p) => h.assessments.listForParty(s.companyId, s.partyId, p), fp), expected(assessments, (a) => a.assessedAt, fp));
    // Without a page, everything, as before.
    assert.equal((await h.bills.list(s.companyId)).length, 5);
    // A cursor that names nothing gives nothing; a page of no rows is refused.
    assert.deepEqual(await h.orders.list(s.companyId, { limit: 2, after: crypto.randomUUID() }), []);
    assert.deepEqual(await h.orders.list(s.companyId, { limit: 2, after: "not-an-id" }), []);
    await assert.rejects(h.receipts.list(s.companyId, { limit: 0 }), code("PAGE_LIMIT_INVALID"));
  });

  t("receipts against one order page on their own", async () => {
    const { h, s } = await setUp();
    const order = orderFor(s, 1);
    const mine = [1, 2, 3].map((n) => receiptFor(s, 20 + n, { orderId: order.id, createdAt: at(n) }));
    await h.write(s.companyId, async () => {
      await h.orders.insert(order);
      for (const row of mine) await h.receipts.insert(row);
      await h.receipts.insert(receiptFor(s, 99));
    });
    const first = await h.receipts.listForOrder(s.companyId, order.id, { limit: 2 });
    const second = await h.receipts.listForOrder(s.companyId, order.id, { limit: 2, after: first.at(-1)!.id });
    assert.deepEqual([...first, ...second].map((r) => r.id), mine.map((r) => r.id));
  });
}
