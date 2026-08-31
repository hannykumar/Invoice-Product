/** Production-shaped in-memory composition used by the local HTTP surface. */
import { asId, fixedClock, isoDate, type CompanyId } from '@invoice/kernel';
import {
  InMemoryAuditPort,
  InMemoryLedgerStore,
  LedgerService,
  buildDefaultChart,
  defaultChartIdFactory,
  permissionPortFromActor,
  type Account,
  type ActorContext,
} from '@invoice/ledger';
import { InMemoryInventoryStore } from '../../../packages/inventory/src/repository.ts';
import { InventoryService } from '../../../packages/inventory/src/service.ts';
import type { StockItem, StockMasterData, Warehouse } from '../../../packages/inventory/src/ports.ts';
import { UnitRegistry, createDefaultUnitRegistry } from '../../../packages/masters/src/units.ts';
import { InMemoryPurchaseBillStore, purchaseInventoryPort } from '../../../packages/purchasing/src/posting-adapters.ts';
import { PurchasePostingService } from '../../../packages/purchasing/src/posting-service.ts';
import { ThreeWayMatchingService } from '../../../packages/purchasing/src/matching-service.ts';
import {
  InMemoryGoodsReceiptStore, InMemoryMatchApprovalStore, InMemoryMatchTolerances, InMemoryPurchaseOrderStore,
} from '../../../packages/purchasing/src/matching-adapters.ts';
import { SupplierRiskService } from '../../../packages/purchasing/src/supplier-risk-service.ts';
import {
  InMemoryGstinCache, InMemoryRiskAcknowledgementStore, InMemoryRiskAssessmentStore,
  SyntheticCredentialVault, SyntheticGstConnector, gstinStatusAdapter,
} from '../../../packages/purchasing/src/supplier-risk-adapters.ts';
import { ConnectorGateway, StaticWebhookVerifier } from '../../../packages/platform/src/connectors.ts';
import { ItcReconciliationService } from '../../../packages/itc/src/service.ts';
import {
  InMemoryImportBatches, InMemoryItcDecisions, InMemoryPortalRecords, gstr2bSignalPort,
  purchaseBillToBookDocument,
} from '../../../packages/itc/src/adapters.ts';
import type { BookPurchaseDocument, TaxPeriod } from '../../../packages/itc/src/types.ts';
import { EInvoiceService } from '../../../packages/gst/src/einvoice-service.ts';
import {
  InMemoryEInvoicePolicies, InMemoryEInvoiceStore, SyntheticIrp, irpAdapter,
} from '../../../packages/gst/src/einvoice-adapters.ts';
import { EwayBillService } from '../../../packages/transport/src/service.ts';
import {
  InMemoryConsolidatedTripStore, InMemoryEwayBillPolicies, InMemoryEwayBillStore,
  SyntheticEwayBillPortal, ewayBillAdapter,
} from '../../../packages/transport/src/adapters.ts';
import { VehicleSuitabilityService } from '../../../packages/transport/src/suitability-service.ts';
import {
  InMemoryVehicleRecordCache, InMemoryVehicleRecordConsents, InMemoryVehicleRecordFreshness,
  SyntheticVahanConnector, apiSetuVehicleAdapter,
} from '../../../packages/transport/src/vehicle-record-adapters.ts';
import {
  TRANSPORT_SUITABILITY_PURPOSE, VehicleRecordService,
} from '../../../packages/transport/src/vehicle-record-service.ts';
import { PERMITTED_VEHICLE_FIELDS } from '../../../packages/transport/src/vehicle-record-types.ts';
import {
  InMemorySuitabilityStore, InMemoryVehicleSuitabilityPolicies, SyntheticPlateReader,
  mastersVehicleAdapter,
} from '../../../packages/transport/src/suitability-adapters.ts';
import type { Vehicle } from '../../../packages/masters/src/types.ts';

export interface CompanySeed {
  readonly companyId: CompanyId;
  readonly branchId: ReturnType<typeof asId<'Branch'>>;
  readonly setupUserId: ReturnType<typeof asId<'User'>>;
  readonly name: string;
  readonly location: string;
  readonly gstin: string;
  readonly customerId: ReturnType<typeof asId<'Party'>>;
  readonly customerName: string;
  readonly customerGstin: string;
  readonly supplierId: ReturnType<typeof asId<'Party'>>;
  readonly supplierName: string;
  /** Synthetic throughout — built by `syntheticGstin`, belonging to no real taxpayer. */
  readonly supplierGstin?: string;
}

const ITEMS: readonly StockItem[] = [
  { itemId: 'TMT12', name: 'TMT Steel Bar 12mm', baseUnit: 'KGS', tracksBatches: false, tracksSerials: false },
  { itemId: 'SOAP', name: 'Herbal Bath Soap 100g', baseUnit: 'PCS', tracksBatches: false, tracksSerials: false },
  { itemId: 'FRT', name: 'Inward freight', baseUnit: 'NOS', tracksBatches: false, tracksSerials: false },
];

class CompanyMasters implements StockMasterData {
  readonly #units = createDefaultUnitRegistry();
  readonly #warehouse: Warehouse;

  constructor(location: string) {
    this.#warehouse = { warehouseId: 'wh-main', name: location };
    this.#units.registerConversion({ fromUnit: 'BOX', toUnit: 'PCS', numerator: 24n, denominator: 1n, itemId: 'SOAP' });
  }

  item(_companyId: CompanyId, itemId: string): StockItem | undefined { return ITEMS.find((item) => item.itemId === itemId); }
  warehouse(_companyId: CompanyId, warehouseId: string): Warehouse | undefined { return warehouseId === this.#warehouse.warehouseId ? this.#warehouse : undefined; }
  units(): UnitRegistry { return this.#units; }
}

/**
 * Invented registrations so every branch of #19 can be seen on screen without a real credential.
 * The GST numbers are structurally valid and belong to nobody.
 */
export const DEMO_REGISTRATIONS = [
  {
    label: 'Deccan Hardware Traders — registration cancelled in March',
    gstin: '29AAFCD1234K1ZN', name: 'Deccan Hardware Traders',
    payload: {
      status: 'CANCELLED', legalName: 'Deccan Hardware Traders', stateCode: '29',
      registeredOn: '2018-04-02', statusChangedOn: '2026-03-12',
      filings: [{ period: '02-2026', returnType: 'GSTR3B', status: 'NOT_FILED' }],
    },
  },
  {
    label: 'Konkan Packaging LLP — suspended, and behind on returns',
    gstin: '27AABFK9012M1Z6', name: 'Konkan Packaging LLP',
    payload: {
      status: 'SUSPENDED', legalName: 'Konkan Packaging LLP', stateCode: '27',
      registeredOn: '2021-01-19', statusChangedOn: '2026-07-01',
      filings: [
        { period: '06-2026', returnType: 'GSTR3B', status: 'NOT_FILED' },
        { period: '07-2026', returnType: 'GSTR3B', status: 'NOT_FILED' },
        { period: '07-2026', returnType: 'GSTR1', status: 'NOT_FILED' },
      ],
    },
  },
  {
    label: 'Nilgiri Chemicals — new registration, must issue e-invoices',
    gstin: '33AAGCN3456P1Z1', name: 'Nilgiri Chemicals Private Limited',
    payload: {
      status: 'ACTIVE', legalName: 'Nilgiri Chemicals Private Limited', stateCode: '33',
      registeredOn: '2026-06-20', eInvoiceEnabled: true, filings: [],
    },
  },
] as const;

const SETUP_PERMISSIONS = [
  'ledger.setup', 'ledger.post.purchase', 'ledger.post.sale', 'ledger.post.receipt', 'ledger.post.payment',
  'ledger.post.journal', 'ledger.reverse', 'inventory.move', 'inventory.adjust', 'inventory.override_negative',
  'ledger.post.credit_note', 'ledger.post.debit_note', 'returns.create',
  'sales.draft.write', 'sales.finalise', 'sales.approve', 'sales.cancel', 'payments.record', 'payments.allocate',
  'payments.reverse', 'payments.write_off', 'dashboard.read',
  'notification.send', 'collections.manage', 'collections.send',
  'collections.reminders.view', 'collections.reminders.send', 'collections.promise.record', 'collections.dispute.manage',
  'bank.balance.read', 'bank.feed.manage', 'bank.feed.sync',
  'purchase.order.write', 'purchase.order.cancel', 'purchase.receipt.write', 'purchase.match.approve',
  'supplier.risk.view', 'supplier.risk.acknowledge',
  'einvoice.view', 'einvoice.generate', 'einvoice.cancel',
  'itc.view', 'itc.import', 'itc.decide', 'itc.claim_at_risk',
  'eway.view', 'eway.generate', 'eway.update', 'eway.cancel',
  'transport.vehicle.view', 'transport.vehicle.check', 'transport.vehicle.override', 'transport.vehicle.connect',
];

/**
 * Issue #28. The shop's own lorry, as its vehicle master holds it.
 *
 * Deliberately a vehicle the registering authority's synthetic service has never heard of, so the
 * screen shows what happens when the only capacity anybody holds is the business's own note.
 */
const OWN_VEHICLES: readonly Omit<Vehicle, 'companyId'>[] = [
  { id: 'veh-own-1', registrationNumber: 'KA09OW5566', vehicleType: 'regular', bodyType: 'closed', ratedCapacityKg: 1500, active: true },
];

export async function createCompanyShop(seed: CompanySeed) {
  const store = new InMemoryLedgerStore();
  const inventory = new InMemoryInventoryStore();
  const bills = new InMemoryPurchaseBillStore();
  const orders = new InMemoryPurchaseOrderStore();
  const receipts = new InMemoryGoodsReceiptStore();
  const approvals = new InMemoryMatchApprovalStore();
  store.join(inventory).join(bills).join(orders).join(receipts).join(approvals);
  const audit = new InMemoryAuditPort();
  const clock = fixedClock('2026-08-29T10:00:00.000Z');
  const masters = new CompanyMasters(seed.location);
  const ledger = new LedgerService({ store, permissions: permissionPortFromActor, audit, clock });
  let sequence = 0;
  const inventoryService = new InventoryService({
    store,
    inventory,
    masterData: masters,
    permissions: permissionPortFromActor,
    audit,
    clock,
    policy: { negativeStock: 'BLOCK', reservationMinutes: 120, valuationMethod: 'WEIGHTED_AVERAGE' },
    idFactory: () => `${seed.companyId}:movement:${sequence += 1}`,
  });
  const posting = new PurchasePostingService({
    store,
    ledger,
    inventory: purchaseInventoryPort(inventoryService, masters),
    bills,
    audit,
    clock,
    // No nominated codes: issue #73 put PURCHASES_SERVICES and REVERSE_CHARGE_PAYABLE in the
    // standard chart, and the posting service finds them by role.
    idFactory: () => `${seed.companyId}:bill:${sequence += 1}`,
  });
  // Issue #18. One per company, sharing this company's store and godown, so an order raised on
  // the screen and the stock it later moves are the same records the tests exercise.
  const matching = new ThreeWayMatchingService({
    store,
    inventory: purchaseInventoryPort(inventoryService, masters),
    orders, receipts, approvals,
    audit,
    clock,
    tolerance: new InMemoryMatchTolerances(),
    idFactory: () => `${seed.companyId}:doc:${sequence += 1}`,
  });
  const riskAssessments = new InMemoryRiskAssessmentStore();
  const riskAcknowledgements = new InMemoryRiskAcknowledgementStore();
  store.join(riskAssessments).join(riskAcknowledgements);

  /**
   * What our own books say about a supplier, read from the bills #17 actually posted.
   *
   * Real data, not a fixture: "first time supplier" on the screen means this company genuinely has
   * no earlier bill from them. Bank-detail changes come from #5's master version history, which
   * the demo company does not populate, so that list is empty here rather than invented.
   */
  const supplierHistory = {
    async historyFor(companyId: CompanyId, partyId: string, on: string) {
      const posted = (await bills.listForParty(companyId, partyId)).filter((bill) => bill.state === 'POSTED');
      const overdue = posted.filter((bill) => bill.dueDate < on);
      const oldest = overdue.reduce((days, bill) => {
        const late = Math.floor((new Date(`${on}T00:00:00Z`).getTime() - new Date(`${bill.dueDate}T00:00:00Z`).getTime()) / 86_400_000);
        return late > days ? late : days;
      }, 0);
      const dates = posted.map((bill) => bill.invoiceDate).sort();
      return {
        billsRecorded: posted.length,
        ...(dates[0] === undefined ? {} : { firstBillDate: dates[0] }),
        totalOutstandingPaise: posted.reduce((sum, bill) => sum + bill.totalPaise, 0n),
        overdueDocuments: overdue.length,
        oldestOverdueDays: oldest,
        openDisputes: [],
        bankDetailChanges: [],
      };
    },
  };

  // Issue #19. The GST department sits behind #8's gateway even here: development runs against a
  // synthetic portal whose GST numbers belong to nobody, so no credential is needed to try this.
  const portal = new SyntheticGstConnector();
  // Four registrations the Deliveries and Supplier-check screens can be tried against. Every
  // number is invented; nothing here corresponds to a real taxpayer.
  if (seed.supplierGstin !== undefined) {
    portal.put(seed.supplierGstin, {
      status: 'ACTIVE', legalName: seed.supplierName, stateCode: seed.supplierGstin.slice(0, 2),
      registeredOn: '2019-08-14', eInvoiceEnabled: false,
      filings: [
        { period: '07-2026', returnType: 'GSTR1', status: 'FILED', filedOn: '2026-08-11' },
        { period: '07-2026', returnType: 'GSTR3B', status: 'FILED', filedOn: '2026-08-20' },
      ],
    });
  }
  for (const demo of DEMO_REGISTRATIONS) portal.put(demo.gstin, demo.payload);
  /**
   * Issue #31. The purchase comparison, over the bills this company has actually posted.
   *
   * The supplier's registration comes from the seed rather than being guessed from the bill: a
   * purchase whose supplier we have no GST number for is reported as uncomparable, which is the
   * honest answer and the one the screen shows.
   */
  const itcRecords = new InMemoryPortalRecords();
  const itcBatches = new InMemoryImportBatches();
  const itcDecisions = new InMemoryItcDecisions();
  const gstinOfParty = (partyId: string): string | null =>
    partyId === seed.supplierId && seed.supplierGstin !== undefined ? seed.supplierGstin : null;
  const itc = new ItcReconciliationService({
    books: {
      async documentsFor(companyId: CompanyId, period: TaxPeriod): Promise<readonly BookPurchaseDocument[]> {
        const posted = await bills.list(companyId);
        return posted
          .filter((bill) => bill.invoiceDate.slice(0, 7) === period)
          .map((bill) => purchaseBillToBookDocument(
            {
              id: bill.id, companyId: bill.companyId, supplierPartyId: bill.supplierPartyId,
              supplierName: bill.supplierName, invoiceNumber: bill.invoiceNumber,
              invoiceDate: bill.invoiceDate, totalPaise: bill.totalPaise, state: bill.state,
              voucherId: bill.voucherId,
              tax: {
                taxableValuePaise: bill.tax.taxableValuePaise, cgstPaise: bill.tax.cgstPaise,
                sgstPaise: bill.tax.sgstPaise, igstPaise: bill.tax.igstPaise, cessPaise: bill.tax.cessPaise,
                ineligibleItcPaise: bill.tax.ineligibleItcPaise, reverseCharge: bill.tax.reverseCharge,
              },
            },
            { gstin: gstinOfParty(bill.supplierPartyId) },
          ));
      },
    },
    records: itcRecords,
    batches: itcBatches,
    decisions: itcDecisions,
    audit,
    clock,
    idFactory: () => `${seed.companyId}:itc:${sequence += 1}`,
  });

  const risk = new SupplierRiskService({
    gstin: gstinStatusAdapter({
      gateway: new ConnectorGateway([portal], new SyntheticCredentialVault(), new StaticWebhookVerifier()),
      cache: new InMemoryGstinCache(),
      clock: () => clock.now(),
    }),
    history: supplierHistory,
    assessments: riskAssessments,
    acknowledgements: riskAcknowledgements,
    audit,
    clock,
    // Issue #31's signal, now that it exists. Before this the supplier check said on every
    // assessment that GSTR-2B had not been looked at, which was true and not much use.
    gstr2b: gstr2bSignalPort(itc),
  });
  // Issue #26. The Invoice Registration Portal behind #8's gateway; development runs against a
  // synthetic one that computes real IRNs, so the verification in `irn.ts` is genuinely exercised.
  const irpPortal = new SyntheticIrp(() => clock.now());
  const eInvoices = new InMemoryEInvoiceStore();
  const eInvoicePolicies = new InMemoryEInvoicePolicies();
  store.join(eInvoices);
  const eInvoice = new EInvoiceService({
    irp: irpAdapter({
      gateway: new ConnectorGateway([irpPortal], new SyntheticCredentialVault(), new StaticWebhookVerifier()),
      clock: () => clock.now(),
    }),
    records: eInvoices,
    audit,
    clock,
    policy: eInvoicePolicies,
    idFactory: () => `${seed.companyId}:einv:${sequence += 1}`,
  });
  // Issue #27. The e-way bill portal behind the same gateway; development runs against a synthetic
  // one that enforces the real windows, so expiry and the 24-hour cancellation are genuinely tried.
  const ewayPortal = new SyntheticEwayBillPortal(() => clock.now());
  const ewayBills = new InMemoryEwayBillStore();
  const ewayTrips = new InMemoryConsolidatedTripStore();
  const ewayPolicies = new InMemoryEwayBillPolicies();
  store.join(ewayBills).join(ewayTrips);
  const ewayBill = new EwayBillService({
    portal: ewayBillAdapter({
      gateway: new ConnectorGateway([ewayPortal], new SyntheticCredentialVault(), new StaticWebhookVerifier()),
      clock: () => clock.now(),
    }),
    records: ewayBills,
    trips: ewayTrips,
    audit,
    clock,
    policy: ewayPolicies,
    idFactory: () => `${seed.companyId}:ewb:${sequence += 1}`,
  });
  // Issue #29. The registering authority, reached the way production reaches it: this product's
  // verification service, over issue #8's connector gateway, with a synthetic VAHAN at the far end.
  // Only that last hop is fake, so the consent check, the field narrowing, the masking, the caching
  // and the audit trail are all the real ones on the screen.
  const vahan = new SyntheticVahanConnector();
  const vehicleRecordCache = new InMemoryVehicleRecordCache();
  const vehicleRecordConsents = new InMemoryVehicleRecordConsents();
  const vehicleRecordFreshness = new InMemoryVehicleRecordFreshness();
  const vehicleRecords = new VehicleRecordService({
    provider: apiSetuVehicleAdapter({
      gateway: new ConnectorGateway([vahan], new SyntheticCredentialVault(), new StaticWebhookVerifier()),
      clock: () => clock.now(),
    }),
    cache: vehicleRecordCache,
    consent: vehicleRecordConsents,
    freshness: vehicleRecordFreshness,
    audit,
    clock,
  });
  // The shop connected the service when it was set up, and agreed to the whole allow-list. A
  // business that had not would see "we could not ask", which is its own state on the screen.
  vehicleRecordConsents.seed({
    companyId: seed.companyId,
    purpose: TRANSPORT_SUITABILITY_PURPOSE,
    fields: [...PERMITTED_VEHICLE_FIELDS],
    grantedBy: seed.setupUserId,
    grantedAt: clock.now().toISOString(),
    credentialReference: `vault://vehicle/${seed.companyId}`,
  });
  const setupActor: ActorContext = {
    companyId: seed.companyId,
    branchId: seed.branchId,
    userId: seed.setupUserId,
    permissions: SETUP_PERMISSIONS,
  };
  const plateReader = new SyntheticPlateReader();
  const vehicleChecks = new InMemorySuitabilityStore();
  const vehiclePolicies = new InMemoryVehicleSuitabilityPolicies();
  store.join(vehicleChecks);
  const vehicleSuitability = new VehicleSuitabilityService({
    records: vehicleChecks,
    audit,
    clock,
    // The person running the check is passed with each lookup; this is only the fallback for a
    // caller that does not name one.
    vehicleRecords: vehicleRecords.portFor(setupActor),
    vehicleMaster: mastersVehicleAdapter(() => OWN_VEHICLES.map((vehicle) => ({ ...vehicle, companyId: seed.companyId })), () => clock.now()),
    plateOcr: plateReader,
    policy: vehiclePolicies,
    idFactory: () => `${seed.companyId}:vsc:${sequence += 1}`,
  });
  const chart = buildDefaultChart(seed.companyId, defaultChartIdFactory(seed.companyId));
  const liabilities = chart.find((account) => account.code === '2000');
  const bankParent = chart.find((account) => account.code === '1120');
  const additions: Account[] = [
    {
      id: asId<'Account'>(`${seed.companyId}:acc:1121`), companyId: seed.companyId, code: '1121',
      name: 'Current bank account', type: 'ASSET', parentId: bankParent?.id ?? null,
      isGroup: false, active: true, partyId: null, systemRole: null,
    },
  ];
  await ledger.initialiseCompany(setupActor, { booksStartDate: isoDate('2026-04-01'), accounts: [...chart, ...additions] });
  await ledger.openPartyAccount(setupActor, { partyId: seed.supplierId, name: seed.supplierName, kind: 'SUPPLIER' });
  await ledger.openPartyAccount(setupActor, { partyId: seed.customerId, name: seed.customerName, kind: 'CUSTOMER' });
  return {
    store, inventory, inventoryService, bills, orders, receipts, approvals, audit, clock, ledger, posting,
    matching, masters, risk, portal, riskAssessments, riskAcknowledgements,
    itc, itcRecords, itcBatches, itcDecisions,
    eInvoice, eInvoices, eInvoicePolicies, irpPortal,
    ewayBill, ewayBills, ewayTrips, ewayPolicies, ewayPortal,
    vehicleSuitability, vehicleChecks, vehiclePolicies, vehicleRecords, vehicleRecordCache,
    vehicleRecordConsents, vehicleRecordFreshness, vahan, plateReader, setupActor,
  };
}
