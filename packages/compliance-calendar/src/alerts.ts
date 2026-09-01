/**
 * Issue #32 [E32] — turning a deadline and what is unresolved beneath it into one warning.
 *
 * This file is pure: occurrence in, alert out, no clock and no database. Everything that decides
 * whether a business acts in time is decided here, so all of it can be tested directly.
 *
 * Four rules shape what comes out.
 *
 *   1. **One rung at a time.** A business that has ignored a deadline for a week does not receive
 *      five messages when the run finally happens; it receives the one that matters — the highest
 *      rung now due. Ladders never go backwards on their own either: once the owner has been told a
 *      return is overdue, nobody sends "due in three days" afterwards.
 *   2. **Before the deadline, the reminder lands on a working day.** The deadline is whatever the
 *      rule says, Sunday or not. The nudge is hung on the last working day at or before it, because
 *      a warning that arrives on a day the shop is shut has arrived too late to be preventive.
 *   3. **A snooze silences the early warnings, never the late ones.** Somebody who says "I know,
 *      not now" on the 12th has made a reasonable decision about a reminder. Nobody gets to make
 *      the overdue notice go away; that one is a fact about money now being owed.
 *   4. **Completed work is silent.** A return with an acknowledgement number against it raises
 *      nothing, at any level, ever again.
 */
import { formatDate, type IsoDate } from '@invoice/kernel';
import { addDays, daysBetween, describePeriod } from './schedule.ts';
import {
  ALERT_LEVEL_ORDER,
  alertKey,
  bilingual,
  describeReviewState,
  type AffectedRecord,
  type AlertLevel,
  type Bilingual,
  type ComplianceAlert,
  type ComplianceSignal,
  type LadderStep,
  type ObligationDefinition,
  type ObligationOccurrence,
} from './types.ts';

/** The date a rung actually fires on. See rule 2 above for why the two halves differ. */
export const triggerDateFor = (occurrence: ObligationOccurrence, step: LadderStep): IsoDate =>
  step.offsetDays <= 0 ? addDays(occurrence.actionableBy, step.offsetDays) : addDays(occurrence.dueDate, step.offsetDays);

export interface LadderDecision {
  /** The rung to ring now, or null when there is nothing to say today. */
  readonly step: LadderStep | null;
  /** Set when a rung was due but a snooze silenced it. A silenced warning is still recorded. */
  readonly suppressedBy: 'SNOOZE' | 'COMPLETED' | 'NOT_APPLICABLE' | 'ALREADY_RAISED' | null;
  readonly suppressedStep: LadderStep | null;
}

/**
 * Which rung, if any, is due today.
 *
 * `alreadyRaised` is the set of deduplication keys the company already holds. Passing it in rather
 * than looking it up keeps this function pure and makes "running the sweep five times before lunch
 * sends one message" a property that can be tested in three lines.
 */
export const nextLadderStep = (
  occurrence: ObligationOccurrence,
  ladder: readonly LadderStep[],
  today: IsoDate,
  alreadyRaised: ReadonlySet<string>,
): LadderDecision => {
  if (occurrence.status === 'COMPLETED') return { step: null, suppressedBy: 'COMPLETED', suppressedStep: null };
  if (occurrence.status === 'NOT_APPLICABLE') return { step: null, suppressedBy: 'NOT_APPLICABLE', suppressedStep: null };

  const due = ladder
    .filter((step) => triggerDateFor(occurrence, step) <= today)
    .sort((left, right) => ALERT_LEVEL_ORDER[right.level] - ALERT_LEVEL_ORDER[left.level]);

  const highest = due[0];
  if (highest === undefined) return { step: null, suppressedBy: null, suppressedStep: null };

  const alreadyHigher =
    occurrence.highestAlertLevel !== null &&
    ALERT_LEVEL_ORDER[occurrence.highestAlertLevel] >= ALERT_LEVEL_ORDER[highest.level];
  if (alreadyHigher || alreadyRaised.has(alertKey(occurrence, highest.level))) {
    return { step: null, suppressedBy: 'ALREADY_RAISED', suppressedStep: highest };
  }

  if (isSnoozed(occurrence, today) && ALERT_LEVEL_ORDER[highest.level] <= ALERT_LEVEL_ORDER.DUE_SOON) {
    return { step: null, suppressedBy: 'SNOOZE', suppressedStep: highest };
  }

  return { step: highest, suppressedBy: null, suppressedStep: null };
};

export const isSnoozed = (occurrence: ObligationOccurrence, today: IsoDate): boolean =>
  occurrence.snooze !== null && today <= occurrence.snooze.until;

// ---------------------------------------------------------------------------- wording

const daysWord = (days: number): Bilingual =>
  days === 0
    ? bilingual('today', 'aaj')
    : days === 1
      ? bilingual('tomorrow', 'kal')
      : days > 1
        ? bilingual(`in ${days} days`, `${days} din mein`)
        : days === -1
          ? bilingual('yesterday', 'kal')
          : bilingual(`${Math.abs(days)} days ago`, `${Math.abs(days)} din pehle`);

const headlineFor = (
  definition: ObligationDefinition,
  occurrence: ObligationOccurrence,
  level: AlertLevel,
  daysRemaining: number,
): Bilingual => {
  const period = describePeriod(occurrence.period);
  const when = daysWord(daysRemaining);
  const title = definition.title;
  switch (level) {
    case 'EARLY':
    case 'DUE_SOON':
      return bilingual(
        `${title['en-IN']} for ${period['en-IN']} is due ${when['en-IN']}, on ${formatDate(occurrence.dueDate)}.`,
        `${period['hi-IN']} ka ${title['hi-IN']} ${when['hi-IN']} due hai, ${formatDate(occurrence.dueDate)} ko.`,
      );
    case 'DUE_TODAY':
      return bilingual(
        `${title['en-IN']} for ${period['en-IN']} is due on ${formatDate(occurrence.dueDate)}. Today is the last working day to do it.`,
        `${period['hi-IN']} ka ${title['hi-IN']} ${formatDate(occurrence.dueDate)} ko due hai. Aaj hi aakhri kaam wala din hai.`,
      );
    case 'OVERDUE':
      return bilingual(
        `${title['en-IN']} for ${period['en-IN']} was due ${when['en-IN']} and is still not done.`,
        `${period['hi-IN']} ka ${title['hi-IN']} ${when['hi-IN']} due tha aur abhi tak nahin hua.`,
      );
    case 'ESCALATED':
      return bilingual(
        `${title['en-IN']} for ${period['en-IN']} is ${Math.abs(daysRemaining)} days late. This is costing money every day.`,
        `${period['hi-IN']} ka ${title['hi-IN']} ${Math.abs(daysRemaining)} din late hai. Har din ka nuksaan ho raha hai.`,
      );
  }
};

/**
 * The body of the message: what is in the way, what it will cost, and the caveat when the date
 * itself has not been checked against its notification yet.
 *
 * The signals go first. "Your summary return is due in three days" is a calendar entry; "and three
 * purchase bills do not match the portal, so the credit may not be allowed" is the reason somebody
 * opens the app instead of closing the notification.
 */
const detailFor = (
  definition: ObligationDefinition,
  occurrence: ObligationOccurrence,
  signals: readonly ComplianceSignal[],
): Bilingual => {
  const parts: { en: string[]; hi: string[] } = { en: [], hi: [] };
  for (const signal of signals) {
    parts.en.push(`${signal.headline['en-IN']} ${signal.consequence['en-IN']}`);
    parts.hi.push(`${signal.headline['hi-IN']} ${signal.consequence['hi-IN']}`);
  }
  parts.en.push(definition.consequence['en-IN']);
  parts.hi.push(definition.consequence['hi-IN']);
  const review = describeReviewState(occurrence.reviewState);
  if (review !== null) {
    parts.en.push(review['en-IN']);
    parts.hi.push(review['hi-IN']);
  }
  return bilingual(parts.en.join(' '), parts.hi.join(' '));
};

/**
 * The next action, taken from the most severe unresolved thing rather than from the deadline.
 *
 * When purchases do not match, "review the unmatched bills" is a more useful instruction than "file
 * the return" — filing the return is what happens after. Where nothing is unresolved, the
 * obligation's own action stands.
 */
const nextActionFor = (
  definition: ObligationDefinition,
  signals: readonly ComplianceSignal[],
): { readonly action: Bilingual; readonly actionCode: string } => {
  const blocking = signals.find((signal) => signal.severity === 'BLOCKING') ?? signals.find((signal) => signal.severity === 'WARNING');
  return blocking === undefined
    ? { action: definition.nextAction, actionCode: definition.actionCode }
    : { action: blocking.nextAction, actionCode: blocking.actionCode };
};

export interface BuildAlertInput {
  readonly occurrence: ObligationOccurrence;
  readonly definition: ObligationDefinition;
  readonly step: LadderStep;
  readonly today: IsoDate;
  readonly signals: readonly ComplianceSignal[];
  readonly id: string;
  readonly at: string;
  readonly raisedBy: ComplianceAlert['raisedBy'];
  readonly manualReason?: string;
}

/** One alert, carrying the rule, the deadline, the affected records and the next action. */
export const buildAlert = (input: BuildAlertInput): ComplianceAlert => {
  const { occurrence, definition, step, signals } = input;
  const daysRemaining = daysBetween(input.today, occurrence.dueDate);
  const { action, actionCode } = nextActionFor(definition, signals);
  const affected: AffectedRecord[] = [];
  for (const signal of signals) affected.push(...signal.affected);
  return Object.freeze({
    id: input.id,
    companyId: occurrence.companyId,
    occurrenceKey: occurrence.key,
    code: occurrence.code,
    obligationKind: definition.kind,
    version: occurrence.version,
    reviewState: occurrence.reviewState,
    sourceRef: occurrence.sourceRef,
    level: step.level,
    audiences: step.audiences,
    dueDate: occurrence.dueDate,
    daysRemaining,
    period: occurrence.period,
    headline: headlineFor(definition, occurrence, step.level, daysRemaining),
    detail: detailFor(definition, occurrence, signals),
    nextAction: action,
    actionCode,
    consequence: definition.consequence,
    signals,
    affected,
    deduplicationKey: alertKey(occurrence, step.level),
    raisedAt: input.at,
    raisedBy: input.raisedBy,
    ...(input.manualReason === undefined ? {} : { manualReason: input.manualReason }),
  });
};

/** How a calendar screen colours a row. Derived, never stored, so it cannot go stale. */
export const entryState = (
  occurrence: ObligationOccurrence,
  today: IsoDate,
): 'DONE' | 'DUE_LATER' | 'DUE_SOON' | 'DUE_TODAY' | 'OVERDUE' | 'NOT_APPLICABLE' => {
  if (occurrence.status === 'COMPLETED') return 'DONE';
  if (occurrence.status === 'NOT_APPLICABLE') return 'NOT_APPLICABLE';
  const days = daysBetween(today, occurrence.dueDate);
  if (days < 0) return 'OVERDUE';
  if (days === 0) return 'DUE_TODAY';
  return days <= 3 ? 'DUE_SOON' : 'DUE_LATER';
};
