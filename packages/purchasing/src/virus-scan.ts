// Virus scanning behind a replaceable port (issue #401, threat model I3).
//
// The inbox never accepts a scan verdict from whoever delivered the file: it asks the
// scanner itself, about the exact bytes it measured. The port follows connector-v1's
// shape — provider-neutral request, idempotency key, correlation id, `ConnectorError`
// with retryability — so a real engine (ClamAV, a cloud scanner) can sit behind it
// without touching the inbox. Nothing here passes a file the scanner did not answer for:
// an outage, a timeout, "could not scan" or an answer about different bytes all hold.

import { createHash } from "node:crypto";
import { ConnectorError } from "../../platform/src/connectors.ts";

export interface VirusScanRequest {
  /** The bytes that were screened; the scanner must answer about these and nothing else. */
  readonly bytes: Uint8Array;
  /** SHA-256 measured by the inbox, so the answer can be tied to the file. */
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly storageKey: string;
  readonly correlationId: string;
  /** `scan:<sha256>`: the same file is never scanned (or billed) twice for one answer. */
  readonly idempotencyKey: string;
}

export interface VirusScanResult {
  /** `unscanned` means the engine answered but could not reach a verdict. It holds. */
  readonly verdict: "clean" | "infected" | "unscanned";
  /** The SHA-256 the scanner computed. An answer about other bytes is not an answer. */
  readonly scannedSha256: string;
  readonly engine: string;
  readonly providerRequestId: string;
  readonly signature?: string;
}

export interface VirusScanPort {
  scan(request: VirusScanRequest): Promise<VirusScanResult>;
}

/** The industry-standard harmless test signature, so tests exercise a real detection path. */
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/**
 * Development and test scanner. Flags the EICAR test string and any SHA-256 listed as
 * infected, and reproduces the failures the inbox must survive.
 */
export class MockVirusScanner implements VirusScanPort {
  readonly #infected: Set<string>;
  #mode: "healthy" | "outage" | "timeout" | "no_verdict" | "wrong_file";
  #failFirst = 0;
  #calls = 0;

  constructor(options: { readonly infectedSha256?: readonly string[]; readonly mode?: MockVirusScanner["mode"] } = {}) {
    this.#infected = new Set(options.infectedSha256 ?? []);
    this.#mode = options.mode ?? "healthy";
  }

  get mode(): "healthy" | "outage" | "timeout" | "no_verdict" | "wrong_file" { return this.#mode; }
  setMode(mode: MockVirusScanner["mode"]): void { this.#mode = mode; }
  /** Fail the next `times` calls with a retryable timeout, then answer normally. */
  failNext(times: number): void { this.#failFirst = times; }
  get callCount(): number { return this.#calls; }

  async scan(request: VirusScanRequest): Promise<VirusScanResult> {
    this.#calls += 1;
    const providerRequestId = `mock-scan-${request.correlationId}-${this.#calls}`;
    if (this.#mode === "outage") throw new ConnectorError("OUTAGE", true, providerRequestId);
    if (this.#mode === "timeout") throw new ConnectorError("TIMEOUT", true, providerRequestId);
    if (this.#failFirst > 0) { this.#failFirst -= 1; throw new ConnectorError("TIMEOUT", true, providerRequestId); }
    const scannedSha256 = this.#mode === "wrong_file" ? "0".repeat(64) : createHash("sha256").update(request.bytes).digest("hex");
    if (this.#mode === "no_verdict") return { verdict: "unscanned", scannedSha256, engine: "mock", providerRequestId };
    const infected = this.#infected.has(scannedSha256) || Buffer.from(request.bytes.buffer, request.bytes.byteOffset, request.bytes.byteLength).includes(EICAR, 0, "latin1");
    return infected
      ? { verdict: "infected", scannedSha256, engine: "mock", providerRequestId, signature: "Eicar-Test-Signature" }
      : { verdict: "clean", scannedSha256, engine: "mock", providerRequestId };
  }
}

export const EICAR_TEST_STRING = EICAR;
