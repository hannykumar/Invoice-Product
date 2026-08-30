/**
 * Issue #34 [E34] — small conveniences over issue #35's own fixture.
 *
 * The business, the reports and the actor all come from `packages/reports/test/fixtures.ts`, which
 * is a real company run through the real modules. Nothing is re-created here; this file only names
 * the period the tests ask about and re-exports what they need.
 */
import { isoDate, monthRange } from '@invoice/kernel';
import type { ReportFilter } from '@invoice/reports';

export { aBusyMonth, actorWith, makeBusiness, ALL_PERMISSIONS, OTHER, SHARMA, type Business } from '../../reports/test/fixtures.ts';

/** The whole of one month, which is what a question like "this month" resolves to. */
export const monthFilterFor = (monthKey: string): ReportFilter => {
  const range = monthRange(monthKey);
  return { from: range.from, to: range.to };
};

export const day = (value: string) => isoDate(value);
