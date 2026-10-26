/**
 * Issue #389 — callbacks taken delivery of are kept in PostgreSQL, so a provider resending an
 * acknowledgement after the server restarts still gets `DUPLICATE` and changes nothing.
 *
 * Runs as a login that is only a member of invoice_app, as the server does. Needs DATABASE_URL.
 * Without it the tests are skipped locally, and fail in CI so they can never pass there by not running.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { InMemoryAuditPort } from '@invoice/ledger';
import type { CompanyId, UserId } from '@invoice/kernel';
import type { TransactionalExecutor } from '../../platform/src/database.ts';
import { ConnectorGateway, HmacWebhookVerifier, MockConnector, signWebhook } from '../../platform/src/connectors.ts';
import { InMemoryAuthorisations, InMemoryCallLog } from '../src/adapters.ts';
import { KARNATAKA_GSTIN, invoicePayload } from '../src/fixtures.ts';
import { PostgresAuthorisations, PostgresCallLog } from '../src/postgres-repositories.ts';
import { GovernmentWebhookReceiver, WebhookNotAuthenticated } from '../src/webhooks.ts';
import type { PostgresWebhookEvents } from '../src/webhook-events-postgres.ts';
import { desk, type GspHarness } from './gsp-store-contract.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the webhook event tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';

const NOW = new Date('2026-08-17T04:30:00.000Z');
const SECRET = 'irp-secret-for-the-database-test';
let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let Events: typeof PostgresWebhookEvents;
const login = `invoice_app_test_${randomBytes(6).toString('hex')}`;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import('../../platform/src/database.ts');
  const { migrate } = await import('../../platform/src/migrations.ts');
  Events = (await import('../src/webhook-events-postgres.ts')).PostgresWebhookEvents;
  owner = createDatabase(url);
  await migrate(owner);
  const password = randomBytes(18).toString('hex');
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const appUrl = new URL(url);
  appUrl.username = login;
  appUrl.password = password;
  app = createDatabase(appUrl.toString());
});
after(async () => {
  await app?.close();
  if (owner !== undefined) { await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

/** A fresh process: new gateway (so its in-memory set is empty), new receiver, same database. */
const freshProcess = (): GovernmentWebhookReceiver => new GovernmentWebhookReceiver({
  gateway: new ConnectorGateway([new MockConnector('irp')], { async credentialReference() { return 'vault://irp'; } },
    new HmacWebhookVerifier({ async webhookSecrets(kind) { return kind === 'irp' ? [SECRET] : []; } }, () => NOW)),
  calls: new InMemoryCallLog(),
  authorisations: new InMemoryAuthorisations(),
  events: new Events(app),
  audit: new InMemoryAuditPort(),
  clock: { now: () => NOW },
});

test('postgres: a resend after a restart of a never-matching delivery stays one UNMATCHED row (#477)', { skip }, async () => {
  const eventId = `evt-${randomUUID()}`;
  const body = JSON.stringify({ eventId, providerRequestId: 'never-sent', occurredAt: NOW.toISOString(), payload: { Irn: 'irn-1' } });
  assert.equal((await freshProcess().receive('irp', body, signWebhook(SECRET, body, NOW))).kind, 'UNMATCHED');
  // A resend of an UNMATCHED delivery is matched again, not deduplicated away: the call it is
  // about may have arrived in between. When it still matches nothing, the record is one row
  // that still says UNMATCHED — and a settled event is never touched by any of this.
  assert.equal((await freshProcess().receive('irp', body, signWebhook(SECRET, body, NOW))).kind, 'UNMATCHED');
  const rows = (await app.query('SELECT outcome FROM government_webhook_events WHERE connector = $1 AND event_id = $2', ['irp', eventId])).rows;
  assert.deepEqual(rows.map((row) => row.outcome), ['UNMATCHED']);
});

/** A company and a person in it, on the real tables. */
const company = async (): Promise<{ companyId: CompanyId; userId: UserId }> => {
  const companyId = randomUUID() as CompanyId;
  const userId = randomUUID() as UserId;
  await app.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Hardware Traders')", [companyId]);
  await app.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Synthetic owner')", [userId, `wh-${userId}@example.invalid`]);
  return { companyId, userId };
};

const postgresHarness = (): GspHarness => ({
  authorisations: new PostgresAuthorisations(app),
  calls: new PostgresCallLog(app),
  company,
  write: (companyId, work) => app.unitOfWork(companyId, () => work()),
});

/** A receiver exactly as `configureGovernmentWebhooks` builds it on the database (#477). */
const postgresProcess = (): GovernmentWebhookReceiver => new GovernmentWebhookReceiver({
  gateway: new ConnectorGateway([new MockConnector('irp')], { async credentialReference() { return 'vault://irp'; } },
    new HmacWebhookVerifier({ async webhookSecrets(kind) { return kind === 'irp' ? [SECRET] : []; } }, () => NOW)),
  calls: new PostgresCallLog(app),
  authorisations: new PostgresAuthorisations(app),
  events: new Events(app),
  audit: new InMemoryAuditPort(),
  clock: { now: () => NOW },
  unitOfWork: (companyId, work) => app.unitOfWork(companyId, () => work()),
});

test('postgres: a signed callback finds its company and settles the call, and touches no other company (#477)', { skip }, async () => {
  const h = postgresHarness();
  const d = await desk(h);
  await d.connect(KARNATAKA_GSTIN);
  d.irp.setMode('timeout');
  const unknown = await d.act(() => d.channel.call(d.owner, { operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-21'), idempotencyKey: 'SI-21', documentRef: 'SI-21' }));
  assert.equal(unknown.kind, 'UNKNOWN');
  const made = await h.calls.find(d.companyId, unknown.callId);
  assert.ok(made?.providerRequestId === null, 'a timed-out call is found by our own correlation id');

  // A second company with its own call: the callback must not see or touch it.
  const h2 = postgresHarness();
  const d2 = await desk(h2);
  await d2.connect(KARNATAKA_GSTIN);
  d2.irp.setMode('timeout');
  const theirs = await d2.act(() => d2.channel.call(d2.owner, { operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-22'), idempotencyKey: 'SI-22', documentRef: 'SI-22' }));
  assert.equal(theirs.kind, 'UNKNOWN');

  const eventId = `evt-${randomUUID()}`;
  const body = JSON.stringify({ eventId, providerRequestId: made!.correlationId, occurredAt: NOW.toISOString(), payload: { Irn: 'irn-for-si-21' } });
  const signed = signWebhook(SECRET, body, NOW);
  const outcome = await postgresProcess().receive('irp', body, signed);
  assert.deepEqual(outcome, { kind: 'SETTLED', callId: made!.id, governmentReference: 'irn-for-si-21' });

  // The call settled in its own company's transaction — the event row carries its company.
  const settled = await h.calls.find(d.companyId, made!.id);
  assert.equal(settled?.outcome, 'ACCEPTED');
  assert.equal(settled?.governmentReference, 'irn-for-si-21');
  const event = await new Events(app).find('irp', eventId);
  assert.equal(event?.outcome, 'SETTLED');
  assert.equal(event?.companyId, d.companyId);

  // The other company's call is exactly as it was, and nothing is recorded under it.
  assert.equal((await h2.calls.find(d2.companyId, theirs.callId))?.outcome, 'UNKNOWN');
  const rows = (await app.query('SELECT count(*)::int AS n FROM government_webhook_events WHERE company_id = $1', [d2.companyId])).rows;
  assert.equal(rows[0]?.n, 0);

  // The provider sending the same event again is a duplicate now that it has settled.
  assert.equal((await postgresProcess().receive('irp', body, signed)).kind, 'DUPLICATE');
});

test('postgres: a callback that arrived before its call is matched when it is sent again (#477)', { skip }, async () => {
  const correlationId = `corr-${randomUUID()}`;
  const eventId = `evt-${randomUUID()}`;
  const body = JSON.stringify({ eventId, providerRequestId: correlationId, occurredAt: NOW.toISOString(), payload: { Irn: 'irn-early' } });
  const signed = signWebhook(SECRET, body, NOW);
  assert.equal((await postgresProcess().receive('irp', body, signed)).kind, 'UNMATCHED');

  // The call it was about lands a moment later, timed out, named by our own correlation id.
  const h = postgresHarness();
  const d = await desk(h);
  await d.connect(KARNATAKA_GSTIN);
  d.irp.setMode('timeout');
  const unknown = await d.act(() => d.channel.call(d.owner, { operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-23'), idempotencyKey: 'SI-23', documentRef: 'SI-23', correlationId }));
  assert.equal(unknown.kind, 'UNKNOWN');

  // Sent again, in what is a fresh process as far as the in-memory dedup knows: the UNMATCHED
  // record is upgraded rather than treated as a duplicate.
  assert.equal((await postgresProcess().receive('irp', body, signed)).kind, 'SETTLED');
  const stored = await new Events(app).find('irp', eventId);
  assert.equal(stored?.outcome, 'SETTLED');
  assert.equal(stored?.companyId, d.companyId);
  assert.equal((await h.calls.find(d.companyId, unknown.callId))?.governmentReference, 'irn-early');
  assert.equal((await postgresProcess().receive('irp', body, signed)).kind, 'DUPLICATE');
});

test('postgres: two inserts of one event keep the first and do not fail', { skip }, async () => {
  const events = new Events(app);
  const record = { kind: 'irp', eventId: `evt-${randomUUID()}`, providerRequestId: 'p', receivedAt: NOW.toISOString(), callId: null, companyId: null, outcome: 'UNMATCHED', governmentReference: null };
  await events.insert(record);
  await events.insert({ ...record, outcome: 'IGNORED' });
  assert.equal((await events.find('irp', record.eventId))?.outcome, 'UNMATCHED');
  assert.equal(await events.find('gst', record.eventId), null);
});

test('postgres: a forged callback is recorded by digest only, and nothing from it is kept as an event', { skip }, async () => {
  const eventId = `evt-${randomUUID()}`;
  const body = JSON.stringify({ eventId, providerRequestId: 'p', occurredAt: NOW.toISOString(), payload: { Irn: 'attacker' } });
  await assert.rejects(freshProcess().receive('irp', body, 'test-signature'), WebhookNotAuthenticated);
  assert.equal(await new Events(app).find('irp', eventId), null);
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(body).digest('hex');
  assert.ok((await new Events(app).listRejected()).some((row) => row.digest === digest && row.kind === 'irp'));
});
