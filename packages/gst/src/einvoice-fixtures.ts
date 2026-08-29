/**
 * Issue #26 [E26] — a Bengaluru trader that has crossed the turnover limit, and one that has not.
 *
 * Every GSTIN is built by `syntheticGstin`: structurally valid, checksum-correct, belonging to
 * nobody. The portal is synthetic and behind #8's real gateway, so no production credential is
 * needed to run or test anything here.
 */
import { fixedClock, asId, type CompanyId } from "@invoice/kernel";
import { InMemoryAuditPort } from "@invoice/ledger";
import { ConnectorGateway, StaticWebhookVerifier } from "../../platform/src/connectors.ts";
import { syntheticGstin } from "../../masters/src/fixtures.ts";
import {
  InMemoryEInvoicePolicies, InMemoryEInvoiceStore, SyntheticIrp, SyntheticIrpVault, irpAdapter,
} from "./einvoice-adapters.ts";
import { EInvoiceService } from "./einvoice-service.ts";
import type { EInvoiceApplicabilityInput } from "./einvoice-types.ts";
import type { EInvoiceDocument, EInvoiceLine, PartyDetails } from "./payload.ts";

/** Drops keys explicitly set to `undefined`, so an override can remove a field entirely. */
const dropUndefined = <T>(value: object): T => {
  const out: Record<string, unknown> = { ...value };
  for (const [key, item] of Object.entries(out)) if (item === undefined) delete out[key];
  return out as T;
};

export const COMPANY: CompanyId = asId<"Company">("sampoorna");
export const OWNER = asId<"User">("ravi");

export const ALL_EINVOICE_PERMISSIONS = ["einvoice.view", "einvoice.generate", "einvoice.cancel"];

export const actorWith = (permissions: readonly string[], companyId: CompanyId = COMPANY) => ({
  companyId, branchId: asId<"Branch">("main"), userId: OWNER, permissions,
});

export const SUPPLIER_GSTIN = syntheticGstin("29", "AAECS5678D");
export const BUYER_GSTIN = syntheticGstin("27", "AAFCD1234K");

export const SELLER: PartyDetails = {
  gstin: SUPPLIER_GSTIN,
  legalName: "Sampoorna Traders Private Limited",
  tradeName: "Sampoorna Traders",
  address1: "14, Peenya Industrial Area, Phase 2",
  location: "Bengaluru",
  pincode: "560058",
  stateCode: "29",
  phone: "9845012345",
  email: "billing@sampoorna.example.invalid",
};

export const BUYER: PartyDetails = {
  gstin: BUYER_GSTIN,
  legalName: "Deccan Hardware Traders",
  address1: "22, Laxmi Road",
  location: "Pune",
  pincode: "411030",
  stateCode: "27",
};

/** Two hundred bags of cement at ₹410, 28% GST, sold from Karnataka into Maharashtra. */
export const cementLine = (over: Partial<EInvoiceLine> = {}): EInvoiceLine => ({
  lineNumber: 1,
  description: "OPC 53 Grade Cement 50kg",
  isService: false,
  hsnOrSac: "25232930",
  quantity: "200",
  unit: "BAG",
  unitPricePaise: 410_00n,
  grossAmountPaise: 82_000_00n,
  discountPaise: 0n,
  taxableValuePaise: 82_000_00n,
  gstRatePercentTimes100: 2800n,
  cgstPaise: 0n,
  sgstPaise: 0n,
  igstPaise: 22_960_00n,
  cessPaise: 0n,
  lineTotalPaise: 104_960_00n,
  ...over,
});

export const invoiceDocument = (over: Partial<EInvoiceDocument> = {}): EInvoiceDocument => ({
  documentId: "inv-001",
  documentType: "INVOICE",
  documentNumber: "SAM/2026/0117",
  documentDate: "2026-08-21",
  recipientKind: "B2B",
  supplier: SELLER,
  recipient: BUYER,
  placeOfSupplyStateCode: "27",
  reverseCharge: false,
  lines: [cementLine()],
  totalTaxableValuePaise: 82_000_00n,
  totalCgstPaise: 0n,
  totalSgstPaise: 0n,
  totalIgstPaise: 22_960_00n,
  totalCessPaise: 0n,
  roundOffPaise: 0n,
  invoiceValuePaise: 104_960_00n,
  ...over,
});

/** Overrides may name a field as `undefined` to leave it off, as the other fixtures do. */
type Overrides<T> = { [K in keyof T]?: T[K] | undefined };

/** A business turning over ₹8 crore: above the ₹5 crore limit, so it must report. */
export const aboveThreshold = (over: Overrides<EInvoiceApplicabilityInput> = {}): EInvoiceApplicabilityInput => dropUndefined({
  documentType: "INVOICE",
  documentDate: "2026-08-21",
  recipientKind: "B2B",
  recipientGstin: BUYER_GSTIN,
  supplier: {
    gstin: SUPPLIER_GSTIN,
    aggregateTurnoverPaise: 8_00_00_000_00n,
    turnoverFinancialYear: "2025-2026",
  },
  ...over,
});

/** A business turning over ₹90 lakh: an ordinary small trader, which needs no IRN at all. */
export const belowThreshold = (over: Overrides<EInvoiceApplicabilityInput> = {}): EInvoiceApplicabilityInput =>
  aboveThreshold({
    supplier: { gstin: SUPPLIER_GSTIN, aggregateTurnoverPaise: 90_00_000_00n, turnoverFinancialYear: "2025-2026" },
    ...over,
  });

/** A working desk: the portal behind #8's gateway, and somewhere to keep what it said. */
export const makeEInvoiceDesk = (options: { readonly permissions?: readonly string[]; readonly now?: string } = {}) => {
  const clock = fixedClock(options.now ?? "2026-08-21T10:00:00.000Z");
  const portal = new SyntheticIrp(() => clock.now());
  const gateway = new ConnectorGateway([portal], new SyntheticIrpVault(), new StaticWebhookVerifier());
  const records = new InMemoryEInvoiceStore();
  const policies = new InMemoryEInvoicePolicies();
  const audit = new InMemoryAuditPort();
  let sequence = 0;

  const service = new EInvoiceService({
    irp: irpAdapter({ gateway, clock: () => clock.now() }),
    records, audit, clock, policy: policies,
    idFactory: () => `einv-${String((sequence += 1)).padStart(4, "0")}`,
  });

  return {
    portal, gateway, records, policies, audit, clock, service,
    actor: actorWith(options.permissions ?? ALL_EINVOICE_PERMISSIONS),
  };
};
