/**
 * Issue #366 — one contract suite for this module's stores, run against the in-memory classes
 * (gsp-store-contract.test.ts) and against PostgreSQL (gsp-store-contract.integration.test.ts).
 *
 * Everything is synthetic: random company ids, `syntheticGstin` registrations, vault references
 * that resolve to nothing, and the sandbox provider's own one-time password.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { CompanyId, UserId } from '@invoice/kernel';
import { InMemoryAuditPort } from '@invoice/ledger';
import { ConnectorGateway, MockConnector, StaticWebhookVerifier } from '../../platform/src/connectors.ts';
import { SyntheticIrp, SyntheticIrpVault } from '../../gst/src/einvoice-adapters.ts';
import { SandboxGspProvider } from '../src/adapters.ts';
import { GovernmentChannel } from '../src/channel.ts';
import { EVERYDAY_SCOPES, KARNATAKA_GSTIN, MAHARASHTRA_GSTIN, SUNRISE_NAME, actorWith, invoicePayload } from '../src/fixtures.ts';
import type { AuthorisationRepository, CallLogRepository, Page } from '../src/ports.ts';
import { GovernmentCallReconciler } from '../src/reconcile.ts';
import { GovernmentAccessService } from '../src/service.ts';
import { GSP_PERMISSIONS, type ProviderCall } from '../src/types.ts';

export interface GspHarness {
  authorisations: AuthorisationRepository;
  calls: CallLogRepository;
  /** A company and a person in it, wherever the implementation keeps them. */
  company(): Promise<{ companyId: CompanyId; userId: UserId }>;
  /** One business action: everything `work` writes is kept together, or nothing is when it throws. */
  write<T>(companyId: CompanyId, work: () => Promise<T>): Promise<T>;
}

const AT = Date.parse('2026-08-17T04:30:00.000Z');

/** The service, the channel and the reconciler on the harness's stores, each call one action. */
export const desk = async (h: GspHarness) => {
  const { companyId, userId } = await h.company();
  let instant = AT;
  const clock = { now: () => new Date(instant) };
  const provider = new SandboxGspProvider({ now: clock.now });
  const audit = new InMemoryAuditPort();
  const irp = new SyntheticIrp(clock.now);
  const gateway = new ConnectorGateway([irp, new MockConnector('gst'), new MockConnector('eway_bill')], new SyntheticIrpVault(), new StaticWebhookVerifier());
  const service = new GovernmentAccessService({ authorisations: h.authorisations, calls: h.calls, provider, audit, clock });
  const channel = new GovernmentChannel({ gateway, authorisations: h.authorisations, calls: h.calls, audit, clock, provider });
  const reconciler = new GovernmentCallReconciler({ calls: h.calls, provider, audit, clock });
  const owner = actorWith(companyId, Object.values(GSP_PERMISSIONS), userId);
  const act = <T>(work: () => Promise<T>) => h.write(companyId, work);
  const connect = async (gstin: string) => {
    await act(() => service.beginOnboarding(owner, { gstin, legalName: SUNRISE_NAME, signatoryHint: 'the owner', scopes: EVERYDAY_SCOPES }));
    await act(() => service.requestOtp(owner, gstin));
    return act(() => service.verifyOtp(owner, gstin, '123456'));
  };
  return { companyId, userId, owner, service, channel, reconciler, provider, irp, act, connect, tick: (seconds: number) => { instant += seconds * 1000; } };
};

const call = (companyId: CompanyId, actorId: UserId, over: Partial<ProviderCall> = {}): ProviderCall => {
  const id = crypto.randomUUID();
  return {
    id, companyId, gstin: KARNATAKA_GSTIN, operation: 'einvoice.generate', scope: 'EINVOICE_GENERATE', idempotencyKey: `key-${id}`,
    correlationId: `gsp-${id}`, documentRef: 'SI-1', outcome: 'UNKNOWN', providerRequestId: null, governmentReference: null,
    errorCode: null, errorMessage: null, refusal: null, attempts: 1, credentialReference: 'vault://gsp/synthetic/1',
    startedAt: '2026-08-17T04:30:00.000Z', settledAt: null, actorId, reconciledAt: null, ...over,
  };
};

/** Walks a list page by page and returns every row it was given. */
const walk = async (fetch: (page: Page) => Promise<readonly ProviderCall[]>, limit = 2): Promise<string[]> => {
  const seen: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await fetch(after === undefined ? { limit } : { limit, after });
    assert.ok(page.length <= limit);
    if (page.length === 0) return seen;
    seen.push(...page.map((row) => row.id));
    after = page[page.length - 1]?.id;
  }
};

export const gspStoreContract = (name: string, make: () => GspHarness, skip: string | false = false): void => {
  test(`${name}: connecting a GST number keeps the consent, the credential and the challenge exactly`, { skip }, async () => {
    const h = make();
    const d = await desk(h);
    const begun = await d.act(() => d.service.beginOnboarding(d.owner, { gstin: KARNATAKA_GSTIN, legalName: SUNRISE_NAME, signatoryHint: 'the owner', scopes: EVERYDAY_SCOPES }));
    assert.equal(begun.kind, 'API_USER_READY');
    assert.deepEqual(await h.authorisations.find(d.companyId, KARNATAKA_GSTIN), begun.kind === 'API_USER_READY' ? begun.authorisation : null);

    const sent = await d.act(() => d.service.requestOtp(d.owner, KARNATAKA_GSTIN));
    assert.equal(sent.kind, 'OTP_SENT');
    assert.deepEqual(await h.authorisations.find(d.companyId, KARNATAKA_GSTIN), sent.kind === 'OTP_SENT' ? sent.authorisation : null);

    const wrong = await d.act(() => d.service.verifyOtp(d.owner, KARNATAKA_GSTIN, '000000'));
    assert.equal(wrong.kind, 'WRONG_OTP');
    assert.equal((await h.authorisations.find(d.companyId, KARNATAKA_GSTIN))?.otp?.attemptsRemaining, 2);

    const done = await d.act(() => d.service.verifyOtp(d.owner, KARNATAKA_GSTIN, '123456'));
    assert.equal(done.kind, 'AUTHORISED');
    const stored = await h.authorisations.find(d.companyId, KARNATAKA_GSTIN);
    assert.deepEqual(stored, done.kind === 'AUTHORISED' ? done.authorisation : null);
    assert.equal(stored?.otp, null, 'the challenge is closed once used');
    assert.match(stored?.credential?.reference ?? '', /^vault:\/\//, 'a vault reference, never a secret');
  });

  test(`${name}: rotating, pausing, starting again and taking it back keep every credential and the withdrawn consent`, { skip }, async () => {
    const h = make();
    const d = await desk(h);
    const first = await d.connect(KARNATAKA_GSTIN);
    const firstReference = first.kind === 'AUTHORISED' ? first.authorisation.credential?.reference : undefined;
    d.tick(60);
    const rotated = await d.act(() => d.service.rotateCredential(d.owner, KARNATAKA_GSTIN, 'yearly rotation'));
    assert.deepEqual(await h.authorisations.find(d.companyId, KARNATAKA_GSTIN), rotated);
    d.tick(60);
    const paused = await d.act(() => d.service.suspend(d.owner, KARNATAKA_GSTIN, 'audit this week'));
    assert.deepEqual(await h.authorisations.find(d.companyId, KARNATAKA_GSTIN), paused);
    // Starting again from a pause keeps the paused credential in the history.
    const again = await d.connect(KARNATAKA_GSTIN);
    assert.equal(again.kind, 'AUTHORISED');
    const reconnected = await h.authorisations.find(d.companyId, KARNATAKA_GSTIN);
    assert.deepEqual(reconnected, again.kind === 'AUTHORISED' ? again.authorisation : null);
    assert.deepEqual(reconnected?.credentialHistory.map((handle) => handle.reference), [firstReference, rotated.credential?.reference]);
    assert.equal(reconnected?.credentialHistory[1]?.rotationReason, 'yearly rotation');
    // Taken back in the same instant: the newest consent is still the one just withdrawn.
    const revoked = await d.act(() => d.service.revoke(d.owner, KARNATAKA_GSTIN, 'business closed'));
    const stored = await h.authorisations.find(d.companyId, KARNATAKA_GSTIN);
    assert.deepEqual(stored, revoked);
    assert.equal(stored?.credential, null);
    assert.equal(stored?.credentialHistory.length, 3);
    assert.equal(stored?.consent?.withdrawalReason, 'business closed');
    assert.equal(stored?.consent?.id, reconnected?.consent?.id);
  });

  test(`${name}: each GST number stands alone, and another company sees none of them`, { skip }, async () => {
    const h = make();
    const d = await desk(h);
    await d.connect(KARNATAKA_GSTIN);
    await d.act(() => d.service.beginOnboarding(d.owner, { gstin: MAHARASHTRA_GSTIN, legalName: SUNRISE_NAME, signatoryHint: 'the owner', scopes: ['GSTR2B_FETCH'] }));
    const rows = await h.authorisations.list(d.companyId);
    assert.deepEqual(rows.map((row) => [row.gstin, row.status]).sort(), [[MAHARASHTRA_GSTIN, 'API_USER_PENDING'], [KARNATAKA_GSTIN, 'ACTIVE']].sort());
    const other = await h.company();
    assert.equal(await h.authorisations.find(other.companyId, KARNATAKA_GSTIN), null);
    assert.deepEqual(await h.authorisations.list(other.companyId), []);
  });

  test(`${name}: every call is kept, a retry under the same reference is a row of its own, and the first answers`, { skip }, async () => {
    const h = make();
    const d = await desk(h);
    // Refused before anything is connected, then made under the same reference once it is.
    const refused = await d.act(() => d.channel.call(d.owner, { operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-1'), idempotencyKey: 'SI-1', documentRef: 'SI-1' }));
    assert.equal(refused.kind, 'REFUSED');
    await d.connect(KARNATAKA_GSTIN);
    d.tick(1);
    const answered = await d.act(() => d.channel.call(d.owner, { operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-1'), idempotencyKey: 'SI-1', documentRef: 'SI-1' }));
    assert.equal(answered.kind, 'ANSWERED');
    assert.equal((await h.calls.findByIdempotencyKey(d.companyId, 'SI-1'))?.id, refused.callId);
    const accepted = await h.calls.find(d.companyId, answered.callId);
    assert.equal(accepted?.outcome, 'ACCEPTED');
    assert.ok(accepted?.governmentReference !== null);
    assert.deepEqual((await h.calls.list(d.companyId)).map((row) => row.id), [refused.callId, answered.callId]);
    const other = await h.company();
    assert.equal(await h.calls.find(other.companyId, answered.callId), null);
    assert.deepEqual(await h.calls.list(other.companyId), []);
  });

  test(`${name}: an unanswered call is settled by reconciliation, once`, { skip }, async () => {
    const h = make();
    const d = await desk(h);
    await d.connect(KARNATAKA_GSTIN);
    d.irp.setMode('timeout');
    const unknown = await d.act(() => d.channel.call(d.owner, { operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-77'), idempotencyKey: 'SI-77', documentRef: 'SI-77' }));
    assert.equal(unknown.kind, 'UNKNOWN');
    d.irp.setMode('outage');
    const lost = await d.act(() => d.channel.call(d.owner, { operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-78'), idempotencyKey: 'SI-78', documentRef: 'SI-78' }));
    d.provider.government('SI-77', 'irn-for-si-77');
    d.tick(3600);
    const report = await d.act(() => d.reconciler.run(d.owner));
    assert.equal(report.checked, 2);
    assert.equal(report.corrected, 1);
    assert.equal(report.notFound, 1);
    const settled = await h.calls.find(d.companyId, unknown.callId);
    assert.equal(settled?.outcome, 'ACCEPTED');
    assert.equal(settled?.governmentReference, 'irn-for-si-77');
    assert.equal((await h.calls.find(d.companyId, lost.callId))?.errorCode, 'NOT_RECEIVED');
    assert.equal((await d.act(() => d.reconciler.run(d.owner))).checked, 0);
  });

  test(`${name}: the call lists come in start order, by GST number, and page without losing or repeating a row`, { skip }, async () => {
    const h = make();
    const { companyId, userId } = await h.company();
    const rows = [
      call(companyId, userId, { startedAt: '2026-08-17T04:30:02.000Z' }),
      call(companyId, userId, { startedAt: '2026-08-17T04:30:00.000Z', gstin: MAHARASHTRA_GSTIN }),
      call(companyId, userId, { startedAt: '2026-08-17T04:30:01.000Z', outcome: 'REFUSED', settledAt: '2026-08-17T04:30:01.000Z', attempts: 0 }),
      // Two that started in the same instant come in the order they were written.
      call(companyId, userId, { startedAt: '2026-08-17T04:30:03.000Z' }),
      call(companyId, userId, { startedAt: '2026-08-17T04:30:03.000Z' }),
    ];
    await h.write(companyId, async () => { for (const row of rows) await h.calls.insert(row); });
    const [late, maharashtra, refused, tieA, tieB] = rows.map((row) => row.id);
    assert.deepEqual((await h.calls.list(companyId)).map((row) => row.id), [maharashtra, refused, late, tieA, tieB]);
    assert.deepEqual(await walk((page) => h.calls.list(companyId, undefined, page)), [maharashtra, refused, late, tieA, tieB]);
    assert.deepEqual(await walk((page) => h.calls.list(companyId, KARNATAKA_GSTIN, page)), [refused, late, tieA, tieB]);
    assert.deepEqual(await walk((page) => h.calls.listUnsettled(companyId, '2026-08-17T04:30:02.000Z', page), 1), [maharashtra, late]);
    assert.deepEqual(await h.calls.list(companyId, undefined, { after: crypto.randomUUID() }), [], 'an unknown cursor ends the list');
    assert.deepEqual(await h.calls.find(companyId, late as string), rows[0]);
  });
};
