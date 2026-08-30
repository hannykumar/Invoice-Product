/**
 * Issue #23 [E23] — the ladder, and the shape of a business's own collection habits.
 *
 * The default ladder is deliberately short. Five messages spread over a month and a half is what a
 * shopkeeper actually sends before picking up the phone; anything more is the product harassing a
 * customer on the business's behalf, which it has no standing to do.
 */
import { rupees, isoDate, type IsoDate, type Money } from '@invoice/kernel';
import { LEVEL_ORDER, type ReminderLevel, type ReminderPolicy, type ReminderStep } from './model.ts';

/** Positive means `later` is after `earlier`. Calendar days in India, not elapsed hours. */
export const daysBetween = (later: IsoDate, earlier: IsoDate): number =>
  Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);

export const addDays = (date: IsoDate, days: number): IsoDate =>
  isoDate(new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10));

export const DEFAULT_REMINDER_STEPS: readonly ReminderStep[] = [
  { code: 'BEFORE_DUE', offsetDays: -3, level: 'ADVANCE', channels: ['whatsapp', 'sms', 'email', 'in_app'] },
  { code: 'DUE_TODAY', offsetDays: 0, level: 'GENTLE', channels: ['whatsapp', 'sms', 'email', 'in_app'] },
  { code: 'WEEK_LATE', offsetDays: 7, level: 'GENTLE', channels: ['whatsapp', 'sms', 'email', 'in_app'] },
  { code: 'FORTNIGHT_LATE', offsetDays: 15, level: 'FIRM', channels: ['whatsapp', 'email', 'sms', 'in_app'] },
  { code: 'MONTH_LATE', offsetDays: 30, level: 'FINAL', channels: ['email', 'whatsapp', 'sms', 'in_app'] },
];

/**
 * Night-time in India, in India's own time zone. A bill chaser that wakes a customer at 2 a.m.
 * loses the customer, and the loss is larger than the bill.
 */
export const DEFAULT_QUIET_HOURS = { fromHour: 21, toHour: 9, timeZone: 'Asia/Kolkata' } as const;

export const DEFAULT_REMINDER_POLICY: ReminderPolicy = {
  effectiveFrom: isoDate('2026-04-01'),
  steps: DEFAULT_REMINDER_STEPS,
  quietHours: DEFAULT_QUIET_HOURS,
  minimumGapDays: 3,
  minimumAmount: rupees(100),
  escalateAboveAmount: rupees(500_000),
  promiseGraceDays: 2,
  remindDuringDispute: false,
};

/** The policy in force on a date. Later effective dates win; nothing is ever back-dated silently. */
export const policyOn = (policies: readonly ReminderPolicy[], date: IsoDate): ReminderPolicy => {
  const applicable = policies
    .filter((policy) => policy.effectiveFrom <= date)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return applicable[0] ?? DEFAULT_REMINDER_POLICY;
};

/**
 * The rung a bill has reached: the latest step whose day has arrived.
 *
 * A bill that has sat unpaid for two months does not get four messages at once. It gets the one
 * that matches how late it is, and the earlier rungs are simply behind it.
 */
export const stepFor = (policy: ReminderPolicy, daysOverdue: number): ReminderStep | null => {
  const reached = policy.steps.filter((step) => daysOverdue >= step.offsetDays);
  return reached.length === 0 ? null : (reached[reached.length - 1] as ReminderStep);
};

/**
 * One rung firmer, for a customer who promised and then did not pay.
 *
 * It stops at `FINAL`, never `ESCALATE`. `ESCALATE` is written to the owner about the customer, not
 * to the customer — a broken promise must not be the way that message reaches the wrong reader.
 */
export const raiseLevel = (level: ReminderLevel): ReminderLevel => {
  const customerLevels: readonly ReminderLevel[] = LEVEL_ORDER.filter((candidate) => candidate !== 'ESCALATE');
  const index = customerLevels.indexOf(level);
  if (index === -1) return level;
  return customerLevels[Math.min(index + 1, customerLevels.length - 1)] as ReminderLevel;
};

/** The hour of the day where the customer is, so quiet hours mean night to them. */
export const localHour = (at: Date, timeZone: string): number =>
  Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone }).format(at));

export const isQuiet = (policy: ReminderPolicy, at: Date): boolean => {
  const hour = localHour(at, policy.quietHours.timeZone);
  const { fromHour, toHour } = policy.quietHours;
  return fromHour <= toHour ? hour >= fromHour && hour < toHour : hour >= fromHour || hour < toHour;
};

export const belowMinimum = (policy: ReminderPolicy, outstanding: Money): boolean =>
  outstanding.minor < policy.minimumAmount.minor;

export const aboveEscalation = (policy: ReminderPolicy, outstanding: Money): boolean =>
  outstanding.minor > policy.escalateAboveAmount.minor;
