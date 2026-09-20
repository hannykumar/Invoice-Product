/**
 * Issue #192 — the 30 November deadline for claiming credit on a supplier's bill.
 *
 * **CGST Act section 16(4):** a registered person may not take input tax credit on a supplier's
 * invoice or debit note after the 30th of November following the end of the financial year the
 * document belongs to, or after furnishing the annual return, whichever is earlier.
 *
 * Each test fails if the change is reverted: before it, a bill from any year showed as claimable
 * in any return, and the officer's disallowance and interest arrived long afterwards.
 *
 * Every GST number below is synthetic and belongs to nobody.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { asId, fixedClock, isoDate } from '@invoice/kernel';
import { InMemoryAuditPort, type ActorContext } from '@invoice/ledger';
import {
  InMemoryImportBatches, InMemoryItcDecisions, InMemoryPortalRecords, InMemoryPurchaseBooks,
} from '../src/adapters.ts';
import { ItcReconciliationService } from '../src/service.ts';
import { CLAIM_DEADLINE_WARNING_DAYS, daysBetween, lastClaimDateFor, returnDueDateFor } from '../src/itc.ts';
import { BLESSING_BILL, NEW_YEAR_BILL, SUNRISE_COMPANY } from '../src/fixtures.ts';
import {
  ITC_PERMISSIONS, taxPeriod, totalTaxOf, type BookPurchaseDocument, type ItcWorkspace,
} from '../src/types.ts';

const owner: ActorContext = {
  companyId: SUNRISE_COMPANY,
  branchId: asId<'Branch'>('main'),
  userId: asId<'User'>('22222222-2222-4222-8222-222222222222'),
  permissions: Object.values(ITC_PERMISSIONS),
};

/** A workspace for one month, built from the bills given and no portal data at all. */
const workspaceFor = async (
  books: readonly BookPurchaseDocument[],
  period: string,
  today = '2026-08-14T10:00:00.000Z',
): Promise<ItcWorkspace> => {
  const store = new InMemoryPurchaseBooks();
  store.add(...books);
  let counter = 0;
  const service = new ItcReconciliationService({
    books: store,
    records: new InMemoryPortalRecords(),
    batches: new InMemoryImportBatches(),
    decisions: new InMemoryItcDecisions(),
    audit: new InMemoryAuditPort(),
    clock: fixedClock(today),
    idFactory: () => `id-${++counter}`,
  });
  return service.workspace(owner, taxPeriod(period));
};

const only = (workspace: ItcWorkspace) => {
  const line = workspace.lines[0];
  assert.ok(line !== undefined, 'expected one line');
  return line;
};

// ------------------------------------------------------------------- the date itself

test('the last claim date is the 30 November after the bill\'s financial year ends', () => {
  // 13 March 2026 is in 2025-26; that year ends 31 March 2026; the next 30 November is in 2026.
  assert.equal(lastClaimDateFor(isoDate('2026-03-13')), '2026-11-30');
  // The last day of the same year, and the first day of the next one, are eight months apart in
  // the calendar and a whole year apart in their deadlines.
  assert.equal(lastClaimDateFor(isoDate('2026-03-31')), '2026-11-30');
  assert.equal(lastClaimDateFor(isoDate('2026-04-01')), '2027-11-30');
});

test('a monthly return is due on the 20th of the month after it, December included', () => {
  assert.equal(returnDueDateFor(taxPeriod('2026-10')), '2026-11-20');
  assert.equal(returnDueDateFor(taxPeriod('2026-11')), '2026-12-20');
  assert.equal(returnDueDateFor(taxPeriod('2026-12')), '2027-01-20');
});

// ------------------------------------------------------------- before and after the deadline

test('a bill of 13 March 2026 is still claimable in October 2026 and time-barred from November', async () => {
  const october = only(await workspaceFor([BLESSING_BILL('2026-10')], '2026-10'));
  assert.equal(october.lastClaimDate, '2026-11-30');
  // October's return is due 20 November 2026, which is before 30 November, so the credit is only
  // waiting on the supplier's filing — not refused.
  assert.equal(october.outcome, 'HELD_BACK');
  assert.ok(!october.findings.some((f) => f.code === 'ITC_TIME_BARRED'));

  for (const period of ['2026-11', '2026-12', '2027-03']) {
    const later = only(await workspaceFor([BLESSING_BILL(period)], period));
    assert.equal(later.outcome, 'TIME_BARRED', `${period} is after the deadline`);
    assert.equal(later.lastClaimDate, '2026-11-30');
    assert.equal(totalTaxOf(later.claimable).minor, 0n, 'nothing is claimed on it');
    const barred = later.findings.find((f) => f.code === 'ITC_TIME_BARRED');
    assert.ok(barred !== undefined);
    assert.equal(barred.severity, 'BLOCKING');
    assert.equal(barred.message['en-IN'], 'Credit on this bill had to be claimed by 30 November 2026.');
  }
});

test('a bill dated the first day of a financial year has the next year\'s 30 November', async () => {
  const line = only(await workspaceFor([NEW_YEAR_BILL('2026-11')], '2026-11'));
  assert.equal(line.lastClaimDate, '2027-11-30');
  // The bill beside it, eighteen days older, is already out of time in the very same return.
  assert.notEqual(line.outcome, 'TIME_BARRED');
});

test('a time-barred bill stays in the purchase books and is kept out of the claimable figure', async () => {
  const workspace = await workspaceFor([BLESSING_BILL('2026-12')], '2026-12');
  assert.equal(workspace.lines.length, 1, 'the bill is still there — only the credit is refused');
  assert.equal(workspace.lines[0]?.book?.number, 'BE/DL/25-26/0139');
  assert.equal(totalTaxOf(workspace.claimable).minor, 0n);
  // ₹10,800 of IGST, out of the claim and out of "held back" as well: held-back credit comes back
  // on the month it is settled, and this never comes back.
  assert.equal(totalTaxOf(workspace.timeBarred).minor, 10_800_00n);
  assert.equal(totalTaxOf(workspace.heldBack).minor, 0n);
  assert.equal(workspace.outcomeCounts.TIME_BARRED, 1);
  assert.match(workspace.returnLinkage.caution['en-IN'], /does not come back: the last date for claiming it has gone by/);
});

// --------------------------------------------------------------------- the warning before it

test('a bill within 45 days of its deadline is listed in a warning, largest first', async () => {
  // 20 October 2026 is 41 days before 30 November 2026, and 41 is inside the 45-day window.
  assert.equal(daysBetween(isoDate('2026-10-20'), isoDate('2026-11-30')), 41);
  assert.ok(41 <= CLAIM_DEADLINE_WARNING_DAYS);

  const workspace = await workspaceFor(
    [BLESSING_BILL('2026-10'), NEW_YEAR_BILL('2026-10')],
    '2026-10',
    '2026-10-20T06:00:00.000Z',
  );
  const warning = workspace.findings.find((f) => f.code === 'ITC_CLAIM_DEADLINE_NEAR');
  assert.ok(warning !== undefined, 'the warning is raised');
  assert.equal(warning.severity, 'WARNING');
  // Only the March bill: the April one is not due until 30 November 2027.
  assert.match(warning.message['en-IN'], /1 bill has credit/);
  assert.match(warning.message['en-IN'], /BE\/DL\/25-26\/0139 \(₹10,800\.00, by 30 November 2026\)/);
  assert.ok(!warning.message['en-IN'].includes('BE/DL/26-27/0001'));
});

test('a bill further out than 45 days raises no warning yet', async () => {
  // 1 October 2026 is 60 days before the deadline, which is outside the window.
  assert.equal(daysBetween(isoDate('2026-10-01'), isoDate('2026-11-30')), 60);
  const workspace = await workspaceFor([BLESSING_BILL('2026-10')], '2026-10', '2026-10-01T06:00:00.000Z');
  assert.ok(!workspace.findings.some((f) => f.code === 'ITC_CLAIM_DEADLINE_NEAR'));
});

test('a bill already out of time is not also warned about', async () => {
  const workspace = await workspaceFor([BLESSING_BILL('2026-12')], '2026-12', '2026-11-25T06:00:00.000Z');
  assert.ok(workspace.lines.some((line) => line.outcome === 'TIME_BARRED'));
  assert.ok(!workspace.findings.some((f) => f.code === 'ITC_CLAIM_DEADLINE_NEAR'), 'a warning about a door already shut is noise');
});

test('the warning puts the biggest amount first, because that is the call worth making', async () => {
  const small = BLESSING_BILL('2026-10');
  const large: BookPurchaseDocument = {
    ...small,
    sourceId: 'bill-blessing-large',
    number: 'BE/DL/25-26/0140',
    documentDate: isoDate('2026-03-20'),
    amounts: { ...small.amounts, taxableValue: { currency: 'INR', minor: 500_000_00n }, igst: { currency: 'INR', minor: 90_000_00n } },
    invoiceValue: { currency: 'INR', minor: 590_000_00n },
  };
  const workspace = await workspaceFor([small, large], '2026-10', '2026-10-20T06:00:00.000Z');
  const warning = workspace.findings.find((f) => f.code === 'ITC_CLAIM_DEADLINE_NEAR');
  assert.ok(warning !== undefined);
  assert.match(warning.message['en-IN'], /2 bills have credit/);
  const listed = warning.message['en-IN'];
  assert.ok(
    listed.indexOf('BE/DL/25-26/0140') < listed.indexOf('BE/DL/25-26/0139'),
    '₹90,000 is named before ₹10,800',
  );
});
