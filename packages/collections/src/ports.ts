import type { ActorContext, AuditPort, PermissionPort } from '@invoice/ledger';
import type { DocumentLedgerPort, PartyPosition } from '@invoice/receivables';
import type { IsoDate, PartyId } from '@invoice/kernel';
import type {
  CollectionCommunication,
  CollectionDispute,
  CollectionPreference,
  PaymentPromise,
  ScheduledReminder,
} from './model.ts';

export interface CollectionReceivablesPort {
  position(actor: ActorContext, partyId: PartyId, today: IsoDate): Promise<PartyPosition>;
}

export type CollectionPartyPort = Pick<DocumentLedgerPort, 'parties' | 'nameOf'>;

export interface ReminderDeliveryInput {
  readonly reminderId: string;
  readonly recipientId: PartyId;
  readonly channel: ScheduledReminder['channel'];
  readonly locale: ScheduledReminder['locale'];
  readonly subject: string;
  readonly message: string;
  readonly deduplicationKey: string;
}

export interface ReminderDeliveryResult {
  readonly notificationId: string;
  readonly status: 'scheduled' | 'delivered' | 'failed' | 'suppressed';
  readonly detail: string | null;
}

export interface ReminderNotificationPort {
  deliver(actor: ActorContext, input: ReminderDeliveryInput): Promise<ReminderDeliveryResult>;
}

export interface CollectionRepository {
  preference(companyId: ActorContext['companyId'], partyId: PartyId): Promise<CollectionPreference | null>;
  savePreference(preference: CollectionPreference): Promise<void>;
  insertReminder(reminder: ScheduledReminder): Promise<void>;
  updateReminder(reminder: ScheduledReminder): Promise<void>;
  reminderByKey(companyId: ActorContext['companyId'], key: string): Promise<ScheduledReminder | null>;
  reminders(companyId: ActorContext['companyId']): Promise<readonly ScheduledReminder[]>;
  insertPromise(promise: PaymentPromise): Promise<void>;
  updatePromise(promise: PaymentPromise): Promise<void>;
  promises(companyId: ActorContext['companyId'], partyId: PartyId): Promise<readonly PaymentPromise[]>;
  insertDispute(dispute: CollectionDispute): Promise<void>;
  updateDispute(dispute: CollectionDispute): Promise<void>;
  disputes(companyId: ActorContext['companyId'], partyId: PartyId): Promise<readonly CollectionDispute[]>;
  insertCommunication(communication: CollectionCommunication): Promise<void>;
  communications(companyId: ActorContext['companyId'], partyId?: PartyId): Promise<readonly CollectionCommunication[]>;
}

export type CollectionPermissionPort = PermissionPort;
export type CollectionAuditPort = AuditPort;
