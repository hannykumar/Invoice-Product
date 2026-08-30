/** Issue #23 [E23] — everything this module needs from outside, and nothing more. */
import type { CompanyId, IsoDate, PartyId } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import type { PartyPosition } from '@invoice/receivables';
import type {
  Bilingual,
  ContactPreference,
  Dispute,
  OptOut,
  PromiseToPay,
  Reminder,
  ReminderChannel,
  ReminderLevel,
} from './model.ts';

/** A customer, their name, and what they owe as receivables (#20) computes it right now. */
export interface CustomerAccount {
  readonly partyId: PartyId;
  readonly partyName: string;
  readonly position: PartyPosition;
}

/**
 * The only door to what is owed.
 *
 * It takes a date on every call because an outstanding balance is a fact about a moment, and this
 * module refuses to remember one for later.
 */
export interface ReceivablesPositionPort {
  customers(actor: ActorContext, today: IsoDate): Promise<readonly CustomerAccount[]>;
  customer(actor: ActorContext, partyId: PartyId, today: IsoDate): Promise<CustomerAccount>;
}

export interface PartyContact {
  /** The address the transport delivers to. Never rendered into a message. */
  readonly recipientId: string;
  /** The channels this customer can actually be reached on, best first. */
  readonly channels: readonly ReminderChannel[];
  /** The language this customer reads. A reminder nobody understands is not a reminder. */
  readonly locale?: 'en-IN' | 'hi-IN';
}

export interface PartyContactPort {
  contact(companyId: CompanyId, partyId: PartyId): Promise<PartyContact | null>;
  /** Who to escalate to when the ladder runs out. */
  owner(companyId: CompanyId): Promise<PartyContact>;
}

export interface ReminderMessage {
  readonly companyId: CompanyId;
  readonly recipientId: string;
  readonly audience: 'CUSTOMER' | 'OWNER';
  readonly channel: ReminderChannel;
  readonly level: ReminderLevel;
  readonly text: Bilingual;
  /** The same key the reminder is stored under, so neither layer can produce a second message. */
  readonly deduplicationKey: string;
  readonly payload: Readonly<Record<string, string>>;
}

/**
 * Sending. Implemented against GPT 2's notification service (#39); a failure here is a failure of
 * delivery only and never changes a bill, a balance or a ledger entry.
 */
export interface ReminderOutcome {
  readonly notificationId: string;
  /** `SUPPRESSED` when the recipient's own preferences silenced it — a fact, not a failure. */
  readonly state: 'SENT' | 'SUPPRESSED';
}

export interface ReminderTransport {
  send(actor: ActorContext, message: ReminderMessage): Promise<ReminderOutcome>;
}

export interface ReminderRepository {
  insert(reminder: Reminder): Promise<void>;
  update(reminder: Reminder): Promise<void>;
  findByKey(companyId: CompanyId, key: string): Promise<Reminder | null>;
  findById(companyId: CompanyId, id: string): Promise<Reminder | null>;
  list(companyId: CompanyId): Promise<readonly Reminder[]>;

  savePreference(preference: ContactPreference): Promise<void>;
  preferences(companyId: CompanyId, partyId: PartyId): Promise<readonly ContactPreference[]>;
  saveOptOut(optOut: OptOut): Promise<void>;
  removeOptOut(companyId: CompanyId, partyId: PartyId): Promise<void>;
  optOut(companyId: CompanyId, partyId: PartyId): Promise<OptOut | null>;

  savePromise(promise: PromiseToPay): Promise<void>;
  promises(companyId: CompanyId): Promise<readonly PromiseToPay[]>;
  saveDispute(dispute: Dispute): Promise<void>;
  disputes(companyId: CompanyId): Promise<readonly Dispute[]>;
}
