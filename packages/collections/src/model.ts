/**
 * Issue #23 [E23] — chasing money without becoming a nuisance.
 *
 * Three facts shape everything in this module:
 *
 *  1. **A reminder is a claim about money owed right now.** So no outstanding amount is stored and
 *     re-used. It is read from receivables when the reminder is planned and read again when it is
 *     sent, and a send whose reason has expired is refused rather than delivered.
 *  2. **Silence is a decision too.** An opt-out, a dispute, a promise to pay and a quiet period all
 *     stop a message, and each one says why in words the shopkeeper can read. Skips are shown as
 *     prominently as sends.
 *  3. **The product never chases harder than a person allowed.** Past the end of the ladder it
 *     stops writing to the customer and tells the owner instead.
 */
import type { BranchId, CompanyId, IsoDate, Money, PartyId, UserId } from '@invoice/kernel';

export type Bilingual = { readonly 'en-IN': string; readonly 'hi-IN': string };

/** The channels a reminder can leave by, in the vocabulary GPT 2's notification service uses. */
export type ReminderChannel = 'in_app' | 'email' | 'whatsapp' | 'sms';

/**
 * How hard the message pushes. Tone only — no level ever accuses the customer of anything, because
 * a late payment is usually an oversight and always somebody we want to keep trading with.
 */
export type ReminderLevel = 'ADVANCE' | 'GENTLE' | 'FIRM' | 'FINAL' | 'ESCALATE';

export const LEVEL_ORDER: readonly ReminderLevel[] = ['ADVANCE', 'GENTLE', 'FIRM', 'FINAL', 'ESCALATE'];

/** One rung of the ladder. `offsetDays` counts from the bill's due date; negative is before it. */
export interface ReminderStep {
  readonly code: string;
  readonly offsetDays: number;
  readonly level: ReminderLevel;
  /** Tried in order; the first one the customer accepts is used. */
  readonly channels: readonly ReminderChannel[];
}

export interface QuietHours {
  /** Local hour the quiet period starts, inclusive. */
  readonly fromHour: number;
  /** Local hour it ends, exclusive. */
  readonly toHour: number;
  readonly timeZone: string;
}

export interface ReminderPolicy {
  readonly effectiveFrom: IsoDate;
  readonly steps: readonly ReminderStep[];
  readonly quietHours: QuietHours;
  /** Two reminders to the same customer are never closer together than this. */
  readonly minimumGapDays: number;
  /** Bills smaller than this are not worth a message. */
  readonly minimumAmount: Money;
  /** Above this the owner is told instead of the customer. */
  readonly escalateAboveAmount: Money;
  /** Days after a promised date before the promise counts as broken. */
  readonly promiseGraceDays: number;
  /** Off by default: a disputed bill is not chased while the dispute is open. */
  readonly remindDuringDispute: boolean;
}

export type ContactState = 'ENABLED' | 'DISABLED';

export interface ContactPreference {
  readonly companyId: CompanyId;
  readonly partyId: PartyId;
  readonly channel: ReminderChannel;
  readonly state: ContactState;
  readonly reason: string | null;
  readonly recordedBy: UserId;
  readonly recordedAt: string;
}

/** A whole-party stop. Stronger than a channel preference and always carries a reason. */
export interface OptOut {
  readonly companyId: CompanyId;
  readonly partyId: PartyId;
  readonly reason: string;
  readonly recordedBy: UserId;
  readonly recordedAt: string;
}

export type PromiseState = 'OPEN' | 'CANCELLED';
/** Kept or broken is derived from what receivables says, never from a stored flag. */
export type PromiseOutcome = 'AWAITED' | 'KEPT' | 'BROKEN' | 'CANCELLED';

export interface PromiseToPay {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly partyId: PartyId;
  readonly documentId: string;
  readonly amount: Money;
  readonly promisedOn: IsoDate;
  readonly note: string | null;
  readonly state: PromiseState;
  readonly recordedBy: UserId;
  readonly recordedAt: string;
}

export type DisputeState = 'OPEN' | 'RESOLVED';

export interface Dispute {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly partyId: PartyId;
  /** Null means the whole account is in dispute, so nothing on it is chased. */
  readonly documentId: string | null;
  readonly reason: string;
  readonly state: DisputeState;
  readonly resolution: string | null;
  readonly raisedBy: UserId;
  readonly raisedAt: string;
  readonly resolvedBy: UserId | null;
  readonly resolvedAt: string | null;
}

export type SkipReason =
  | 'SETTLED'
  | 'NOT_YET_DUE'
  | 'NO_STEP_DUE'
  | 'ALREADY_SENT'
  | 'DISPUTED'
  | 'PROMISED'
  | 'OPTED_OUT'
  | 'QUIET_PERIOD'
  | 'TOO_SOON'
  | 'BELOW_MINIMUM'
  | 'NO_CHANNEL'
  | 'LADDER_EXHAUSTED';

/** What a bill was worth at the instant a reminder was planned or sent. Never recycled. */
export interface BalanceSnapshot {
  readonly asOf: IsoDate;
  readonly documentNumber: string;
  readonly documentValue: Money;
  readonly outstanding: Money;
  readonly partyOutstanding: Money;
  readonly daysOverdue: number;
}

export interface ReminderCandidate {
  readonly partyId: PartyId;
  readonly partyName: string;
  readonly documentId: string;
  readonly snapshot: BalanceSnapshot;
  readonly decision: 'SEND' | 'SKIP' | 'ESCALATE';
  readonly step: ReminderStep | null;
  readonly level: ReminderLevel | null;
  readonly channel: ReminderChannel | null;
  readonly reason: SkipReason | null;
  /** Why, in a sentence, whichever way the decision went. */
  readonly explanation: Bilingual;
  /** The key a send would use. Stable, so a retry cannot produce a second message. */
  readonly reminderKey: string | null;
}

export interface ReminderPlan {
  readonly asOf: IsoDate;
  readonly candidates: readonly ReminderCandidate[];
  readonly toSend: number;
  readonly toEscalate: number;
  readonly skipped: number;
  readonly summary: Bilingual;
}

export type ReminderState = 'SCHEDULED' | 'SENT' | 'FAILED' | 'SUPPRESSED' | 'CANCELLED';

export interface Reminder {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly branchId: BranchId | null;
  readonly partyId: PartyId;
  readonly documentId: string;
  readonly reminderKey: string;
  readonly stepCode: string;
  readonly level: ReminderLevel;
  readonly channel: ReminderChannel;
  readonly audience: 'CUSTOMER' | 'OWNER';
  readonly message: Bilingual;
  readonly snapshot: BalanceSnapshot;
  readonly state: ReminderState;
  readonly failureReason: string | null;
  /** The notification #39 created, so the delivery trail can be followed to its end. */
  readonly notificationId: string | null;
  readonly scheduledBy: UserId;
  readonly scheduledAt: string;
  readonly sentAt: string | null;
}

export const COLLECTIONS_PERMISSIONS = {
  view: 'collections.reminders.view',
  send: 'collections.reminders.send',
  promise: 'collections.promise.record',
  dispute: 'collections.dispute.manage',
} as const;

export const reminderKeyOf = (documentId: string, stepCode: string): string =>
  `reminder:${documentId}:${stepCode}`;
