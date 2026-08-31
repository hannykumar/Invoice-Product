/**
 * Issue #42 [E42] — may this company do this, today?
 *
 * A pure decision over the plan, the subscription's dates and the counters as they stand. Nothing
 * is cached, because a cached entitlement is how a business gets stopped for a limit it is no
 * longer over — or, worse, allowed past one it is.
 *
 * Two things it will never say no to: anything essential, and reading. The first is the issue's own
 * acceptance criterion; the second is what makes "nothing is deleted" mean anything at all.
 */
import { formatINR, type IsoDate } from '@invoice/kernel';
import { canWrite, stateOn, STATE_WORDS } from './lifecycle.ts';
import {
  isEssential,
  METER_LABELS,
  type Bilingual,
  type Capability,
  type Entitlement,
  type MeterId,
  type Plan,
  type Subscription,
} from './model.ts';
import { limitFor } from './plans.ts';

export interface EntitlementInput {
  readonly capability: Capability;
  readonly plan: Plan;
  readonly subscription: Subscription;
  readonly today: IsoDate;
  /** What this meter already stands at for the month. Read a moment ago, never remembered. */
  readonly used: bigint;
  /** How much this one action would spend. One bill is one; ten megabytes is ten. */
  readonly wants: bigint;
  /** The cheapest plan that would actually help, if there is one. Never the current plan. */
  readonly nextPlan?: Plan | null;
}

/**
 * The sentence somebody reads when they cannot issue the next bill.
 *
 * It says three things in this order: what the limit is, that **nothing they have already done is
 * affected**, and what would help. The middle one matters most — a person who has just been stopped
 * mid-day needs to know their books are intact before they need to know the price list.
 */
const overLimitWords = (meter: MeterId, limit: bigint, planName: Bilingual, next: Plan | null): Bilingual => {
  const wayOut = next === null
    ? { 'en-IN': ' Please get in touch and we will sort it out.', 'hi-IN': ' Humse baat karein, hum iska hal nikal denge.' }
    : {
        'en-IN': ` Moving to ${next.name['en-IN']} (${formatINR(next.monthlyPrice)} a month) lets you carry on.`,
        'hi-IN': ` ${next.name['hi-IN']} plan (${formatINR(next.monthlyPrice)} maheena) lene par aage badh sakte hain.`,
      };
  return {
    'en-IN': `Your ${planName['en-IN']} plan covers ${limit} ${METER_LABELS[meter]['en-IN']}, and you have used them all. Everything you have already recorded is safe and unchanged.${wayOut['en-IN']}`,
    'hi-IN': `Aapke ${planName['hi-IN']} plan mein ${limit} ${METER_LABELS[meter]['hi-IN']} milte hain, aur woh poore ho gaye. Jo aap pehle likh chuke hain woh surakshit hai aur waisa hi hai.${wayOut['hi-IN']}`,
  };
};

export const decide = (input: EntitlementInput): Entitlement => {
  const { capability, plan, subscription, today } = input;
  const state = stateOn(subscription, plan, today);
  const essential = isEssential(capability.name);

  // The acceptance criterion, first and unconditionally. No plan, no lapse, no cancellation and no
  // exhausted meter can stop the product from telling a business what it needs to know, or from
  // handing over its own data.
  if (essential) {
    return {
      capability: capability.name,
      outcome: 'ALLOWED',
      state,
      essential: true,
      meter: null,
      used: null,
      limit: null,
      reason: {
        'en-IN': 'Every plan includes this. Warnings, checks and getting your own data out are never withheld.',
        'hi-IN': 'Yeh har plan mein hai. Chetavni, jaanch aur apna data le jaana kabhi roka nahin jata.',
      },
    };
  }

  const meter = capability.meter;
  const limit = meter === null ? null : limitFor(plan, meter);

  if (capability.kind === 'READ' && meter === null) {
    return {
      capability: capability.name, outcome: 'ALLOWED', state, essential: false,
      meter: null, used: null, limit: null,
      reason: { 'en-IN': 'Reading your own books is always allowed.', 'hi-IN': 'Apni bahi dekhna hamesha khula hai.' },
    };
  }

  if (!canWrite(state) && capability.kind === 'WRITE') {
    return {
      capability: capability.name, outcome: 'BLOCKED_READ_ONLY', state, essential: false,
      meter, used: meter === null ? null : input.used, limit,
      reason: STATE_WORDS[state],
    };
  }

  if (meter !== null && limit !== null && input.used + input.wants > limit) {
    return {
      capability: capability.name, outcome: 'BLOCKED_LIMIT', state, essential: false,
      meter, used: input.used, limit,
      reason: overLimitWords(meter, limit, plan.name, input.nextPlan ?? null),
    };
  }

  return {
    capability: capability.name, outcome: 'ALLOWED', state, essential: false,
    meter, used: meter === null ? null : input.used, limit,
    reason: limit === null
      ? { 'en-IN': 'Your plan has no limit on this.', 'hi-IN': 'Aapke plan mein iski koi seema nahin hai.' }
      : {
          'en-IN': `${limit - input.used} of ${limit} ${METER_LABELS[meter as MeterId]['en-IN']} left this month.`,
          'hi-IN': `Is mahine ${limit} mein se ${limit - input.used} ${METER_LABELS[meter as MeterId]['hi-IN']} baaki hain.`,
        },
  };
};
