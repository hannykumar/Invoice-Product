/**
 * Issue #43 [E43] — comparing what happened against what was expected.
 *
 * The comparison is deliberately strict and deliberately specific: a mismatch names the figure,
 * what was expected and what came out. A golden dataset whose failure message is "not equal" costs
 * more time than it saves.
 *
 * It is also the thing the mutation tests point at. If this returns "matches" for a dataset whose
 * figures have been tampered with, the whole exercise is theatre, so there are tests that tamper
 * on purpose and require a failure.
 */
import type { ExpectedOutputs, GoldenFixture } from './schema.ts';
import type { ReplayResult } from './replay.ts';

export interface Mismatch {
  readonly what: string;
  readonly expected: string;
  readonly actual: string;
}

const compareValue = (what: string, expected: string, actual: string, into: Mismatch[]): void => {
  if (expected !== actual) into.push({ what, expected, actual });
};

/**
 * Checks each declared refusal happened, and happened for the reason the fixture states. A code on
 * its own is not enough: `SALES_NEEDS_INFO` covers every reason a bill cannot be issued, so a
 * dataset that pinned only the code would keep passing if the module started refusing for
 * something else entirely.
 */
export const compareRefusalReasons = (fixture: GoldenFixture, actual: ReplayResult): readonly Mismatch[] => {
  const mismatches: Mismatch[] = [];
  for (const event of fixture.events) {
    if (event.kind !== 'sale_refused') continue;
    const found = actual.refusalDetails.find((refusal) => refusal.ref === event.ref);
    if (found === undefined) {
      mismatches.push({ what: `${event.ref} should have been refused`, expected: event.expectedCode, actual: 'it went through' });
      continue;
    }
    compareValue(`${event.ref} refusal code`, event.expectedCode, found.code, mismatches);
    if (!found.message.includes(event.expectedMessageContains)) {
      mismatches.push({
        what: `${event.ref} was refused for the wrong reason`,
        expected: `a message containing "${event.expectedMessageContains}"`,
        actual: found.message,
      });
    }
  }
  return mismatches;
};

export const compareToExpected = (expected: ExpectedOutputs, actual: ReplayResult): readonly Mismatch[] => {
  const mismatches: Mismatch[] = [];

  compareValue('the books balance', String(expected.trialBalanceBalanced), String(actual.trialBalanceBalanced), mismatches);
  compareValue('total debits', expected.totalDebits, actual.totalDebits, mismatches);
  compareValue('total credits', expected.totalCredits, actual.totalCredits, mismatches);

  // Every account the fixture names must be there with that balance. Accounts the fixture does not
  // name are allowed: a fixture states what it is about, not every row of the chart.
  for (const account of expected.accounts) {
    const found = actual.accounts.find((row) => row.code === account.code);
    if (found === undefined) {
      mismatches.push({ what: `account ${account.code} (${account.name})`, expected: account.balance, actual: 'the account has no entries' });
      continue;
    }
    compareValue(`account ${account.code} (${account.name})`, account.balance, found.balance, mismatches);
  }

  for (const item of expected.stock) {
    const found = actual.stock.find((row) => row.itemId === item.itemId);
    if (found === undefined) {
      mismatches.push({ what: `stock of ${item.itemId}`, expected: `${item.physical} ${item.unit}`, actual: 'the item was not counted' });
      continue;
    }
    compareValue(`stock of ${item.itemId}`, `${item.physical} ${item.unit}`, `${found.physical} ${found.unit}`, mismatches);
  }

  compareValue('taxable value', expected.tax.taxableValue, actual.tax.taxableValue, mismatches);
  compareValue('central GST', expected.tax.cgst, actual.tax.cgst, mismatches);
  compareValue('state GST', expected.tax.sgst, actual.tax.sgst, mismatches);
  compareValue('GST on outside sales', expected.tax.igst, actual.tax.igst, mismatches);
  compareValue('total GST', expected.tax.total, actual.tax.total, mismatches);

  // Refusals are compared as a set in order: a fixture that expects an oversale to be refused must
  // see exactly that refusal, and a run that refused something extra has changed behaviour too.
  compareValue('refusals', expected.refusals.join(', ') || '(none)', actual.refusals.join(', ') || '(none)', mismatches);

  return mismatches;
};

export const describeMismatches = (fixture: GoldenFixture, mismatches: readonly Mismatch[]): string =>
  [
    `"${fixture.id}" did not match its golden expectations:`,
    ...mismatches.map((m) => `  ${m.what}: expected ${m.expected}, got ${m.actual}`),
    '',
    'If the new figures are right, the fixture must be changed deliberately, and the note on the',
    'expectation says what to review before doing so.',
  ].join('\n');
