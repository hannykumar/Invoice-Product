/**
 * Issue #42 [E42] — in-memory stores, company-scoped at every read.
 *
 * `InMemoryUsageRepository.record` is the one method in this package where concurrency matters. It
 * does the duplicate check and the increment with **no `await` between them**, so the whole
 * check-and-add runs in one turn of the event loop and two simultaneous callers cannot both read
 * the same starting value. The PostgreSQL version gets the same guarantee from a unique index on
 * the idempotency key.
 */
import { conflict } from '@invoice/kernel';
import type { MeterId, ServiceInvoice, Subscription, UsageEvent } from './model.ts';
import type { Page, ServiceInvoiceRepository, SubscriptionRepository, UsageRepository } from './ports.ts';

/** Issue #366 — keyset pagination over a list already in its stable order: the rows after the one whose id is `after`. */
export const pageOf = <T extends { readonly id: string }>(rows: readonly T[], page?: Page): readonly T[] => {
  if (page === undefined) return rows;
  const from = page.after === undefined ? 0 : rows.findIndex((row) => row.id === page.after) + 1;
  return from === 0 && page.after !== undefined ? [] : rows.slice(from, from + page.limit);
};

/**
 * What `subscription_service_invoices`' freeze trigger (#368, `FROZEN` in
 * packages/platform/src/immutability-migrations.ts) allows once an invoice is ISSUED, PAID or
 * FAILED: only the state (never back to DRAFT), `paidOn`, `providerReference` and `failureReason`
 * change. Held here too so the in-memory store refuses what PostgreSQL refuses.
 */
export const assertServiceInvoiceChange = (before: ServiceInvoice | undefined, next: ServiceInvoice): void => {
  if (before === undefined || before.state === 'DRAFT') return;
  const fixed = (i: ServiceInvoice) => [i.companyId, i.planId, i.period, i.net.minor, i.gst.minor, i.total.minor, i.issuedOn, i.dueOn].join('|');
  if (next.state === 'DRAFT' || fixed(before) !== fixed(next)) {
    throw conflict('SERVICE_INVOICE_FROZEN', 'This subscription invoice has been issued, so its amounts and dates can no longer change.');
  }
};

export const SERVICE_INVOICE_DUPLICATE_PERIOD = () =>
  conflict('SERVICE_INVOICE_DUPLICATE', 'There is already a subscription invoice for this month.');

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

  async events(companyId: string, period: string, page?: Page): Promise<readonly UsageEvent[]> {
    const rows = this.#events
      .filter((event) => event.companyId === companyId && event.period === period)
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return pageOf(rows, page);
  }
}

export class InMemoryServiceInvoiceRepository implements ServiceInvoiceRepository {
  readonly #invoices = new Map<string, ServiceInvoice>();

  async save(invoice: ServiceInvoice): Promise<void> {
    const key = `${invoice.companyId}:${invoice.id}`;
    assertServiceInvoiceChange(this.#invoices.get(key), invoice);
    const samePeriod = [...this.#invoices.values()].find((other) => other.companyId === invoice.companyId && other.period === invoice.period);
    if (samePeriod !== undefined && samePeriod.id !== invoice.id) throw SERVICE_INVOICE_DUPLICATE_PERIOD();
    this.#invoices.set(key, invoice);
  }

  async find(companyId: string, id: string): Promise<ServiceInvoice | null> {
    const found = this.#invoices.get(`${companyId}:${id}`);
    return found !== undefined && found.companyId === companyId ? found : null;
  }

  async findForPeriod(companyId: string, period: string): Promise<ServiceInvoice | null> {
    return [...this.#invoices.values()].find((invoice) => invoice.companyId === companyId && invoice.period === period) ?? null;
  }

  async list(companyId: string, page?: Page): Promise<readonly ServiceInvoice[]> {
    const rows = [...this.#invoices.values()]
      .filter((invoice) => invoice.companyId === companyId)
      .sort((a, b) => (a.period < b.period ? 1 : -1));
    return pageOf(rows, page);
  }
}
