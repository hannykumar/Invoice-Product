/**
 * Issue #123 — the door a provider's callback arrives at.
 *
 * Two things about this route are different from every other route in the API, and both follow from
 * who is calling.
 *
 *   1. **There is no session.** A GSP posting an acknowledgement has not signed in and never will.
 *      It authenticates with a signature over the bytes it sent, which is why this is one of the
 *      three routes that sit in front of `runtime.authenticate` — and why the raw body has to reach
 *      it unparsed. A body that has been read into an object and re-serialised is a different string
 *      with the same meaning, and it verifies against nothing.
 *   2. **Nothing the caller says is trusted.** The company, the GST number and the document all come
 *      from the call row the callback matches — a row this product wrote when it made the call. A
 *      forged callback cannot name a company, which is a stronger property than checking whether the
 *      one it named was allowed.
 *
 * The verifier wired in below is `StaticWebhookVerifier`, GPT 2's development one. It is exactly as
 * strong as the provider contract behind it, which is to say not at all until #51 supplies a real
 * signing secret and a real verifier. That swap is one line here and nothing anywhere else.
 *
 * Until the government channel itself is wired into the running app (#51 again — it needs a
 * contracted provider and authorised GST numbers), this endpoint verifies, deduplicates and records
 * every delivery, and reports that it matched no call. That is the correct answer for a callback
 * about a call this process never made, and it is the same code path that will settle one when the
 * app does make it.
 */
import { systemClock } from '@invoice/kernel';
import { InMemoryAuditPort } from '@invoice/ledger';
import { ConnectorGateway, MockConnector, StaticWebhookVerifier, type ConnectorKind } from '../../../packages/platform/src/connectors.ts';
import {
  GovernmentWebhookReceiver,
  InMemoryAuthorisations,
  InMemoryCallLog,
  InMemoryWebhookEvents,
  RecordingExceptionSink,
  type WebhookOutcome,
} from '../../../packages/gsp/src/index.ts';

/** The connectors a government callback may arrive for. Anything else is not our door. */
const GOVERNMENT_CONNECTORS: readonly ConnectorKind[] = ['irp', 'eway_bill', 'gst'];

export const isGovernmentConnector = (value: string): value is ConnectorKind =>
  (GOVERNMENT_CONNECTORS as readonly string[]).includes(value);

let receiver: GovernmentWebhookReceiver | undefined;

const governmentWebhookReceiver = (): GovernmentWebhookReceiver => {
  if (receiver === undefined) {
    const gateway = new ConnectorGateway(
      GOVERNMENT_CONNECTORS.map((kind) => new MockConnector(kind)),
      { async credentialReference(tenantId: string, connector: string) { return `vault://${connector}/${tenantId}`; } },
      new StaticWebhookVerifier(),
    );
    receiver = new GovernmentWebhookReceiver({
      gateway,
      calls: new InMemoryCallLog(),
      authorisations: new InMemoryAuthorisations(),
      events: new InMemoryWebhookEvents(),
      audit: new InMemoryAuditPort(),
      clock: systemClock,
      exceptions: new RecordingExceptionSink(),
    });
  }
  return receiver;
};

/**
 * What the provider is told.
 *
 * Everything we verified and wrote down answers 202: we have it, stop resending. Only a delivery we
 * could not authenticate answers 401, because that is the one a provider should retry differently
 * — with the right signature.
 */
export const receiveGovernmentWebhook = async (
  kind: ConnectorKind,
  rawBody: string,
  signature: string,
): Promise<{ readonly status: number; readonly outcome: WebhookOutcome }> => {
  const outcome = await governmentWebhookReceiver().receive(kind, rawBody, signature);
  return { status: 202, outcome };
};
