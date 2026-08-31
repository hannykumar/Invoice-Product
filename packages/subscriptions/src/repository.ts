/**
 * Issue #42 [E42] — in-memory stores, company-scoped at every read.
 *
 * `InMemoryUsageRepository.record` is the one method in this package where concurrency matters. It
 * does the duplicate check and the increment with **no `await` between them**, so the whole
 * check-and-add runs in one turn of the event loop and two simultaneous callers cannot both read
 * the same starting value. The PostgreSQL version gets the same guarantee from a unique index on
 * the idempotency key.
 */
import type { MeterId, ServiceInvoice, Subscription, UsageEvent } from './model.ts';
import type { ServiceInvoiceRepository, SubscriptionRepository, UsageRepository } from './ports.ts';

export class InMemorySubscriptionRepository implements SubscriptionRepository {
  readonly #byCompany = new Map<string, Subscription>();

  async save(subscription: Subscription): Promise<void> {
    this.#byCompany.set(subscription.companyId, subscription);
  }

  async find(companyId: string): Promise<Subscription | null> {
    const found = this.#byCompany.get(companyId);
    return found !== undefined && found.companyId === companyId ? found : null;
  }
}

export class InMemoryUsageRepository implements UsageRepository {
  readonly #totals = new Map<string, bigint>();
  readonly #seen = new Map<string, string>();
  readonly #events: UsageEvent[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await -- the body must not yield; see above.
  async record(event: UsageEvent): Promise<{ counted: boolean; total: bigint }> {
    const totalKey = `${event.companyId}:${event.meter}:${event.period}`;
    const seenKey = `${event.companyId}:${event.idempotencyKey}`;
    // From here to the end there is no `await`, so nothing else can run in between.
    if (this.#seen.has(seenKey)) {
      return { counted: false, total: this.#totals.get(totalKey) ?? 0n };
    }
    this.#seen.set(seenKey, event.id);
    const total = (this.#totals.get(totalKey) ?? 0n) + event.quantity;
    this.#totals.set(totalKey, total);
    this.#events.push(event);
    return { counted: true, total };
  }

  async total(companyId: string, meter: MeterId, period: string): Promise<bigint> {
    return this.#totals.get(`${companyId}:${meter}:${period}`) ?? 0n;
  }

  async events(companyId: string, period: string): Promise<readonly UsageEvent[]> {
    return this.#events.filter((event) => event.companyId === companyId && event.period === period);
  }
}

export class InMemoryServiceInvoiceRepository implements ServiceInvoiceRepository {
  readonly #invoices = new Map<string, ServiceInvoice>();

  async save(invoice: ServiceInvoice): Promise<void> {
    this.#invoices.set(`${invoice.companyId}:${invoice.id}`, invoice);
  }

  async find(companyId: string, id: string): Promise<ServiceInvoice | null> {
    const found = this.#invoices.get(`${companyId}:${id}`);
    return found !== undefined && found.companyId === companyId ? found : null;
  }

  async findForPeriod(companyId: string, period: string): Promise<ServiceInvoice | null> {
    return [...this.#invoices.values()].find((invoice) => invoice.companyId === companyId && invoice.period === period) ?? null;
  }

  async list(companyId: string): Promise<readonly ServiceInvoice[]> {
    return [...this.#invoices.values()]
      .filter((invoice) => invoice.companyId === companyId)
      .sort((a, b) => (a.period < b.period ? 1 : -1));
  }
}
