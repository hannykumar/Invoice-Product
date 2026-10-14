/**
 * Issue #366 — one contract for the subscription stores, run on the in-memory ones
 * (subscriptions-contract.test.ts) and on PostgreSQL (subscriptions-contract.integration.test.ts).
 *
 * `write` is how the harness runs a write: directly in memory, inside `db.unitOfWork` on
 * PostgreSQL. `transactional` harnesses also get the rollback and "no unit of work" tests.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { isoDate, money } from '@invoice/kernel';
import type { ServiceInvoice, ServiceInvoiceRepository, Subscription, SubscriptionRepository, UsageEvent, UsageRepository } from '../src/index.ts';

export interface SubscriptionStoresHarness {
  readonly subscriptions: SubscriptionRepository;
  readonly usage: UsageRepository;
  readonly invoices: ServiceInvoiceRepository;
  /** A company the stores may hold rows for. */
  company(): Promise<string>;
  write<T>(companyId: string, work: () => Promise<T>): Promise<T>;
  readonly transactional: boolean;
}

const code = (...expected: string[]) => (error: unknown) => expected.includes((error as { code?: string }).code ?? '');

export const aSubscription = (companyId: string, over: Partial<Subscription> = {}): Subscription => ({
  id: crypto.randomUUID(),
  companyId,
  planId: 'starter',
  startedOn: isoDate('2026-02-28'),
  trialEndsOn: isoDate('2026-03-14'),
  paidThrough: null,
  cancelledOn: null,
  cancellationReason: null,
  history: [{ planId: 'starter', from: isoDate('2026-02-28'), reason: 'Signed up — दुकान' }],
  updatedAt: '2026-02-28T10:00:00.123Z',
  updatedBy: 'user-synthetic',
  ...over,
});

export const anEvent = (companyId: string, over: Partial<UsageEvent> = {}): UsageEvent => ({
  id: crypto.randomUUID(),
  companyId,
  meter: 'invoices',
  quantity: 1n,
  period: '2026-03',
  idempotencyKey: crypto.randomUUID(),
  at: '2026-03-01T10:00:00.000Z',
  by: 'user-synthetic',
  note: 'Bill recorded',
  ...over,
});

export const anInvoice = (companyId: string, over: Partial<ServiceInvoice> = {}): ServiceInvoice => ({
  id: crypto.randomUUID(),
  companyId,
  planId: 'starter',
  period: '2026-03',
  // Beyond 2^53, so a float anywhere on the way would show.
  net: money(9_007_199_254_740_993n),
  gst: money(1_621_295_865_853_378n),
  total: money(10_628_495_120_594_371n),
  state: 'ISSUED',
  issuedOn: isoDate('2026-03-01'),
  dueOn: isoDate('2026-03-08'),
  paidOn: null,
  providerReference: null,
  failureReason: null,
  ...over,
});

export function subscriptionStoresContract(label: string, harness: () => SubscriptionStoresHarness, skip: false | string = false): void {
  describe(`subscription stores (${label})`, { skip }, () => {
    describe('subscriptions', () => {
      it('saves, finds and replaces one subscription per company, every value exactly', async () => {
        const h = harness();
        const companyId = await h.company();
        assert.equal(await h.subscriptions.find(companyId), null, 'not found before it is saved');
        const first = aSubscription(companyId);
        await h.write(companyId, () => h.subscriptions.save(first));
        assert.deepEqual(await h.subscriptions.find(companyId), first);
        const next = aSubscription(companyId, {
          id: first.id, paidThrough: isoDate('2026-04-30'), cancelledOn: isoDate('2026-05-01'), cancellationReason: 'Closing the shop',
          history: [...first.history, { planId: 'growth', from: isoDate('2026-04-01'), reason: 'More bills' }], planId: 'growth',
          updatedAt: '2026-05-01T09:30:00.000Z',
        });
        await h.write(companyId, () => h.subscriptions.save(next));
        assert.deepEqual(await h.subscriptions.find(companyId), next);
      });

      it("one company never reads another's subscription", async () => {
        const h = harness();
        const [a, b] = [await h.company(), await h.company()];
        await h.write(a, () => h.subscriptions.save(aSubscription(a)));
        assert.equal(await h.subscriptions.find(b), null);
      });
    });

    describe('usage', () => {
      it('counts an event once, however often it is repeated, and keeps months and meters apart', async () => {
        const h = harness();
        const companyId = await h.company();
        const event = anEvent(companyId, { quantity: 9_007_199_254_740_993n });
        assert.deepEqual(await h.write(companyId, () => h.usage.record(event)), { counted: true, total: 9_007_199_254_740_993n });
        assert.deepEqual(await h.write(companyId, () => h.usage.record({ ...event, id: crypto.randomUUID() })), { counted: false, total: 9_007_199_254_740_993n });
        await h.write(companyId, () => h.usage.record(anEvent(companyId, { quantity: 2n })));
        await h.write(companyId, () => h.usage.record(anEvent(companyId, { period: '2026-04' })));
        await h.write(companyId, () => h.usage.record(anEvent(companyId, { meter: 'ai_requests' })));
        assert.equal(await h.usage.total(companyId, 'invoices', '2026-03'), 9_007_199_254_740_995n);
        assert.equal(await h.usage.total(companyId, 'invoices', '2026-04'), 1n);
        assert.equal(await h.usage.total(companyId, 'ai_requests', '2026-03'), 1n);
        assert.equal(await h.usage.total(companyId, 'storage_mb', '2026-03'), 0n);
        const events = await h.usage.events(companyId, '2026-03');
        assert.equal(events.length, 3);
        assert.deepEqual(events.find((e) => e.id === event.id), event, 'every field round-trips, the bigint exactly');
      });

      it('counts many simultaneous events in full', async () => {
        const h = harness();
        const companyId = await h.company();
        await Promise.all(Array.from({ length: 20 }, () => h.write(companyId, () => h.usage.record(anEvent(companyId)))));
        assert.equal(await h.usage.total(companyId, 'invoices', '2026-03'), 20n);
      });

      it('pages through the events oldest first, each exactly once', async () => {
        const h = harness();
        const companyId = await h.company();
        for (let n = 0; n < 7; n += 1) {
          await h.write(companyId, () => h.usage.record(anEvent(companyId, { at: `2026-03-0${String(1 + (n % 3))}T10:00:00.000Z` })));
        }
        const all = await h.usage.events(companyId, '2026-03');
        const seen: UsageEvent[] = [];
        let after: string | undefined;
        for (;;) {
          const page = await h.usage.events(companyId, '2026-03', { limit: 3, ...(after === undefined ? {} : { after }) });
          if (page.length === 0) break;
          seen.push(...page);
          after = page.at(-1)?.id;
        }
        assert.deepEqual(seen, all);
        assert.equal(new Set(seen.map((e) => e.id)).size, 7);
        assert.deepEqual([...seen].map((e) => e.at), [...seen].map((e) => e.at).sort(), 'oldest first');
        assert.deepEqual(await h.usage.events(companyId, '2026-03', { limit: 3, after: crypto.randomUUID() }), [], 'an unknown cursor finds nothing');
      });

      it("one company never sees or spends another's usage, even under the same key", async () => {
        const h = harness();
        const [a, b] = [await h.company(), await h.company()];
        const key = crypto.randomUUID();
        await h.write(a, () => h.usage.record(anEvent(a, { idempotencyKey: key })));
        assert.equal(await h.usage.total(b, 'invoices', '2026-03'), 0n);
        assert.deepEqual(await h.usage.events(b, '2026-03'), []);
        assert.deepEqual(await h.write(b, () => h.usage.record(anEvent(b, { idempotencyKey: key }))), { counted: true, total: 1n });
      });
    });

    describe('service invoices', () => {
      it('saves and finds an invoice by id and by month, every value exactly', async () => {
        const h = harness();
        const companyId = await h.company();
        const invoice = anInvoice(companyId);
        assert.equal(await h.invoices.find(companyId, invoice.id), null, 'not found before it is saved');
        assert.equal(await h.invoices.find(companyId, 'not-an-id'), null);
        await h.write(companyId, () => h.invoices.save(invoice));
        assert.deepEqual(await h.invoices.find(companyId, invoice.id), invoice);
        assert.deepEqual(await h.invoices.findForPeriod(companyId, '2026-03'), invoice);
        assert.equal(await h.invoices.findForPeriod(companyId, '2026-04'), null);
      });

      it('makes every move the service makes: issued, failed, then paid', async () => {
        const h = harness();
        const companyId = await h.company();
        const issued = anInvoice(companyId);
        await h.write(companyId, () => h.invoices.save(issued));
        const failed: ServiceInvoice = { ...issued, state: 'FAILED', failureReason: 'The card was declined.' };
        await h.write(companyId, () => h.invoices.save(failed));
        assert.deepEqual(await h.invoices.find(companyId, issued.id), failed);
        const paid: ServiceInvoice = { ...failed, state: 'PAID', paidOn: isoDate('2026-03-03'), providerReference: 'mock-ref', failureReason: null };
        await h.write(companyId, () => h.invoices.save(paid));
        await h.write(companyId, () => h.invoices.save(paid));
        assert.deepEqual(await h.invoices.find(companyId, issued.id), paid);
        // A free plan's invoice is written already paid.
        const free = anInvoice(companyId, { period: '2026-04', net: money(0n), gst: money(0n), total: money(0n), state: 'PAID', paidOn: isoDate('2026-04-01') });
        await h.write(companyId, () => h.invoices.save(free));
        assert.deepEqual(await h.invoices.find(companyId, free.id), free);
      });

      it('refuses to change an issued invoice’s amounts, or take it back to a draft', async () => {
        const h = harness();
        const companyId = await h.company();
        const issued = anInvoice(companyId);
        await h.write(companyId, () => h.invoices.save(issued));
        await assert.rejects(h.write(companyId, () => h.invoices.save({ ...issued, total: money(1n) })), code('SERVICE_INVOICE_FROZEN'));
        await assert.rejects(h.write(companyId, () => h.invoices.save({ ...issued, state: 'DRAFT' })), code('SERVICE_INVOICE_FROZEN'));
        assert.deepEqual(await h.invoices.find(companyId, issued.id), issued);
      });

      it('refuses a second invoice for the same month', async () => {
        const h = harness();
        const companyId = await h.company();
        const first = anInvoice(companyId);
        await h.write(companyId, () => h.invoices.save(first));
        await assert.rejects(h.write(companyId, () => h.invoices.save(anInvoice(companyId))), code('SERVICE_INVOICE_DUPLICATE'));
        assert.deepEqual(await h.invoices.list(companyId), [first]);
      });

      it('lists newest month first and pages through every invoice exactly once', async () => {
        const h = harness();
        const companyId = await h.company();
        const months = ['2025-11', '2026-02', '2025-12', '2026-01', '2026-03'];
        for (const period of months) await h.write(companyId, () => h.invoices.save(anInvoice(companyId, { period })));
        const all = await h.invoices.list(companyId);
        assert.deepEqual(all.map((i) => i.period), [...months].sort().reverse());
        const seen: ServiceInvoice[] = [];
        let after: string | undefined;
        for (;;) {
          const page = await h.invoices.list(companyId, { limit: 2, ...(after === undefined ? {} : { after }) });
          if (page.length === 0) break;
          seen.push(...page);
          after = page.at(-1)?.id;
        }
        assert.deepEqual(seen, all);
        assert.deepEqual(await h.invoices.list(companyId, { limit: 2, after: crypto.randomUUID() }), [], 'an unknown cursor finds nothing');
      });

      it("one company never reads or changes another's invoice", async () => {
        const h = harness();
        const [a, b] = [await h.company(), await h.company()];
        const invoice = anInvoice(a);
        await h.write(a, () => h.invoices.save(invoice));
        assert.equal(await h.invoices.find(b, invoice.id), null);
        assert.equal(await h.invoices.findForPeriod(b, invoice.period), null);
        assert.deepEqual(await h.invoices.list(b), []);
        assert.deepEqual(await h.invoices.list(b, { limit: 5, after: invoice.id }), []);
        // Saving B's copy under A's id is either kept apart (memory) or refused (PostgreSQL); A's invoice never changes.
        await h.write(b, () => h.invoices.save({ ...invoice, companyId: b, state: 'PAID', paidOn: isoDate('2026-03-02') })).catch(() => undefined);
        assert.deepEqual(await h.invoices.find(a, invoice.id), invoice);
      });
    });

    describe('transactions', () => {
      it('a rolled-back action leaves nothing behind', async (t) => {
        const h = harness();
        if (!h.transactional) { t.skip('the in-memory stores have no transactions'); return; }
        const companyId = await h.company();
        const invoice = anInvoice(companyId);
        await assert.rejects(h.write(companyId, async () => {
          await h.subscriptions.save(aSubscription(companyId));
          await h.usage.record(anEvent(companyId));
          await h.invoices.save(invoice);
          throw new Error('the action failed after its writes');
        }), /the action failed/);
        assert.equal(await h.subscriptions.find(companyId), null);
        assert.equal(await h.usage.total(companyId, 'invoices', '2026-03'), 0n);
        assert.equal(await h.invoices.find(companyId, invoice.id), null);
      });

      it('a write outside a unit of work is refused, not committed on its own', async (t) => {
        const h = harness();
        if (!h.transactional) { t.skip('the in-memory stores have no transactions'); return; }
        const companyId = await h.company();
        await assert.rejects(h.subscriptions.save(aSubscription(companyId)), code('NO_UNIT_OF_WORK'));
        await assert.rejects(h.usage.record(anEvent(companyId)), code('NO_UNIT_OF_WORK'));
        await assert.rejects(h.invoices.save(anInvoice(companyId)), code('NO_UNIT_OF_WORK'));
        assert.equal(await h.subscriptions.find(companyId), null);
      });
    });
  });
}
