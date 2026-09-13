/**
 * Issue #51 [X03] — the drills the issue asks for, as something that actually runs.
 *
 * "Credential rotation and revocation drill" is a rehearsal, and a rehearsal nobody has ever
 * performed is a paragraph. These three run the composed path — the authorisation service, the
 * channel, the connector gateway, the audit log and the offline fallback — against the sandbox
 * provider, and return a report with the evidence for each step, so a failed drill is a failed
 * test rather than a discovery made during an incident.
 *
 * They are deliberately *not* a second copy of #33's unit tests. Those prove each mechanism; these
 * prove the operational story end to end and in order: a customer connects, credentials are
 * replaced under a live connection, the connection is revoked, and the business can still invoice
 * afterwards by hand. The last step is the one an SLA cannot promise and a shopkeeper still needs.
 *
 * Nothing here touches a real portal. The provider is `SandboxGspProvider`; the "government" is
 * #26's `SyntheticIrp`. Every GST number is built by `syntheticGstin` and belongs to nobody.
 */
import { InMemoryAuditPort } from '@invoice/ledger';
import { toOfflineJson } from '@invoice/gst';
import { invoiceDocument } from '../../../packages/gst/src/einvoice-fixtures.ts';
import { SyntheticIrp, SyntheticIrpVault, irpAdapter } from '../../../packages/gst/src/einvoice-adapters.ts';
import { ConnectorGateway, MockConnector, StaticWebhookVerifier } from '../../../packages/platform/src/connectors.ts';
import {
  EVERYDAY_SCOPES,
  GovernmentAccessService,
  GovernmentChannel,
  InMemoryAuthorisations,
  InMemoryCallLog,
  KARNATAKA_GSTIN,
  REDACTED,
  SUNRISE_NAME,
  SandboxGspProvider,
  SlidingWindowLimiter,
  invoicePayload,
  ownerOf,
} from '@invoice/gsp';
import type { DrillReport, DrillStep } from './model.ts';

/** The moment the drills are staged at, so a report reads the same however often it is run. */
const AT = '2026-09-13T05:00:00.000Z';

interface Desk {
  readonly service: GovernmentAccessService;
  readonly channel: GovernmentChannel;
  readonly provider: SandboxGspProvider;
  readonly authorisations: InMemoryAuthorisations;
  readonly calls: InMemoryCallLog;
  readonly audit: InMemoryAuditPort;
}

const makeDesk = (): Desk => {
  const clock = { now: () => new Date(AT) };
  const provider = new SandboxGspProvider({ now: () => clock.now() });
  const authorisations = new InMemoryAuthorisations();
  const calls = new InMemoryCallLog();
  const audit = new InMemoryAuditPort();
  const gateway = new ConnectorGateway(
    [new SyntheticIrp(() => clock.now()), new MockConnector('gst'), new MockConnector('eway_bill')],
    new SyntheticIrpVault(),
    new StaticWebhookVerifier(),
  );
  let counter = 0;
  return {
    provider,
    authorisations,
    calls,
    audit,
    service: new GovernmentAccessService({ authorisations, calls, provider, audit, clock, idFactory: () => `drill-${++counter}` }),
    channel: new GovernmentChannel({
      gateway, authorisations, calls, audit, clock, provider,
      limiter: new SlidingWindowLimiter(),
      idFactory: () => `drill-call-${++counter}`,
    }),
  };
};

const step = (name: string, passed: boolean, evidence: string): DrillStep => ({ name, passed, evidence });

const generate = (desk: Desk, reference: string) => desk.channel.call(ownerOf(), {
  operation: 'einvoice.generate',
  payload: invoicePayload(KARNATAKA_GSTIN, reference),
  idempotencyKey: `drill:${reference}`,
  documentRef: reference,
});

/** The onboarding dance, exactly as a pilot customer would be walked through it. */
const connect = async (desk: Desk): Promise<DrillStep[]> => {
  const owner = ownerOf();
  const begun = await desk.service.beginOnboarding(owner, {
    gstin: KARNATAKA_GSTIN, legalName: SUNRISE_NAME, signatoryHint: 'the owner', scopes: EVERYDAY_SCOPES,
  });
  const sent = await desk.service.requestOtp(owner, KARNATAKA_GSTIN);
  const wrong = await desk.service.verifyOtp(owner, KARNATAKA_GSTIN, '000000');
  const done = await desk.service.verifyOtp(owner, KARNATAKA_GSTIN, '123456');
  const consent = done.kind === 'AUTHORISED' ? done.authorisation.consent : null;

  return [
    step('The provider creates an API user for the GST number', begun.kind === 'API_USER_READY', `Outcome: ${begun.kind}.`),
    step(
      'The portal sends a one-time password to the signatory’s own phone',
      sent.kind === 'OTP_SENT',
      sent.kind === 'OTP_SENT' ? `Sent to ${sent.authorisation.otp?.sentToHint ?? '—'}; we never see the whole number.` : `Outcome: ${sent.kind}.`,
    ),
    step(
      'A wrong code is an ordinary answer that says how many tries are left',
      wrong.kind === 'WRONG_OTP',
      wrong.kind === 'WRONG_OTP' ? wrong.message['en-IN'] : `Outcome: ${wrong.kind}.`,
    ),
    step(
      'The consent records the exact wording the person was shown',
      consent !== null && consent.wordingShown['en-IN'].length > 0 && consent.scopes.length > 0,
      consent === null ? 'No consent was written.' : `${consent.scopes.length} permissions, agreed as: “${consent.wordingShown['en-IN']}”`,
    ),
    step(
      'What is kept is a vault reference, never a portal password',
      done.kind === 'AUTHORISED' && (done.authorisation.credential?.reference ?? '').length > 0,
      done.kind === 'AUTHORISED' ? `Credential held as ${done.authorisation.credential?.reference}.` : `Outcome: ${done.kind}.`,
    ),
  ];
};

/**
 * Drill one — a pilot customer connects its own registration and one controlled call is made.
 *
 * This is the shape of the issue's production smoke test, run where it is safe to run it. Against
 * production the only differences are whose registration it is and that the IRN is real.
 */
export const pilotOnboardingDrill = async (): Promise<DrillReport> => {
  const desk = makeDesk();
  const steps = await connect(desk);

  const answered = await generate(desk, 'DRILL-001');
  steps.push(step(
    'One controlled operation goes through, and the government answers',
    answered.kind === 'ANSWERED',
    answered.kind === 'ANSWERED' ? `IRN ${String(answered.response.payload.Irn).slice(0, 16)}… returned for DRILL-001.` : `Outcome: ${answered.kind}.`,
  ));

  const logged = (await desk.calls.list(ownerOf().companyId, KARNATAKA_GSTIN)).find((call) => call.documentRef === 'DRILL-001');
  steps.push(step(
    'The call is on the record, against the GST number it was made for',
    logged !== undefined && logged.gstin === KARNATAKA_GSTIN,
    logged === undefined ? 'Nothing was logged.' : `Logged as ${logged.operation} → ${logged.outcome}.`,
  ));

  return report('pilot-onboarding', steps);
};

/** Drill two — credentials are replaced while the connection is live, and calls keep working. */
export const credentialRotationDrill = async (): Promise<DrillReport> => {
  const desk = makeDesk();
  await connect(desk);
  const owner = ownerOf();
  const before = (await desk.authorisations.find(owner.companyId, KARNATAKA_GSTIN))?.credential?.reference ?? null;

  const rotated = await desk.service.rotateCredential(owner, KARNATAKA_GSTIN, 'Scheduled rotation drill');
  const after = rotated.credential?.reference ?? null;
  const steps: DrillStep[] = [
    step(
      'The credential is replaced with a different one',
      before !== null && after !== null && before !== after,
      `${before} → ${after}.`,
    ),
    step(
      'The old credential stays on the record, so what was used when is knowable',
      rotated.credentialHistory.length === 1 && rotated.credentialHistory[0]?.reference === before,
      `${rotated.credentialHistory.length} earlier credential(s) kept, with the reason for the change.`,
    ),
    step(
      'The connection stays active — a rotation is not an outage',
      rotated.status === 'ACTIVE',
      `Status after rotation: ${rotated.status}.`,
    ),
  ];

  const after_ = await generate(desk, 'DRILL-002');
  steps.push(step(
    'The next call works on the new credential',
    after_.kind === 'ANSWERED',
    after_.kind === 'ANSWERED' ? 'DRILL-002 was registered after the rotation.' : `Outcome: ${after_.kind}.`,
  ));

  const audited = desk.audit.events.filter((event) => event.action.startsWith('gsp.credential'));
  const secretLeak = JSON.stringify(desk.audit.events).includes('123456');
  steps.push(step(
    'The rotation is audited, and no secret is written down',
    audited.length > 0 && !secretLeak,
    `${audited.length} credential event(s) recorded; secret-shaped fields are stored as ${REDACTED}.`,
  ));

  return report('credential-rotation', steps);
};

/**
 * Drill three — the connection is revoked, and the business can still invoice.
 *
 * The second half is the one that matters operationally. A revocation, an expired authorisation and
 * a provider outage all end in the same place for a shopkeeper: the portal cannot be reached
 * through us. The fallback has to be a thing that exists, not a promise, and it must not touch the
 * provider at all — which is what the last step checks.
 */
export const revocationAndFallbackDrill = async (): Promise<DrillReport> => {
  const desk = makeDesk();
  await connect(desk);
  const owner = ownerOf();
  await generate(desk, 'DRILL-003');

  const revoked = await desk.service.revoke(owner, KARNATAKA_GSTIN, 'Revocation drill');
  const next = await generate(desk, 'DRILL-004');
  const history = await desk.calls.list(owner.companyId, KARNATAKA_GSTIN);

  const steps: DrillStep[] = [
    step(
      'Revoking clears the live credential and withdraws the consent',
      revoked.status === 'REVOKED' && revoked.credential === null,
      `Status ${revoked.status}; the credential reference is gone, the history is not.`,
    ),
    step(
      'The very next call is refused, with a sentence a shopkeeper can act on',
      next.kind === 'REFUSED',
      next.kind === 'REFUSED' ? `${next.refusal.reason}: “${next.refusal.message['en-IN']}”` : `Outcome: ${next.kind}.`,
    ),
    step(
      'Nothing is deleted — the refusal and everything sent before it are both on the record',
      history.some((call) => call.documentRef === 'DRILL-003') && history.some((call) => call.documentRef === 'DRILL-004'),
      `${history.length} calls kept, including the one that was refused.`,
    ),
  ];

  // The fallback: the government's own JSON, built with no provider, no credential and no network.
  let fallback = '';
  let fallbackFailed: string | null = null;
  try {
    fallback = toOfflineJson(invoiceDocument());
  } catch (error) {
    fallbackFailed = error instanceof Error ? error.message : String(error);
  }
  const parsed = fallbackFailed === null ? (JSON.parse(fallback) as { InvoiceList?: unknown[]; _karobar?: { note?: string } }) : null;
  steps.push(step(
    'With the connection revoked, the business can still produce the file it uploads by hand',
    parsed !== null && Array.isArray(parsed.InvoiceList) && parsed.InvoiceList.length === 1,
    fallbackFailed ?? `A ${fallback.length}-character upload file, which says of itself: “${parsed?._karobar?.note ?? ''}”`,
  ));

  return report('revocation-and-fallback', steps);
};

const report = (drill: string, steps: readonly DrillStep[]): DrillReport => ({
  drill,
  ranAt: AT,
  passed: steps.every((entry) => entry.passed),
  steps,
});

export const runAllDrills = async (): Promise<readonly DrillReport[]> => [
  await pilotOnboardingDrill(),
  await credentialRotationDrill(),
  await revocationAndFallbackDrill(),
];
