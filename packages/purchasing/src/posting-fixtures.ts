/**
 * Issue #17 [E17] — a Bengaluru trader who buys steel from Pune and soap from down the road.
 *
 * Synthetic throughout: the GSTIN is built by `syntheticGstin`, so no real taxpayer appears here.
 * Kept in `src` beside `masters/src/fixtures.ts` so the demo and the tests share one world.
 */
import { asId, fixedClock, isoDate, type CompanyId } from "@invoice/kernel";
import {
  InMemoryAuditPort, InMemoryLedgerStore, LedgerService, buildDefaultChart, defaultChartIdFactory,
  permissionPortFromActor, type Account, type ActorContext,
} from "@invoice/ledger";
import { InMemoryInventoryStore } from "../../inventory/src/repository.ts";
import { InventoryService } from "../../inventory/src/service.ts";
import type { StockItem, StockMasterData, Warehouse } from "../../inventory/src/ports.ts";
import { UnitRegistry, createDefaultUnitRegistry, quantity } from "../../masters/src/units.ts";
import { syntheticGstin } from "../../masters/src/fixtures.ts";
import { InMemoryPurchaseBillStore, purchaseInventoryPort } from "./posting-adapters.ts";
import { PurchasePostingService } from "./posting-service.ts";
import type { ApprovedPurchase, ApprovedPurchaseLine } from "./posting-types.ts";
import type { PurchaseVerdict } from "./validation-types.ts";

export const COMPANY: CompanyId = asId<"Company">("sampoorna");
export const OTHER: CompanyId = asId<"Company">("konkan");
const OWNER = asId<"User">("ravi");

export const SUPPLIER_GSTIN = syntheticGstin("27", "AAECS5678D");
export const SUPPLIER = "party-srs";

export const ALL_PERMISSIONS = [
  "ledger.setup", "ledger.post.purchase", "ledger.reverse",
  "inventory.move", "inventory.adjust", "inventory.override_negative",
];

export const actorWith = (permissions: readonly string[], companyId: CompanyId = COMPANY): ActorContext => ({
  companyId, branchId: asId<"Branch">("main"), userId: OWNER, permissions,
});

const ITEMS: StockItem[] = [
  { itemId: "TMT12", name: "TMT Steel Bar 12mm", baseUnit: "KGS", tracksBatches: false, tracksSerials: false },
  { itemId: "SOAP", name: "Herbal Bath Soap 100g", baseUnit: "PCS", tracksBatches: true, tracksSerials: false },
  { itemId: "FRT", name: "Inward freight", baseUnit: "NOS", tracksBatches: false, tracksSerials: false },
];
const WAREHOUSES: Warehouse[] = [
  { warehouseId: "wh-main", name: "Peenya godown" },
  // Where returned goods that cannot be sold again are put. A separate place rather than a flag,
  // because the whole point is that the saleable balance must not include them (#44).
  { warehouseId: "wh-quarantine", name: "Quarantine shelf" },
];

export class Masters implements StockMasterData {
  readonly #registry: UnitRegistry;
  constructor() {
    this.#registry = createDefaultUnitRegistry();
    // One box of this soap is twenty-four pieces. Item-specific, never universal.
    this.#registry.registerConversion({ fromUnit: "BOX", toUnit: "PCS", numerator: 24n, denominator: 1n, itemId: "SOAP" });
  }
  item(_c: CompanyId, itemId: string): StockItem | undefined { return ITEMS.find((i) => i.itemId === itemId); }
  warehouse(_c: CompanyId, warehouseId: string): Warehouse | undefined { return WAREHOUSES.find((w) => w.warehouseId === warehouseId); }
  units(): UnitRegistry { return this.#registry; }
}

let counter = 0;

export const makeShop = async (options: { permissions?: readonly string[] } = {}) => {
  const store = new InMemoryLedgerStore();
  const inventory = new InMemoryInventoryStore();
  const bills = new InMemoryPurchaseBillStore();
  store.join(inventory).join(bills);
  const audit = new InMemoryAuditPort();
  const clock = fixedClock("2026-08-29T10:00:00.000Z");
  counter += 1;
  let n = 0;

  const masters = new Masters();
  const ledger = new LedgerService({ store, permissions: permissionPortFromActor, audit, clock });
  const inventoryService = new InventoryService({
    store, inventory, masterData: new Masters(), permissions: permissionPortFromActor, audit, clock,
    policy: { negativeStock: "BLOCK", reservationMinutes: 120, valuationMethod: "WEIGHTED_AVERAGE" },
    idFactory: () => `mv${counter}-${String((n += 1)).padStart(4, "0")}`,
  });
  const posting = new PurchasePostingService({
    store, ledger, inventory: purchaseInventoryPort(inventoryService, masters), bills, audit, clock,
    // No nominated codes any more: issue #73 put PURCHASES_SERVICES and REVERSE_CHARGE_PAYABLE in
    // the standard chart, and the role lookup finds them.
    idFactory: () => `bill${counter}-${String((n += 1)).padStart(4, "0")}`,
  });

  const setup = actorWith(ALL_PERMISSIONS);
  const chart = buildDefaultChart(COMPANY, defaultChartIdFactory(COMPANY));
  await ledger.initialiseCompany(setup, {
    booksStartDate: isoDate("2026-04-01"),
    accounts: chart,
  });
  await ledger.openPartyAccount(setup, { partyId: SUPPLIER, name: "Shree Ram Steels Private Limited", kind: "SUPPLIER" });

  return {
    store, inventory, inventoryService, bills, audit, ledger, posting,
    actor: actorWith(options.permissions ?? ALL_PERMISSIONS),
  };
};

/** A verdict that cleared, with the tax split decided by the rules engine. */
export const clearedVerdict = (over: Partial<PurchaseVerdict> = {}): PurchaseVerdict => ({
  draftId: "draft-1",
  companyId: COMPANY,
  status: "POSTABLE",
  findings: [],
  duplicate: { verdict: "NONE", matches: [], fingerprint: "fp-1", message: "Nothing like this has been entered before." },
  recomputed: { taxableValuePaise: 0n, totalTaxPaise: 0n, invoiceTotalPaise: 0n, linesTaxableValuePaise: [], lineProblems: [], complete: true },
  taxCheck: { basis: "RULES_ENGINE", intraState: false, ruleSetVersion: "gst-2026.1", ruleId: "POS.INTERSTATE", explanation: "Supplier is in Maharashtra and the goods came to Karnataka." },
  corrections: [],
  policy: { roundingPaise: 100n, taxAbsolutePaise: 100n, totalAbsolutePaise: 100n, totalRelativeBasisPoints: 10, effectiveFrom: "2026-04-01" },
  fingerprint: "v-1",
  summary: "Everything on this bill adds up.",
  ...over,
});

type LineOver = { [K in keyof ApprovedPurchaseLine]?: ApprovedPurchaseLine[K] | undefined };

export const steelLine = (over: LineOver = {}): ApprovedPurchaseLine => {
  const merged: Record<string, unknown> = {
    lineNumber: 1, itemId: "TMT12", description: "TMT Steel Bar 12mm", hsnSac: "72142090",
    quantity: quantity("500", "KGS"), ratePaise: 6_400n, taxableValuePaise: 32_000_00n,
    gstRateBasisPoints: 1800, itcEligibility: "ELIGIBLE", supplyKind: "GOODS", warehouseId: "wh-main",
    ...over,
  };
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key];
  return merged as unknown as ApprovedPurchaseLine;
};

export const purchase = (over: Partial<ApprovedPurchase> = {}): ApprovedPurchase => ({
  id: "pur-1",
  companyId: COMPANY,
  sourceDocumentId: "doc-1",
  verdict: clearedVerdict(),
  supplierPartyId: SUPPLIER,
  supplierName: "Shree Ram Steels Private Limited",
  supplierGstin: SUPPLIER_GSTIN,
  invoiceNumber: "SRS/2026/0042",
  invoiceDate: "2026-07-21",
  lines: [steelLine()],
  invoiceTotalPaise: 37_760_00n,
  taxLiability: "SUPPLIER",
  creditDays: 45,
  approvedBy: "ravi",
  approvedAt: "2026-07-22T10:00:00.000Z",
  ...over,
});
