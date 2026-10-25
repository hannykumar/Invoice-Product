import { createHmac, timingSafeEqual } from "node:crypto";
import type { Id } from "./types.ts";
import { redactSecretText } from "./credentials.ts";

// "payments" is our own subscription provider (issue #42 [E42], GPT 1) — the money customers pay
// us, which is a different thing from "banking", the customer's own bank feed.
export type ConnectorKind = "gst" | "irp" | "eway_bill" | "banking" | "vehicle" | "ocr" | "email" | "whatsapp" | "payments";
export class ConnectorError extends Error {
  public readonly code: "OUTAGE" | "TIMEOUT" | "UNAUTHORIZED" | "INVALID_REQUEST";
  public readonly retryable: boolean;
  public readonly providerRequestId: string | undefined;
  constructor(code: "OUTAGE" | "TIMEOUT" | "UNAUTHORIZED" | "INVALID_REQUEST", retryable: boolean, providerRequestId?: string) { super(code); this.code = code; this.retryable = retryable; this.providerRequestId = providerRequestId === undefined ? undefined : redactSecretText(providerRequestId); }
}
export interface ConnectorRequest { tenantId: Id; operation: string; payload: Readonly<Record<string, unknown>>; idempotencyKey: string; correlationId: string; }
export interface ConnectorResponse { providerRequestId: string; status: "accepted" | "completed"; payload: Readonly<Record<string, unknown>>; }
export interface ExternalConnector { readonly kind: ConnectorKind; execute(request: ConnectorRequest): Promise<ConnectorResponse>; health(): Promise<"healthy" | "degraded" | "unavailable">; }
export interface CredentialVault { credentialReference(tenantId: Id, connector: ConnectorKind): Promise<string>; }
export interface ConnectorWebhook { readonly eventId: string; readonly providerRequestId: string; readonly occurredAt: string; readonly payload: Readonly<Record<string, unknown>>; }
export interface WebhookVerifier { verify(kind: ConnectorKind, body: string, signature: string): Promise<ConnectorWebhook>; }

/** The per-provider signing secrets for callbacks. More than one while a secret is being rotated. */
export interface WebhookSigningSecrets { webhookSecrets(kind: ConnectorKind): Promise<readonly string[]>; }

/** A process-local first line against resends; the durable record is the receiver's (issue #389). */
const SEEN_WEBHOOKS_KEPT = 10_000;

export class ConnectorGateway {
  #failures = new Map<string, number>();
  #seenWebhooks = new Set<string>();
  private readonly connectors: ReadonlyMap<ConnectorKind, ExternalConnector>;
  private readonly vault: CredentialVault;
  private readonly verifier: WebhookVerifier;
  private readonly failureThreshold: number;
  constructor(connectors: readonly ExternalConnector[], vault: CredentialVault, verifier: WebhookVerifier, failureThreshold = 3) {
    this.connectors = new Map(connectors.map((connector) => [connector.kind, connector])); this.vault = vault; this.verifier = verifier; this.failureThreshold = failureThreshold;
  }
  async execute(kind: ConnectorKind, request: ConnectorRequest, attempts = 2): Promise<ConnectorResponse> {
    if (!request.tenantId || !request.idempotencyKey || !request.correlationId) throw new ConnectorError("INVALID_REQUEST", false);
    const connector = this.connectors.get(kind); if (!connector) throw new ConnectorError("INVALID_REQUEST", false);
    const key = `${kind}:${request.tenantId}`; if ((this.#failures.get(key) ?? 0) >= this.failureThreshold) throw new ConnectorError("OUTAGE", true);
    await this.vault.credentialReference(request.tenantId, kind);
    for (let attempt = 1; ; attempt += 1) try {
      const result = await connector.execute(request); this.#failures.delete(key); return result;
    } catch (error) {
      const normalized = error instanceof ConnectorError ? error : new ConnectorError("OUTAGE", true);
      if (!normalized.retryable || attempt >= attempts) { this.#failures.set(key, (this.#failures.get(key) ?? 0) + 1); throw normalized; }
    }
  }
  async health(kind: ConnectorKind): Promise<"healthy" | "degraded" | "unavailable"> { const connector = this.connectors.get(kind); if (!connector) return "unavailable"; return connector.health(); }
  async receiveWebhook(kind: ConnectorKind, body: string, signature: string): Promise<{ readonly webhook: ConnectorWebhook; readonly duplicate: boolean }> {
    const webhook = await this.verifier.verify(kind, body, signature); const key = `${kind}:${webhook.eventId}`; const duplicate = this.#seenWebhooks.has(key);
    this.#seenWebhooks.add(key);
    if (this.#seenWebhooks.size > SEEN_WEBHOOKS_KEPT) this.#seenWebhooks.delete(this.#seenWebhooks.values().next().value!);
    return { webhook, duplicate };
  }
}

const LOCAL_ENVIRONMENTS = new Set(["", "development", "test"]);
/** A developer's machine or a test run. Anything else ("production", "staging", "prod") is not. */
export const isLocalEnvironment = (environment: string | undefined = process.env.NODE_ENV): boolean =>
  LOCAL_ENVIRONMENTS.has((environment ?? "").trim().toLowerCase());

/** How far a signed timestamp may be from our clock, either way, before the delivery is refused. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;
const MAX_EVENT_ID_LENGTH = 200;

const signatureOver = (secret: string, timestamp: string, body: string): Buffer =>
  createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest();

/**
 * Issue #389 — the `x-provider-signature` a provider sends: `t=<unix seconds>,v1=<hex HMAC-SHA256>`,
 * the HMAC taken with the provider's secret over `<t>.<raw body>`. Tests and the mock provider sign
 * with this; a real provider's own header is mapped onto it by its adapter (#51).
 */
export const signWebhook = (secret: string, body: string, at: Date): string => {
  const timestamp = String(Math.floor(at.getTime() / 1000));
  return `t=${timestamp},v1=${signatureOver(secret, timestamp, body).toString("hex")}`;
};

const parseSignatureHeader = (header: string): { readonly timestamp: string; readonly signatures: readonly Buffer[] } | null => {
  let timestamp: string | null = null;
  const signatures: Buffer[] = [];
  for (const part of header.split(",")) {
    const [name, value, ...rest] = part.trim().split("=");
    if (rest.length > 0 || value === undefined) return null;
    if (name === "t" && /^\d{1,12}$/.test(value)) timestamp = value;
    else if (name === "v1" && /^[0-9a-f]{64}$/i.test(value)) signatures.push(Buffer.from(value, "hex"));
  }
  return timestamp === null || signatures.length === 0 ? null : { timestamp, signatures };
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isId = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && value.length <= MAX_EVENT_ID_LENGTH;

/** The shape every callback must have once its signature has verified. Anything else is refused. */
export const parseConnectorWebhook = (body: string): ConnectorWebhook => {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new ConnectorError("INVALID_REQUEST", false); }
  if (!isPlainObject(parsed)) throw new ConnectorError("INVALID_REQUEST", false);
  const { eventId, providerRequestId, occurredAt, payload } = parsed;
  if (!isId(eventId) || !isId(providerRequestId)) throw new ConnectorError("INVALID_REQUEST", false);
  if (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt))) throw new ConnectorError("INVALID_REQUEST", false);
  if (!isPlainObject(payload)) throw new ConnectorError("INVALID_REQUEST", false);
  return Object.freeze({ eventId, providerRequestId, occurredAt, payload: Object.freeze({ ...payload }) });
};

/**
 * Issue #389 — the verifier the running app uses. HMAC-SHA256 over the raw bytes with the
 * provider's own secret, compared in constant time; a signed timestamp more than
 * `WEBHOOK_TOLERANCE_SECONDS` from our clock is refused, so a captured delivery cannot be replayed
 * later; and the body must have the callback's shape before anything reads it.
 */
export class HmacWebhookVerifier implements WebhookVerifier {
  readonly #secrets: WebhookSigningSecrets;
  readonly #now: () => Date;
  readonly #toleranceSeconds: number;
  constructor(secrets: WebhookSigningSecrets, now: () => Date = () => new Date(), toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS) {
    this.#secrets = secrets; this.#now = now; this.#toleranceSeconds = toleranceSeconds;
  }
  async verify(kind: ConnectorKind, body: string, signature: string): Promise<ConnectorWebhook> {
    const header = parseSignatureHeader(signature);
    if (header === null) throw new ConnectorError("UNAUTHORIZED", false);
    const skew = Math.abs(Math.floor(this.#now().getTime() / 1000) - Number(header.timestamp));
    if (skew > this.#toleranceSeconds) throw new ConnectorError("UNAUTHORIZED", false);
    const secrets = (await this.#secrets.webhookSecrets(kind)).filter((secret) => secret !== "");
    let verified = false;
    // Every comparison runs, so how long this takes says nothing about which one matched.
    for (const secret of secrets) {
      const expected = signatureOver(secret, header.timestamp, body);
      for (const given of header.signatures) if (timingSafeEqual(expected, given)) verified = true;
    }
    if (!verified) throw new ConnectorError("UNAUTHORIZED", false);
    return parseConnectorWebhook(body);
  }
}

/** For a gateway that only makes calls and takes no callbacks: every delivery is refused. */
export class NoWebhooksVerifier implements WebhookVerifier {
  async verify(): Promise<ConnectorWebhook> { throw new ConnectorError("UNAUTHORIZED", false); }
}

/**
 * A fixed, publicly known signature, for unit tests and local demos only. Constructing it anywhere
 * else throws, so a server can never start with it (issue #389).
 */
export class StaticWebhookVerifier implements WebhookVerifier {
  constructor() {
    if (!isLocalEnvironment()) throw new Error("StaticWebhookVerifier accepts a publicly known signature and is only for development and tests.");
  }
  async verify(_kind: ConnectorKind, body: string, signature: string): Promise<ConnectorWebhook> {
    if (signature !== "test-signature") throw new ConnectorError("UNAUTHORIZED", false);
    return JSON.parse(body) as ConnectorWebhook;
  }
}
export class MockConnector implements ExternalConnector {
  readonly #responses = new Map<string, ConnectorResponse>();
  public readonly kind: ConnectorKind;
  private readonly mode: "healthy" | "timeout" | "outage";
  constructor(kind: ConnectorKind, mode: "healthy" | "timeout" | "outage" = "healthy") { this.kind = kind; this.mode = mode; }
  async execute(request: ConnectorRequest): Promise<ConnectorResponse> { if (this.mode === "timeout") throw new ConnectorError("TIMEOUT", true); if (this.mode === "outage") throw new ConnectorError("OUTAGE", true); const prior = this.#responses.get(request.idempotencyKey); if (prior) return prior; const response = Object.freeze({ providerRequestId: `mock-${request.correlationId}`, status: "completed" as const, payload: { accepted: true } }); this.#responses.set(request.idempotencyKey, response); return response; }
  async health(): Promise<"healthy" | "degraded" | "unavailable"> { return this.mode === "healthy" ? "healthy" : "unavailable"; }
}
export class ReferenceEmailConnector extends MockConnector { constructor() { super("email"); } }
