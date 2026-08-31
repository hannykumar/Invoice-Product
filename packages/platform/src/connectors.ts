import type { Id } from "./types.ts";

// "payments" is our own subscription provider (issue #42 [E42], GPT 1) — the money customers pay
// us, which is a different thing from "banking", the customer's own bank feed.
export type ConnectorKind = "gst" | "irp" | "eway_bill" | "banking" | "vehicle" | "ocr" | "email" | "whatsapp" | "payments";
export class ConnectorError extends Error {
  public readonly code: "OUTAGE" | "TIMEOUT" | "UNAUTHORIZED" | "INVALID_REQUEST";
  public readonly retryable: boolean;
  public readonly providerRequestId: string | undefined;
  constructor(code: "OUTAGE" | "TIMEOUT" | "UNAUTHORIZED" | "INVALID_REQUEST", retryable: boolean, providerRequestId?: string) { super(code); this.code = code; this.retryable = retryable; this.providerRequestId = providerRequestId; }
}
export interface ConnectorRequest { tenantId: Id; operation: string; payload: Readonly<Record<string, unknown>>; idempotencyKey: string; correlationId: string; }
export interface ConnectorResponse { providerRequestId: string; status: "accepted" | "completed"; payload: Readonly<Record<string, unknown>>; }
export interface ExternalConnector { readonly kind: ConnectorKind; execute(request: ConnectorRequest): Promise<ConnectorResponse>; health(): Promise<"healthy" | "degraded" | "unavailable">; }
export interface CredentialVault { credentialReference(tenantId: Id, connector: ConnectorKind): Promise<string>; }
export interface ConnectorWebhook { readonly eventId: string; readonly providerRequestId: string; readonly occurredAt: string; readonly payload: Readonly<Record<string, unknown>>; }
export interface WebhookVerifier { verify(kind: ConnectorKind, body: string, signature: string): Promise<ConnectorWebhook>; }

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
    const webhook = await this.verifier.verify(kind, body, signature); const key = `${kind}:${webhook.eventId}`; const duplicate = this.#seenWebhooks.has(key); this.#seenWebhooks.add(key); return { webhook, duplicate };
  }
}

export class StaticWebhookVerifier implements WebhookVerifier {
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
