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
 * Issue #389 — the verifier wired in below is `HmacWebhookVerifier`: an HMAC-SHA256 over the raw
 * bytes with that provider's own secret, compared in constant time, inside a five-minute window, on
 * a body that must have the callback's shape. The secrets come from the environment
 * (`GOVERNMENT_WEBHOOK_SECRET_IRP`, `…_EWAY_BILL`, `…_GST`; comma-separated while rotating). On a
 * developer's machine or in a test a connector without one uses `DEVELOPMENT_WEBHOOK_SECRET`;
 * anywhere else it has no secret, so every callback for it is refused. Seen events are kept in
 * `government_webhook_events` whenever the app has a database, so a resend after a restart is still
 * a duplicate.
 *
 * Until the government channel itself is wired into the running app (#51 again — it needs a
 * contracted provider and authorised GST numbers), this endpoint verifies, deduplicates and records
 * every delivery, and reports that it matched no call. That is the correct answer for a callback
 * about a call this process never made, and it is the same code path that will settle one when the
 * app does make it.
 */
import { appClock } from './app-clock.ts';
import { InMemoryAuditPort } from '@invoice/ledger';
import type { CompanyId } from '@invoice/kernel';
import { ConnectorGateway, HmacWebhookVerifier, isLocalEnvironment, MockConnector, type ConnectorKind, type WebhookSigningSecrets } from '../../../packages/platform/src/connectors.ts';
import { registerSecretValues } from '../../../packages/platform/src/credentials.ts';
import type { TransactionalExecutor } from '../../../packages/platform/src/database.ts';
import {
  GovernmentWebhookReceiver,
  PostgresAuthorisations,
  PostgresCallLog,
  PostgresWebhookEvents,
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

/** Publicly known, so it is only ever used where nothing real can arrive: development and tests. */
export const DEVELOPMENT_WEBHOOK_SECRET = 'karobar-development-webhook-secret';

const secretVariable = (kind: ConnectorKind): string => `GOVERNMENT_WEBHOOK_SECRET_${kind.toUpperCase()}`;

/** Each provider's signing secrets, read once. A connector with none refuses every callback. */
export const governmentWebhookSecrets = (env: NodeJS.ProcessEnv = process.env): WebhookSigningSecrets & { readonly missing: readonly ConnectorKind[] } => {
  const local = isLocalEnvironment(env.NODE_ENV);
  const secrets = new Map<ConnectorKind, readonly string[]>();
  for (const kind of GOVERNMENT_CONNECTORS) {
    const configured = (env[secretVariable(kind)] ?? '').split(',').map((value) => value.trim()).filter((value) => value !== '');
    registerSecretValues(configured);
    secrets.set(kind, configured.length > 0 ? configured : local ? [DEVELOPMENT_WEBHOOK_SECRET] : []);
  }
  return {
    missing: GOVERNMENT_CONNECTORS.filter((kind) => (secrets.get(kind) ?? []).length === 0),
    async webhookSecrets(kind) { return secrets.get(kind) ?? []; },
  };
};

let receiver: GovernmentWebhookReceiver | undefined;

/**
 * Built once, at start-up when the server starts (`server.ts`), otherwise on the first callback.
 * With a database the seen events are kept there; without one (development, tests) in memory.
 */
export const configureGovernmentWebhooks = (db: TransactionalExecutor | null, env: NodeJS.ProcessEnv = process.env, warn: (message: string) => void = console.warn): GovernmentWebhookReceiver => {
  const secrets = governmentWebhookSecrets(env);
  if (secrets.missing.length > 0) {
    warn(`Government callbacks will be refused for ${secrets.missing.join(', ')}: no signing secret is set. Set ${secrets.missing.map(secretVariable).join(', ')}.`);
  }
  const gateway = new ConnectorGateway(
    GOVERNMENT_CONNECTORS.map((kind) => new MockConnector(kind)),
    { async credentialReference(tenantId: string, connector: string) { return `vault://${connector}/${tenantId}`; } },
    new HmacWebhookVerifier(secrets, () => appClock.now()),
  );
  receiver = new GovernmentWebhookReceiver({
    gateway,
    // A callback names no company, so `companyForRequest` asks the narrow SECURITY DEFINER lookup
    // for the company id alone (#477), and the callback is then handled inside that company's
    // unit of work — dedup row, settle and audit line committing together.
    calls: db === null ? new InMemoryCallLog() : new PostgresCallLog(db),
    authorisations: db === null ? new InMemoryAuthorisations() : new PostgresAuthorisations(db),
    events: db === null ? new InMemoryWebhookEvents() : new PostgresWebhookEvents(db),
    audit: new InMemoryAuditPort(),
    clock: appClock,
    exceptions: new RecordingExceptionSink(),
    ...(db === null ? {} : { unitOfWork: <T>(companyId: CompanyId, work: () => Promise<T>) => db.unitOfWork(companyId, () => work()) }),
  });
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
  db: TransactionalExecutor | null = null,
): Promise<{ readonly status: number; readonly outcome: WebhookOutcome }> => {
  const outcome = await (receiver ?? configureGovernmentWebhooks(db)).receive(kind, rawBody, signature);
  return { status: 202, outcome };
};
