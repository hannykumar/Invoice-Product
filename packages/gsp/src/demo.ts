/**
 * Issue #33 [E33] — a shop connecting its GST number, and everything that then goes wrong.
 *
 *   npm run demo:gsp
 *
 * Sunrise Hardware has two registrations: Bengaluru, and a godown across the border in Maharashtra.
 * The owner connects the Bengaluru one, mistypes the code once, gets it right, registers an
 * invoice, watches an invoice for the *other* registration be refused rather than filed under the
 * wrong state, loses the network mid-call, and finds out from the government's own record what
 * actually happened. Then the connection is taken back, and everything done under it stays exactly
 * where it was.
 *
 * No network, no contract and no credential: the provider is the sandbox in `adapters.ts`, which
 * expires codes, counts wrong attempts and keeps its own record of what the government holds.
 */
import { InMemoryAuditPort } from '@invoice/ledger';
import { ConnectorGateway, MockConnector, StaticWebhookVerifier } from '../../platform/src/connectors.ts';
import { SyntheticIrp, SyntheticIrpVault } from '../../gst/src/einvoice-adapters.ts';
import { InMemoryAuthorisations, InMemoryCallLog, RecordingExceptionSink, SandboxGspProvider, SlidingWindowLimiter } from './adapters.ts';
import { GovernmentChannel } from './channel.ts';
import { GovernmentCallReconciler } from './reconcile.ts';
import { GovernmentAccessService } from './service.ts';
import { EVERYDAY_SCOPES, KARNATAKA_GSTIN, MAHARASHTRA_GSTIN, SUNRISE_COMPANY, SUNRISE_NAME, invoicePayload, ownerOf } from './fixtures.ts';

const heading = (text: string): void => console.log(`\n${text}\n${'─'.repeat(text.length)}`);

let instant = new Date('2026-08-17T04:30:00.000Z');
const clock = { now: () => new Date(instant.getTime()) };
const provider = new SandboxGspProvider({ now: () => clock.now() });
const authorisations = new InMemoryAuthorisations();
const calls = new InMemoryCallLog();
const audit = new InMemoryAuditPort();
const irp = new SyntheticIrp(() => clock.now());
const gateway = new ConnectorGateway([irp, new MockConnector('gst'), new MockConnector('eway_bill')], new SyntheticIrpVault(), new StaticWebhookVerifier());

const service = new GovernmentAccessService({ authorisations, calls, provider, audit, clock });
const channel = new GovernmentChannel({ gateway, authorisations, calls, audit, clock, provider, limiter: new SlidingWindowLimiter() });
const owner = ownerOf();

heading('Connecting the Bengaluru registration');
await service.beginOnboarding(owner, { gstin: KARNATAKA_GSTIN, legalName: SUNRISE_NAME, signatoryHint: 'the owner', scopes: EVERYDAY_SCOPES });
const sent = await service.requestOtp(owner, KARNATAKA_GSTIN);
console.log(`A one-time password went to the signatory's phone (${sent.kind === 'OTP_SENT' ? sent.authorisation.otp?.sentToHint : ''}).`);
const wrong = await service.verifyOtp(owner, KARNATAKA_GSTIN, '000000');
console.log(wrong.kind === 'WRONG_OTP' ? wrong.message['en-IN'] : '');
const done = await service.verifyOtp(owner, KARNATAKA_GSTIN, '123456');
if (done.kind === 'AUTHORISED') {
  console.log(`Connected. ${done.authorisation.consent?.wordingShown['en-IN']}`);
  console.log(`Credentials are held as a reference: ${done.authorisation.credential?.reference}`);
}

heading('Registering an invoice');
const registered = await channel.call(owner, {
  operation: 'einvoice.generate',
  payload: invoicePayload(KARNATAKA_GSTIN, 'SI-1042'),
  idempotencyKey: 'demo-si-1042',
  documentRef: 'SI-1042',
});
if (registered.kind === 'ANSWERED') {
  console.log(`The government registered it: IRN ${String(registered.response.payload.Irn).slice(0, 24)}…`);
}

heading('An invoice for the other registration, which is not connected');
const refused = await channel.call(owner, {
  operation: 'einvoice.generate',
  payload: invoicePayload(MAHARASHTRA_GSTIN, 'SI-1043'),
  idempotencyKey: 'demo-si-1043',
  documentRef: 'SI-1043',
});
if (refused.kind === 'REFUSED') {
  console.log(refused.refusal.message['en-IN']);
  console.log(`What to do: ${refused.refusal.nextAction?.['en-IN']}`);
}

heading('The network drops mid-call');
irp.setMode('timeout');
const unknown = await channel.call(owner, {
  operation: 'einvoice.generate',
  payload: invoicePayload(KARNATAKA_GSTIN, 'SI-1044'),
  idempotencyKey: 'demo-si-1044',
  documentRef: 'SI-1044',
});
console.log(`Outcome: ${unknown.kind}. The invoice's state with the government is unknown — not failed.`);

heading('Asking the government what actually happened');
irp.setMode('healthy');
provider.government('SI-1044', 'irn-for-si-1044');
instant = new Date('2026-08-17T05:30:00.000Z');
const report = await new GovernmentCallReconciler({ calls, provider, audit, clock, exceptions: new RecordingExceptionSink() }).run(owner);
console.log(`Checked ${report.checked}; corrected ${report.corrected}; never arrived ${report.notFound}; still unknown ${report.stillUnknown}.`);
const settled = (await calls.list(SUNRISE_COMPANY, KARNATAKA_GSTIN)).find((call) => call.documentRef === 'SI-1044');
console.log(`SI-1044 is now ${settled?.outcome} with the government's own reference ${settled?.governmentReference}.`);

heading('Taking the permission back');
const revoked = await service.revoke(owner, KARNATAKA_GSTIN, 'The owner is changing accountants.');
console.log(`Status: ${revoked.status}. Consent withdrawn at ${revoked.consent?.withdrawnAt}, and still on the record.`);
const stopped = await channel.call(owner, {
  operation: 'einvoice.generate', payload: invoicePayload(KARNATAKA_GSTIN, 'SI-1045'), idempotencyKey: 'demo-si-1045',
});
if (stopped.kind === 'REFUSED') console.log(stopped.refusal.message['en-IN']);

const history = await service.history(owner, KARNATAKA_GSTIN);
console.log(`\nCalls kept after revocation: ${history.calls.length} (${history.calls.filter((call) => call.outcome === 'ACCEPTED').length} accepted, ${history.calls.filter((call) => call.outcome === 'REFUSED').length} refused).`);
console.log(`Credentials on the record: ${history.authorisation.credentialHistory.length}. Live credentials: ${history.authorisation.credential === null ? 'none' : 'one'}.`);

heading('What was written down');
for (const event of audit.events.slice(0, 8)) console.log(`${event.action} — ${event.summary}`);
console.log(`\n${audit.events.length} audit entries. Search them for the one-time password: ${JSON.stringify(audit.events).includes('123456') ? 'FOUND — that would be a bug' : 'not there, as it should be'}.`);
