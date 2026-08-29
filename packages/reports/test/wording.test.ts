/**
 * Issue #35 [E35] — the pages are read by someone who has never studied accounting.
 *
 * Every sentence, heading, column and note a report puts in front of a person goes through issue
 * #46's linter here. It is the same check the message catalogue passes, applied to the wording a
 * report generates from its own figures, because wording that is only reviewed by eye drifts.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { supportedLocales, type Locale } from '@invoice/ux-vocabulary';
import { lintUserFacingText } from '@invoice/ux-vocabulary/lint';
import {
  ageingTable,
  balanceSheetTable,
  exceptionsTable,
  gstTable,
  profitAndLossTable,
  registerTable,
  stockTable,
  trialBalanceTable,
  type Bilingual,
  renderPack,
} from '../src/index.ts';
import { aBusyMonth, on } from './fixtures.ts';

const FILTER = { from: on('2026-04-01'), to: on('2026-05-31') };

/**
 * Words the pages teach on purpose. "GST" is on every bill in the country and hiding it would be
 * less clear, not more; "opening" and "closing" are the two words a report cannot do without and
 * both are explained on the page itself.
 */
const TAUGHT = ['gst', 'stock', 'balance', 'account', 'accounts'];

const check = (text: string, where: string, locale: Locale): void => {
  const issues = lintUserFacingText(text, { locale, allow: TAUGHT });
  assert.equal(issues.length, 0, `${where} (${locale}): "${text}" — ${issues.map((i) => i.detail).join('; ')}`);
};

const checkBoth = (sentence: Bilingual, where: string): void => {
  for (const locale of supportedLocales()) check(sentence[locale], where, locale);
};

test('every sentence a report writes is one a shopkeeper can read', async () => {
  const business = await aBusyMonth();
  const pack = await business.reports.pack(business.actor, FILTER);

  for (const [name, report] of Object.entries(pack)) {
    checkBoth(report.header.title, `${name} title`);
    for (const note of report.header.notes) checkBoth(note, `${name} note`);
  }

  checkBoth(pack.profitAndLoss.body.sentence, 'what was earned');
  checkBoth(pack.profitAndLoss.body.income.heading, 'income heading');
  checkBoth(pack.profitAndLoss.body.expenses.heading, 'expenses heading');
  checkBoth(pack.balanceSheet.body.sentence, 'balance sheet');
  checkBoth(pack.balanceSheet.body.assets.heading, 'assets heading');
  checkBoth(pack.balanceSheet.body.liabilities.heading, 'liabilities heading');
  checkBoth(pack.balanceSheet.body.ownersMoney.heading, "owner's money heading");
  checkBoth(pack.sales.body.sentence, 'sales register');
  checkBoth(pack.purchases.body.sentence, 'purchase register');
  checkBoth(pack.stock.body.sentence, 'stock');
  checkBoth(pack.receivables.body.sentence, 'what customers owe');
  checkBoth(pack.payables.body.sentence, 'what is owed to suppliers');
  checkBoth(pack.gst.body.sentence, 'gst summary');
  checkBoth(pack.gst.body.caution, 'gst caution');
  checkBoth(pack.exceptions.body.sentence, 'exceptions');

  for (const head of pack.gst.body.heads) checkBoth(head.label, 'gst head');
  for (const band of pack.receivables.body.bandLabels) checkBoth(band, 'ageing band');
  for (const row of pack.receivables.body.rows) checkBoth(row.sentence, `${row.partyName}'s position`);
  for (const problem of pack.exceptions.body.exceptions) {
    checkBoth(problem.what, `${problem.code} — what happened`);
    checkBoth(problem.why, `${problem.code} — why it matters`);
  }
});

test('every column heading on an exported page is plain wording, in both languages', async () => {
  const business = await aBusyMonth();
  const pack = await business.reports.pack(business.actor, FILTER);
  for (const locale of supportedLocales()) {
    const tables = [
      trialBalanceTable(pack.trialBalance.body, locale),
      profitAndLossTable(pack.profitAndLoss.body, locale),
      balanceSheetTable(pack.balanceSheet.body, locale),
      registerTable(pack.sales.body, locale),
      stockTable(pack.stock.body, locale),
      ageingTable(pack.receivables.body, locale),
      gstTable(pack.gst.body, locale),
      exceptionsTable(pack.exceptions.body, locale),
    ];
    for (const table of tables) for (const column of table.columns) check(column, 'a column heading', locale);
  }
});

test('a page asked for in Hindi does not come back half in English', async () => {
  const business = await aBusyMonth();
  const pack = await business.reports.pack(business.actor, FILTER);
  const page = renderPack(pack, 'Sharma Fruit Traders', 'hi-IN');
  // Headings and labels the English page uses, which must not survive into the Hindi one.
  for (const english of ['What is left', 'Came in', 'Kind of GST', 'Everything you earned', 'What it was', 'Still owed']) {
    assert.equal(page.includes(english), false, `"${english}" is left in English on the Hindi page`);
  }
  assert.ok(page.includes('Godown mein kya bacha hai'));
});

test('no page shows an internal state name where a person can see it', async () => {
  const business = await aBusyMonth();
  const pack = await business.reports.pack(business.actor, FILTER);
  const rendered = JSON.stringify(pack, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
  // Codes are for callers. Anything a person reads is a sentence, checked above.
  for (const shouted of ['PENDING_APPROVAL', 'NEEDS_INFO', 'PURCHASE_IN', 'SALE_OUT', 'CGST_SGST']) {
    assert.equal(rendered.includes(shouted), false, `${shouted} is leaking into a report`);
  }
});
