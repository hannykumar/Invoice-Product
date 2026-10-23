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
import type { TransactionalExecutor } from '../../platform/src/database.ts';
import { ConnectorGateway, HmacWebhookVerifier, MockConnector, signWebhook } from '../../platform/src/connectors.ts';
import { InMemoryAuthorisations, InMemoryCallLog } from '../src/adapters.ts';
import { GovernmentWebhookReceiver, WebhookNotAuthenticated } from '../src/webhooks.ts';
import type { PostgresWebhookEvents } from '../src/webhook-events-postgres.ts';

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

test('postgres: a resend after a restart is still a duplicate', { skip }, async () => {
  const eventId = `evt-${randomUUID()}`;
  const body = JSON.stringify({ eventId, providerRequestId: 'never-sent', occurredAt: NOW.toISOString(), payload: { Irn: 'irn-1' } });
  assert.equal((await freshProcess().receive('irp', body, signWebhook(SECRET, body, NOW))).kind, 'UNMATCHED');
  assert.equal((await freshProcess().receive('irp', body, signWebhook(SECRET, body, NOW))).kind, 'DUPLICATE');
  const rows = (await app.query('SELECT outcome FROM government_webhook_events WHERE connector = $1 AND event_id = $2', ['irp', eventId])).rows;
  assert.deepEqual(rows.map((row) => row.outcome), ['UNMATCHED']);
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
