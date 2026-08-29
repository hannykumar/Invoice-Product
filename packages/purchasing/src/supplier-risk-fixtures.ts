/**
 * Issue #19 [E19] — four suppliers to a Bengaluru trader, each with a different story.
 *
 * Every GST number here is built by `syntheticGstin`: structurally valid, checksum-correct and
 * belonging to nobody. No real taxpayer appears in this file, and none ever should (rule 10).
 */
import { fixedClock, type CompanyId } from "@invoice/kernel";
import { InMemoryAuditPort } from "@invoice/ledger";
import { ConnectorGateway, StaticWebhookVerifier } from "../../platform/src/connectors.ts";
import { syntheticGstin } from "../../masters/src/fixtures.ts";
import {
  InMemoryGstinCache, InMemoryRiskAcknowledgementStore, InMemoryRiskAssessmentStore,
  InMemoryRiskPolicies, SyntheticCredentialVault, SyntheticGstConnector, gstinStatusAdapter,
} from "./supplier-risk-adapters.ts";
import { SupplierRiskService } from "./supplier-risk-service.ts";
import type { SupplierHistoryPort } from "./supplier-risk-ports.ts";
import type { SupplierHistory } from "./supplier-risk-types.ts";
import { COMPANY, actorWith } from "./posting-fixtures.ts";

export { COMPANY, actorWith } from "./posting-fixtures.ts";

export const RISK_PERMISSIONS = ["supplier.risk.view", "supplier.risk.acknowledge"];

/** Shree Ram Steels of Pune — the good supplier we have bought from for years. */
export const GOOD_SUPPLIER = { partyId: "party-srs", name: "Shree Ram Steels Private Limited", gstin: syntheticGstin("27", "AAECS5678D"), stateCode: "27" };
/** Deccan Hardware of Bengaluru — cancelled their registration in March. The user's example. */
export const CANCELLED_SUPPLIER = { partyId: "party-dhw", name: "Deccan Hardware Traders", gstin: syntheticGstin("29", "AAFCD1234K"), stateCode: "29" };
/** Konkan Packaging of Mumbai — suspended, and behind on their returns. */
export const SUSPENDED_SUPPLIER = { partyId: "party-kpk", name: "Konkan Packaging LLP", gstin: syntheticGstin("27", "AABFK9012M"), stateCode: "27" };
/** Nilgiri Chemicals of Coimbatore — new to us, new registration, and just changed their bank. */
export const NEW_SUPPLIER = { partyId: "party-nlg", name: "Nilgiri Chemicals Private Limited", gstin: syntheticGstin("33", "AAGCN3456P"), stateCode: "33" };

/** A supplier we know nothing bad about: no disputes, nothing overdue, no bank changes. */
export const cleanHistory = (over: Partial<SupplierHistory> = {}): SupplierHistory => ({
  billsRecorded: 24,
  firstBillDate: "2024-06-11",
  totalOutstandingPaise: 0n,
  overdueDocuments: 0,
  oldestOverdueDays: 0,
  openDisputes: [],
  bankDetailChanges: [],
  ...over,
});

/** A history port that answers from a map, so a test states exactly what our books say. */
export const historyPortFrom = (byParty: Readonly<Record<string, SupplierHistory>>): SupplierHistoryPort => ({
  async historyFor(_companyId, partyId) {
    return byParty[partyId] ?? cleanHistory({ billsRecorded: 0, firstBillDate: undefined as never });
  },
});

/** The GST department as it will answer for these four suppliers. */
export const syntheticPortal = (): SyntheticGstConnector => new SyntheticGstConnector()
  .put(GOOD_SUPPLIER.gstin, {
    status: "ACTIVE", legalName: "Shree Ram Steels Private Limited", stateCode: "27",
    registeredOn: "2019-08-14", eInvoiceEnabled: false,
    filings: [
      { period: "07-2026", returnType: "GSTR1", status: "FILED", filedOn: "2026-08-11" },
      { period: "07-2026", returnType: "GSTR3B", status: "FILED", filedOn: "2026-08-20" },
    ],
  })
  .put(CANCELLED_SUPPLIER.gstin, {
    status: "CANCELLED", legalName: "Deccan Hardware Traders", stateCode: "29",
    registeredOn: "2018-04-02", statusChangedOn: "2026-03-12",
    filings: [{ period: "02-2026", returnType: "GSTR3B", status: "NOT_FILED" }],
  })
  .put(SUSPENDED_SUPPLIER.gstin, {
    status: "SUSPENDED", legalName: "Konkan Packaging LLP", stateCode: "27",
    registeredOn: "2021-01-19", statusChangedOn: "2026-07-01",
    filings: [
      { period: "06-2026", returnType: "GSTR3B", status: "NOT_FILED" },
      { period: "07-2026", returnType: "GSTR3B", status: "NOT_FILED" },
      { period: "07-2026", returnType: "GSTR1", status: "NOT_FILED" },
    ],
  })
  .put(NEW_SUPPLIER.gstin, {
    status: "ACTIVE", legalName: "Nilgiri Chemicals Private Limited", stateCode: "33",
    registeredOn: "2026-06-20", eInvoiceEnabled: true, filings: [],
  });

/** A working desk: the GST department behind #8's gateway, and somewhere to keep what it said. */
export const makeRiskDesk = (options: {
  readonly permissions?: readonly string[];
  readonly connector?: SyntheticGstConnector;
  readonly history?: Readonly<Record<string, SupplierHistory>>;
  readonly now?: string;
} = {}) => {
  const connector = options.connector ?? syntheticPortal();
  const gateway = new ConnectorGateway([connector], new SyntheticCredentialVault(), new StaticWebhookVerifier());
  const cache = new InMemoryGstinCache();
  const assessments = new InMemoryRiskAssessmentStore();
  const acknowledgements = new InMemoryRiskAcknowledgementStore();
  const policies = new InMemoryRiskPolicies();
  const audit = new InMemoryAuditPort();
  const clock = fixedClock(options.now ?? "2026-08-29T10:00:00.000Z");

  const service = new SupplierRiskService({
    gstin: gstinStatusAdapter({ gateway, cache, clock: () => clock.now() }),
    history: historyPortFrom(options.history ?? {
      [GOOD_SUPPLIER.partyId]: cleanHistory(),
      [CANCELLED_SUPPLIER.partyId]: cleanHistory({ billsRecorded: 3 }),
      [SUSPENDED_SUPPLIER.partyId]: cleanHistory({ billsRecorded: 8 }),
      [NEW_SUPPLIER.partyId]: cleanHistory({ billsRecorded: 0, firstBillDate: undefined as never }),
    }),
    assessments,
    acknowledgements,
    audit,
    clock,
  });

  return {
    connector, gateway, cache, assessments, acknowledgements, policies, audit, clock, service,
    actor: actorWith(options.permissions ?? RISK_PERMISSIONS),
    companyId: COMPANY as CompanyId,
  };
};
