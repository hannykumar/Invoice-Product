/**
 * Issue #123 acceptance criteria, enforced automatically.
 *
 *   - "A verified callback settles the matching call and updates the document's status"
 *   - "The same callback delivered twice changes the record once"
 *   - "A callback whose signature does not verify is refused and recorded, and never parsed"
 *   - "A callback that disagrees with what we already hold raises an exception rather than
 *      overwriting either side"
 *
 * plus the tests the issue asks for by name: unsigned, wrongly signed, replayed and out-of-order
 * deliveries, a callback for an unknown or already-settled call, and one arriving while
 * reconciliation is chasing the same call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryAuditPort } from '@invoice/ledger';
import { ConnectorGateway, MockConnector, StaticWebhookVerifier } from '../../platform/src/connectors.ts';
import { SyntheticIrp, SyntheticIrpVault } from '../../gst/src/einvoice-adapters.ts';
import {
  InMemoryAuthorisations,
  InMemoryCallLog,
  InMemoryWebhookEvents,
  RecordingExceptionSink,
  SandboxGspProvider,
} from '../src/adapters.ts';
import { GovernmentChannel } from '../src/channel.ts';
import { GovernmentCallReconciler } from '../src/reconcile.ts';
import { GovernmentAccessService } from '../src/service.ts';
import { GovernmentWebhookReceiver, WebhookNotAuthenticated } from '../src/webhooks.ts';
import {
  EVERYDAY_SCOPES,
  KARNATAKA_GSTIN,
  SUNRISE_COMPANY,
  SUNRISE_NAME,
  invoicePayload,
  ownerOf,
} from '../src/fixtures.ts';

const AT = '2026-08-17T04:30:00.000Z';

interface Desk {
  readonly channel: GovernmentChannel;
  readonly receiver: GovernmentWebhookReceiver;
  readonly service: GovernmentAccessService;
  readonly provider: SandboxGspProvider;
  readonly calls: InMemoryCallLog;
  readonly events: InMemoryWebhookEvents;
  readonly exceptions: RecordingExceptionSink;
  readonly audit: InMemoryAuditPort;
  readonly authorisations: InMemoryAuthorisations;
  readonly irp: SyntheticIrp;
  readonly clock: { now(): Date };
}

const makeDesk = (): Desk => {
  let instant = new Date(AT);
  const clock = { now: () => new Date(instant.getTime()), set: (value: string) => { instant = new Date(value); } };
  const provider = new SandboxGspProvider({ now: () => clock.now() });
  const authorisations = new InMemoryAuthorisations();
  const calls = new InMemoryCallLog();
  const events = new InMemoryWebhookEvents();
  const exceptions = new RecordingExceptionSink();
  const audit = new InMemoryAuditPort();
  const irp = new SyntheticIrp(() => clock.now());
  const gateway = new ConnectorGateway([irp, new MockConnector('gst')], new SyntheticIrpVault(), new StaticWebhookVerifier());
  const service = new GovernmentAccessService({ authorisations, calls, provider, audit, clock });
  const channel = new GovernmentChannel({ gateway, authorisations, calls, audit, clock, provider });
  const receiver = new GovernmentWebhookReceiver({ gateway, calls, authorisations, events, audit, clock, exceptions });
  return { channel, receiver, service, provider, calls, events, exceptions, audit, authorisations, irp, clock };
};

const setClock = (desk: Desk, at: string): void => {
  (desk.clock as unknown as { set(value: string): void }).set(at);
};

const connect = async (desk: Desk): Promise<void> => {
  const owner = ownerOf();
  await desk.service.beginOnboarding(owner, { gstin: KARNATAKA_GSTIN, legalName: SUNRISE_NAME, signatoryHint: 'the owner', scopes: EVERYDAY_SCOPES });
  await desk.service.requestOtp(owner, KARNATAKA_GSTIN);
  await desk.service.verifyOtp(owner, KARNATAKA_GSTIN, '123456');
};

/** The bytes a provider posts. The signature is over these, so the test sends them unparsed. */
const callback = (input: {
  providerRequestId: string;
  irn?: string;
  eventId?: string;
  extra?: Record<string, unknown>;
}): string =>
  JSON.stringify({
    eventId: input.eventId ?? `evt-${input.providerRequestId}`,
    providerRequestId: input.providerRequestId,
    occurredAt: AT,
    payload: { ...(input.irn === undefined ? {} : { Irn: input.irn }), ...(input.extra ?? {}) },
  });

/** A call that timed out: recorded, unsettled, with only our own correlation id to find it by. */
const timedOutCall = async (desk: Desk, documentRef = 'SI-1042'): Promise<{ callId: string; correlationId: string }> => {
  await connect(desk);
  desk.irp.setMode('timeout');
  const outcome = await desk.channel.call(ownerOf(), {
    operation: 'einvoice.generate',
    payload: invoicePayload(KARNATAKA_GSTIN, documentRef),
    idempotencyKey: `key-${documentRef}`,
    documentRef,
  });
  assert.equal(outcome.kind, 'UNKNOWN');
  const call = await desk.calls.find(SUNRISE_COMPANY, outcome.callId);
  assert.ok(call !== null);
  desk.irp.setMode('healthy');
  return { callId: call.id, correlationId: call.correlationId };
};

// ------------------------------------------------------------------- the case it was built for

test('a callback settles the call that timed out, and the invoice is registered after all', async () => {
  const desk = makeDesk();
  const { callId, correlationId } = await timedOutCall(desk);

  const outcome = await desk.receiver.receive('irp', callback({ providerRequestId: correlationId, irn: 'irn-for-si-1042' }), 'test-signature');
  assert.equal(outcome.kind, 'SETTLED');
  assert.equal(outcome.kind === 'SETTLED' ? outcome.governmentReference : '', 'irn-for-si-1042');

  const call = await desk.calls.find(SUNRISE_COMPANY, callId);
  assert.equal(call?.outcome, 'ACCEPTED');
  assert.equal(call?.governmentReference, 'irn-for-si-1042');
  assert.ok(call?.reconciledAt !== null);
  assert.ok(desk.audit.events.some((event) => event.action === 'gsp.webhook.settled'));
  assert.equal(desk.events.all().length, 1);
});

test('the same callback delivered twice changes the record once', async () => {
  const desk = makeDesk();
  const { callId, correlationId } = await timedOutCall(desk);
  const body = callback({ providerRequestId: correlationId, irn: 'irn-for-si-1042' });

  const first = await desk.receiver.receive('irp', body, 'test-signature');
  const second = await desk.receiver.receive('irp', body, 'test-signature');
  const third = await desk.receiver.receive('irp', body, 'test-signature');
  assert.equal(first.kind, 'SETTLED');
  assert.equal(second.kind, 'DUPLICATE');
  assert.equal(third.kind, 'DUPLICATE');

  const call = await desk.calls.find(SUNRISE_COMPANY, callId);
  assert.equal(call?.governmentReference, 'irn-for-si-1042');
  assert.equal(desk.events.all().length, 1, 'one event row, not three');
  assert.equal(desk.audit.events.filter((event) => event.action === 'gsp.webhook.settled').length, 1);
});

// ------------------------------------------------------------------- authentication

test('a callback that does not authenticate is refused, recorded by digest, and never read', async () => {
  const desk = makeDesk();
  const { callId, correlationId } = await timedOutCall(desk);
  const body = callback({ providerRequestId: correlationId, irn: 'forged-irn' });

  await assert.rejects(desk.receiver.receive('irp', body, 'not-the-signature'), (error: unknown) => error instanceof WebhookNotAuthenticated);
  await assert.rejects(desk.receiver.receive('irp', body, ''), (error: unknown) => error instanceof WebhookNotAuthenticated);

  const call = await desk.calls.find(SUNRISE_COMPANY, callId);
  assert.equal(call?.outcome, 'UNKNOWN', 'an unauthenticated body cannot settle anything');
  assert.equal(call?.governmentReference, null);
  assert.equal(desk.events.all().length, 0, 'nothing was parsed, so there is no event to record');

  const rejected = await desk.events.listRejected();
  assert.equal(rejected.length, 2, 'but the fact that somebody sent it is kept');
  assert.match(rejected[0]?.digest ?? '', /^[0-9a-f]{64}$/, 'recorded by a digest of the bytes, not by their contents');
  assert.equal(JSON.stringify(rejected).includes('forged-irn'), false, 'and the contents are not stored');
  assert.ok(desk.audit.events.some((event) => event.action === 'gsp.webhook.rejected'));
});

test('a callback cannot name a company: the company comes from the call it matched', async () => {
  const desk = makeDesk();
  const { correlationId } = await timedOutCall(desk);
  const outcome = await desk.receiver.receive(
    'irp',
    callback({ providerRequestId: correlationId, irn: 'irn-1', extra: { companyId: '99999999-9999-4999-8999-999999999999', Gstin: '27ZZZZZ9999Z1ZZ' } }),
    'test-signature',
  );
  assert.equal(outcome.kind, 'SETTLED');
  const event = desk.events.all()[0];
  assert.equal(event?.companyId, SUNRISE_COMPANY, 'the company is ours, from our own row');
  const audited = desk.audit.events.find((entry) => entry.action === 'gsp.webhook.settled');
  assert.equal(audited?.companyId, SUNRISE_COMPANY);
  assert.equal(audited?.details.gstin, KARNATAKA_GSTIN, 'and so is the GST number');
});

// ------------------------------------------------------------------- late, unknown, unwanted

test('a callback about a call we already settled the same way changes nothing', async () => {
  const desk = makeDesk();
  await connect(desk);
  const answered = await desk.channel.call(ownerOf(), {
    operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-2000'), idempotencyKey: 'k-2000', documentRef: 'SI-2000',
  });
  assert.equal(answered.kind, 'ANSWERED');
  const before = await desk.calls.find(SUNRISE_COMPANY, answered.callId);
  assert.ok(before?.providerRequestId !== null && before?.governmentReference !== null);

  const outcome = await desk.receiver.receive('irp', callback({ providerRequestId: before!.providerRequestId!, irn: before!.governmentReference! }), 'test-signature');
  assert.equal(outcome.kind, 'CONFIRMED');
  const after = await desk.calls.find(SUNRISE_COMPANY, answered.callId);
  assert.deepEqual(after, before, 'the row is untouched');
  assert.equal(desk.exceptions.raised.length, 0);
});

test('a callback that arrives after reconciliation has already settled the call agrees with it', async () => {
  const desk = makeDesk();
  const { callId, correlationId } = await timedOutCall(desk);
  desk.provider.government('SI-1042', 'irn-for-si-1042');
  setClock(desk, '2026-08-17T05:30:00.000Z');
  const report = await new GovernmentCallReconciler({ calls: desk.calls, provider: desk.provider, audit: desk.audit, clock: desk.clock }).run(ownerOf());
  assert.equal(report.corrected, 1);

  // The provider's callback turns up a minute after polling already found the answer.
  const outcome = await desk.receiver.receive('irp', callback({ providerRequestId: correlationId, irn: 'irn-for-si-1042' }), 'test-signature');
  assert.equal(outcome.kind, 'CONFIRMED');
  const call = await desk.calls.find(SUNRISE_COMPANY, callId);
  assert.equal(call?.outcome, 'ACCEPTED');
  assert.equal(call?.governmentReference, 'irn-for-si-1042');
  assert.equal(desk.exceptions.raised.length, 0, 'the two agreeing is not a conflict');
});

test('a callback carrying a different reference than ours is a question for a person', async () => {
  const desk = makeDesk();
  await connect(desk);
  const answered = await desk.channel.call(ownerOf(), {
    operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-2001'), idempotencyKey: 'k-2001', documentRef: 'SI-2001',
  });
  const before = await desk.calls.find(SUNRISE_COMPANY, (answered as { callId: string }).callId);

  const outcome = await desk.receiver.receive('irp', callback({ providerRequestId: before!.providerRequestId!, irn: 'a-different-irn' }), 'test-signature');
  assert.equal(outcome.kind, 'CONFLICT');
  assert.equal(outcome.kind === 'CONFLICT' ? outcome.ours : '', before!.governmentReference);
  assert.equal(outcome.kind === 'CONFLICT' ? outcome.theirs : '', 'a-different-irn');
  assert.match(outcome.kind === 'CONFLICT' ? outcome.question['en-IN'] : '', /Somebody needs to look at both/);

  const after = await desk.calls.find(SUNRISE_COMPANY, before!.id);
  assert.equal(after?.governmentReference, before!.governmentReference, 'neither side is written over');
  assert.equal(desk.exceptions.raised.length, 1);
  assert.equal(desk.exceptions.raised[0]?.theirs, 'a-different-irn');
  assert.ok(desk.audit.events.some((event) => event.action === 'gsp.webhook.conflict'));
});

test('a callback saying it arrived, when we recorded that it never did, is not a silent correction', async () => {
  const desk = makeDesk();
  const { callId, correlationId } = await timedOutCall(desk, 'SI-1043');
  // Reconciliation asked, the provider said the government has no record, and we wrote that down.
  setClock(desk, '2026-08-17T05:30:00.000Z');
  const report = await new GovernmentCallReconciler({ calls: desk.calls, provider: desk.provider, audit: desk.audit, clock: desk.clock }).run(ownerOf());
  assert.equal(report.notFound, 1);
  assert.equal((await desk.calls.find(SUNRISE_COMPANY, callId))?.outcome, 'REJECTED');

  const outcome = await desk.receiver.receive('irp', callback({ providerRequestId: correlationId, irn: 'irn-after-all' }), 'test-signature');
  assert.equal(outcome.kind, 'CONFLICT', 'two answers about one invoice is a question, not a race the newer message wins');
  const call = await desk.calls.find(SUNRISE_COMPANY, callId);
  assert.equal(call?.outcome, 'REJECTED', 'our record is left exactly as it was');
  assert.equal(desk.exceptions.raised.length, 1);
});

test('a callback about a call this product never made is recorded and not acted on', async () => {
  const desk = makeDesk();
  await connect(desk);
  const outcome = await desk.receiver.receive('irp', callback({ providerRequestId: 'nothing-we-ever-sent', irn: 'irn-x' }), 'test-signature');
  assert.equal(outcome.kind, 'UNMATCHED');
  const event = desk.events.all()[0];
  assert.equal(event?.outcome, 'UNMATCHED');
  assert.equal(event?.companyId, null, 'an unmatched callback belongs to no company, and cannot claim one');
});

test('a callback for a GST number this business has never connected is refused', async () => {
  const desk = makeDesk();
  const { callId, correlationId } = await timedOutCall(desk);
  // The authorisation disappears entirely — a company deleted, a bad migration, a forged match.
  const stripped = new InMemoryAuthorisations();
  const receiver = new GovernmentWebhookReceiver({
    gateway: new ConnectorGateway([desk.irp], new SyntheticIrpVault(), new StaticWebhookVerifier()),
    calls: desk.calls, authorisations: stripped, events: desk.events, audit: desk.audit, clock: desk.clock, exceptions: desk.exceptions,
  });

  const outcome = await receiver.receive('irp', callback({ providerRequestId: correlationId, irn: 'irn-y' }), 'test-signature');
  assert.equal(outcome.kind, 'REFUSED');
  assert.equal((await desk.calls.find(SUNRISE_COMPANY, callId))?.outcome, 'UNKNOWN');
  assert.ok(desk.audit.events.some((event) => event.action === 'gsp.webhook.refused'));
});

test('a callback about a call made before the permission was taken back still settles it', async () => {
  const desk = makeDesk();
  const { callId, correlationId } = await timedOutCall(desk);
  await desk.service.revoke(ownerOf(), KARNATAKA_GSTIN, 'The owner is changing accountants.');

  const outcome = await desk.receiver.receive('irp', callback({ providerRequestId: correlationId, irn: 'irn-z' }), 'test-signature');
  // Revocation stops new calls. It does not make an invoice that was registered before it
  // un-registered, and pretending otherwise would leave a real IRN with nobody holding it.
  assert.equal(outcome.kind, 'SETTLED');
  assert.equal((await desk.calls.find(SUNRISE_COMPANY, callId))?.governmentReference, 'irn-z');
});

test('a callback with nothing in it to apply is recorded and ignored', async () => {
  const desk = makeDesk();
  const { callId, correlationId } = await timedOutCall(desk);
  const outcome = await desk.receiver.receive('irp', callback({ providerRequestId: correlationId, extra: { Status: 'PROCESSING' } }), 'test-signature');
  assert.equal(outcome.kind, 'IGNORED');
  assert.equal((await desk.calls.find(SUNRISE_COMPANY, callId))?.outcome, 'UNKNOWN', 'still unknown, and still chased by reconciliation');
  assert.equal(desk.events.all()[0]?.outcome, 'IGNORED');
});

test('a callback is matched by the provider’s request id when the call got one', async () => {
  const desk = makeDesk();
  await connect(desk);
  const answered = await desk.channel.call(ownerOf(), {
    operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-2002'), idempotencyKey: 'k-2002', documentRef: 'SI-2002',
  });
  const call = await desk.calls.find(SUNRISE_COMPANY, (answered as { callId: string }).callId);
  assert.ok(call?.providerRequestId !== null);
  const outcome = await desk.receiver.receive('irp', callback({ providerRequestId: call!.providerRequestId!, irn: call!.governmentReference! }), 'test-signature');
  assert.equal(outcome.kind, 'CONFIRMED');
});
