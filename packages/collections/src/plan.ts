/**
 * Issue #23 [E23] — deciding, for every open bill, whether a message goes out today.
 *
 * This is a pure function of facts read a moment ago. It posts nothing and sends nothing, so the
 * owner can look at exactly what would happen — including every bill that will be left alone and
 * the reason — before anything leaves the building. `send()` runs it again at the moment of
 * sending and refuses if the answer has changed.
 */
import { formatDate, formatINR, type IsoDate, type PartyId } from '@invoice/kernel';
import type { DocumentPosition } from '@invoice/receivables';
import {
  reminderKeyOf,
  type Bilingual,
  type BalanceSnapshot,
  type ContactPreference,
  type Dispute,
  type OptOut,
  type PromiseToPay,
  type Reminder,
  type ReminderCandidate,
  type ReminderChannel,
  type ReminderLevel,
  type ReminderPlan,
  type ReminderPolicy,
  type ReminderStep,
  type SkipReason,
} from './model.ts';
import { aboveEscalation, belowMinimum, daysBetween, isQuiet, raiseLevel, stepFor } from './policy.ts';
import type { CustomerAccount, PartyContact } from './ports.ts';
import { reminderMessage, skipExplanation } from './wording.ts';

export const ESCALATION_STEP_CODE = 'ESCALATE_TO_OWNER';

export interface PlanFacts {
  readonly businessName: string;
  readonly policy: ReminderPolicy;
  readonly today: IsoDate;
  readonly at: Date;
  readonly accounts: readonly CustomerAccount[];
  readonly contacts: ReadonlyMap<PartyId, PartyContact | null>;
  readonly preferences: readonly ContactPreference[];
  readonly optOuts: readonly OptOut[];
  readonly promises: readonly PromiseToPay[];
  readonly disputes: readonly Dispute[];
  readonly history: readonly Reminder[];
}

const snapshotOf = (position: DocumentPosition, partyOutstanding: BalanceSnapshot['partyOutstanding'], today: IsoDate): BalanceSnapshot => ({
  asOf: today,
  documentNumber: position.document.number,
  documentValue: position.document.value,
  outstanding: position.outstanding,
  partyOutstanding,
  daysOverdue: position.daysOverdue,
});

/** An open dispute on the bill itself, or on the whole account. */
const disputeFor = (disputes: readonly Dispute[], partyId: PartyId, documentId: string): Dispute | null =>
  disputes.find(
    (d) => d.state === 'OPEN' && d.partyId === partyId && (d.documentId === null || d.documentId === documentId),
  ) ?? null;

/**
 * A promise still inside its window. The grace days exist because a customer who says "Friday"
 * often pays on Monday, and a reminder on Saturday morning insults them for no gain.
 */
const livePromise = (
  promises: readonly PromiseToPay[],
  policy: ReminderPolicy,
  today: IsoDate,
  partyId: PartyId,
  documentId: string,
): PromiseToPay | null =>
  promises.find(
    (p) =>
      p.state === 'OPEN' &&
      p.partyId === partyId &&
      p.documentId === documentId &&
      daysBetween(today, p.promisedOn) <= policy.promiseGraceDays,
  ) ?? null;

const brokenPromise = (
  promises: readonly PromiseToPay[],
  policy: ReminderPolicy,
  today: IsoDate,
  partyId: PartyId,
  documentId: string,
): PromiseToPay | null =>
  promises.find(
    (p) =>
      p.state === 'OPEN' &&
      p.partyId === partyId &&
      p.documentId === documentId &&
      daysBetween(today, p.promisedOn) > policy.promiseGraceDays,
  ) ?? null;

/** The first channel the step wants that the customer both has and has not turned off. */
const channelFor = (
  step: ReminderStep,
  contact: PartyContact | null,
  preferences: readonly ContactPreference[],
  partyId: PartyId,
): ReminderChannel | null => {
  if (contact === null) return null;
  const disabled = new Set(
    preferences.filter((p) => p.partyId === partyId && p.state === 'DISABLED').map((p) => p.channel),
  );
  return step.channels.find((channel) => contact.channels.includes(channel) && !disabled.has(channel)) ?? null;
};

const sentReminderFor = (history: readonly Reminder[], key: string): Reminder | null =>
  history.find((r) => r.reminderKey === key && r.state !== 'CANCELLED' && r.state !== 'FAILED') ?? null;

const skip = (
  base: Omit<ReminderCandidate, 'decision' | 'step' | 'level' | 'channel' | 'reason' | 'explanation' | 'reminderKey'>,
  reason: SkipReason,
  detail: Readonly<Record<string, string>> = {},
  /** Carried only for `ALREADY_SENT`, so a replayed send returns the first message rather than a
   *  refusal. Every other skip has no reminder to point at. */
  reminderKey: string | null = null,
): ReminderCandidate => ({
  ...base,
  decision: 'SKIP',
  step: null,
  level: null,
  channel: null,
  reason,
  explanation: skipExplanation(reason, detail),
  reminderKey,
});

/**
 * The decision for one bill.
 *
 * The order of the checks is the product's judgement about which fact outranks which. A settled
 * bill outranks everything because there is nothing to say. A dispute and a promise outrank the
 * ladder, because in both cases a person has already been told something and a machine
 * contradicting them is worse than silence.
 */
const decide = (
  facts: PlanFacts,
  account: CustomerAccount,
  position: DocumentPosition,
  partyAlreadySending: boolean,
): ReminderCandidate => {
  const { policy, today } = facts;
  const documentId = position.document.documentId;
  const snapshot = snapshotOf(position, account.position.totalOutstanding, today);
  const base = { partyId: account.partyId, partyName: account.partyName, documentId, snapshot };
  const named = { partyName: account.partyName };

  if (position.outstanding.minor <= 0n) return skip(base, 'SETTLED');

  const dispute = disputeFor(facts.disputes, account.partyId, documentId);
  if (dispute !== null && !policy.remindDuringDispute) {
    return skip(base, 'DISPUTED', { reason: dispute.reason });
  }

  const promise = livePromise(facts.promises, policy, today, account.partyId, documentId);
  if (promise !== null) {
    return skip(base, 'PROMISED', { ...named, promisedOn: formatDate(promise.promisedOn) });
  }

  if (belowMinimum(policy, position.outstanding)) {
    return skip(base, 'BELOW_MINIMUM', { outstanding: formatINR(position.outstanding) });
  }

  const lastStep = policy.steps[policy.steps.length - 1] as ReminderStep;
  const finalSent = sentReminderFor(facts.history, reminderKeyOf(documentId, lastStep.code));
  // The last message is given the same breathing space as any other before the owner is troubled:
  // a customer who is about to pay should not become a decision the same afternoon.
  const ladderSpent = finalSent !== null && daysBetween(today, finalSent.snapshot.asOf) >= policy.minimumGapDays;
  const escalate = ladderSpent || aboveEscalation(policy, position.outstanding);

  if (escalate) {
    const key = reminderKeyOf(documentId, ESCALATION_STEP_CODE);
    if (sentReminderFor(facts.history, key) !== null) return skip(base, 'LADDER_EXHAUSTED', {}, key);
    return {
      ...base,
      decision: 'ESCALATE',
      step: { code: ESCALATION_STEP_CODE, offsetDays: lastStep.offsetDays, level: 'ESCALATE', channels: ['in_app', 'email'] },
      level: 'ESCALATE',
      channel: 'in_app',
      reason: null,
      explanation: reminderMessage({ businessName: facts.businessName, partyName: account.partyName, level: 'ESCALATE', snapshot }),
      reminderKey: key,
    };
  }

  const step = stepFor(policy, position.daysOverdue);
  if (step === null) {
    return position.daysOverdue < 0
      ? skip(base, 'NOT_YET_DUE', { dueDate: position.document.dueDate === null ? 'its due date' : formatDate(position.document.dueDate) })
      : skip(base, 'NO_STEP_DUE');
  }

  const key = reminderKeyOf(documentId, step.code);
  const already = sentReminderFor(facts.history, key);
  if (already !== null) return skip(base, 'ALREADY_SENT', { sentOn: formatDate(already.snapshot.asOf) }, key);

  if (facts.optOuts.some((o) => o.partyId === account.partyId)) return skip(base, 'OPTED_OUT', named);

  const contact = facts.contacts.get(account.partyId) ?? null;
  const channel = channelFor(step, contact, facts.preferences, account.partyId);
  if (channel === null) return skip(base, 'NO_CHANNEL', named);

  if (partyAlreadySending) return skip(base, 'TOO_SOON', { ...named, sameRun: 'yes' });

  const lastToParty = facts.history
    .filter((r) => r.partyId === account.partyId && r.state === 'SENT' && r.audience === 'CUSTOMER')
    .sort((a, b) => (a.snapshot.asOf < b.snapshot.asOf ? 1 : -1))[0];
  if (lastToParty !== undefined) {
    const gap = daysBetween(today, lastToParty.snapshot.asOf);
    if (gap < policy.minimumGapDays) return skip(base, 'TOO_SOON', { ...named, daysAgo: String(gap) });
  }

  if (isQuiet(policy, facts.at)) return skip(base, 'QUIET_PERIOD');

  // A customer who promised and then let the date pass hears the next rung up, not the same one.
  const broken = brokenPromise(facts.promises, policy, today, account.partyId, documentId);
  const level: ReminderLevel = broken === null ? step.level : raiseLevel(step.level);

  return {
    ...base,
    decision: 'SEND',
    step,
    level,
    channel,
    reason: null,
    explanation: reminderMessage({ businessName: facts.businessName, partyName: account.partyName, level, snapshot }),
    reminderKey: key,
  };
};

const summarise = (candidates: readonly ReminderCandidate[]): Bilingual => {
  const send = candidates.filter((c) => c.decision === 'SEND').length;
  const escalate = candidates.filter((c) => c.decision === 'ESCALATE').length;
  const skipped = candidates.filter((c) => c.decision === 'SKIP').length;
  const tail = escalate === 0 ? '' : ` ${escalate} bill${escalate === 1 ? '' : 's'} need${escalate === 1 ? 's' : ''} you to decide what happens next.`;
  const tailHi = escalate === 0 ? '' : ` ${escalate} bill par aage kya karna hai, yeh aapko tay karna hai.`;
  return {
    'en-IN': `${send} reminder${send === 1 ? '' : 's'} ready to send, ${skipped} bill${skipped === 1 ? '' : 's'} deliberately left alone.${tail}`,
    'hi-IN': `${send} reminder bhejne ke liye taiyar, ${skipped} bill jaan-boojh kar chhode gaye.${tailHi}`,
  };
};

export const buildPlan = (facts: PlanFacts): ReminderPlan => {
  const candidates: ReminderCandidate[] = [];
  const sendingTo = new Set<string>();

  for (const account of facts.accounts) {
    const receivables = account.position.documents.filter((d) => d.document.side === 'RECEIVABLE');
    // Oldest first: if only one message goes to this customer today, it should be about the bill
    // that has waited longest.
    const ordered = [...receivables].sort((a, b) => b.daysOverdue - a.daysOverdue);
    for (const position of ordered) {
      const candidate = decide(facts, account, position, sendingTo.has(account.partyId));
      if (candidate.decision === 'SEND') sendingTo.add(account.partyId);
      candidates.push(candidate);
    }
  }

  return {
    asOf: facts.today,
    candidates,
    toSend: candidates.filter((c) => c.decision === 'SEND').length,
    toEscalate: candidates.filter((c) => c.decision === 'ESCALATE').length,
    skipped: candidates.filter((c) => c.decision === 'SKIP').length,
    summary: summarise(candidates),
  };
};
