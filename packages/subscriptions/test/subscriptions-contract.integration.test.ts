/**
 * Issue #366 — the subscription stores on a real PostgreSQL: the shared contract, connected as the
 * application role so row-level security and the freeze trigger of #368 are really in force, and
 * the service's own lifecycle run through the stores inside units of work.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { after, before, it } from 'node:test';
import { isoDate } from '@invoice/kernel';
import { permissionPortFromActor, type ActorContext } from '@invoice/ledger';
import type { TransactionalExecutor } from '../../platform/src/database.ts';
import {
  PostgresServiceInvoiceRepository,
  PostgresSubscriptionRepository,
  PostgresUsageRepository,
  SubscriptionService,
} from '../src/index.ts';
import { ScriptedPayments, SUBSCRIPTION_PERMISSION_LIST } from './harness.ts';
import { anInvoice, subscriptionStoresContract, type SubscriptionStoresHarness } from './subscriptions-contract.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the subscription database tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let harness: SubscriptionStoresHarness;
const login = `invoice_app_test_${randomBytes(6).toString('hex')}`;

const company = async (): Promise<string> => {
  const id = crypto.randomUUID();
  await owner.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Subscription Traders')", [id]);
  return id;
};

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import('../../platform/src/database.ts');
  const { migrate } = await import('../../platform/src/migrations.ts');
  owner = createDatabase(url);
  await migrate(owner);
  const password = randomBytes(18).toString('hex');
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const appUrl = new URL(url);
  appUrl.username = login;
  appUrl.password = password;
  app = createDatabase(appUrl.toString());
  harness = {
    subscriptions: new PostgresSubscriptionRepository(app),
    usage: new PostgresUsageRepository(app),
    invoices: new PostgresServiceInvoiceRepository(app),
    company,
    write: (companyId, work) => app.unitOfWork(companyId, () => work()),
    transactional: true,
  };
});
after(async () => {
  await app?.close();
  if (owner !== undefined) { await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

subscriptionStoresContract('postgres as the application role', () => harness, skip);

it("refuses to save one company's invoice over another's id", { skip }, async () => {
  const [a, b] = [await company(), await company()];
  const invoice = anInvoice(a);
  await app.unitOfWork(a, () => harness.invoices.save(invoice));
  await assert.rejects(app.unitOfWork(b, () => harness.invoices.save({ ...invoice, companyId: b })), (e: unknown) => (e as { code?: string }).code === 'SERVICE_INVOICE_DUPLICATE');
  assert.deepEqual(await harness.invoices.find(a, invoice.id), invoice);
});

it('runs the service lifecycle through the stores: trial, invoice, declined, paid twice, counted once', { skip }, async () => {
  const companyId = await company();
  const actor = { companyId, userId: 'user-synthetic', permissions: [...SUBSCRIPTION_PERMISSION_LIST] } as unknown as ActorContext;
  const payments = new ScriptedPayments();
  const audited: string[] = [];
  const service = new SubscriptionService({
    subscriptions: harness.subscriptions, usage: harness.usage, invoices: harness.invoices, payments,
    permissions: permissionPortFromActor,
    audit: { record: async (event: { action: string }) => { audited.push(event.action); } } as never,
    clock: { now: () => new Date('2026-06-01T10:00:00.000Z') },
  });
  const action = <T>(work: () => Promise<T>) => app.unitOfWork(companyId, work);
  const on = isoDate('2026-06-01');
  await action(() => service.start(actor, { planId: 'starter', on }));
  const issued = await action(() => service.issueServiceInvoice(actor, { period: '2026-06', on }));
  assert.equal((await action(() => service.issueServiceInvoice(actor, { period: '2026-06', on }))).id, issued.id);
  payments.declineNext = true;
  assert.equal((await action(() => service.chargeServiceInvoice(actor, issued.id, on))).state, 'FAILED');
  const webhook = { eventId: 'evt-1', invoiceId: issued.id, outcome: 'PAID' as const, providerReference: 'mock-ref', occurredOn: on };
  assert.equal((await action(() => service.receivePaymentEvent(actor, webhook))).state, 'PAID');
  assert.equal((await action(() => service.receivePaymentEvent(actor, webhook))).state, 'PAID');
  const view = await service.account(actor, on);
  assert.equal(view.state, 'ACTIVE');
  assert.equal(view.subscription.paidThrough, '2026-07-01');
  assert.deepEqual(view.invoices.map((i) => [i.state, i.paidOn, i.providerReference, i.failureReason]), [['PAID', '2026-06-01', 'mock-ref', null]]);
  for (let n = 0; n < 2; n += 1) {
    await action(() => service.recordUsage(actor, { meter: 'invoices', idempotencyKey: 'bill-1', note: 'Bill recorded', on }));
  }
  assert.equal(await harness.usage.total(companyId, 'invoices', '2026-06'), 1n);
  assert.deepEqual(audited, ['subscription.started', 'subscription.invoice_issued', 'subscription.payment_failed', 'subscription.invoice_paid']);
});
