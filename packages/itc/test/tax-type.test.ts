/**
 * Issue #228 — the kind of GST on a bill is part of whether it agrees with the portal.
 *
 * Our books said CGST ₹2,880 + SGST ₹2,880 for a bill the supplier filed as IGST ₹5,760. The
 * totals agreed, so the line was marked "agrees with the portal", and then credit was claimed head
 * by head at the lower of the two figures — ₹0 under every head. ₹5,760 vanished beside a green
 * "agrees". Credit of IGST cannot be taken as CGST and SGST, so the line must be a mismatch that
 * says so, and it must never claim anything until the bill or the filing is corrected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatINR, isoDate, type Money } from '@invoice/kernel';
import { matchDocuments } from '../src/match.ts';
import { assessLine } from '../src/itc.ts';
import { SHREE_RAM_GSTIN, STEEL_BILL, SUNRISE_COMPANY, SUNRISE_PERIOD } from '../src/fixtures.ts';
import { totalTaxOf, type BookPurchaseDocument, type PortalDocument, type TaxAmounts } from '../src/types.ts';

const inr = (rupees: number): Money => ({ currency: 'INR', minor: BigInt(rupees) * 100n });

const amounts = (split: { cgst?: number; sgst?: number; igst?: number }): TaxAmounts => ({
  taxableValue: inr(32_000),
  cgst: inr(split.cgst ?? 0),
  sgst: inr(split.sgst ?? 0),
  igst: inr(split.igst ?? 0),
  cess: inr(0),
});

const book = (split: { cgst?: number; sgst?: number; igst?: number }): BookPurchaseDocument => ({
  ...STEEL_BILL,
  number: 'SRS-101',
  documentDate: isoDate('2026-09-27'),
  amounts: amounts(split),
  invoiceValue: inr(37_760),
});

const portal = (split: { cgst?: number; sgst?: number; igst?: number }): PortalDocument => ({
  id: 'portal-srs-101', companyId: SUNRISE_COMPANY, period: SUNRISE_PERIOD, supplierGstin: SHREE_RAM_GSTIN,
  supplierName: 'Shree Ram Steels', kind: 'INVOICE', number: 'SRS-101', documentDate: isoDate('2026-09-27'),
  amounts: amounts(split), invoiceValue: inr(37_760),
  itcAvailableOnPortal: true, itcUnavailableReason: null, amends: null, reversed: false,
  reverseCharge: false, source: 'TYPED', batchId: 'b1', observedAt: '2026-09-27T10:00:00.000Z',
});

const lineOf = (ours: BookPurchaseDocument, theirs: PortalDocument) => {
  const [pair] = matchDocuments({ books: [ours], portal: [theirs] });
  assert.ok(pair !== undefined);
  return assessLine({ pair, decision: null });
};

test('books with CGST and SGST against a portal with IGST of the same total is not an agreement', () => {
  const line = lineOf(book({ cgst: 2_880, sgst: 2_880 }), portal({ igst: 5_760 }));
  assert.notEqual(line.status, 'EXACT');
  assert.equal(line.outcome, 'HELD_BACK');
  assert.equal(totalTaxOf(line.claimable).minor, 0n);
  assert.equal(totalTaxOf(line.heldBack).minor, 576_000n);
  const kind = line.evidence.find((row) => row.field === 'TAX_TYPE');
  assert.equal(kind?.verdict, 'DIFFERS');
  assert.equal(kind?.ours, 'CGST and SGST');
  assert.equal(kind?.theirs, 'IGST');
  assert.equal(
    line.sentence['en-IN'],
    `Your books say CGST and SGST; the supplier filed IGST. One of the two is wrong. ${formatINR(inr(5_760))} is held back until the bill or the filing is corrected.`,
  );
  assert.ok(line.findings.some((finding) => finding.code === 'ITC_TAX_TYPE_DIFFERS'));
  assert.doesNotMatch(line.statusLabel['en-IN'], /agrees/i);
});

test('the reverse — IGST in the books, CGST and SGST on the portal — is held back the same way', () => {
  const line = lineOf(book({ igst: 5_760 }), portal({ cgst: 2_880, sgst: 2_880 }));
  assert.equal(line.status, 'CLOSE');
  assert.equal(line.outcome, 'HELD_BACK');
  assert.match(line.sentence['en-IN'], /^Your books say IGST; the supplier filed CGST and SGST\./);
});

test('accepting a line whose kind of GST differs still claims nothing', () => {
  const ours = book({ cgst: 2_880, sgst: 2_880 });
  const theirs = portal({ igst: 5_760 });
  const [pair] = matchDocuments({ books: [ours], portal: [theirs] });
  const first = assessLine({ pair: pair!, decision: null });
  const accepted = assessLine({
    pair: pair!,
    decision: {
      id: 'd1', companyId: SUNRISE_COMPANY, period: SUNRISE_PERIOD, lineKey: first.key, kind: 'ACCEPT',
      reason: 'Looks right to me', decidedBy: 'owner' as never, decidedAt: '2026-09-27T10:00:00.000Z',
      fingerprint: first.fingerprint, idempotencyKey: 'accept-1',
    },
  });
  assert.equal(accepted.outcome, 'HELD_BACK');
  assert.equal(totalTaxOf(accepted.claimable).minor, 0n);
});

test('IGST ₹5,760 in the books against IGST ₹5,760 on the portal agrees and claims ₹5,760', () => {
  const line = lineOf(book({ igst: 5_760 }), portal({ igst: 5_760 }));
  assert.equal(line.status, 'EXACT');
  assert.equal(line.outcome, 'CLAIM_NOW');
  assert.equal(line.claimable.igst.minor, 576_000n);
  assert.equal(totalTaxOf(line.claimable).minor, 576_000n);
  assert.equal(line.evidence.find((row) => row.field === 'TAX_TYPE')?.verdict, 'AGREES');
});
