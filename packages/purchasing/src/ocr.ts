// OCR behind the platform's connector contract (issue #15, dependency #8).
//
// No provider SDK appears in this module. The adapter speaks `ExternalConnector` from
// connector-v1, so the OCR vendor can be replaced without touching extraction, and a
// mock satisfies the same interface for development and tests.

import { ConnectorError } from "../../platform/src/connectors.ts";
import type { ExternalConnector } from "../../platform/src/connectors.ts";
import type { Id } from "../../masters/src/types.ts";

export interface OcrBox { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

export interface OcrBlock {
  readonly text: string;
  readonly box: OcrBox;
  /** The provider's own confidence for this block, 0 to 1. */
  readonly confidence: number;
}

export interface OcrPage {
  readonly pageNumber: number;
  readonly blocks: readonly OcrBlock[];
  /** Rotation the provider corrected for. Recorded so a sideways scan is explainable. */
  readonly rotationDegrees: number;
  /** False when the page is too blurred or too dark to read anything reliable. */
  readonly readable: boolean;
}

export interface OcrResult {
  readonly provider: string;
  readonly providerRequestId: string;
  readonly pages: readonly OcrPage[];
}

export interface OcrRequest {
  readonly companyId: Id;
  readonly storageKey: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface OcrAdapter {
  read(request: OcrRequest): Promise<OcrResult>;
}

/** The real adapter: one connector call, provider-neutral payload, no secrets. */
export class ConnectorOcrAdapter implements OcrAdapter {
  readonly #connector: ExternalConnector;
  constructor(connector: ExternalConnector) {
    if (connector.kind !== "ocr") throw new Error(`Expected an OCR connector, received ${connector.kind}.`);
    this.#connector = connector;
  }

  async read(request: OcrRequest): Promise<OcrResult> {
    const response = await this.#connector.execute({
      tenantId: request.companyId,
      operation: "ocr.read_document",
      payload: { storageKey: request.storageKey },
      idempotencyKey: request.idempotencyKey,
      correlationId: request.correlationId,
    });
    const pages = response.payload.pages;
    if (!Array.isArray(pages)) throw new ConnectorError("INVALID_REQUEST", false, response.providerRequestId);
    return { provider: "connector", providerRequestId: response.providerRequestId, pages: pages as readonly OcrPage[] };
  }
}

/**
 * Fixture-driven adapter for development and tests. `mode` reproduces the failures the
 * inbox has to survive: a provider outage, a timeout, and a page too blurred to read.
 */
export class MockOcrAdapter implements OcrAdapter {
  readonly #pagesByKey: Map<string, readonly OcrPage[]>;
  readonly #mode: "healthy" | "outage" | "timeout";
  #calls = 0;
  /** Number of calls to fail before succeeding, for retry tests. */
  #failFirst = 0;

  constructor(pagesByKey: Record<string, readonly OcrPage[]> = {}, mode: "healthy" | "outage" | "timeout" = "healthy") {
    this.#pagesByKey = new Map(Object.entries(pagesByKey));
    this.#mode = mode;
  }

  failNext(times: number): void { this.#failFirst = times; }
  get callCount(): number { return this.#calls; }

  set(storageKey: string, pages: readonly OcrPage[]): void { this.#pagesByKey.set(storageKey, pages); }

  async read(request: OcrRequest): Promise<OcrResult> {
    this.#calls += 1;
    if (this.#mode === "outage") throw new ConnectorError("OUTAGE", true, `mock-${request.correlationId}`);
    if (this.#mode === "timeout") throw new ConnectorError("TIMEOUT", true, `mock-${request.correlationId}`);
    if (this.#failFirst > 0) { this.#failFirst -= 1; throw new ConnectorError("TIMEOUT", true, `mock-${request.correlationId}`); }
    const pages = this.#pagesByKey.get(request.storageKey);
    if (!pages) throw new ConnectorError("INVALID_REQUEST", false, `mock-${request.correlationId}`);
    return { provider: "mock", providerRequestId: `mock-${request.correlationId}`, pages };
  }
}

/** Builds a page from plain lines, for fixtures. Boxes are laid out top to bottom. */
export function pageFromLines(pageNumber: number, lines: readonly (string | { text: string; confidence: number })[], options: { rotationDegrees?: number; readable?: boolean } = {}): OcrPage {
  const blocks: OcrBlock[] = lines.map((line, index) => {
    const text = typeof line === "string" ? line : line.text;
    const confidence = typeof line === "string" ? 0.96 : line.confidence;
    return { text, confidence, box: { x: 0.06, y: Number((0.04 + index * 0.045).toFixed(4)), width: 0.88, height: 0.035 } };
  });
  return { pageNumber, blocks, rotationDegrees: options.rotationDegrees ?? 0, readable: options.readable ?? true };
}
