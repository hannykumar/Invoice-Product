/**
 * Issue #33 [E33] acceptance criteria, enforced automatically.
 *
 *   - "Each GSTIN has separate authorisation state"
 *   - "Revocation stops new calls without deleting history"
 *   - "Internal status matches authoritative government acknowledgement"
 *
 * plus the tests the issue asks for by name: sandbox onboarding and consent, expired and revoked
 * credentials, and provider outage, retry and reconciliation. The non-goal — "give one customer
 * access to another GSTIN" — is tested as hard as the criteria are, because it is the one failure
 * in this module that would be somebody else's tax return.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '@invoice/kernel';
import { InMemoryAuditPort } from '@invoice/ledger';
import { ConnectorGateway, MockConnector, StaticWebhookVerifier } from '../../platform/src/connectors.ts';
import { SyntheticIrp, SyntheticIrpVault, irpAdapter } from '../../gst/src/einvoice-adapters.ts';
import {
  InMemoryAuthorisations,
  InMemoryCallLog,
  RecordingExceptionSink,
  SANDBOX_PROFILE,
  SandboxGspProvider,
  SlidingWindowLimiter,
  authorisedPortalRecordSource,
  authorisedReturnPort,
} from '../src/adapters.ts';
import { checkAuthorisation, effectiveStatus } from '../src/authorisation.ts';
import { AuthorisedGateway, GovernmentChannel, gstinInPayload } from '../src/channel.ts';
import { GovernmentCallReconciler } from '../src/reconcile.ts';
import { GovernmentAccessService } from '../src/service.ts';
import { REDACTED, containsSecretField, redact } from '../src/redact.ts';
import {
  CLERK_USER,
  EVERYDAY_SCOPES,
  KARNATAKA_GSTIN,
  MAHARASHTRA_GSTIN,
  OTHER_COMPANY,
  OWNER_USER,
  SUNRISE_COMPANY,
  SUNRISE_NAME,
  VIEW_ONLY,
  actorWith,
  invoicePayload,
  ownerOf,
} from '../src/fixtures.ts';
import { GSP_PERMISSIONS, type GovernmentScope, type ProviderProfile } from '../src/types.ts';

const AT = '2026-08-17T04:30:00.000Z';

interface Desk {
  readonly service: GovernmentAccessService;
  readonly channel: GovernmentChannel;
  readonly provider: SandboxGspProvider;
  readonly authorisations: InMemoryAuthorisations;
  readonly calls: InMemoryCallLog;
  readonly audit: InMemoryAuditPort;
  readonly irp: SyntheticIrp;
  readonly gateway: ConnectorGateway;
  readonly clock: { now(): Date };
}

const makeDesk = (options: { at?: string; profile?: ProviderProfile } = {}): Desk => {
  let instant = new Date(options.at ?? AT);
  const clock = { now: () => new Date(instant.getTime()), set: (value: string) => { instant = new Date(value); } };
  const provider = new SandboxGspProvider({ now: () => clock.now(), ...(options.profile === undefined ? {} : { profile: options.profile }) });
  const authorisations = new InMemoryAuthorisations();
  const calls = new InMemoryCallLog();
  const audit = new InMemoryAuditPort();
  const irp = new SyntheticIrp(() => clock.now());
  const gateway = new ConnectorGateway([irp, new MockConnector('gst'), new MockConnector('eway_bill')], new SyntheticIrpVault(), new StaticWebhookVerifier());
  let counter = 0;
  const service = new GovernmentAccessService({
    authorisations, calls, provider, audit, clock, idFactory: () => `id-${++counter}`,
  });
  const channel = new GovernmentChannel({
    gateway, authorisations, calls, audit, clock, provider,
    limiter: new SlidingWindowLimiter(),
    idFactory: () => `call-${++counter}`,
  });
  return { service, channel, provider, authorisations, calls, audit, irp, gateway, clock };
};

const setClock = (desk: Desk, at: string): void => {
  (desk.clock as unknown as { set(value: string): void }).set(at);
};

/** The whole onboarding dance, as a business actually does it. */
const connect = async (
  desk: Desk,
  gstin: string,
  scopes: readonly GovernmentScope[] = EVERYDAY_SCOPES,
  actor = ownerOf(),
): Promise<void> => {
  const begun = await desk.service.beginOnboarding(actor, { gstin, legalName: SUNRISE_NAME, signatoryHint: 'the owner', scopes });
  assert.equal(begun.kind, 'API_USER_READY');
  const sent = await desk.service.requestOtp(actor, gstin);
  assert.equal(sent.kind, 'OTP_SENT');
  const done = await desk.service.verifyOtp(actor, gstin, '123456');
  assert.equal(done.kind, 'AUTHORISED');
};

// ------------------------------------------------------------------- onboarding and consent

test('a GST number is connected by a one-time password, and the consent records what was agreed', async () => {
  const desk = makeDesk();
  const owner = ownerOf();
  const begun = await desk.service.beginOnboarding(owner, {
    gstin: KARNATAKA_GSTIN, legalName: SUNRISE_NAME, signatoryHint: 'the owner', scopes: EVERYDAY_SCOPES,
  });
  assert.equal(begun.kind, 'API_USER_READY');

  const sent = await desk.service.requestOtp(owner, KARNATAKA_GSTIN);
  assert.equal(sent.kind, 'OTP_SENT');
  assert.equal(sent.kind === 'OTP_SENT' ? sent.authorisation.status : '', 'OTP_REQUESTED');
  assert.equal(sent.kind === 'OTP_SENT' ? sent.authorisation.otp?.sentToHint : '', '••••1234');

  const done = await desk.service.verifyOtp(owner, KARNATAKA_GSTIN, '123456');
  assert.equal(done.kind, 'AUTHORISED');
  const authorisation = await desk.service.connection(owner, KARNATAKA_GSTIN);
  assert.equal(authorisation.status, 'ACTIVE');
  assert.equal(authorisation.otp, null, 'the challenge is finished with and not kept');
  assert.deepEqual([...authorisation.scopes], [...EVERYDAY_SCOPES]);
  assert.equal(authorisation.consent?.grantedBy, OWNER_USER);
  assert.equal(authorisation.consent?.method, 'PORTAL_OTP');
  assert.match(authorisation.consent?.wordingShown['en-IN'] ?? '', /never see or keep your GST portal password/);
  assert.match(authorisation.consent?.wordingShown['hi-IN'] ?? '', /password hum na dekhte hain na rakhte hain/);
  assert.match(authorisation.credential?.reference ?? '', /^vault:\/\//);
});

test('a wrong code counts down and the right one still works', async () => {
  const desk = makeDesk();
  const owner = ownerOf();
  await desk.service.beginOnboarding(owner, { gstin: KARNATAKA_GSTIN, legalName: SUNRISE_NAME, signatoryHint: 'the owner', scopes: EVERYDAY_SCOPES });
  await desk.service.requestOtp(owner, KARNATAKA_GSTIN);

  const wrong = await desk.service.verifyOtp(owner, KARNATAKA_GSTIN, '000000');
  assert.equal(wrong.kind, 'WRONG_OTP');
  assert.equal(wrong.kind === 'WRONG_OTP' ? wrong.attemptsRemaining : -1, 2);
  assert.match(wrong.kind === 'WRONG_OTP' ? wrong.message['en-IN'] : '', /2 tries left/);
  const stillPending = await desk.service.connection(owner, KARNATAKA_GSTIN);
  assert.equal(stillPending.status, 'OTP_REQUESTED');

  const right = await desk.service.verifyOtp(owner, KARNATAKA_GSTIN, '123456');
  assert.equal(right.kind, 'AUTHORISED');
});

test('a code that has expired is not accepted, and the person is told to ask for another', async () => {
  const desk = makeDesk();
  const owner = ownerOf();
  await desk.service.beginOnboarding(owner, { gstin: KARNATAKA_GSTIN, legalName: SUNRISE_NAME, signatoryHint: 'the owner', scopes: EVERYDAY_SCOPES });
  await desk.service.requestOtp(owner, KARNATAKA_GSTIN);
  setClock(desk, '2026-08-17T06:30:00.000Z');
  const late = await desk.service.verifyOtp(owner, KARNATAKA_GSTIN, '123456');
  assert.equal(late.kind, 'OTP_EXPIRED');
  assert.match(late.kind === 'OTP_EXPIRED' ? late.message['en-IN'] : '', /Ask for a new one/);
});

test('this product refuses to be handed a GST portal password at all', async () => {
  const desk = makeDesk();
  await assert.rejects(
    desk.service.beginOnboarding(ownerOf(), {
      gstin: KARNATAKA_GSTIN,
      legalName: SUNRISE_NAME,
      signatoryHint: 'the owner',
      scopes: EVERYDAY_SCOPES,
      // Somebody trying to be helpful.
      ...({ portalPassword: 'hunter2' } as Record<string, unknown>),
    } as never),
    (error: unknown) => error instanceof DomainError && error.code === 'GSP_PASSWORD_NOT_ACCEPTED',
  );
});

test('nothing that looks like a secret is ever written to the record', async () => {
  const desk = makeDesk();
  await connect(desk, KARNATAKA_GSTIN);
  const written = JSON.stringify(desk.audit.events);
  assert.equal(written.includes('123456'), false, 'the one-time password must never reach the audit trail');
  assert.equal(written.includes('hunter2'), false);
  assert.ok(desk.audit.events.some((event) => event.action === 'gsp.authorisation.granted'));

  const cleaned = redact({ Gstin: KARNATAKA_GSTIN, clientSecret: 's3cret', nested: { access_token: 'abc', keep: 'yes' } }) as Record<string, unknown>;
  assert.equal(cleaned.clientSecret, REDACTED);
  assert.equal((cleaned.nested as Record<string, unknown>).access_token, REDACTED);
  assert.equal((cleaned.nested as Record<string, unknown>).keep, 'yes');
  assert.equal(cleaned.Gstin, KARNATAKA_GSTIN);
  assert.equal(containsSecretField({ a: { b: { otp: '1' } } }), true);
  assert.equal(containsSecretField({ a: { b: { gstin: '1' } } }), false);
});

// ------------------------------------------------------------------- one GSTIN at a time

test('each GST number has its own authorisation, and one does not speak for the other', async () => {
  const desk = makeDesk();
  const owner = ownerOf();
  await connect(desk, KARNATAKA_GSTIN);

  const refused = await desk.channel.call(owner, {
    operation: 'einvoice.generate',
    payload: invoicePayload(MAHARASHTRA_GSTIN, 'SI-1042'),
    idempotencyKey: 'inv-1042',
  });
  assert.equal(refused.kind, 'REFUSED');
  assert.equal(refused.kind === 'REFUSED' ? refused.refusal.reason : '', 'NOT_AUTHORISED');

  await connect(desk, MAHARASHTRA_GSTIN);
  const accepted = await desk.channel.call(owner, {
    operation: 'einvoice.generate',
    payload: invoicePayload(MAHARASHTRA_GSTIN, 'SI-1042'),
    idempotencyKey: 'inv-1042b',
  });
  assert.equal(accepted.kind, 'ANSWERED');

  const connections = await desk.service.connections(owner);
  assert.equal(connections.length, 2);
  assert.deepEqual(connections.map((row) => row.status).sort(), ['ACTIVE', 'ACTIVE']);
});

test('revoking one GST number leaves the other one working', async () => {
  const desk = makeDesk();
  const owner = ownerOf();
  await connect(desk, KARNATAKA_GSTIN);
  await connect(desk, MAHARASHTRA_GSTIN);

  await desk.service.revoke(owner, KARNATAKA_GSTIN, 'The Bengaluru registration was surrendered.');

  const stopped = await desk.channel.call(owner, {
    operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-1'), idempotencyKey: 'a',
  });
  assert.equal(stopped.kind === 'REFUSED' ? stopped.refusal.reason : '', 'AUTHORISATION_REVOKED');

  const still = await desk.channel.call(owner, {
    operation: 'einvoice.generate', payload: invoicePayload(MAHARASHTRA_GSTIN, 'SI-2'), idempotencyKey: 'b',
  });
  assert.equal(still.kind, 'ANSWERED');
});

test('a document that does not say which GST number it belongs to is refused, never guessed', async () => {
  const desk = makeDesk();
  const owner = ownerOf();
  await connect(desk, KARNATAKA_GSTIN);
  await connect(desk, MAHARASHTRA_GSTIN);

  const outcome = await desk.channel.call(owner, {
    operation: 'gstr2b.fetch', payload: { RetPeriod: '2026-07' }, idempotencyKey: 'ambiguous-1',
  });
  assert.equal(outcome.kind, 'REFUSED');
  assert.match(outcome.kind === 'REFUSED' ? outcome.refusal.message['en-IN'] : '', /more than one connected GST number/);
  assert.equal(gstinInPayload({ RetPeriod: '2026-07' }), null);
  assert.equal(gstinInPayload(invoicePayload(KARNATAKA_GSTIN, 'SI-1')), KARNATAKA_GSTIN);
});

test('a business that authorised only some acts cannot be made to do the others', async () => {
  const desk = makeDesk();
  const owner = ownerOf();
  await connect(desk, KARNATAKA_GSTIN, ['EINVOICE_GENERATE', 'GSTR2B_FETCH']);

  const refused = await desk.channel.call(owner, {
    operation: 'return.submit', gstin: KARNATAKA_GSTIN, payload: { Gstin: KARNATAKA_GSTIN }, idempotencyKey: 'ret-1',
  });
  assert.equal(refused.kind === 'REFUSED' ? refused.refusal.reason : '', 'SCOPE_NOT_GRANTED');
  assert.match(refused.kind === 'REFUSED' ? refused.refusal.message['en-IN'] : '', /did not allow "file your gst returns"/i);
  assert.ok(refused.kind === 'REFUSED' && refused.refusal.nextAction !== null);
});

test('an operation nobody has mapped to a permission is never sent', () => {
  const verdict = checkAuthorisation({ authorisation: null, operation: 'einvoice.mystery', gstin: KARNATAKA_GSTIN, now: AT });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.allowed === false ? verdict.refusal.reason : '', 'UNKNOWN_OPERATION');
});

// ------------------------------------------------------------------- revocation and expiry

test('revocation stops the next call and deletes nothing', async () => {
  const desk = makeDesk();
  const owner = ownerOf();
  await connect(desk, KARNATAKA_GSTIN);
  const before = await desk.channel.call(owner, {
    operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-900'), idempotencyKey: 'before-1',
  });
  assert.equal(before.kind, 'ANSWERED');

  const revoked = await desk.service.revoke(owner, KARNATAKA_GSTIN, 'The owner asked for the connection to stop.');
  assert.equal(revoked.status, 'REVOKED');
  assert.equal(revoked.credential, null, 'nothing can be sent with it any more');
  assert.equal(revoked.revokedBy, OWNER_USER);
  assert.equal(revoked.consent?.withdrawnAt !== undefined, true, 'the consent is marked withdrawn, not deleted');
  assert.equal(revoked.consent?.grantedBy, OWNER_USER, 'and it still says who gave it');
  assert.equal(revoked.credentialHistory.length, 1, 'the credential that made those calls is still on the record');

  const after = await desk.channel.call(owner, {
    operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-901'), idempotencyKey: 'after-1',
  });
  assert.equal(after.kind === 'REFUSED' ? after.refusal.reason : '', 'AUTHORISATION_REVOKED');

  const history = await desk.service.history(owner, KARNATAKA_GSTIN);
  assert.equal(history.calls.filter((call) => call.outcome === 'ACCEPTED').length, 1, 'the call made before revocation is still there');
  assert.equal(history.calls.filter((call) => call.outcome === 'REFUSED').length, 1, 'and so is the one we would not make');
});

test('an expired credential stops calls and says so in words', async () => {
  const desk = makeDesk();
  const owner = ownerOf();
  await connect(desk, KARNATAKA_GSTIN);
  const authorisation = await desk.service.connection(owner, KARNATAKA_GSTIN);
  await desk.authorisations.put({
    ...authorisation,
    credential: { ...authorisation.credential!, expiresAt: '2026-08-16T00:00:00.000Z' },
  });

  const outcome = await desk.channel.call(owner, {
    operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-1'), idempotencyKey: 'exp-1',
  });
  assert.equal(outcome.kind === 'REFUSED' ? outcome.refusal.reason : '', 'AUTHORISATION_EXPIRED');
  assert.match(outcome.kind === 'REFUSED' ? outcome.refusal.nextAction?.['en-IN'] ?? '' : '', /one-time password/);

  const shown = await desk.service.connection(owner, KARNATAKA_GSTIN);
  assert.equal(shown.status, 'EXPIRED', 'the screen shows what is true now, not what the row last said');
  assert.equal(effectiveStatus({ ...shown, status: 'ACTIVE' }, AT), 'EXPIRED');
});

test('pausing a connection is not the same as taking it back', async () => {
  const desk = makeDesk();
  const owner = ownerOf();
  await connect(desk, KARNATAKA_GSTIN);
  await desk.service.suspend(owner, KARNATAKA_GSTIN, 'The provider bill is unpaid.');
  const paused = await desk.channel.call(owner, {
    operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-1'), idempotencyKey: 'sus-1',
  });
  assert.equal(paused.kind === 'REFUSED' ? paused.refusal.reason : '', 'AUTHORISATION_SUSPENDED');
  assert.equal(paused.kind === 'REFUSED' ? paused.refusal.retryable : false, true);

  const resumed = await desk.service.resume(owner, KARNATAKA_GSTIN);
  assert.equal(resumed.status, 'ACTIVE');
  assert.equal(resumed.consent?.withdrawnAt, undefined, 'nobody withdrew their consent');
});

test('rotating credentials keeps the old reference on the record', async () => {
  const desk = makeDesk();
  const owner = ownerOf();
  await connect(desk, KARNATAKA_GSTIN);
  const before = await desk.service.connection(owner, KARNATAKA_GSTIN);
  const rotated = await desk.service.rotateCredential(owner, KARNATAKA_GSTIN, 'Six-monthly rotation.');
  assert.notEqual(rotated.credential?.reference, before.credential?.reference);
  assert.equal(rotated.credentialHistory.at(-1)?.reference, before.credential?.reference);
  assert.equal(rotated.credential?.rotatedBy, OWNER_USER);
  const audited = desk.audit.events.find((event) => event.action === 'gsp.credential.rotated');
  assert.equal(audited?.overrideReason, 'Six-monthly rotation.');
  assert.equal(audited?.details.previousVaultRef, before.credential?.reference);
  assert.equal(audited?.details.vaultRef, rotated.credential?.reference);
});

test('a provider that wants the business to authorise again pauses instead of pretending', async () => {
  const desk = makeDesk();
  const owner = ownerOf();
  await connect(desk, KARNATAKA_GSTIN);
  await desk.provider.revoke({ gstin: KARNATAKA_GSTIN, reason: 'the provider ended the session' });
  const outcome = await desk.service.rotateCredential(owner, KARNATAKA_GSTIN, 'Routine rotation.');
  assert.equal(outcome.status, 'SUSPENDED');
  assert.equal(outcome.credential, null);
  const blocked = await desk.channel.call(owner, {
    operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-1'), idempotencyKey: 'reauth-1',
  });
  assert.equal(blocked.kind, 'REFUSED');
  await assert.rejects(
    desk.service.resume(owner, KARNATAKA_GSTIN),
    (error: unknown) => error instanceof DomainError && error.code === 'GSP_REAUTHORISATION_REQUIRED',
  );
});

// ------------------------------------------------------------------- limits and outages

test('our own rate limit refuses politely and says when to try again', async () => {
  const desk = makeDesk({
    profile: { ...SANDBOX_PROFILE, limits: [{ operation: '*', maxCalls: 2, windowSeconds: 60 }] },
  });
  const owner = ownerOf();
  await connect(desk, KARNATAKA_GSTIN);
  for (const number of ['SI-1', 'SI-2']) {
    const outcome = await desk.channel.call(owner, {
      operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, number), idempotencyKey: number,
    });
    assert.equal(outcome.kind, 'ANSWERED');
  }
  const limited = await desk.channel.call(owner, {
    operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-3'), idempotencyKey: 'SI-3',
  });
  assert.equal(limited.kind === 'REFUSED' ? limited.refusal.reason : '', 'RATE_LIMITED');
  assert.equal(limited.kind === 'REFUSED' ? limited.refusal.retryable : false, true);
  assert.ok(limited.kind === 'REFUSED' && limited.refusal.retryAfter !== undefined);
});

test('an outage is recorded as unknown, never as a failure', async () => {
  const desk = makeDesk();
  const owner = ownerOf();
  await connect(desk, KARNATAKA_GSTIN);
  desk.irp.setMode('timeout');
  const outcome = await desk.channel.call(owner, {
    operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-77'), idempotencyKey: 'unknown-1', documentRef: 'SI-77',
  });
  assert.equal(outcome.kind, 'UNKNOWN');
  assert.equal(outcome.kind === 'UNKNOWN' ? outcome.retryable : false, true);
  const call = await desk.calls.find(SUNRISE_COMPANY, outcome.callId);
  assert.equal(call?.outcome, 'UNKNOWN');
  assert.equal(call?.settledAt, null, 'an unanswered call is not settled by the clock running out');
  assert.ok(desk.audit.events.some((event) => event.action === 'gsp.call.unknown'));
});

test('every call is recorded, including the ones we refused to make', async () => {
  const desk = makeDesk();
  const owner = ownerOf();
  const refused = await desk.channel.call(owner, {
    operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-1'), idempotencyKey: 'never-sent',
  });
  assert.equal(refused.kind, 'REFUSED');
  const calls = await desk.calls.list(SUNRISE_COMPANY);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.outcome, 'REFUSED');
  assert.equal(calls[0]?.attempts, 0, 'nothing was sent');
  assert.ok(desk.audit.events.some((event) => event.action === 'gsp.call.refused'));
});

// ------------------------------------------------------------------- reconciliation

test('a call we never got an answer for is settled by the government’s own record', async () => {
  const desk = makeDesk();
  const owner = ownerOf();
  await connect(desk, KARNATAKA_GSTIN);
  desk.irp.setMode('timeout');
  const outcome = await desk.channel.call(owner, {
    operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-77'), idempotencyKey: 'rec-1', documentRef: 'SI-77',
  });
  assert.equal(outcome.kind, 'UNKNOWN');

  // It did reach the portal after all: the government holds an IRN for it.
  desk.provider.government('SI-77', 'irn-for-si-77');
  setClock(desk, '2026-08-17T05:30:00.000Z');
  const reconciler = new GovernmentCallReconciler({ calls: desk.calls, provider: desk.provider, audit: desk.audit, clock: desk.clock });
  const report = await reconciler.run(owner);
  assert.equal(report.checked, 1);
  assert.equal(report.corrected, 1);

  const call = await desk.calls.find(SUNRISE_COMPANY, outcome.callId);
  assert.equal(call?.outcome, 'ACCEPTED');
  assert.equal(call?.governmentReference, 'irn-for-si-77');
  assert.ok(call?.reconciledAt !== null);
  assert.ok(desk.audit.events.some((event) => event.action === 'gsp.call.reconciled'));

  // Running it again checks nothing: settled calls are not chased.
  const again = await reconciler.run(owner);
  assert.equal(again.checked, 0);
});

test('a call that never reached the government is recorded as such, so it can be sent again', async () => {
  const desk = makeDesk();
  const owner = ownerOf();
  await connect(desk, KARNATAKA_GSTIN);
  desk.irp.setMode('outage');
  const outcome = await desk.channel.call(owner, {
    operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-78'), idempotencyKey: 'rec-2', documentRef: 'SI-78',
  });
  setClock(desk, '2026-08-17T05:30:00.000Z');
  const report = await new GovernmentCallReconciler({ calls: desk.calls, provider: desk.provider, audit: desk.audit, clock: desk.clock }).run(owner);
  assert.equal(report.notFound, 1);
  const call = await desk.calls.find(SUNRISE_COMPANY, outcome.callId);
  assert.equal(call?.outcome, 'REJECTED');
  assert.equal(call?.errorCode, 'NOT_RECEIVED');
});

test('when our record and the government’s disagree, a person is asked and nothing is overwritten', async () => {
  const desk = makeDesk();
  const owner = ownerOf();
  await connect(desk, KARNATAKA_GSTIN);
  const answered = await desk.channel.call(owner, {
    operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-79'), idempotencyKey: 'rec-3', documentRef: 'SI-79',
  });
  assert.equal(answered.kind, 'ANSWERED');
  const ours = (await desk.calls.find(SUNRISE_COMPANY, answered.callId))?.governmentReference;
  assert.ok(ours !== null && ours !== undefined);

  // Force the call back into the unsettled state the reconciler reads, then make the government
  // hold a different reference than the one we recorded.
  const call = await desk.calls.find(SUNRISE_COMPANY, answered.callId);
  await desk.calls.settle({ ...call!, outcome: 'UNKNOWN', settledAt: null });
  desk.provider.government('SI-79', 'a-different-irn');
  setClock(desk, '2026-08-17T05:30:00.000Z');

  const sink = new RecordingExceptionSink();
  const report = await new GovernmentCallReconciler({ calls: desk.calls, provider: desk.provider, audit: desk.audit, clock: desk.clock, exceptions: sink }).run(owner);
  assert.equal(report.conflicts.length, 1);
  assert.equal(sink.raised.length, 1);
  assert.equal(sink.raised[0]?.ours, ours);
  assert.equal(sink.raised[0]?.theirs, 'a-different-irn');
  const after = await desk.calls.find(SUNRISE_COMPANY, answered.callId);
  assert.equal(after?.governmentReference, ours, 'neither side is written over');
  assert.match(report.conflicts[0]?.question['en-IN'] ?? '', /Somebody needs to look at both/);
});

test('a provider that cannot answer leaves an unknown call exactly as it was', async () => {
  const desk = makeDesk();
  const owner = ownerOf();
  await connect(desk, KARNATAKA_GSTIN);
  desk.irp.setMode('timeout');
  await desk.channel.call(owner, {
    operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-80'), idempotencyKey: 'rec-4', documentRef: 'SI-80',
  });
  setClock(desk, '2026-08-17T05:30:00.000Z');
  desk.provider.setMode('unavailable');
  const report = await new GovernmentCallReconciler({ calls: desk.calls, provider: desk.provider, audit: desk.audit, clock: desk.clock }).run(owner);
  assert.equal(report.stillUnknown, 1);
  assert.equal(report.corrected, 0);
  assert.equal(report.notFound, 0);
});

// ------------------------------------------------------------------- the ports other modules use

test('the e-invoice module talks to the live provider through the guard without knowing it', async () => {
  const desk = makeDesk();
  const owner = ownerOf();
  const authorisedGateway = new AuthorisedGateway(
    [desk.irp], new SyntheticIrpVault(), new StaticWebhookVerifier(), desk.channel, () => owner,
  );
  const port = irpAdapter({ gateway: authorisedGateway, clock: () => desk.clock.now() });
  const document = { supplierGstin: KARNATAKA_GSTIN, documentNumber: 'SI-1042' } as never;

  const before = await port.generate(SUNRISE_COMPANY, document, invoicePayload(KARNATAKA_GSTIN, 'SI-1042'), 'gate-1');
  assert.equal(before.kind, 'UNAVAILABLE');
  assert.equal(before.kind === 'UNAVAILABLE' ? before.code : '', 'UNAUTHORIZED', 'an unauthorised GST number cannot register anything');

  await connect(desk, KARNATAKA_GSTIN);
  const after = await port.generate(SUNRISE_COMPANY, document, invoicePayload(KARNATAKA_GSTIN, 'SI-1042'), 'gate-2');
  assert.equal(after.kind, 'REGISTERED');
  const calls = await desk.calls.list(SUNRISE_COMPANY, KARNATAKA_GSTIN);
  const accepted = calls.find((call) => call.outcome === 'ACCEPTED');
  assert.ok(accepted !== undefined);
  assert.equal(accepted.governmentReference, after.kind === 'REGISTERED' ? after.acknowledgement.irn : '');
});

test('filing a return through the channel never turns "we do not know" into "rejected"', async () => {
  const desk = makeDesk();
  const owner = ownerOf();
  const port = authorisedReturnPort(desk.channel, () => owner, desk.provider);

  const unauthorised = await port.submit({
    companyId: SUNRISE_COMPANY, gstin: KARNATAKA_GSTIN, period: '2026-07' as never, returnType: 'GSTR3B',
    payload: {}, idempotencyKey: 'ret-1',
  });
  assert.equal(unauthorised.kind, 'UNKNOWN', 'a refusal is not the portal rejecting the return');

  await connect(desk, KARNATAKA_GSTIN, [...EVERYDAY_SCOPES, 'RETURN_SUBMIT']);
  const accepted = await port.submit({
    companyId: SUNRISE_COMPANY, gstin: KARNATAKA_GSTIN, period: '2026-07' as never, returnType: 'GSTR3B',
    payload: { table1: [] }, idempotencyKey: 'ret-2',
  });
  assert.equal(accepted.kind, 'ACCEPTED');
  const call = (await desk.calls.list(SUNRISE_COMPANY, KARNATAKA_GSTIN)).find((row) => row.operation === 'return.submit' && row.outcome === 'ACCEPTED');
  assert.equal(call?.documentRef, 'GSTR3B:2026-07', 'the filing is recorded against the month it is for');
});

test('downloading GSTR-2B keeps "not published yet" separate from "we could not reach it"', async () => {
  const desk = makeDesk();
  const owner = ownerOf();
  await connect(desk, KARNATAKA_GSTIN, ['GSTR2B_FETCH']);
  const source = authorisedPortalRecordSource(desk.channel, () => owner, desk.provider);
  const outcome = await source.fetchGstr2b(SUNRISE_COMPANY, KARNATAKA_GSTIN, '2026-07' as never);
  // The mock connector answers with `{ accepted: true }`, which carries no file: unreadable, and
  // reported as such rather than as an empty month.
  assert.equal(outcome.kind, 'UNAVAILABLE');
  assert.equal(outcome.kind === 'UNAVAILABLE' ? outcome.retryable : true, false);
});

// ------------------------------------------------------------------- access

test('one company can never see or change another company’s connections', async () => {
  const desk = makeDesk();
  await connect(desk, KARNATAKA_GSTIN);
  const intruder = actorWith(OTHER_COMPANY, Object.values(GSP_PERMISSIONS));
  assert.deepEqual(await desk.service.connections(intruder), []);
  await assert.rejects(
    desk.service.connection(intruder, KARNATAKA_GSTIN),
    (error: unknown) => error instanceof DomainError && error.kind === 'NOT_FOUND',
  );
  await assert.rejects(
    desk.service.revoke(intruder, KARNATAKA_GSTIN, 'Not mine to revoke.'),
    (error: unknown) => error instanceof DomainError && error.kind === 'NOT_FOUND',
  );
});

test('watching the connection screen is not permission to connect, revoke or rotate', async () => {
  const desk = makeDesk();
  await connect(desk, KARNATAKA_GSTIN);
  const clerk = actorWith(SUNRISE_COMPANY, VIEW_ONLY, CLERK_USER);
  assert.equal((await desk.service.connections(clerk)).length, 1);
  for (const attempt of [
    desk.service.beginOnboarding(clerk, { gstin: MAHARASHTRA_GSTIN, legalName: SUNRISE_NAME, signatoryHint: 'the owner', scopes: EVERYDAY_SCOPES }),
    desk.service.revoke(clerk, KARNATAKA_GSTIN, 'Because I can.'),
    desk.service.rotateCredential(clerk, KARNATAKA_GSTIN, 'Because I can.'),
  ]) {
    await assert.rejects(attempt, (error: unknown) => error instanceof DomainError && error.kind === 'FORBIDDEN');
  }
  await assert.rejects(
    new GovernmentCallReconciler({ calls: desk.calls, provider: desk.provider, audit: desk.audit, clock: desk.clock }).run(clerk),
    (error: unknown) => error instanceof DomainError && error.kind === 'FORBIDDEN',
  );
});

test('connecting a GST number twice is refused rather than quietly replacing the consent', async () => {
  const desk = makeDesk();
  const owner = ownerOf();
  await connect(desk, KARNATAKA_GSTIN);
  await assert.rejects(
    desk.service.beginOnboarding(owner, { gstin: KARNATAKA_GSTIN, legalName: SUNRISE_NAME, signatoryHint: 'the owner', scopes: ['RETURN_SUBMIT'] }),
    (error: unknown) => error instanceof DomainError && error.code === 'GSP_ALREADY_CONNECTED',
  );
});

test('a GST number that is mistyped is refused in words a shopkeeper can act on', async () => {
  const desk = makeDesk();
  await assert.rejects(
    desk.service.beginOnboarding(ownerOf(), { gstin: '29AAECS1234', legalName: SUNRISE_NAME, signatoryHint: 'the owner', scopes: EVERYDAY_SCOPES }),
    (error: unknown) => error instanceof DomainError && /digit is probably mistyped/.test(error.message),
  );
});
