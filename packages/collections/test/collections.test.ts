import assert from 'node:assert/strict';
import test from 'node:test';
import { asId, isoDate, money, type IsoDate, type PartyId } from '@invoice/kernel';
import type { ActorContext, AuditEvent } from '@invoice/ledger';
import type { DocumentPosition, PartyPosition } from '@invoice/receivables';
import { NotificationService, type NotificationTransport } from '../../platform/src/index.ts';
import {
  CollectionsService,
  InMemoryCollectionRepository,
  PlatformReminderNotificationAdapter,
} from '../src/index.ts';

const COMPANY = asId<'Company'>('00000000-0000-4000-8000-000000000001');
const CUSTOMER = asId<'Party'>('customer-abc');
const actor: ActorContext = {
  companyId: COMPANY,
  branchId: asId<'Branch'>('branch-main'),
  userId: asId<'User'>('owner'),
  permissions: ['collections.manage', 'collections.send', 'notification.send'],
};

const document = (outstandingPaise: bigint, daysOverdue: number): DocumentPosition => ({
  document: {
    documentId: 'invoice-1', kind: 'SALES_INVOICE', number: 'INV/1', partyId: CUSTOMER,
    date: isoDate('2026-06-01'), dueDate: isoDate('2026-06-30'), value: money(100_000_00n), side: 'RECEIVABLE',
  },
  allocated: money(100_000_00n - outstandingPaise), outstanding: money(outstandingPaise), daysOverdue,
  status: outstandingPaise === 0n ? 'SETTLED' : outstandingPaise < 100_000_00n ? 'PARTLY_PAID' : 'OPEN',
});

const position = (outstandingPaise: bigint, daysOverdue = 31): PartyPosition => ({
  partyId: CUSTOMER,
  documents: [document(outstandingPaise, daysOverdue)],
  totalOutstanding: money(outstandingPaise), onAccount: money(0n), chequesNotCleared: money(0n),
});

const makeDesk = (transport?: NotificationTransport) => {
  let now = new Date('2026-08-01T10:00:00.000Z');
  let current = position(100_000_00n);
  const audit: AuditEvent[] = [];
  const repository = new InMemoryCollectionRepository();
  const notificationService = new NotificationService(transport ?? { async send() {} }, () => now.getTime());
  let sequence = 0;
  const service = new CollectionsService({
    receivables: { async position() { return current; } },
    parties: { async parties() { return [CUSTOMER]; }, async nameOf() { return 'ABC Traders'; } },
    repository,
    notifications: new PlatformReminderNotificationAdapter(notificationService, () => now.getTime()),
    permissions: { require(context, permission) { if (!context.permissions.includes(permission)) throw new Error('permission denied'); } },
    audit: { async record(event) { audit.push(event); } },
    clock: { now: () => now },
    idFactory: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
  });
  return {
    service, repository, notificationService, audit,
    setPosition(value: PartyPosition) { current = value; },
    setNow(value: string) { now = new Date(value); },
  };
};

test('owner reviews a staged message and a retry cannot schedule it twice', async () => {
  const desk = makeDesk();
  const first = await desk.service.schedule(actor, { partyId: CUSTOMER, asOf: isoDate('2026-08-01'), idempotencyKey: 'abc:inv1:stage3' });
  const retry = await desk.service.schedule(actor, { partyId: CUSTOMER, asOf: isoDate('2026-08-01'), idempotencyKey: 'abc:inv1:stage3' });
  assert.equal(retry.id, first.id);
  assert.equal(first.stage, 3);
  assert.equal(first.channel, 'whatsapp');
  assert.match(first.message, /₹100000\.00/);
  assert.deepEqual((await desk.service.review(actor)).map((item) => item.id), [first.id]);
});

test('a partial payment refreshes the message and communication balance before sending', async () => {
  const sent: string[] = [];
  const desk = makeDesk({ async send(notification) { sent.push(String(notification.payload.message)); } });
  await desk.service.schedule(actor, { partyId: CUSTOMER, asOf: isoDate('2026-08-01'), channel: 'email' });
  desk.setPosition(position(50_000_00n));
  const [delivered] = await desk.service.deliverDue(actor, isoDate('2026-08-01'));
  assert.equal(delivered?.status, 'DELIVERED');
  assert.match(sent[0] ?? '', /₹50000\.00/);
  assert.doesNotMatch(sent[0] ?? '', /₹100000\.00/);
  const [communication] = await desk.service.communications(actor, CUSTOMER);
  assert.equal(communication?.snapshot.totalOutstanding.minor, 50_000_00n);
  assert.equal(communication?.outcome, 'DELIVERED');
});

test('settlement after scheduling cancels the reminder without contacting the customer', async () => {
  let sends = 0;
  const desk = makeDesk({ async send() { sends += 1; } });
  await desk.service.schedule(actor, { partyId: CUSTOMER, asOf: isoDate('2026-08-01') });
  desk.setPosition(position(0n, 0));
  const [cancelled] = await desk.service.deliverDue(actor, isoDate('2026-08-01'));
  assert.equal(cancelled?.status, 'CANCELLED');
  assert.match(cancelled?.statusReason ?? '', /settled/);
  assert.equal(sends, 0);
});

test('an open dispute stops delivery and keeps the reason in the communication timeline', async () => {
  let sends = 0;
  const desk = makeDesk({ async send() { sends += 1; } });
  await desk.service.schedule(actor, { partyId: CUSTOMER, asOf: isoDate('2026-08-01') });
  await desk.service.openDispute(actor, { partyId: CUSTOMER, documentId: 'invoice-1', asOf: isoDate('2026-08-01'), reason: 'The delivered quantity was short.' });
  const [cancelled] = await desk.service.deliverDue(actor, isoDate('2026-08-01'));
  assert.equal(cancelled?.status, 'CANCELLED');
  assert.match(cancelled?.statusReason ?? '', /disputed/);
  assert.equal(sends, 0);
  assert.match((await desk.service.communications(actor, CUSTOMER))[0]?.detail ?? '', /disputed/);
});

test('customer opt-out and notification quiet hours suppress delivery visibly', async () => {
  let sends = 0;
  const optedOut = makeDesk({ async send() { sends += 1; } });
  await optedOut.service.setPreference(actor, { partyId: CUSTOMER, optedOut: true });
  await optedOut.service.schedule(actor, { partyId: CUSTOMER, asOf: isoDate('2026-08-01'), channel: 'email' });
  assert.equal((await optedOut.service.deliverDue(actor, isoDate('2026-08-01')))[0]?.status, 'SUPPRESSED');
  assert.equal(sends, 0);

  const quiet = makeDesk({ async send() { sends += 1; } });
  quiet.notificationService.setPreference({ companyId: COMPANY, branchId: 'branch-main', actorId: 'owner', sessionId: 'session', permissions: new Set(['notification.send']) }, { recipientId: CUSTOMER, channel: 'email', enabled: true, quietFromHour: 9, quietToHour: 11, timeZone: 'UTC' });
  await quiet.service.schedule(actor, { partyId: CUSTOMER, asOf: isoDate('2026-08-01'), channel: 'email' });
  const [suppressed] = await quiet.service.deliverDue(actor, isoDate('2026-08-01'));
  assert.equal(suppressed?.status, 'SUPPRESSED');
  assert.match(suppressed?.statusReason ?? '', /quiet hours/);
});

test('delivery failure remains visible and does not change the collection balance', async () => {
  let attempts = 0;
  const desk = makeDesk({ async send() { attempts += 1; if (attempts === 1) throw new Error('provider outage'); } });
  await desk.service.schedule(actor, { partyId: CUSTOMER, asOf: isoDate('2026-08-01'), channel: 'whatsapp' });
  const [failed] = await desk.service.deliverDue(actor, isoDate('2026-08-01'));
  assert.equal(failed?.status, 'FAILED');
  assert.match(failed?.statusReason ?? '', /Retry is available/);
  assert.equal(failed?.snapshot.totalOutstanding.minor, 100_000_00n);
  const [retried] = await desk.service.deliverDue(actor, isoDate('2026-08-01'));
  assert.equal(retried?.status, 'DELIVERED');
  assert.equal(attempts, 2);
  assert.deepEqual((await desk.service.communications(actor, CUSTOMER)).map((item) => item.outcome), ['FAILED', 'DELIVERED']);
});

test('the collections migration forces tenant row-level security for every stored record', async () => {
  const sql = (await import('../src/migrations.ts')).collectionMigrations[0]!.up;
  for (const table of ['collection_preferences', 'collection_promises', 'collection_disputes', 'collection_reminders', 'collection_communications']) {
    assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`CREATE POLICY ${table}_tenant`));
  }
});

test('a promise pauses reminders until its date and is marked kept after enough payment', async () => {
  let sends = 0;
  const desk = makeDesk({ async send() { sends += 1; } });
  await desk.service.recordPromise(actor, { partyId: CUSTOMER, amount: money(40_000_00n), promisedOn: isoDate('2026-08-05'), asOf: isoDate('2026-08-01'), note: 'Bank transfer expected' });
  await desk.service.schedule(actor, { partyId: CUSTOMER, asOf: isoDate('2026-08-01'), channel: 'email' });
  const [paused] = await desk.service.deliverDue(actor, isoDate('2026-08-01'));
  assert.equal(paused?.status, 'SCHEDULED');
  assert.match(paused?.statusReason ?? '', /promise date/);
  assert.equal(sends, 0);

  desk.setPosition(position(60_000_00n));
  desk.setNow('2026-08-02T10:00:00.000Z');
  const [delivered] = await desk.service.deliverDue(actor, isoDate('2026-08-02'));
  assert.equal(delivered?.status, 'DELIVERED');
  assert.equal(sends, 1);
});

test('collection actions require their dedicated permissions and remain tenant scoped', async () => {
  const desk = makeDesk();
  const viewer: ActorContext = { ...actor, permissions: [] };
  await assert.rejects(() => desk.service.schedule(viewer, { partyId: CUSTOMER, asOf: isoDate('2026-08-01') }), /permission denied/);
  const other: ActorContext = { ...actor, companyId: asId<'Company'>('00000000-0000-4000-8000-000000000099') };
  assert.deepEqual(await desk.service.review(other), []);
});
