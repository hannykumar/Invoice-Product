/** Issue #42 [E42] — what this module needs from outside. */
import type { IsoDate } from '@invoice/kernel';
import type { MeterId, ServiceInvoice, Subscription, UsageEvent } from './model.ts';

export interface SubscriptionRepository {
  save(subscription: Subscription): Promise<void>;
  find(companyId: string): Promise<Subscription | null>;
}

export interface UsageRepository {
  /**
   * Counts one usage event, or recognises that it has already been counted.
   *
   * Implementations must do the check and the increment **without yielding**: in this runtime that
   * means no `await` between reading the counter and writing it, and in PostgreSQL it means one
   * insert against a unique key. That is what makes two tills recording a bill at the same instant
   * add up to two rather than one.
   */
  record(event: UsageEvent): Promise<{ counted: boolean; total: bigint }>;
  total(companyId: string, meter: MeterId, period: string): Promise<bigint>;
  events(companyId: string, period: string): Promise<readonly UsageEvent[]>;
}

export interface ServiceInvoiceRepository {
  save(invoice: ServiceInvoice): Promise<void>;
  find(companyId: string, id: string): Promise<ServiceInvoice | null>;
  findForPeriod(companyId: string, period: string): Promise<ServiceInvoice | null>;
  list(companyId: string): Promise<readonly ServiceInvoice[]>;
}

export interface ChargeRequest {
  readonly companyId: string;
  readonly invoiceId: string;
  readonly amountPaise: bigint;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface ChargeOutcome {
  readonly providerReference: string;
  readonly state: 'PAID' | 'PENDING' | 'FAILED';
  readonly failureReason: string | null;
}

/**
 * Taking the money.
 *
 * Behind #8's connector gateway, so development runs on a mock and no production credential is
 * needed. A failure here moves the subscription along its lifecycle and touches no business record.
 */
export interface PaymentProviderPort {
  charge(request: ChargeRequest): Promise<ChargeOutcome>;
}

export interface PaymentWebhook {
  readonly eventId: string;
  readonly invoiceId: string;
  readonly outcome: 'PAID' | 'FAILED';
  readonly providerReference: string;
  readonly failureReason?: string;
  readonly occurredOn: IsoDate;
}
