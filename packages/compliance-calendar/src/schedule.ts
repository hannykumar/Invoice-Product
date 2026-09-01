/**
 * Issue #32 [E32] — turning a rule into a date, and a date into the day somebody can act on.
 *
 * Everything in this file is pure arithmetic on calendar dates. It is separated from the service so
 * that the questions this module gets wrong most expensively — what is today in India, does the
 * deadline move because it is a Sunday, which quarter does August belong to — can be tested without
 * a database, a clock or a company.
 *
 * Two distinctions run through it.
 *
 *   1. **A calendar date is not an instant.** A due date is "20 September 2026" in India, not a
 *      moment in UTC. `todayIn` is the only bridge between the two, and every caller crosses it once
 *      at the top rather than doing date arithmetic on a `Date` and hoping the server is in Mumbai.
 *   2. **The deadline and the reminder are different dates.** The deadline is whatever the rule
 *      says, Sunday or not. The reminder is hung on the last working day at or before it, because a
 *      warning that arrives on a day the business cannot file is a warning that arrives too late.
 */
import { isoDate, type Clock, type IsoDate } from '@invoice/kernel';
import { bilingual, type Bilingual, type Cadence, type DueDateShift, type DueRule, type ObligationPeriod } from './types.ts';

// ---------------------------------------------------------------------------- days

const MS_PER_DAY = 86_400_000;

const utc = (date: IsoDate): number => Date.parse(`${date}T00:00:00.000Z`);

const fromUtc = (millis: number): IsoDate => isoDate(new Date(millis).toISOString().slice(0, 10));

export const addDays = (date: IsoDate, days: number): IsoDate => fromUtc(utc(date) + days * MS_PER_DAY);

/** Whole days from `from` to `to`. Positive when `to` is later. Both are calendar dates. */
export const daysBetween = (from: IsoDate, to: IsoDate): number => Math.round((utc(to) - utc(from)) / MS_PER_DAY);

/** 0 is Sunday, 6 is Saturday, as `Date` counts them. */
export const dayOfWeek = (date: IsoDate): number => new Date(utc(date)).getUTCDay();

const lastDayOfMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * The calendar date in a time zone at a given instant.
 *
 * This is the whole of the product's time-zone handling for deadlines and it is deliberately one
 * function. A run started at 19:30 UTC on 19 September is already 20 September in India, and the
 * summary return is due *today* — a business that got its "due tomorrow" message at that moment
 * would have been told something false by a computer that was thinking in the wrong country.
 */
export const todayIn = (clock: Clock, timeZone = 'Asia/Kolkata'): IsoDate => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(clock.now());
  return isoDate(parts);
};

// ---------------------------------------------------------------------------- working days

/**
 * Whether a business could actually do something on this date.
 *
 * Sunday is not a working day. Saturday usually is, for the shops this product is built for, and
 * the company profile says so rather than a library deciding on their behalf. Holidays are supplied
 * by the caller — they differ by state, they change every year, and a hard-coded list would be
 * wrong within twelve months and confidently wrong forever after.
 */
export interface WorkingDayPolicy {
  readonly saturdayIsWorking: boolean;
  readonly holidays: ReadonlySet<string>;
}

export const isWorkingDay = (date: IsoDate, policy: WorkingDayPolicy): boolean => {
  if (policy.holidays.has(date)) return false;
  const day = dayOfWeek(date);
  if (day === 0) return false;
  if (day === 6 && !policy.saturdayIsWorking) return false;
  return true;
};

/** The last working day at or before `date`. Never searches back more than a fortnight. */
export const workingDayBefore = (date: IsoDate, policy: WorkingDayPolicy): IsoDate => {
  let candidate = date;
  for (let step = 0; step < 14; step += 1) {
    if (isWorkingDay(candidate, policy)) return candidate;
    candidate = addDays(candidate, -1);
  }
  return date;
};

/** The first working day at or after `date`. Used only where a rule says a deadline may shift. */
export const workingDayAfter = (date: IsoDate, policy: WorkingDayPolicy): IsoDate => {
  let candidate = date;
  for (let step = 0; step < 14; step += 1) {
    if (isWorkingDay(candidate, policy)) return candidate;
    candidate = addDays(candidate, 1);
  }
  return date;
};

// ---------------------------------------------------------------------------- periods

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const monthPeriod = (year: number, month: number): ObligationPeriod => ({
  kind: 'MONTH',
  key: `${year}-${String(month).padStart(2, '0')}`,
  from: isoDate(`${year}-${String(month).padStart(2, '0')}-01`),
  to: isoDate(`${year}-${String(month).padStart(2, '0')}-${String(lastDayOfMonth(year, month)).padStart(2, '0')}`),
});

/**
 * The GST quarters, which follow the financial year: April-June is Q1, and January-March is Q4 of
 * the previous financial year. A quarter named by the calendar would put January in the wrong
 * financial year and file three months into the wrong annual return.
 */
const quarterPeriod = (year: number, month: number): ObligationPeriod => {
  const financialYearStart = month >= 4 ? year : year - 1;
  const quarter = Math.floor(((month - 4 + 12) % 12) / 3) + 1;
  const startMonth = 4 + (quarter - 1) * 3;
  const startYear = startMonth > 12 ? financialYearStart + 1 : financialYearStart;
  const realStartMonth = ((startMonth - 1) % 12) + 1;
  const endMonthIndex = realStartMonth + 2;
  const endYear = endMonthIndex > 12 ? startYear + 1 : startYear;
  const endMonth = ((endMonthIndex - 1) % 12) + 1;
  return {
    kind: 'QUARTER',
    key: `${financialYearStart}-Q${quarter}`,
    from: isoDate(`${startYear}-${String(realStartMonth).padStart(2, '0')}-01`),
    to: isoDate(`${endYear}-${String(endMonth).padStart(2, '0')}-${String(lastDayOfMonth(endYear, endMonth)).padStart(2, '0')}`),
  };
};

/** India's financial year, 1 April to 31 March, named "2026-27" as every Indian form names it. */
const yearPeriod = (year: number, month: number): ObligationPeriod => {
  const start = month >= 4 ? year : year - 1;
  return {
    kind: 'YEAR',
    key: `${start}-${String((start + 1) % 100).padStart(2, '0')}`,
    from: isoDate(`${start}-04-01`),
    to: isoDate(`${start + 1}-03-31`),
  };
};

export const periodContaining = (cadence: Cadence, date: IsoDate): ObligationPeriod => {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  switch (cadence) {
    case 'MONTHLY':
      return monthPeriod(year, month);
    case 'QUARTERLY':
      return quarterPeriod(year, month);
    case 'ANNUAL':
      return yearPeriod(year, month);
    case 'EVENT':
      throw new RangeError('An event obligation has no period of its own; build it from the event.');
  }
};

/** The period before this one. Used to walk backwards over the months a business already owes. */
export const previousPeriod = (cadence: Cadence, period: ObligationPeriod): ObligationPeriod =>
  periodContaining(cadence, addDays(period.from, -1));

export const nextPeriod = (cadence: Cadence, period: ObligationPeriod): ObligationPeriod =>
  periodContaining(cadence, addDays(period.to, 1));

/** "July 2026", "April to June 2026", "2026-27". Never "2026-07" at a person. */
export const describePeriod = (period: ObligationPeriod): Bilingual => {
  switch (period.kind) {
    case 'MONTH': {
      const name = MONTH_NAMES[Number(period.key.slice(5, 7)) - 1] as string;
      return bilingual(`${name} ${period.key.slice(0, 4)}`, `${name} ${period.key.slice(0, 4)}`);
    }
    case 'QUARTER': {
      const fromName = MONTH_NAMES[Number(period.from.slice(5, 7)) - 1] as string;
      const toName = MONTH_NAMES[Number(period.to.slice(5, 7)) - 1] as string;
      return bilingual(
        `${fromName} to ${toName} ${period.to.slice(0, 4)}`,
        `${fromName} se ${toName} ${period.to.slice(0, 4)}`,
      );
    }
    case 'YEAR':
      return bilingual(`the year ${period.key}`, `saal ${period.key}`);
    case 'EVENT':
      return period.label;
  }
};

// ---------------------------------------------------------------------------- due dates

export interface DueDateInput {
  readonly rule: DueRule;
  readonly shift: DueDateShift;
  readonly period: ObligationPeriod;
  readonly stateCode: string | null;
  readonly policy: WorkingDayPolicy;
}

export interface DueDateOutcome {
  /** The date the rule gives, whether or not it is a working day. */
  readonly dueDate: IsoDate;
  /** The last working day at or before it: the day the reminders are hung on. */
  readonly actionableBy: IsoDate;
  /** Set when a shifting rule actually moved the deadline, so a screen can say why. */
  readonly shiftedFrom: IsoDate | null;
}

/**
 * The deadline for one period under one rule.
 *
 * `byState` is applied before the plain `day` because the quarterly summary return is genuinely due
 * on the 22nd in some states and the 24th in others. Where the company's state is not known, the
 * caller never reaches this function: applicability has already stopped and asked.
 */
export const dueDateFor = (input: DueDateInput): DueDateOutcome => {
  const raw = rawDueDate(input.rule, input.period, input.stateCode);
  const shifted = input.shift === 'NEXT_WORKING_DAY' ? workingDayAfter(raw, input.policy) : raw;
  return {
    dueDate: shifted,
    actionableBy: workingDayBefore(shifted, input.policy),
    shiftedFrom: shifted === raw ? null : raw,
  };
};

const rawDueDate = (rule: DueRule, period: ObligationPeriod, stateCode: string | null): IsoDate => {
  switch (rule.kind) {
    case 'DAYS_AFTER_PERIOD_END':
      return addDays(period.to, rule.days);
    case 'DAYS_AFTER_EVENT':
      return addDays(period.from, rule.days);
    case 'DAY_OF_MONTH_AFTER_PERIOD': {
      const day = dayForState(rule.byState, stateCode) ?? rule.day;
      const endYear = Number(period.to.slice(0, 4));
      const endMonth = Number(period.to.slice(5, 7));
      const targetIndex = endMonth + rule.monthsAfter;
      const year = endYear + Math.floor((targetIndex - 1) / 12);
      const month = ((targetIndex - 1) % 12) + 1;
      // A rule that says "the 31st" in a month with 30 days means the last day of that month. It
      // never means the 1st of the next one, which is a day late and a different month's problem.
      const safeDay = Math.min(day, lastDayOfMonth(year, month));
      return isoDate(`${year}-${String(month).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`);
    }
  }
};

const dayForState = (
  groups: readonly { readonly day: number; readonly stateCodes: readonly string[] }[] | undefined,
  stateCode: string | null,
): number | null => {
  if (groups === undefined || stateCode === null) return null;
  for (const group of groups) if (group.stateCodes.includes(stateCode)) return group.day;
  return null;
};
