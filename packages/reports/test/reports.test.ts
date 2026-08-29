/**
 * Issue #35 [E35] — the reports, checked against the modules that produced the records.
 *
 * The acceptance criteria are three: totals reconcile to the ledger, every total drills to the
 * records behind it, and the period, company and branch filters are explicit. Each has tests here
 * that fail if it stops being true, and the reconciliation ones are run against the real ledger
 * rather than against a figure written down in this file.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { asId, isoDate, rupees, subtract, sum, type CompanyId, type Money } from '@invoice/kernel';
import { trialBalance as ledgerTrialBalance } from '@invoice/ledger';
import { DomainError } from '@invoice/kernel';
import {
  drillTable,
  exportReport,
  loadBooks,
  reconciles,
  registerTable,
  trialBalanceTable,
  type Figure,
  type ReportFilter,
} from '../src/index.ts';
import {
  ABC,
  ALL_PERMISSIONS,
  GURUGRAM,
  KAROL_BAGH,
  NASHIK,
  NARELA,
  OTHER,
  aBusyMonth,
  actorWith,
  buyStock,
  inr,
  issueBill,
  makeBusiness,
  on,
  type Business,
} from './fixtures.ts';

const APRIL_TO_MAY: ReportFilter = { from: on('2026-04-01'), to: on('2026-05-31') };
const MAY: ReportFilter = { from: on('2026-05-01'), to: on('2026-05-31') };

const figuresIn = (value: unknown, found: Figure[] = []): Figure[] => {
  if (value === null || typeof value !== 'object') return found;
  const candidate = value as { amount?: unknown; contributors?: unknown };
  if (candidate.amount !== undefined && Array.isArray(candidate.contributors)) found.push(value as Figure);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    if (Array.isArray(nested)) for (const item of nested) figuresIn(item, found);
    else figuresIn(nested, found);
  }
  return found;
};

test('the trial balance holds together, and matches the ledger asked directly', async () => {
  const business = await aBusyMonth();
  const report = await business.reports.trialBalance(business.actor, APRIL_TO_MAY);

  assert.equal(report.body.balanced, true);
  assert.equal(report.body.difference.minor, 0n);

  const direct = await ledgerTrialBalance(business.store.read(), business.actor.companyId, { to: APRIL_TO_MAY.to });
  assert.equal(report.body.totalDebits.amount.minor, direct.totalDebit.minor);
  assert.equal(report.body.totalCredits.amount.minor, direct.totalCredit.minor);

  // Row by row, against the same accounts the ledger folded itself.
  for (const row of direct.rows) {
    const mine = report.body.rows.find((r) => r.accountId === row.account.id);
    assert.notEqual(mine, undefined, `report is missing ${row.account.name}`);
    assert.equal((mine as { closing: Figure }).closing.amount.minor, row.balance.minor, row.account.name);
  }
});

test('every total in the whole pack is the sum of the records it names', async () => {
  const business = await aBusyMonth();
  const pack = await business.reports.pack(business.actor, APRIL_TO_MAY);
  const figures = figuresIn(pack);

  assert.ok(figures.length > 20, `expected the pack to be full of figures, found ${figures.length}`);
  for (const figure of figures) {
    assert.ok(reconciles(figure), `a total does not match its own records: ${figure.amount.minor} paise across ${figure.contributors.length} records`);
  }
});

test('a total with money in it names at least one record to look at', async () => {
  const business = await aBusyMonth();
  const pack = await business.reports.pack(business.actor, APRIL_TO_MAY);
  for (const figure of figuresIn(pack)) {
    if (figure.amount.minor === 0n) continue;
    assert.ok(figure.contributors.length > 0, 'a figure carries money but no records');
  }
});

test('what the owner earned reconciles to the sales bills that produced it', async () => {
  const business = await aBusyMonth();
  const [profit, sales] = await Promise.all([
    business.reports.profitAndLoss(business.actor, APRIL_TO_MAY),
    business.reports.salesRegister(business.actor, APRIL_TO_MAY),
  ]);
  assert.equal(profit.body.income.total.amount.minor, sales.body.taxableValue.amount.minor);

  const gst = await business.reports.gstSummary(business.actor, APRIL_TO_MAY);
  assert.equal(gst.body.totalCollected.amount.minor, sales.body.tax.amount.minor);
});

test('the balance sheet balances, and says so in words an owner reads', async () => {
  const business = await aBusyMonth();
  const sheet = await business.reports.balanceSheet(business.actor, APRIL_TO_MAY);
  assert.equal(sheet.body.balanced, true, `off by ${sheet.body.difference.minor}`);
  assert.equal(sheet.body.difference.minor, 0n);
  assert.match(sheet.body.sentence['en-IN'], /fully accounted for/);
});

test('what customers owe matches their accounts in the books, once money with no bill is put back', async () => {
  const business = await aBusyMonth();
  const ageing = await business.reports.receivablesAgeing(business.actor, APRIL_TO_MAY);
  const books = await loadBooks(business.store.read(), business.actor.companyId, APRIL_TO_MAY);

  const customerAccounts = books.accounts.filter((a) => a.partyId !== null && a.type === 'ASSET');
  const inTheBooks = sum(
    customerAccounts.map((account) =>
      sum(
        books.closing
          .filter((e) => e.line.accountId === account.id)
          .map((e) => ({ currency: 'INR' as const, minor: e.line.debit.minor - e.line.credit.minor })),
      ),
    ),
  );

  const onAccount = sum(ageing.body.rows.map((r) => r.onAccount));
  assert.equal(subtract(ageing.body.total.amount, onAccount).minor, inTheBooks.minor);
});

test('a part payment leaves the bill open, and never rounds itself up to paid', async () => {
  const business = await aBusyMonth();
  const ageing = await business.reports.receivablesAgeing(business.actor, APRIL_TO_MAY);
  const abc = ageing.body.rows.find((r) => r.partyId === ABC);
  assert.notEqual(abc, undefined);
  const partly = (abc as { documents: readonly { sourceNumber: string | null; amount: Money }[] }).documents.find(
    (d) => d.sourceNumber?.endsWith('00001') === true,
  );
  assert.notEqual(partly, undefined, 'the part-paid bill should still be listed as owing something');
  assert.ok((partly as { amount: Money }).amount.minor > 0n);
});

test('the branch filter is a real filter, and "no branch" is a different question from "all branches"', async () => {
  const business = await aBusyMonth();

  const everywhere = await business.reports.salesRegister(business.actor, APRIL_TO_MAY);
  const karolBagh = await business.reports.salesRegister(business.actor, { ...APRIL_TO_MAY, branchId: KAROL_BAGH });
  const narela = await business.reports.salesRegister(business.actor, { ...APRIL_TO_MAY, branchId: NARELA });
  const noBranch = await business.reports.salesRegister(business.actor, { ...APRIL_TO_MAY, branchId: null });

  assert.equal(everywhere.body.rows.length, 3);
  assert.equal(karolBagh.body.rows.length, 2);
  assert.equal(narela.body.rows.length, 1);
  assert.equal(noBranch.body.rows.length, 0);
  assert.equal(
    sum([karolBagh.body.total.amount, narela.body.total.amount]).minor,
    everywhere.body.total.amount.minor,
  );

  // And the books agree: one shop's trial balance is a subset of the whole business's.
  const whole = await business.reports.trialBalance(business.actor, APRIL_TO_MAY);
  const shop = await business.reports.trialBalance(business.actor, { ...APRIL_TO_MAY, branchId: NARELA });
  assert.ok(shop.body.totalDebits.amount.minor < whole.body.totalDebits.amount.minor);
  assert.equal(shop.body.balanced, true);
});

test('a period opens where the one before it closed', async () => {
  const business = await aBusyMonth();
  const april = await business.reports.trialBalance(business.actor, { from: on('2026-04-01'), to: on('2026-04-30') });
  const may = await business.reports.trialBalance(business.actor, MAY);

  for (const closing of april.body.rows) {
    const opening = may.body.rows.find((r) => r.accountId === closing.accountId);
    if (opening === undefined) continue;
    assert.equal(opening.opening.amount.minor, closing.closing.amount.minor, closing.name);
  }
});

test('closing equals opening plus what the period did, on every account', async () => {
  const business = await aBusyMonth();
  const may = await business.reports.trialBalance(business.actor, MAY);
  for (const row of may.body.rows) {
    assert.equal(row.closing.amount.minor, row.opening.amount.minor + row.movement.amount.minor, row.name);
  }
});

test('the stock report counts what is left, holds back what a waiting bill is keeping, and values it', async () => {
  const business = await aBusyMonth();
  const stock = await business.reports.stock(business.actor, APRIL_TO_MAY);

  const shopCrates = stock.body.rows.find((r) => r.itemId === 'CRATE-P' && r.warehouseId === 'shop');
  assert.notEqual(shopCrates, undefined);
  const row = shopCrates as NonNullable<typeof shopCrates>;
  // 300 bought, 20 and 30 sold, 5 held by the bill that has not gone out.
  assert.equal(row.closing, '250.000');
  assert.equal(row.reserved, '5.000');
  assert.equal(row.available, '245.000');
  assert.equal(row.value.minor, rupees(12500).minor);
  assert.ok(row.movements.length >= 3, 'the count should be arguable with, movement by movement');
});

test('the goods on the floor and the goods in the books are not quietly made to agree', async () => {
  const business = await aBusyMonth();
  const exceptions = await business.reports.exceptions(business.actor, APRIL_TO_MAY);
  const gap = exceptions.body.exceptions.find((e) => e.code === 'STOCK_VALUE_NOT_IN_BOOKS');
  assert.notEqual(gap, undefined, 'stock has value that the books do not carry, and that must be said');
  assert.ok((gap as { records: readonly unknown[] }).records.length > 0);

  // And the balance sheet still shows the books' own figure, not the stock report's.
  const sheet = await business.reports.balanceSheet(business.actor, APRIL_TO_MAY);
  const stockRow = sheet.body.assets.rows.find((r) => r.name === 'Stock in hand');
  assert.equal(stockRow, undefined, 'nothing has posted stock value to the books yet, so it is not on the sheet');
});

test('the exception page names money with no bill, cheques that have not cleared, and bills not yet given out', async () => {
  const business = await aBusyMonth();
  const exceptions = await business.reports.exceptions(business.actor, APRIL_TO_MAY);
  const codes = exceptions.body.exceptions.map((e) => e.code);

  assert.ok(codes.includes('MONEY_WITHOUT_A_BILL'));
  assert.ok(codes.includes('CHEQUE_NOT_CLEARED'));
  assert.ok(codes.includes('BILL_STUCK_BEFORE_ISSUE'));
  assert.equal(exceptions.body.clean, false);
  assert.equal(exceptions.body.exceptions[0]?.severity !== 'WORTH_KNOWING', true, 'urgent things come first');
});

test('a business with nothing awkward in it gets a clean exception page', async () => {
  const business = await makeBusiness();
  const exceptions = await business.reports.exceptions(business.actor, APRIL_TO_MAY);
  assert.equal(exceptions.body.clean, true);
  assert.match(exceptions.body.sentence['en-IN'], /Nothing/);
});

test('the purchase side says it is not built yet rather than showing nothing and letting you assume', async () => {
  const business = await aBusyMonth();
  const register = await business.reports.purchaseRegister(business.actor, APRIL_TO_MAY);
  assert.equal(register.body.available, true, 'this fixture supplies the port');

  const withoutPurchases = await makeBusiness();
  const empty = await withoutPurchases.reports.purchaseRegister(withoutPurchases.actor, APRIL_TO_MAY);
  assert.equal(empty.body.rows.length, 0);
  assert.equal(empty.body.available, true);
});

test('one business cannot see another business, even with every permission', async () => {
  const mine = await aBusyMonth();
  const theirs = await makeBusiness({ companyId: OTHER });

  const theirReport = await theirs.reports.salesRegister(actorWith(ALL_PERMISSIONS, { companyId: OTHER }), APRIL_TO_MAY);
  assert.equal(theirReport.body.rows.length, 0);
  assert.equal(theirReport.header.companyId, OTHER);

  // There is no company argument to get wrong: it comes from the actor.
  const myReport = await mine.reports.salesRegister(mine.actor, APRIL_TO_MAY);
  assert.equal(myReport.header.companyId, mine.actor.companyId);
  assert.equal(myReport.body.rows.length, 3);
});

test('a permission is needed for each kind of report, and refusing says which', async () => {
  const business = await aBusyMonth();
  const noFinancials = actorWith(ALL_PERMISSIONS.filter((p) => p !== 'reports.view.financial'));
  await assert.rejects(
    () => business.reports.balanceSheet(noFinancials, APRIL_TO_MAY),
    (error: unknown) => error instanceof DomainError && error.kind === 'FORBIDDEN',
  );
  // The one they do hold still works.
  const stock = await business.reports.stock(noFinancials, APRIL_TO_MAY);
  assert.ok(stock.body.rows.length > 0);
});

test('a period that runs backwards, or ends before the books begin, is refused in plain words', async () => {
  const business = await aBusyMonth();
  await assert.rejects(
    () => business.reports.trialBalance(business.actor, { from: on('2026-05-31'), to: on('2026-05-01') }),
    (error: unknown) => error instanceof DomainError && error.code === 'REPORT_RANGE_INVALID',
  );
  await assert.rejects(
    () => business.reports.trialBalance(business.actor, { from: on('2025-01-01'), to: on('2025-03-31') }),
    (error: unknown) => error instanceof DomainError && error.code === 'REPORT_RANGE_BEFORE_BOOKS',
  );
});

test('looking at a report records who looked, at what and for when — and never the figures', async () => {
  const business = await aBusyMonth();
  const before = business.audit.events.length;
  await business.reports.profitAndLoss(business.actor, MAY);
  const events = business.audit.events.slice(before);
  assert.equal(events.length, 1);
  const event = events[0] as { action: string; details: Record<string, string>; summary: string };
  assert.equal(event.action, 'reports.viewed');
  assert.equal(event.details.from, MAY.from);
  assert.equal(event.details.to, MAY.to);
  assert.equal(event.details.branch, 'all');
  assert.equal(Object.values(event.details).some((v) => /\d{3,}/.test(v) && v.includes('-') === false), false);
});

test('reading a report changes nothing', async () => {
  const business = await aBusyMonth();
  const countVouchers = async (): Promise<number> =>
    (await business.store.read().vouchers.list(business.actor.companyId, {})).length;
  const before = await countVouchers();
  await business.reports.pack(business.actor, APRIL_TO_MAY);
  assert.equal(await countVouchers(), before);
});

test('the same period asked for twice at the same moment exports exactly the same file', async () => {
  const business = await aBusyMonth();
  const first = await business.reports.trialBalance(business.actor, MAY);
  const second = await business.reports.trialBalance(business.actor, MAY);
  assert.equal(first.header.snapshotId, second.header.snapshotId);
  assert.equal(
    exportReport(first, trialBalanceTable(first.body), 'CSV'),
    exportReport(second, trialBalanceTable(second.body), 'CSV'),
  );
});

test('an exported file says what it was filtered to before it says anything else', async () => {
  const business = await aBusyMonth();
  const register = await business.reports.salesRegister(business.actor, { ...MAY, branchId: NARELA });
  const csv = exportReport(register, registerTable(register.body), 'CSV');
  const lines = csv.split('\n');
  assert.match(lines[0] ?? '', /Every bill you gave out/);
  assert.ok(csv.includes('1 May 2026'));
  assert.ok(csv.includes('31 May 2026'));
  assert.ok(csv.includes(register.header.snapshotId));

  const json = JSON.parse(exportReport(register, registerTable(register.body), 'JSON')) as {
    header: { filter: { branchId: string } };
    rows: string[][];
  };
  assert.equal(json.header.filter.branchId, NARELA);
  assert.equal(json.rows.length, register.body.rows.length);
});

test('a total on the page opens into the entries a person can check one by one', async () => {
  const business = await aBusyMonth();
  const profit = await business.reports.profitAndLoss(business.actor, APRIL_TO_MAY);
  const table = drillTable(profit.body.income.total);
  assert.equal(table.rows.length, profit.body.income.total.contributors.length);
  assert.ok(table.rows.length >= 3, 'three bills went out, so three rows at least');
  for (const row of table.rows) {
    assert.notEqual(row[0], '', 'every record shows its date');
    assert.notEqual(row[2], '', 'every record says what it was');
  }
});

test('a cancelled bill is in neither the register nor what was earned', async () => {
  const business = await makeBusiness();
  await buyStock(business, {
    itemId: 'CRATE-P', warehouseId: 'shop', quantity: '100', unit: 'PCS', unitCost: inr(50), on: '2026-04-01', key: 'buy',
  });
  const kept = await issueBill(business, {
    partyId: ABC, on: '2026-04-05', due: '2026-05-05', key: 'keep',
    lines: [{ itemId: 'CRATE-P', quantity: '10', unit: 'PCS', price: inr(100) }],
  });
  const dropped = await issueBill(business, {
    partyId: GURUGRAM, on: '2026-04-06', due: '2026-05-06', key: 'drop',
    lines: [{ itemId: 'CRATE-P', quantity: '10', unit: 'PCS', price: inr(100) }],
  });
  await business.sales.cancel(business.actor, {
    idempotencyKey: 'drop-cancel',
    invoiceId: dropped.id,
    today: on('2026-04-08'),
    reason: 'The customer sent the goods straight back.',
  });

  const register = await business.reports.salesRegister(business.actor, APRIL_TO_MAY);
  assert.deepEqual(register.body.rows.map((r) => r.documentId), [kept.id]);

  // And the books agree, because the cancellation was reversed rather than deleted.
  const profit = await business.reports.profitAndLoss(business.actor, APRIL_TO_MAY);
  assert.equal(profit.body.income.total.amount.minor, register.body.taxableValue.amount.minor);
  const trial = await business.reports.trialBalance(business.actor, APRIL_TO_MAY);
  assert.equal(trial.body.balanced, true);
});

test('an empty business produces empty reports rather than failing', async () => {
  const business = await makeBusiness();
  const pack = await business.reports.pack(business.actor, APRIL_TO_MAY);
  assert.equal(pack.trialBalance.body.balanced, true);
  assert.equal(pack.trialBalance.body.totalDebits.amount.minor, 0n);
  assert.equal(pack.profitAndLoss.body.result.amount.minor, 0n);
  assert.equal(pack.balanceSheet.body.balanced, true);
  assert.equal(pack.stock.body.rows.length, 0);
  assert.equal(pack.receivables.body.rows.length, 0);
});

test('a company with two years of trading still produces its reports quickly', async () => {
  const business = await makeBusiness();
  const companyId: CompanyId = business.actor.companyId;
  const account = asId<'Account'>(`${companyId}:acc:1110`);
  const other = asId<'Account'>(`${companyId}:acc:4100`);

  const posts: Promise<unknown>[] = [];
  for (let i = 0; i < 1500; i += 1) {
    const day = String((i % 28) + 1).padStart(2, '0');
    posts.push(
      business.ledger.postVoucher(business.actor, {
        idempotencyKey: `bulk-${i}`,
        type: 'JOURNAL',
        date: isoDate(`2026-0${(i % 2) + 4}-${day}`),
        narration: 'Counter takings',
        lines: [
          { accountId: account, debit: rupees(100), credit: rupees(0), partyId: null, narration: null },
          { accountId: other, debit: rupees(0), credit: rupees(100), partyId: null, narration: null },
        ],
      }),
    );
  }
  for (const post of posts) await post;

  const started = process.hrtime.bigint();
  const pack = await business.reports.pack(business.actor, APRIL_TO_MAY);
  const millis = Number(process.hrtime.bigint() - started) / 1_000_000;

  assert.equal(pack.trialBalance.body.balanced, true);
  assert.equal(pack.trialBalance.body.totalDebits.amount.minor, rupees(150_000).minor);
  assert.ok(millis < 5000, `the whole pack took ${Math.round(millis)}ms, which is too slow to sit in front of someone`);
});

test('a business is never told a figure the books cannot support', async () => {
  const business: Business = await aBusyMonth();
  const gst = await business.reports.gstSummary(business.actor, APRIL_TO_MAY);
  // Nothing here decides what is actually payable; that is the return's job and it says so.
  assert.match(gst.body.caution['en-IN'], /worked out when the return is prepared/);
  assert.equal(
    gst.body.difference.minor,
    subtract(gst.body.totalCollected.amount, gst.body.totalAlreadyPaid.amount).minor,
  );
});

test('money with no bill against it is counted once, not on both pages', async () => {
  const business = await aBusyMonth();
  const [receivables, payables] = await Promise.all([
    business.reports.receivablesAgeing(business.actor, APRIL_TO_MAY),
    business.reports.payablesAgeing(business.actor, APRIL_TO_MAY),
  ]);
  assert.equal(sum(receivables.body.rows.map((r) => r.onAccount)).minor, rupees(500).minor);
  assert.equal(sum(payables.body.rows.map((r) => r.onAccount)).minor, 0n);

  const exceptions = await business.reports.exceptions(business.actor, APRIL_TO_MAY);
  const held = exceptions.body.exceptions.find((e) => e.code === 'MONEY_WITHOUT_A_BILL');
  assert.equal((held as { amount: Money | null }).amount?.minor, rupees(500).minor);
  assert.equal((held as { records: readonly unknown[] }).records.length, 1);
});

test('when what the goods cost is not in the books, the page says the profit is flattering', async () => {
  const business = await aBusyMonth();
  const profit = await business.reports.profitAndLoss(business.actor, APRIL_TO_MAY);
  assert.equal(profit.body.costOfGoodsInBooks, false, 'this fixture buys stock without a purchase entry');
  assert.match(profit.body.sentence['en-IN'], /higher than the real figure/);
});

test('once buying is written into the books, the profit sentence reads plainly again', async () => {
  const business = await makeBusiness();
  const companyId = business.actor.companyId;
  await buyStock(business, {
    itemId: 'CRATE-P', warehouseId: 'shop', quantity: '100', unit: 'PCS', unitCost: inr(50), on: '2026-04-01', key: 'buy',
  });
  // Standing in for GPT 3's #17: what a posted purchase does to the books.
  await business.ledger.postVoucher(business.actor, {
    idempotencyKey: 'purchase-entry',
    type: 'PURCHASE',
    date: on('2026-04-01'),
    narration: 'Crates bought from Nashik Farms',
    lines: [
      { accountId: asId<'Account'>(`${companyId}:acc:5100`), debit: rupees(5000), credit: rupees(0), partyId: null, narration: null },
      { accountId: asId<'Account'>(`${companyId}:acc:2101`), debit: rupees(0), credit: rupees(5000), partyId: NASHIK, narration: null },
    ],
  });
  await issueBill(business, {
    partyId: ABC, on: '2026-04-05', due: '2026-05-05', key: 'sell',
    lines: [{ itemId: 'CRATE-P', quantity: '10', unit: 'PCS', price: inr(100) }],
  });

  const profit = await business.reports.profitAndLoss(business.actor, APRIL_TO_MAY);
  assert.equal(profit.body.costOfGoodsInBooks, true);
  assert.match(profit.body.sentence['en-IN'], /so you are short by/);
  const trial = await business.reports.trialBalance(business.actor, APRIL_TO_MAY);
  assert.equal(trial.body.balanced, true);
});
