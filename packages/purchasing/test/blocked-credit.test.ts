/**
 * Issue #289, part 3 — credit blocked by CGST s.17(5), in the posting itself: the tax goes into
 * cost and the blocked heads are kept for GSTR-3B 4(B)(1); under reverse charge the blocked tax
 * is still owed to the government (s.9(3)), so the entry still balances.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { computePurchaseTotals } from "../src/posting.ts";
import { purchase, steelLine } from "../src/posting-fixtures.ts";
import { BLOCKED_CREDIT_REASONS, blockedCreditReasonFor } from "../src/blocked-credit.ts";

test("a blocked line's tax is cost, split by head; the other line is claimed", () => {
  const totals = computePurchaseTotals(purchase({
    lines: [steelLine(), steelLine({ lineNumber: 2, itcEligibility: "INELIGIBLE", blockedCreditClause: "17(5)(d)", taxableValuePaise: 10_000_00n, quantity: undefined })]
      .map((line) => ({ ...line, quantity: steelLine().quantity })),
    invoiceTotalPaise: 37_760_00n + 11_800_00n,
  }));
  // ₹32,000 + ₹5,760 claimed; ₹10,000 + ₹1,800 into cost.
  assert.equal(totals.tax.cgstPaise + totals.tax.sgstPaise + totals.tax.igstPaise, 5_760_00n);
  assert.equal(totals.tax.ineligibleItcPaise, 1_800_00n);
  const heads = totals.tax.ineligibleHeads!;
  assert.equal(heads.cgstPaise + heads.sgstPaise + heads.igstPaise + heads.cessPaise, 1_800_00n);
  assert.equal(totals.goodsCostPaise, 32_000_00n + 11_800_00n);
  assert.equal(totals.roundOffPaise, 0n);
});

test("reverse charge with a blocked line: the bill (no GST) balances against cost and the whole tax owed", () => {
  const totals = computePurchaseTotals(purchase({
    taxLiability: "REVERSE_CHARGE",
    lines: [steelLine({ itcEligibility: "INELIGIBLE", blockedCreditClause: "17(5)(g)" })],
    invoiceTotalPaise: 32_000_00n,
  }));
  assert.equal(totals.tax.ineligibleItcPaise, 5_760_00n);
  assert.equal(totals.tax.cgstPaise + totals.tax.sgstPaise + totals.tax.igstPaise, 0n);
  assert.equal(totals.goodsCostPaise, 37_760_00n, "cost carries the tax");
  assert.equal(totals.roundOffPaise, 0n, "debits ₹37,760 = supplier ₹32,000 + reverse charge payable ₹5,760");
  assert.match(totals.warnings.join(" "), /₹5,760\.00 of tax is yours to pay/);
});

test("the reasons: each names a clause of s.17(5); a form's id or clause finds it; nonsense does not", () => {
  for (const reason of BLOCKED_CREDIT_REASONS) assert.match(reason.clause, /^17\(5\)\([a-z]{1,2}\)$/);
  assert.equal(blockedCreditReasonFor("personal_use")?.clause, "17(5)(g)");
  assert.equal(blockedCreditReasonFor("17(5)(h)")?.id, "gift_sample");
  assert.equal(blockedCreditReasonFor(""), null);
  assert.equal(blockedCreditReasonFor("17(5)(e)"), undefined, "composition purchases are decided by the supplier record, not chosen");
  assert.equal(blockedCreditReasonFor("anything"), undefined);
});
