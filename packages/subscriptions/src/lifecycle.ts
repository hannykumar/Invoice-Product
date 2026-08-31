/**
 * Issue #42 [E42] — the life of a subscription, derived rather than remembered.
 *
 * `stateOn` is a pure function of the subscription's own dates and the day you ask about. Nothing
 * here depends on a nightly job having run, so a company cannot be quietly left in the wrong state
 * because a queue was down — and the same question asked twice always gets the same answer.
 *
 * The end of the road is `READ_ONLY`, never deletion. A business that stops paying keeps its books,
 * can read them, and can take them away.
 */
import { isoDate, type IsoDate } from '@invoice/kernel';
import type { Plan, Subscription, SubscriptionState } from './model.ts';

export const daysBetween = (later: IsoDate, earlier: IsoDate): number =>
  Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);

export const addDays = (date: IsoDate, days: number): IsoDate =>
  isoDate(new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10));

export const stateOn = (subscription: Subscription, plan: Plan, today: IsoDate): SubscriptionState => {
  if (subscription.cancelledOn !== null && subscription.cancelledOn <= today) return 'CANCELLED';

  // A free plan cannot fall behind, because nothing is owed. It is stated here rather than faked
  // with a far-future "paid through" date, so nobody has to wonder what the year 9999 means.
  if (plan.monthlyPrice.minor === 0n) return 'ACTIVE';

  // Paid up: the ordinary case, and the only one that needs no arithmetic.
  if (subscription.paidThrough !== null && subscription.paidThrough >= today) return 'ACTIVE';

  if (subscription.paidThrough === null && subscription.trialEndsOn >= today) return 'TRIALING';

  // Everything below is a subscription that has run out of paid time. It is given the plan's grace
  // in full before anything stops, and what stops is writing — never reading, never the books.
  const ranOutOn = subscription.paidThrough ?? subscription.trialEndsOn;
  const daysOverdue = daysBetween(today, ranOutOn);
  if (daysOverdue <= 0) return 'ACTIVE';
  if (daysOverdue <= plan.graceDays) return daysOverdue <= 1 ? 'PAST_DUE' : 'GRACE';
  return 'READ_ONLY';
};

/** Writing is what a lapsed plan stops. Reading, exporting and every warning carry on. */
export const canWrite = (state: SubscriptionState): boolean =>
  state === 'TRIALING' || state === 'ACTIVE' || state === 'PAST_DUE' || state === 'GRACE';

/** The day writing would stop, so the screen can warn before it happens rather than after. */
export const writingStopsOn = (subscription: Subscription, plan: Plan): IsoDate | null => {
  if (subscription.cancelledOn !== null) return subscription.cancelledOn;
  if (plan.monthlyPrice.minor === 0n) return null;
  const ranOutOn = subscription.paidThrough ?? subscription.trialEndsOn;
  return addDays(ranOutOn, plan.graceDays);
};

export const STATE_WORDS: Readonly<Record<SubscriptionState, { 'en-IN': string; 'hi-IN': string }>> = {
  TRIALING: { 'en-IN': 'You are trying the product out.', 'hi-IN': 'Aap product aazma rahe hain.' },
  ACTIVE: { 'en-IN': 'Everything is running normally.', 'hi-IN': 'Sab kuch theek chal raha hai.' },
  PAST_DUE: {
    'en-IN': 'Payment did not go through. Nothing has stopped — please pay when you can.',
    'hi-IN': 'Bhugtan nahin hua. Abhi kuch band nahin hua hai — jab ho sake, bhar dein.',
  },
  GRACE: {
    'en-IN': 'Still unpaid. Everything works for now, and you will be told before anything stops.',
    'hi-IN': 'Abhi tak bhugtan nahin hua. Filhaal sab chalta rahega, aur kuch band hone se pehle aapko bata diya jayega.',
  },
  READ_ONLY: {
    'en-IN': 'You can read and download everything, but not record anything new until this is paid. Nothing has been deleted.',
    'hi-IN': 'Aap sab kuch dekh aur download kar sakte hain, par bhugtan tak naya kuch likh nahin sakte. Kuch bhi mitaya nahin gaya hai.',
  },
  CANCELLED: {
    'en-IN': 'This subscription is cancelled. Your books are still here, and still yours to download.',
    'hi-IN': 'Yeh subscription band hai. Aapki bahi yahin hai, aur aap use download kar sakte hain.',
  },
};
