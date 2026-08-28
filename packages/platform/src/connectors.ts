import type { Id } from "./types.ts";

export type ConnectorKind = "gst" | "irp" | "eway_bill" | "banking" | "vehicle" | "ocr" | "email" | "whatsapp";
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
export class MockConnector implements ExternalConnector {
  readonly #responses = new Map<string, ConnectorResponse>();
  public readonly kind: ConnectorKind;
  private readonly mode: "healthy" | "timeout" | "outage";
  constructor(kind: ConnectorKind, mode: "healthy" | "timeout" | "outage" = "healthy") { this.kind = kind; this.mode = mode; }
  async execute(request: ConnectorRequest): Promise<ConnectorResponse> { if (this.mode === "timeout") throw new ConnectorError("TIMEOUT", true); if (this.mode === "outage") throw new ConnectorError("OUTAGE", true); const prior = this.#responses.get(request.idempotencyKey); if (prior) return prior; const response = Object.freeze({ providerRequestId: `mock-${request.correlationId}`, status: "completed" as const, payload: { accepted: true } }); this.#responses.set(request.idempotencyKey, response); return response; }
  async health(): Promise<"healthy" | "degraded" | "unavailable"> { return this.mode === "healthy" ? "healthy" : "unavailable"; }
}
export class ReferenceEmailConnector extends MockConnector { constructor() { super("email"); } }
