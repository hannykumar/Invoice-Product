/**
 * Issue #192 — CGST section 16(4): credit on a supplier's bill dies on the 30 November after the
 * end of the financial year the bill belongs to.
 *
 * Reverting the fix makes every one of these fail: a year-old bill goes back to showing as
 * claimable, and the business puts it on a return the officer later disallows with interest.
 *
 * Every name, GST number and figure below is synthetic and belongs to nobody.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { asId, fixedClock, type CompanyId, type IsoDate } from '@invoice/kernel';
import { InMemoryAuditPort, type ActorContext } from '@invoice/ledger';
import {
  InMemoryImportBatches, InMemoryItcClaims, InMemoryItcDecisions, InMemoryPortalRecords, InMemoryPurchaseBooks,
} from '../src/adapters.ts';
import { CLAIM_WARNING_DAYS, isInWarningWindow, isTimeBarred, lastClaimDateFor, returnDueDate } from '../src/deadline.ts';
import { assessLine } from '../src/itc.ts';
import { matchDocuments } from '../src/match.ts';
import { ItcReconciliationService } from '../src/service.ts';
import { SUNRISE_COMPANY, bill } from '../src/fixtures.ts';
import { ITC_PERMISSIONS, taxPeriod, totalTaxOf, type BookPurchaseDocument } from '../src/types.ts';

/** The Blessing Export bill from `docs/reference/real-bills/`: 13 March 2026, so 2025-26. */
const MARCH_BILL = bill({
  id: 'bill-blessing', supplierName: 'Blessing Export', gstin: '07AAFCB5566R1Z2',
  number: 'BE/DL/25-26/0139', date: '2026-03-13', taxable: 50_000, igst: 9_000,
});

const lineFor = (document: BookPurchaseDocument, period: string) => {
  const pairs = matchDocuments({ books: [document], portal: [] });
  return assessLine({ pair: pairs[0]!, decision: null, period: taxPeriod(period) });
};

test('the last claim date is the 30 November after the bill’s financial year ends', () => {
  assert.equal(lastClaimDateFor('2026-03-13' as IsoDate), '2026-11-30');
  // 1 April 2026 starts financial year 2026-27, which ends 31 March 2027.
  assert.equal(lastClaimDateFor('2026-04-01' as IsoDate), '2027-11-30');
  assert.equal(lastClaimDateFor('2026-03-31' as IsoDate), '2026-11-30');
});

test('a bill is claimable up to the deadline and barred in the return after it', () => {
  assert.equal(returnDueDate(taxPeriod('2026-10')), '2026-11-20');
  assert.equal(returnDueDate(taxPeriod('2026-11')), '2026-12-20');
  assert.equal(returnDueDate(taxPeriod('2026-12')), '2027-01-20');

  assert.equal(isTimeBarred('2026-03-13' as IsoDate, taxPeriod('2026-10')), false);
  assert.equal(isTimeBarred('2026-03-13' as IsoDate, taxPeriod('2026-11')), true);
  assert.equal(isTimeBarred('2026-03-13' as IsoDate, taxPeriod('2027-01')), true);

  const october = lineFor(MARCH_BILL, '2026-10');
  assert.equal(october.lastClaimDate, '2026-11-30');
  assert.notEqual(october.outcome, 'TIME_BARRED');

  const november = lineFor(MARCH_BILL, '2026-11');
  assert.equal(november.outcome, 'TIME_BARRED');
  assert.equal(november.lastClaimDate, '2026-11-30');
  assert.equal(totalTaxOf(november.claimable).minor, 0n);
  assert.equal(november.sentence['en-IN'], 'Credit on this bill had to be claimed by 30 November 2026.');
  assert.ok(november.findings.some((each) => each.code === 'ITC_TIME_BARRED' && each.severity === 'BLOCKING'));
});

test('an old month prepared today is filed today, not on a due date that has gone', () => {
  // The only way a March 2026 return is still open in December 2026 is that it is being filed late,
  // so the credit on a March bill is already closed even though 20 April 2026 was inside the limit.
  assert.equal(isTimeBarred('2026-03-13' as IsoDate, taxPeriod('2026-03')), false);
  assert.equal(isTimeBarred('2026-03-13' as IsoDate, taxPeriod('2026-03'), '2026-04-15' as IsoDate), false);
  assert.equal(isTimeBarred('2026-03-13' as IsoDate, taxPeriod('2026-03'), '2026-12-15' as IsoDate), true);

  const line = assessLine({
    pair: matchDocuments({ books: [MARCH_BILL], portal: [] })[0]!,
    decision: null,
    period: taxPeriod('2026-03'),
    today: '2026-12-15' as IsoDate,
  });

  assert.equal(line.outcome, 'TIME_BARRED');
  assert.equal(line.sentence['en-IN'], 'Credit on this bill had to be claimed by 30 November 2026.');
});

test('the purchase itself is untouched: only the credit is refused', () => {
  const november = lineFor(MARCH_BILL, '2026-11');

  assert.notEqual(november.book, null);
  assert.equal(november.book?.number, 'BE/DL/25-26/0139');
  // Still counted as held back, so the month's figures say where the money went.
  assert.equal(totalTaxOf(november.heldBack).minor, 9_000_00n);
});

test('a bill for a later financial year is nowhere near its deadline', () => {
  const aprilBill = bill({
    id: 'bill-april', supplierName: 'Blessing Export', gstin: '07AAFCB5566R1Z2',
    number: 'BE/DL/26-27/0001', date: '2026-04-01', taxable: 10_000, igst: 1_800,
  });

  const line = lineFor(aprilBill, '2026-11');

  assert.equal(line.lastClaimDate, '2027-11-30');
  assert.notEqual(line.outcome, 'TIME_BARRED');
});

test('inside the 45 days before the deadline the unclaimed bills are listed, largest first', async () => {
  // 20 October 2026 is 41 days before 30 November 2026, and 41 is inside the window.
  assert.equal(isInWarningWindow('2026-10-20' as IsoDate, '2026-11-30' as IsoDate), true);
  assert.equal(isInWarningWindow('2026-10-01' as IsoDate, '2026-11-30' as IsoDate), false);
  assert.equal(isInWarningWindow('2026-12-01' as IsoDate, '2026-11-30' as IsoDate), false);
  assert.equal(CLAIM_WARNING_DAYS, 45);

  // Two old bills entered into the October books and never claimed: the larger one first.
  const october = taxPeriod('2026-10');
  const older = { ...MARCH_BILL, period: october };
  const smaller: BookPurchaseDocument = {
    ...bill({
      id: 'bill-small', supplierName: 'Konkan Packaging', gstin: '30AAFCK4321L1ZU',
      number: 'KP/0091', date: '2026-03-20', taxable: 5_000, igst: 900,
    }),
    period: october,
  };
  const books = new InMemoryPurchaseBooks();
  books.add(older, smaller);
  const service = new ItcReconciliationService({
    books,
    records: new InMemoryPortalRecords(),
    batches: new InMemoryImportBatches(),
    decisions: new InMemoryItcDecisions(),
    claims: new InMemoryItcClaims(),
    audit: new InMemoryAuditPort(),
    clock: fixedClock('2026-10-20T06:00:00.000Z'),
    idFactory: () => 'id-1',
  });
  const owner: ActorContext = {
    companyId: SUNRISE_COMPANY as CompanyId,
    branchId: asId<'Branch'>('main'),
    userId: asId<'User'>('22222222-2222-4222-8222-222222222222'),
    permissions: Object.values(ITC_PERMISSIONS),
  };

  const workspace = await service.workspace(owner, october);

  const warning = workspace.findings.find((each) => each.code === 'ITC_CLAIM_DEADLINE_NEAR');
  assert.ok(warning !== undefined, 'the deadline warning must be raised');
  assert.equal(warning.severity, 'WARNING');
  assert.match(warning.message['en-IN'], /30 November 2026/);
  assert.ok(
    warning.message['en-IN'].indexOf('BE/DL/25-26/0139') < warning.message['en-IN'].indexOf('KP/0091'),
    'the largest amount is listed first',
  );
});
