// Issue #19 [E19] — the GST department behind #8's connector, and storage for what it said.
//
// No production credential is needed to run or test any of this: the gateway resolves an opaque
// tenant-scoped credential reference, and development runs against `SyntheticGstConnector`, whose
// GST numbers are all built by `syntheticGstin` and belong to nobody.

import type { CompanyId } from "@invoice/kernel";
import type { TransactionParticipant } from "@invoice/ledger";
import {
  ConnectorError, type ConnectorGateway, type ConnectorRequest, type ConnectorResponse,
  type ExternalConnector,
} from "../../platform/src/connectors.ts";
import { maskAccount } from "./supplier-risk-wording.ts";
import { DEFAULT_RISK_POLICY } from "./supplier-risk-types.ts";
import type {
  BankDetailChange, GstinLookupOutcome, GstinRecord, RiskAcknowledgement, RiskPolicy,
  SupplierRiskAssessment, UnavailableReason,
} from "./supplier-risk-types.ts";
import type {
  GstinCacheRepository, GstinStatusPort, RiskAcknowledgementRepository, RiskAssessmentRepository,
  RiskPolicyPort,
} from "./supplier-risk-ports.ts";
import type { Id, IsoDate } from "../../masters/src/types.ts";

/** How a connector failure becomes something a buyer can be told without alarm. */
const reasonOf = (error: unknown): { reason: UnavailableReason; retryable: boolean; explanation: string } => {
  if (error instanceof ConnectorError) {
    if (error.code === "TIMEOUT") return { reason: "TIMEOUT", retryable: true, explanation: "The GST department did not answer in time." };
    if (error.code === "OUTAGE") return { reason: "PROVIDER_OUTAGE", retryable: true, explanation: "The GST department's service is not responding at the moment." };
    if (error.code === "UNAUTHORIZED") return { reason: "NOT_PERMITTED", retryable: false, explanation: "This business is not set up to check GST numbers yet." };
    return { reason: "NOT_CONFIGURED", retryable: false, explanation: "The GST check could not be made with the details we have." };
  }
  return { reason: "PROVIDER_OUTAGE", retryable: true, explanation: "The GST department's service could not be reached." };
};

/** Reads the provider's answer into our own shape, refusing to invent anything it did not say. */
const readRecord = (gstin: string, payload: Readonly<Record<string, unknown>>, observedAt: string): GstinRecord => {
  const text = (key: string): string | undefined => {
    const value = payload[key];
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  };
  const status = (text("status") ?? "UNKNOWN").toUpperCase();
  const known = ["ACTIVE", "CANCELLED", "SUSPENDED", "PROVISIONAL", "INACTIVE", "NOT_FOUND"];
  const filings = Array.isArray(payload.filings) ? payload.filings as GstinRecord["filings"] : [];
  return {
    gstin,
    // An unrecognised status is `UNKNOWN`, never guessed into one of the real ones.
    status: (known.includes(status) ? status : "UNKNOWN") as GstinRecord["status"],
    ...(text("legalName") === undefined ? {} : { legalName: text("legalName")! }),
    ...(text("tradeName") === undefined ? {} : { tradeName: text("tradeName")! }),
    ...(text("stateCode") === undefined ? {} : { stateCode: text("stateCode")! }),
    ...(text("registeredOn") === undefined ? {} : { registeredOn: text("registeredOn")! }),
    ...(text("statusChangedOn") === undefined ? {} : { statusChangedOn: text("statusChangedOn")! }),
    filings,
    ...(typeof payload.eInvoiceEnabled === "boolean" ? { eInvoiceEnabled: payload.eInvoiceEnabled } : {}),
    observedAt,
  };
};

export interface GstinStatusAdapterDeps {
  readonly gateway: ConnectorGateway;
  readonly cache: GstinCacheRepository;
  readonly clock: () => Date;
  /** Readings younger than this are served from the cache rather than re-fetched. */
  readonly cacheMinutes?: number;
  readonly correlationId?: () => string;
}

/**
 * The GST department behind `connector-v1`.
 *
 * On failure it returns the last reading it has rather than nothing, marked as old. Showing a
 * seven-day-old "cancelled" is far more useful than showing silence, provided it is labelled —
 * and `assessSupplierRisk` labels it.
 */
export const gstinStatusAdapter = (deps: GstinStatusAdapterDeps): GstinStatusPort => ({
  async lookup(companyId, gstin, options = {}): Promise<GstinLookupOutcome> {
    const cached = await deps.cache.get(companyId, gstin);
    if (!options.refresh && cached !== null && cached.kind === "FOUND") {
      const age = deps.clock().getTime() - new Date(cached.record.observedAt).getTime();
      if (age <= (deps.cacheMinutes ?? 60) * 60_000) return cached;
    }

    const observedAt = deps.clock().toISOString();
    const request: ConnectorRequest = {
      tenantId: companyId,
      operation: "gstin.status",
      payload: { gstin },
      // Keyed on the day, so a retry inside one day is the same call to the provider.
      idempotencyKey: `gstin:status:${companyId}:${gstin}:${observedAt.slice(0, 10)}`,
      correlationId: deps.correlationId?.() ?? `gstin-${gstin}-${observedAt}`,
    };

    try {
      const response: ConnectorResponse = await deps.gateway.execute("gst", request);
      const outcome: GstinLookupOutcome = { kind: "FOUND", record: readRecord(gstin, response.payload, observedAt) };
      await deps.cache.put(companyId, outcome);
      return outcome;
    } catch (error) {
      const { reason, retryable, explanation } = reasonOf(error);
      const lastKnown = cached?.kind === "FOUND" ? cached.record : undefined;
      return {
        kind: "UNAVAILABLE", reason, retryable, explanation,
        ...(lastKnown === undefined ? {} : { lastKnown }),
      };
    }
  },
});

/**
 * A GST department for development and tests.
 *
 * Every registration here is invented. Statuses are keyed on the GST number so a test can ask for
 * a cancelled one by name, and the connector still honours the `connector-v1` contract — same
 * idempotency behaviour, same `ConnectorError` shapes — so the adapter above is exercised for real.
 */
export class SyntheticGstConnector implements ExternalConnector {
  readonly kind = "gst" as const;
  readonly #records = new Map<string, Readonly<Record<string, unknown>>>();
  readonly #seen = new Map<string, ConnectorResponse>();
  #mode: "healthy" | "timeout" | "outage";

  constructor(mode: "healthy" | "timeout" | "outage" = "healthy") {
    this.#mode = mode;
  }

  /** Registers what the portal will say about one invented GST number. */
  put(gstin: string, payload: Readonly<Record<string, unknown>>): this {
    this.#records.set(gstin, payload);
    return this;
  }

  /** Lets a test take the provider down mid-run, to prove the outage path. */
  setMode(mode: "healthy" | "timeout" | "outage"): void {
    this.#mode = mode;
  }

  async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
    if (this.#mode === "timeout") throw new ConnectorError("TIMEOUT", true);
    if (this.#mode === "outage") throw new ConnectorError("OUTAGE", true);
    const prior = this.#seen.get(request.idempotencyKey);
    if (prior !== undefined) return prior;
    const gstin = String((request.payload as { gstin?: unknown }).gstin ?? "");
    // A number nobody registered is answered as `NOT_FOUND`, which is what the portal does.
    const payload = this.#records.get(gstin) ?? { status: "NOT_FOUND" };
    const response: ConnectorResponse = {
      providerRequestId: `synthetic-${request.correlationId}`,
      status: "completed",
      payload,
    };
    this.#seen.set(request.idempotencyKey, response);
    return response;
  }

  async health(): Promise<"healthy" | "degraded" | "unavailable"> {
    return this.#mode === "healthy" ? "healthy" : "unavailable";
  }
}

/** A credential vault for development: opaque references, never a secret. */
export class SyntheticCredentialVault {
  async credentialReference(tenantId: string, connector: string): Promise<string> {
    return `vault://${connector}/${tenantId}`;
  }
}

// --------------------------------------------------------------------------- storage

export class InMemoryGstinCache implements GstinCacheRepository {
  readonly #byKey = new Map<string, GstinLookupOutcome>();

  async get(companyId: CompanyId, gstin: string): Promise<GstinLookupOutcome | null> {
    return this.#byKey.get(`${companyId}|${gstin}`) ?? null;
  }

  async put(companyId: CompanyId, outcome: GstinLookupOutcome): Promise<void> {
    if (outcome.kind !== "FOUND") return;
    this.#byKey.set(`${companyId}|${outcome.record.gstin}`, outcome);
  }
}

export class InMemoryRiskAssessmentStore implements RiskAssessmentRepository, TransactionParticipant {
  #rows: SupplierRiskAssessment[] = [];

  snapshot(): unknown { return [...this.#rows]; }
  restore(taken: unknown): void { this.#rows = [...(taken as SupplierRiskAssessment[])]; }

  async insert(assessment: SupplierRiskAssessment): Promise<void> {
    this.#rows.push(Object.freeze(assessment));
  }

  async findByFingerprint(companyId: CompanyId, fingerprint: string): Promise<SupplierRiskAssessment | null> {
    return this.#rows.find((row) => row.companyId === companyId && row.fingerprint === fingerprint) ?? null;
  }

  async listForParty(companyId: CompanyId, partyId: Id): Promise<SupplierRiskAssessment[]> {
    return this.#rows.filter((row) => row.companyId === companyId && row.supplierPartyId === partyId);
  }
}

export class InMemoryRiskAcknowledgementStore implements RiskAcknowledgementRepository, TransactionParticipant {
  #rows: { companyId: CompanyId; acknowledgement: RiskAcknowledgement }[] = [];

  snapshot(): unknown { return [...this.#rows]; }
  restore(taken: unknown): void { this.#rows = [...(taken as { companyId: CompanyId; acknowledgement: RiskAcknowledgement }[])]; }

  async insert(companyId: CompanyId, acknowledgement: RiskAcknowledgement): Promise<void> {
    this.#rows.push({ companyId, acknowledgement: Object.freeze(acknowledgement) });
  }

  async findByFingerprint(companyId: CompanyId, fingerprint: string): Promise<RiskAcknowledgement | null> {
    return this.#rows.find((row) => row.companyId === companyId && row.acknowledgement.assessmentFingerprint === fingerprint)?.acknowledgement ?? null;
  }
}

/** Effective-dated risk policies, newest first, exactly as #18's tolerances are held. */
export class InMemoryRiskPolicies implements RiskPolicyPort {
  readonly #byCompany = new Map<string, RiskPolicy[]>();

  set(companyId: CompanyId, policy: RiskPolicy): void {
    const merged = [...(this.#byCompany.get(companyId) ?? []).filter((candidate) => candidate.effectiveFrom !== policy.effectiveFrom), policy];
    merged.sort((left, right) => (left.effectiveFrom < right.effectiveFrom ? 1 : -1));
    this.#byCompany.set(companyId, merged);
  }

  async policyFor(companyId: CompanyId, on: IsoDate): Promise<RiskPolicy> {
    return (this.#byCompany.get(companyId) ?? []).find((policy) => policy.effectiveFrom <= on) ?? DEFAULT_RISK_POLICY;
  }
}

/**
 * Bank-detail changes read from #5's version history.
 *
 * Master records are never overwritten — each change appends a version — so the history is already
 * there and this module stores nothing of its own. Account numbers are masked on the way out: a
 * warning about a changed account has no business carrying the account itself.
 */
export const bankDetailChangesFrom = (
  versions: readonly {
    readonly recordId: Id; readonly effectiveFrom: IsoDate; readonly recordedAt: string;
    readonly recordedBy: Id; readonly reason?: string;
    readonly data: { readonly accountNumber: string; readonly ifsc: string; readonly partyId?: Id };
  }[],
  partyId: Id,
): BankDetailChange[] => {
  const mine = versions.filter((version) => version.data.partyId === partyId);
  const byRecord = new Map<Id, typeof mine>();
  for (const version of mine) byRecord.set(version.recordId, [...(byRecord.get(version.recordId) ?? []), version]);

  const changes: BankDetailChange[] = [];
  for (const history of byRecord.values()) {
    const ordered = [...history].sort((left, right) => (left.effectiveFrom < right.effectiveFrom ? -1 : 1));
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1]!;
      const current = ordered[index]!;
      // Only where the money would actually go somewhere else. A renamed branch is not a warning.
      if (previous.data.accountNumber === current.data.accountNumber && previous.data.ifsc === current.data.ifsc) continue;
      changes.push({
        bankAccountId: current.recordId,
        changedOn: current.effectiveFrom,
        recordedAt: current.recordedAt,
        recordedBy: current.recordedBy,
        previousAccountMasked: maskAccount(previous.data.accountNumber),
        currentAccountMasked: maskAccount(current.data.accountNumber),
        ...(previous.data.ifsc === current.data.ifsc ? {} : { previousIfsc: previous.data.ifsc, currentIfsc: current.data.ifsc }),
        ...(current.reason === undefined ? {} : { reason: current.reason }),
      });
    }
  }
  return changes;
};
