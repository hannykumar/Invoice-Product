/**
 * Issue #34 [E34] — which period a question is about.
 *
 * "How much did I sell?" has no period in it, and a figure for the wrong period is worse than no
 * figure at all. So the period is read from the words where the words say one, and where they do
 * not, the assistant uses this month **and says so on the answer as an assumption**. An assumption
 * a person can see is a different thing from a default nobody mentioned.
 *
 * India's financial year runs 1 April to 31 March, which `@invoice/kernel` already knows.
 */
import { financialYearOf, financialYearRange, isoDate, monthRange, type IsoDate } from '@invoice/kernel';
import type { Bilingual } from './model.ts';

export interface ResolvedPeriod {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly described: Bilingual;
  /** True when nothing in the question named a period, so this one was assumed. */
  readonly assumed: boolean;
}

const MONTHS: readonly { readonly names: readonly string[]; readonly month: number }[] = [
  { names: ['january', 'jan'], month: 1 },
  { names: ['february', 'feb'], month: 2 },
  { names: ['march', 'mar'], month: 3 },
  { names: ['april', 'apr'], month: 4 },
  { names: ['may'], month: 5 },
  { names: ['june', 'jun'], month: 6 },
  { names: ['july', 'jul'], month: 7 },
  { names: ['august', 'aug'], month: 8 },
  { names: ['september', 'sep', 'sept'], month: 9 },
  { names: ['october', 'oct'], month: 10 },
  { names: ['november', 'nov'], month: 11 },
  { names: ['december', 'dec'], month: 12 },
];

const monthKey = (year: number, month: number): string => `${year}-${String(month).padStart(2, '0')}`;

const previousMonth = (today: IsoDate): { year: number; month: number } => {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
};

const described = (en: string, hi: string): Bilingual => ({ 'en-IN': en, 'hi-IN': hi });

const daysBefore = (today: IsoDate, days: number): IsoDate => {
  const at = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)));
  const then = new Date(at - days * 86_400_000);
  return isoDate(
    `${then.getUTCFullYear()}-${String(then.getUTCMonth() + 1).padStart(2, '0')}-${String(then.getUTCDate()).padStart(2, '0')}`,
  );
};

/**
 * Works out the period from the words.
 *
 * `today` is passed in rather than read from a clock, because a period is a fact about the question
 * and has to be reproducible: the same question and the same day always give the same period.
 */
export const resolvePeriod = (question: string, today: IsoDate): ResolvedPeriod => {
  const text = question.toLowerCase();
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));

  if (/\b(today|aaj)\b/.test(text)) {
    return { from: today, to: today, described: described('today', 'aaj'), assumed: false };
  }
  if (/\b(yesterday|kal\s+tak|beeta\s+kal)\b/.test(text)) {
    const then = daysBefore(today, 1);
    return { from: then, to: then, described: described('yesterday', 'kal'), assumed: false };
  }

  const lastDays = /\b(?:last|past|pichhle|pichle)\s+(\d{1,3})\s+(?:days?|din)\b/.exec(text);
  if (lastDays !== null) {
    const days = Number(lastDays[1]);
    return {
      from: daysBefore(today, days - 1),
      to: today,
      described: described(`the last ${days} days`, `pichhle ${days} din`),
      assumed: false,
    };
  }

  if (/\b(last month|previous month|pichhle mahine|pichle mahine|pichhle maheene)\b/.test(text)) {
    const previous = previousMonth(today);
    const range = monthRange(monthKey(previous.year, previous.month));
    return { ...range, described: described('last month', 'pichhle mahine'), assumed: false };
  }
  if (/\b(this month|is mahine|is maheene|current month)\b/.test(text)) {
    const range = monthRange(monthKey(year, month));
    return { ...range, described: described('this month', 'is mahine'), assumed: false };
  }

  if (/\b(last (?:financial )?year|pichhle saal|pichle saal|previous year)\b/.test(text)) {
    const current = financialYearOf(today);
    const startYear = Number(current.slice(0, 4)) - 1;
    const range = financialYearRange(`${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`);
    return {
      ...range,
      described: described(`last financial year (${startYear}-${String((startYear + 1) % 100).padStart(2, '0')})`, `pichhla saal (${startYear}-${String((startYear + 1) % 100).padStart(2, '0')})`),
      assumed: false,
    };
  }
  if (/\b(this (?:financial )?year|is saal|current year|financial year|is varsh)\b/.test(text)) {
    const financialYear = financialYearOf(today);
    const range = financialYearRange(financialYear);
    return {
      from: range.from,
      to: today,
      described: described(`this financial year (${financialYear}) up to today`, `is saal (${financialYear}) aaj tak`),
      assumed: false,
    };
  }

  // A named month, with the year when it is given: "in April", "April 2026".
  for (const candidate of MONTHS) {
    const pattern = new RegExp(`\\b(${candidate.names.join('|')})\\b\\s*(\\d{4})?`, 'i');
    const found = pattern.exec(text);
    if (found === null) continue;
    const namedYear = found[2] === undefined ? (candidate.month > month ? year - 1 : year) : Number(found[2]);
    const range = monthRange(monthKey(namedYear, candidate.month));
    return {
      ...range,
      described: described(`${candidate.names[0]} ${namedYear}`, `${candidate.names[0]} ${namedYear}`),
      assumed: false,
    };
  }

  const range = monthRange(monthKey(year, month));
  return { ...range, described: described('this month', 'is mahine'), assumed: true };
};

/** What the answer says when it had to assume the period. */
export const ASSUMED_PERIOD_NOTE = (period: ResolvedPeriod): Bilingual => ({
  'en-IN': `You did not say which period, so this is ${period.described['en-IN']}. Ask again with a month or a year if you meant something else.`,
  'hi-IN': `Aapne samay nahin bataya, isliye yeh ${period.described['hi-IN']} ka hai. Koi aur samay chahiye to mahina ya saal batakar dobara poochein.`,
});
