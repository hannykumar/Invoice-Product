/**
 * Issue #17 [E17] acceptance criteria, enforced automatically.
 *
 *  - "Ledger, stock and payable update atomically"
 *  - "A failed component leaves no partial posting"
 *  - "Reprocessing the same approval is idempotent"
 *
 * plus the required atomic-transaction, batch/unit/tax and duplicate-approval tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DomainError, isoDate, toDecimalString } from "@invoice/kernel";
import { formatQuantity } from "../../masters/src/units.ts";
import { quantity } from "../../masters/src/units.ts";
import { purchaseDocumentLedger } from "../src/posting-adapters.ts";
import { computePurchaseTotals, splitLineTax } from "../src/posting.ts";
import {
  ALL_PERMISSIONS, COMPANY, OTHER, SUPPLIER, actorWith, clearedVerdict, makeShop, purchase, steelLine,
} from "../src/posting-fixtures.ts";

const codeOf = async (shop: Awaited<ReturnType<typeof makeShop>>, accountId: string): Promise<string> => {
  const account = await shop.store.read().accounts.findById(COMPANY, accountId as never);
  return account?.code ?? "?";
};

/** The voucher as a map of account code to signed paise, which is how a person reads it. */
const entryOf = async (shop: Awaited<ReturnType<typeof makeShop>>, voucherId: string) => {
  const voucher = await shop.store.read().vouchers.findById(COMPANY, voucherId as never);
  assert.ok(voucher, "the voucher must exist");
  const out: Record<string, { debit: string; credit: string }> = {};
  for (const line of voucher.lines) {
    out[await codeOf(shop, line.accountId)] = { debit: toDecimalString(line.debit), credit: toDecimalString(line.credit) };
  }
  return { voucher, lines: out };
};

// ---------------------------------------------------------------------- arithmetic

test("CGST and SGST always add back up to the GST that was charged", () => {
  // ₹1,234.55 at 18% is 22,222 paise. An odd paise must not vanish between the two halves.
  const line = steelLine({ taxableValuePaise: 1_234_55n });
  const intra = splitLineTax(1_234_55n, line, true);
  assert.equal(intra.cgst + intra.sgst, 22_222n);
  assert.equal(intra.igst, 0n);
  const inter = splitLineTax(1_234_55n, line, false);
  assert.equal(inter.igst, 22_222n);
  assert.equal(inter.cgst + inter.sgst, 0n);
});

test("a purchase whose tax split the rules engine could not decide is refused", () => {
  const undecided = clearedVerdict({
    taxCheck: { basis: "SELF_CONSISTENCY_ONLY", missingFacts: ["supplier state"], explanation: "The supplier's state is not known." },
  });
  assert.throws(
    () => computePurchaseTotals(purchase({ verdict: undecided })),
    (error: unknown) => error instanceof DomainError && /within your state or from outside/.test(error.message),
  );
});

// ------------------------------------------------------------------ the whole posting

test("an inter-state purchase records the entry, the goods and what is owed, together", async () => {
  const shop = await makeShop();
  const { bill } = await shop.posting.post(shop.actor, purchase(), "post-1");

  const { voucher, lines } = await entryOf(shop, bill.voucherId);
  assert.equal(voucher.type, "PURCHASE");
  assert.equal(voucher.state, "FINAL");
  assert.equal(lines["5100"]?.debit, "32000.00", "goods bought");
  assert.equal(lines["1430"]?.debit, "5760.00", "input IGST");
  assert.equal(lines["1410"], undefined, "no CGST on an inter-state purchase");
  assert.equal(lines["2100-0001"]?.credit, "37760.00", "owed to the supplier");
  assert.equal(voucher.source?.kind, "purchase_invoice");
  assert.equal(voucher.source?.number, "SRS/2026/0042");

  const balance = await shop.inventoryService.balance(shop.actor, { itemId: "TMT12", warehouseId: "wh-main" });
  assert.equal(formatQuantity(balance.physical), "500.000 KGS");

  assert.equal(bill.dueDate, "2026-09-04", "45 credit days after 21 July 2026");
  assert.equal(bill.tax.igstPaise, 5_760_00n);
  assert.equal(bill.sourceDocumentId, "doc-1");
});

test("an intra-state purchase splits the tax into CGST and SGST", async () => {
  const shop = await makeShop();
  const intra = clearedVerdict({
    taxCheck: { basis: "RULES_ENGINE", intraState: true, ruleSetVersion: "gst-2026.1", ruleId: "POS.INTRASTATE", explanation: "Both in Karnataka." },
  });
  const { bill } = await shop.posting.post(shop.actor, purchase({ verdict: intra }), "post-1");
  const { lines } = await entryOf(shop, bill.voucherId);
  assert.equal(lines["1410"]?.debit, "2880.00");
  assert.equal(lines["1420"]?.debit, "2880.00");
  assert.equal(lines["1430"], undefined);
  assert.equal(bill.tax.intraState, true);
  assert.equal(bill.tax.ruleId, "POS.INTRASTATE", "the rule that decided it is kept");
});

test("goods bought by the box are received in the unit stock is kept in", async () => {
  const shop = await makeShop();
  const { bill } = await shop.posting.post(shop.actor, purchase({
    lines: [steelLine({
      itemId: "SOAP", description: "Herbal Bath Soap 100g", hsnSac: "34011190",
      quantity: quantity("10", "BOX"), ratePaise: 24_000n, taxableValuePaise: 2_400_00n, batchId: "batch-jul",
    })],
    invoiceTotalPaise: 2_832_00n,
  }), "post-1");

  const balance = await shop.inventoryService.balance(shop.actor, { itemId: "SOAP", warehouseId: "wh-main", batchId: "batch-jul" });
  assert.equal(formatQuantity(balance.physical), "240.000 PCS", "ten boxes of twenty-four");
  assert.equal(bill.receipts[0]?.batchId, "batch-jul");

  // Valued per piece, not per box: ₹2,400 over 240 pieces.
  const value = await shop.inventoryService.value(shop.actor, { itemId: "SOAP", warehouseId: "wh-main" });
  assert.equal(toDecimalString(value.value), "2400.00");
});

test("a service line is a cost and receives no stock", async () => {
  const shop = await makeShop();
  const { bill } = await shop.posting.post(shop.actor, purchase({
    lines: [
      steelLine(),
      steelLine({ lineNumber: 2, itemId: "FRT", description: "Inward freight", hsnSac: "996511", supplyKind: "SERVICES", warehouseId: undefined, quantity: quantity("1", "NOS"), ratePaise: 1_000_00n, taxableValuePaise: 1_000_00n, gstRateBasisPoints: 500 }),
    ],
    invoiceTotalPaise: 38_810_00n,
  }), "post-1");
  const { lines } = await entryOf(shop, bill.voucherId);
  assert.equal(lines["5900"]?.debit, "1000.00", "services are a cost, not stock");
  assert.equal(lines["5100"]?.debit, "32000.00");
  assert.equal(bill.receipts.length, 1, "freight does not enter the godown");
});

test("GST that cannot be claimed is added to what the goods cost", async () => {
  const shop = await makeShop();
  const { bill } = await shop.posting.post(shop.actor, purchase({ lines: [steelLine({ itcEligibility: "INELIGIBLE" })] }), "post-1");
  const { lines } = await entryOf(shop, bill.voucherId);
  assert.equal(lines["5100"]?.debit, "37760.00", "the GST joins the cost of the goods");
  assert.equal(lines["1430"], undefined);
  assert.equal(bill.tax.ineligibleItcPaise, 5_760_00n);
  assert.equal(bill.receipts[0]?.valuePaise, 37_760_00n, "stock is valued at what it landed for");
});

test("reverse charge records GST the business owes the government itself", async () => {
  const shop = await makeShop();
  const { bill } = await shop.posting.post(shop.actor, purchase({
    taxLiability: "REVERSE_CHARGE",
    invoiceTotalPaise: 32_000_00n, // the supplier charges no tax
  }), "post-1");
  const { lines } = await entryOf(shop, bill.voucherId);
  assert.equal(lines["2100-0001"]?.credit, "32000.00", "the supplier is owed the value only");
  assert.equal(lines["2260"]?.credit, "5760.00", "the tax is owed to the government");
  assert.equal(lines["1430"]?.debit, "5760.00", "and claimed back at the same time");
  assert.equal(bill.tax.reverseCharge, true);
});

test("rupee rounding on the bill is recorded rather than absorbed", async () => {
  const shop = await makeShop();
  const { bill } = await shop.posting.post(shop.actor, purchase({ invoiceTotalPaise: 37_760_40n }), "post-1");
  const { lines } = await entryOf(shop, bill.voucherId);
  assert.equal(lines["4900"]?.debit, "0.40");
  assert.equal(lines["2100-0001"]?.credit, "37760.40");
});

test("the summary is written for a shopkeeper, not an accountant", async () => {
  const shop = await makeShop();
  const { bill } = await shop.posting.post(shop.actor, purchase(), "post-1");
  assert.match(bill.summary, /₹37,760\.00 is now owed to Shree Ram Steels/);
  assert.match(bill.summary, /due on 2026-09-04/);
  assert.doesNotMatch(bill.summary, /debit|credit|voucher|ledger/i);
});

// ------------------------------------------------------------------------- refusals

test("a bill #16 did not clear never reaches the books", async () => {
  const shop = await makeShop();
  const blocked = clearedVerdict({
    status: "BLOCKED",
    findings: [{ code: "TOTAL_MISMATCH", severity: "MATERIAL", field: "invoiceTotal", message: "The total does not match the lines.", evidence: null } as never],
    summary: "This bill does not add up.",
  });
  await assert.rejects(
    () => shop.posting.post(shop.actor, purchase({ verdict: blocked }), "post-1"),
    (error: unknown) => error instanceof DomainError && /still has something to sort out/.test(error.message),
  );
  assert.equal((await shop.bills.list(COMPANY)).length, 0);
  assert.equal((await shop.inventory.movements.list(COMPANY)).length, 0);
});

test("a bill #16 called a confirmed duplicate is not recorded twice", async () => {
  const shop = await makeShop();
  const duplicate = clearedVerdict({
    duplicate: { verdict: "CONFIRMED", matches: [], fingerprint: "fp-1", message: "The same bill was entered on 3 August." },
  });
  await assert.rejects(
    () => shop.posting.post(shop.actor, purchase({ verdict: duplicate }), "post-1"),
    (error: unknown) => error instanceof DomainError && /already entered/.test(error.message),
  );
});

test("a total that does not add up is refused, and nothing is written", async () => {
  const shop = await makeShop();
  await assert.rejects(
    () => shop.posting.post(shop.actor, purchase({ invoiceTotalPaise: 45_000_00n }), "post-1"),
    (error: unknown) => error instanceof DomainError && /too big to be rounding/.test(error.message),
  );
  assert.equal((await shop.bills.list(COMPANY)).length, 0);
  assert.equal((await shop.inventory.movements.list(COMPANY)).length, 0);
});

test("goods with no godown chosen cannot be posted", async () => {
  const shop = await makeShop();
  await assert.rejects(
    () => shop.posting.post(shop.actor, purchase({ lines: [steelLine({ warehouseId: undefined })] }), "post-1"),
    (error: unknown) => error instanceof DomainError && /no godown was chosen/.test(error.message),
  );
});

test("a purchase belonging to another business is not found", async () => {
  const shop = await makeShop();
  await assert.rejects(
    () => shop.posting.post(actorWith(ALL_PERMISSIONS, OTHER), purchase(), "post-1"),
    (error: unknown) => error instanceof DomainError && error.code === "PURCHASE_UNKNOWN",
  );
});

test("posting needs the permission to post a purchase", async () => {
  const shop = await makeShop({ permissions: ["inventory.move"] });
  await assert.rejects(
    () => shop.posting.post(shop.actor, purchase(), "post-1"),
    (error: unknown) => error instanceof DomainError && error.code === "PERMISSION_DENIED",
  );
});

// --------------------------------------------------------------- atomicity and retries

test("a godown that refuses the goods leaves no entry in the books", async () => {
  const shop = await makeShop();
  // A batched item with no batch named: the godown refuses, after the voucher was written.
  await assert.rejects(
    () => shop.posting.post(shop.actor, purchase({
      lines: [steelLine({ itemId: "SOAP", description: "Herbal Bath Soap 100g", quantity: quantity("10", "BOX"), ratePaise: 24_000n, taxableValuePaise: 2_400_00n })],
      invoiceTotalPaise: 2_832_00n,
    }), "post-1"),
    (error: unknown) => error instanceof DomainError && error.code === "STOCK_BATCH_REQUIRED",
  );

  const vouchers = await shop.store.read().vouchers.list(COMPANY, {});
  assert.equal(vouchers.length, 0, "the voucher must have been rolled back with the receipt");
  assert.equal((await shop.bills.list(COMPANY)).length, 0, "and so must the bill");
  assert.equal((await shop.inventory.movements.list(COMPANY)).length, 0);
});

test("after a failure the same purchase can be posted cleanly", async () => {
  const shop = await makeShop();
  await assert.rejects(() => shop.posting.post(shop.actor, purchase({
    lines: [steelLine({ itemId: "SOAP", quantity: quantity("10", "BOX"), ratePaise: 24_000n, taxableValuePaise: 2_400_00n })],
    invoiceTotalPaise: 2_832_00n,
  }), "post-1"));

  const { bill } = await shop.posting.post(shop.actor, purchase(), "post-2");
  assert.equal(bill.state, "POSTED");
  assert.equal((await shop.store.read().vouchers.list(COMPANY, {})).length, 1);
});

test("approving the same purchase twice records it once", async () => {
  const shop = await makeShop();
  const first = await shop.posting.post(shop.actor, purchase(), "post-1");
  const second = await shop.posting.post(shop.actor, purchase(), "a-completely-different-key");

  assert.equal(first.bill.id, second.bill.id);
  assert.equal(second.deduplicated, true);
  assert.equal((await shop.store.read().vouchers.list(COMPANY, {})).length, 1, "one entry only");
  const balance = await shop.inventoryService.balance(shop.actor, { itemId: "TMT12", warehouseId: "wh-main" });
  assert.equal(formatQuantity(balance.physical), "500.000 KGS", "the stock must not double");
});

test("two approvals racing each other still post once", async () => {
  const shop = await makeShop();
  const results = await Promise.allSettled([
    shop.posting.post(shop.actor, purchase(), "race-1"),
    shop.posting.post(shop.actor, purchase(), "race-2"),
  ]);
  const posted = results.filter((r) => r.status === "fulfilled");
  assert.equal(posted.length, 2, "both callers get an answer");
  assert.equal((await shop.store.read().vouchers.list(COMPANY, {})).length, 1, "but only one entry exists");
  const balance = await shop.inventoryService.balance(shop.actor, { itemId: "TMT12", warehouseId: "wh-main" });
  assert.equal(formatQuantity(balance.physical), "500.000 KGS");
});

// -------------------------------------------------------------------------- preview

test("the preview shows what would be posted, and posts nothing", async () => {
  const shop = await makeShop();
  const preview = shop.posting.preview(shop.actor, purchase());
  assert.equal((await shop.store.read().vouchers.list(COMPANY, {})).length, 0);
  assert.equal(preview.dueDate, "2026-09-04");
  assert.equal(preview.tax.igstPaise, 5_760_00n);
  assert.equal(preview.receipts.length, 1);

  const { bill } = await shop.posting.post(shop.actor, purchase(), "post-1");
  assert.deepEqual(preview.tax, bill.tax, "what was approved is what landed");
  assert.equal(preview.dueDate, bill.dueDate);
});

test("the preview warns about what a person should see before approving", async () => {
  const shop = await makeShop();
  const reverseCharged = shop.posting.preview(shop.actor, purchase({
    taxLiability: "REVERSE_CHARGE", invoiceTotalPaise: 32_000_00n,
  }));
  assert.ok(reverseCharged.warnings.some((w) => /reverse charge/.test(w)));

  const blockedCredit = shop.posting.preview(shop.actor, purchase({ lines: [steelLine({ itcEligibility: "INELIGIBLE" })] }));
  assert.ok(blockedCredit.warnings.some((w) => /cannot be claimed back/.test(w)));

  const rounded = shop.posting.preview(shop.actor, purchase({ invoiceTotalPaise: 37_760_40n }));
  assert.ok(rounded.warnings.some((w) => /rounding/.test(w)));
});

// ------------------------------------------------------------------------- reversal

test("a reversal undoes the entry, the stock and what was owed, together", async () => {
  const shop = await makeShop();
  const { bill } = await shop.posting.post(shop.actor, purchase(), "post-1");
  const reversed = await shop.posting.reverse(shop.actor, bill.id, {
    on: isoDate("2026-07-28"), reason: "Wrong grade of steel; the whole lot went back.",
  });

  assert.equal(reversed.state, "REVERSED");
  const vouchers = await shop.store.read().vouchers.list(COMPANY, {});
  assert.equal(vouchers.length, 2, "the original entry is left exactly as it was");
  const original = vouchers.find((v) => v.id === bill.voucherId);
  assert.equal(original?.state, "REVERSED");

  const balance = await shop.inventoryService.balance(shop.actor, { itemId: "TMT12", warehouseId: "wh-main" });
  assert.equal(formatQuantity(balance.physical), "0.000 KGS", "the goods went back out");
  assert.match(reversed.summary, /Reason kept on record: Wrong grade of steel/);
});

test("a reversal will not take out stock that has already been sold, without authority", async () => {
  const shop = await makeShop();
  const { bill } = await shop.posting.post(shop.actor, purchase(), "post-1");
  await shop.inventoryService.recordMovement(shop.actor, {
    idempotencyKey: "sale-1", itemId: "TMT12", warehouseId: "wh-main", kind: "SALE_OUT",
    quantity: quantity("400", "KGS"), documentDate: isoDate("2026-07-25"),
    source: { kind: "sales_invoice", id: "inv-9", number: "INV/9" },
  });

  await assert.rejects(
    () => shop.posting.reverse(shop.actor, bill.id, { on: isoDate("2026-07-28"), reason: "Wrong grade." }),
    (error: unknown) => error instanceof DomainError && error.code === "STOCK_WOULD_GO_NEGATIVE",
  );
  const still = await shop.posting.bill(shop.actor, bill.id);
  assert.equal(still?.state, "POSTED", "the refusal changed nothing");
  assert.equal((await shop.store.read().vouchers.list(COMPANY, {})).length, 1, "no reversal entry was left behind");
});

test("a reversal must say why", async () => {
  const shop = await makeShop();
  const { bill } = await shop.posting.post(shop.actor, purchase(), "post-1");
  await assert.rejects(
    () => shop.posting.reverse(shop.actor, bill.id, { on: isoDate("2026-07-28"), reason: "   " }),
    (error: unknown) => error instanceof DomainError && /say why/.test(error.message),
  );
});

test("a reversed bill cannot be reversed again, nor posted again", async () => {
  const shop = await makeShop();
  const { bill } = await shop.posting.post(shop.actor, purchase(), "post-1");
  await shop.posting.reverse(shop.actor, bill.id, { on: isoDate("2026-07-28"), reason: "Returned." });
  await assert.rejects(
    () => shop.posting.reverse(shop.actor, bill.id, { on: isoDate("2026-07-29"), reason: "Again." }),
    (error: unknown) => error instanceof DomainError && error.code === "PURCHASE_ALREADY_REVERSED",
  );
  await assert.rejects(
    () => shop.posting.post(shop.actor, purchase(), "post-2"),
    (error: unknown) => error instanceof DomainError && error.code === "PURCHASE_ALREADY_REVERSED",
  );
});

// ------------------------------------------------------- what the payables lane reads

test("a posted bill shows up as money owed, and a reversed one does not", async () => {
  const shop = await makeShop();
  const documents = purchaseDocumentLedger(shop.bills, async () => "Shree Ram Steels Private Limited");

  const { bill } = await shop.posting.post(shop.actor, purchase(), "post-1");
  const open = await documents.openDocuments(COMPANY, SUPPLIER as never);
  assert.equal(open.length, 1);
  assert.equal(open[0]?.kind, "PURCHASE_INVOICE");
  assert.equal(open[0]?.side, "PAYABLE");
  assert.equal(toDecimalString(open[0]?.value as never), "37760.00");
  assert.equal(open[0]?.dueDate, "2026-09-04");

  await shop.posting.reverse(shop.actor, bill.id, { on: isoDate("2026-07-28"), reason: "Returned." });
  assert.equal((await documents.openDocuments(COMPANY, SUPPLIER as never)).length, 0);
});

// ---------------------------------------------------------------------------- audit

test("posting and reversing are both on the record, linked to the source document", async () => {
  const shop = await makeShop();
  const { bill } = await shop.posting.post(shop.actor, purchase(), "post-1");
  await shop.posting.reverse(shop.actor, bill.id, { on: isoDate("2026-07-28"), reason: "Returned to supplier." });

  const actions = shop.audit.events.map((e) => e.action);
  assert.ok(actions.includes("purchase.bill_posted"));
  assert.ok(actions.includes("purchase.bill_reversed"));
  const posted = shop.audit.events.find((e) => e.action === "purchase.bill_posted");
  assert.equal(posted?.details["sourceDocumentId"], "doc-1");
  assert.equal(posted?.details["split"], "IGST");
  const reversed = shop.audit.events.find((e) => e.action === "purchase.bill_reversed");
  assert.equal(reversed?.overrideReason, "Returned to supplier.");
});
