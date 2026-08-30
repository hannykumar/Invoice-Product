import type { CompanyId, IsoDate, Money, PartyId, UserId } from '@invoice/kernel';

export type CollectionChannel = 'in_app' | 'email' | 'whatsapp';
export type CollectionLocale = 'en-IN' | 'hi-IN';
export type ReminderStatus = 'SCHEDULED' | 'DELIVERED' | 'FAILED' | 'SUPPRESSED' | 'CANCELLED';
export type PromiseStatus = 'OPEN' | 'KEPT' | 'BROKEN' | 'CANCELLED';
export type DisputeStatus = 'OPEN' | 'RESOLVED';

export interface ReminderStep {
  readonly afterDaysOverdue: number;
  readonly channel: CollectionChannel;
  readonly template: 'gentle' | 'firm' | 'final';
}

export interface CollectionPolicy {
  readonly steps: readonly ReminderStep[];
  readonly stopForOpenDispute: boolean;
  readonly pauseForPromiseToPay: boolean;
}

export const DEFAULT_COLLECTION_POLICY: CollectionPolicy = Object.freeze({
  steps: Object.freeze([
    Object.freeze({ afterDaysOverdue: 1, channel: 'in_app' as const, template: 'gentle' as const }),
    Object.freeze({ afterDaysOverdue: 15, channel: 'email' as const, template: 'firm' as const }),
    Object.freeze({ afterDaysOverdue: 30, channel: 'whatsapp' as const, template: 'final' as const }),
  ]),
  stopForOpenDispute: true,
  pauseForPromiseToPay: true,
});

export interface CollectionPreference {
  readonly companyId: CompanyId;
  readonly partyId: PartyId;
  readonly optedOut: boolean;
  readonly disabledChannels: readonly CollectionChannel[];
  readonly locale: CollectionLocale;
  readonly updatedAt: string;
  readonly updatedBy: UserId;
}

export interface PaymentPromise {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly partyId: PartyId;
  readonly amount: Money;
  readonly promisedOn: IsoDate;
  readonly note: string | null;
  readonly status: PromiseStatus;
  readonly balanceAtPromise: Money;
  readonly createdAt: string;
  readonly createdBy: UserId;
  readonly closedAt: string | null;
}

export interface CollectionDispute {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly partyId: PartyId;
  readonly documentId: string;
  readonly documentNumber: string;
  readonly reason: string;
  readonly status: DisputeStatus;
  readonly openedAt: string;
  readonly openedBy: UserId;
  readonly resolvedAt: string | null;
  readonly resolution: string | null;
}

export interface BalanceSnapshot {
  readonly asOf: IsoDate;
  readonly totalOutstanding: Money;
  readonly oldestDaysOverdue: number;
  readonly documents: readonly {
    readonly id: string;
    readonly number: string;
    readonly outstanding: Money;
    readonly daysOverdue: number;
  }[];
}

export interface ScheduledReminder {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly partyId: PartyId;
  readonly partyName: string;
  readonly channel: CollectionChannel;
  readonly locale: CollectionLocale;
  readonly template: ReminderStep['template'];
  readonly stage: number;
  readonly scheduledAt: string;
  readonly status: ReminderStatus;
  readonly subject: string;
  readonly message: string;
  readonly snapshot: BalanceSnapshot;
  readonly deduplicationKey: string;
  readonly notificationId: string | null;
  readonly statusReason: string | null;
  readonly createdAt: string;
  readonly createdBy: UserId;
  readonly updatedAt: string;
}

export interface CollectionCommunication {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly reminderId: string;
  readonly partyId: PartyId;
  readonly channel: CollectionChannel;
  readonly outcome: Exclude<ReminderStatus, 'SCHEDULED'>;
  readonly subject: string;
  readonly message: string;
  readonly snapshot: BalanceSnapshot;
  readonly providerReference: string | null;
  readonly detail: string | null;
  readonly occurredAt: string;
  readonly actorId: UserId;
}

export const COLLECTION_PERMISSIONS = Object.freeze({ manage: 'collections.manage', send: 'collections.send' });
