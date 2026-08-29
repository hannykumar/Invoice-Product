// Issue #19 [E19] — the narrow surfaces supplier risk needs from other lanes.
//
// Every government source sits behind a port so development and tests run against mocks and no
// production credential is needed to run anything (rule 5 of the brief). The GSTR-2B port is
// optional throughout, because #31 has not shipped and #19 must not wait for it.

import type { CompanyId } from "@invoice/kernel";
import type { Id, IsoDate } from "../../masters/src/types.ts";
import type {
  GstinLookupOutcome, Gstr2bSignal, RiskAcknowledgement, RiskPolicy, SupplierHistory,
  SupplierRiskAssessment,
} from "./supplier-risk-types.ts";

/**
 * The GST department, as this module needs it.
 *
 * Deliberately not the whole GST connector: a change inside GPT 2's gateway cannot break supplier
 * warnings, and a test can hand over a cancelled registration in two lines.
 */
export interface GstinStatusPort {
  lookup(companyId: CompanyId, gstin: string, options?: { readonly refresh?: boolean }): Promise<GstinLookupOutcome>;
}

/** What our own books say. Implemented over #20's positions and #17's bills. */
export interface SupplierHistoryPort {
  historyFor(companyId: CompanyId, partyId: Id, on: IsoDate): Promise<SupplierHistory>;
}

/**
 * #31's signal, when it exists.
 *
 * This is the "optional input contract for later reconciliation/ITC risk signals" the execution
 * override asks for. Until #31 supplies an implementation, the service is constructed without one
 * and every assessment says plainly that GSTR-2B was not checked.
 */
export interface Gstr2bPort {
  signalFor(
    companyId: CompanyId,
    input: { readonly supplierGstin: string; readonly invoiceNumber: string; readonly invoiceDate: IsoDate },
  ): Promise<Gstr2bSignal | null>;
}

/** Readings kept so an outage can still show what we last saw, marked as old. */
export interface GstinCacheRepository {
  get(companyId: CompanyId, gstin: string): Promise<GstinLookupOutcome | null>;
  put(companyId: CompanyId, outcome: GstinLookupOutcome): Promise<void>;
}

export interface RiskAssessmentRepository {
  insert(assessment: SupplierRiskAssessment): Promise<void>;
  findByFingerprint(companyId: CompanyId, fingerprint: string): Promise<SupplierRiskAssessment | null>;
  listForParty(companyId: CompanyId, partyId: Id): Promise<SupplierRiskAssessment[]>;
}

export interface RiskAcknowledgementRepository {
  insert(companyId: CompanyId, acknowledgement: RiskAcknowledgement): Promise<void>;
  findByFingerprint(companyId: CompanyId, fingerprint: string): Promise<RiskAcknowledgement | null>;
}

/** Per-company, effective-dated. A port rather than a table read, exactly as #18's tolerance is. */
export interface RiskPolicyPort {
  policyFor(companyId: CompanyId, on: IsoDate): Promise<RiskPolicy>;
}
