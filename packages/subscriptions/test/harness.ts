/**
 * Issue #42 [E42] — a real business with a plan.
 *
 * The books underneath are #35's own golden business: stock bought in, bills issued through
 * `SalesService`, money taken through `ReceivablesService`. That matters for exactly one test —
 * the one that proves a lapsed plan changes nothing about them — and that test is the acceptance
 * criterion, so it is worth the whole fixture.
 */
import { isoDate, type IsoDate } from '@invoice/kernel';
import { permissionPortFromActor, type ActorContext } from '@invoice/ledger';
import { aBusyMonth, ALL_PERMISSIONS } from '../../reports/test/fixtures.ts';
import {
  InMemoryServiceInvoiceRepository,
  InMemorySubscriptionRepository,
  InMemoryUsageRepository,
  SubscriptionService,
  type ChargeOutcome,
  type ChargeRequest,
  type PaymentProviderPort,
} from '../src/index.ts';

export const SUBSCRIPTION_PERMISSION_LIST = ['subscription.view', 'subscription.manage'] as const;
export const EVERY_PERMISSION = [...ALL_PERMISSIONS, ...SUBSCRIPTION_PERMISSION_LIST];

export const TODAY: IsoDate = isoDate('2026-06-01');

/** A provider that can be told to decline, so a failed payment is exercised rather than described. */
export class ScriptedPayments implements PaymentProviderPort {
  readonly seen: ChargeRequest[] = [];
  declineNext = false;

  async charge(request: ChargeRequest): Promise<ChargeOutcome> {
    this.seen.push(request);
    if (this.declineNext) {
      this.declineNext = false;
      return { providerReference: '', state: 'FAILED', failureReason: 'The card was declined.' };
    }
    return { providerReference: `mock-${request.invoiceId}`, state: 'PAID', failureReason: null };
  }
}

export const makeSubscriptionDesk = async (options: { permissions?: readonly string[] } = {}) => {
  const business = await aBusyMonth();
  const actor: ActorContext = { ...business.actor, permissions: options.permissions ?? EVERY_PERMISSION };
  const payments = new ScriptedPayments();
  const usage = new InMemoryUsageRepository();
  const invoices = new InMemoryServiceInvoiceRepository();
  let n = 0;
  const service = new SubscriptionService({
    subscriptions: new InMemorySubscriptionRepository(),
    usage,
    invoices,
    payments,
    permissions: permissionPortFromActor,
    audit: business.audit,
    clock: { now: () => new Date('2026-06-01T10:00:00.000Z') },
    idFactory: () => `sub-${String((n += 1)).padStart(4, '0')}`,
  });
  return { business, actor, service, payments, usage, invoices };
};
