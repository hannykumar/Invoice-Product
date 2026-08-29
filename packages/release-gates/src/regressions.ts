/**
 * Issue #48 [E48] — every financial defect we have found, and the test that stops it coming back.
 *
 * "Every discovered financial defect gains a regression test" is an acceptance criterion, and a
 * criterion nobody can check is a wish. This register is the checkable form: each entry names the
 * defect, what went wrong in business terms, and the test file that would fail if it returned.
 *
 * A test in the register guards `packages/release-gates/test/regressions.test.ts`, which asserts
 * every named file exists and every entry is filled in. Adding a defect here without adding its
 * test therefore breaks the build, which is the only way this stays honest.
 */

export interface RegressionEntry {
  /** The issue it was found under, or the PR if it was found in passing. */
  readonly foundIn: string;
  /** What the product did wrong, in the terms a business would notice. */
  readonly defect: string;
  /** Why it mattered, so nobody "simplifies" the guard away later. */
  readonly consequence: string;
  /** The file that fails if it returns. Checked to exist. */
  readonly guardedBy: string;
  readonly fixedOn: string;
}

export const REGRESSION_REGISTER: readonly RegressionEntry[] = [
  {
    foundIn: '#86',
    defect:
      'Asking how much of a batch-tracked item was in a godown answered zero, because not naming a batch was read as naming the empty one.',
    consequence:
      'Zero is the most dangerous wrong answer stock can give: it reads as "we are out of it", and a reorder prompt, a low-stock warning or a negative-stock guard would all act on it.',
    guardedBy: 'packages/inventory/test/inventory.test.ts',
    fixedOn: '2026-08-29',
  },
  {
    foundIn: '#73',
    defect:
      'The chart of accounts had no home for services bought or for GST owed under reverse charge, so freight had to be filed under "purchases of goods".',
    consequence:
      'Freight in purchases of goods overstates what stock cost and misstates the profit and loss. A reverse-charge liability with no system role is invisible to anything that looks it up by role, including the return.',
    guardedBy: 'packages/ledger/test/chart-of-accounts.test.ts',
    fixedOn: '2026-08-29',
  },
  {
    foundIn: '#43',
    defect:
      'The golden replay sold a service as though it were goods, so a service sale was refused for want of stock that a service never has.',
    consequence:
      'A harness that mis-sells services would have quietly recorded "services cannot be sold" as the expected behaviour of the product.',
    guardedBy: 'packages/golden-dataset/test/golden.test.ts',
    fixedOn: '2026-08-29',
  },
  {
    foundIn: '#48',
    defect:
      'The GST gate compared a bill\'s total tax with the sum of its parts, but the total is re-summed from those same parts, so the check was comparing a number with itself.',
    consequence:
      'A deliberately injected defect that dropped state GST from a line total passed every gate. A check that cannot fail is worse than no check, because it is reported as assurance.',
    guardedBy: 'packages/release-gates/test/gates.test.ts',
    fixedOn: '2026-08-30',
  },
  {
    foundIn: '#35',
    defect:
      'Money a customer had paid against no particular bill was counted on both the money-owed-to-us and money-we-owe pages, so it appeared twice.',
    consequence:
      'A figure counted twice in a report is a figure an owner plans around wrongly, and it was in the exception list that is supposed to be the trustworthy part.',
    guardedBy: 'packages/reports/test/reports.test.ts',
    fixedOn: '2026-08-29',
  },
];
