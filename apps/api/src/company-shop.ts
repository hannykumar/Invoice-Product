/**
 * One company's books, stock, purchases and GST records, composed over memory (the demo and the
 * tests) or over PostgreSQL (issue #340), behind the same ports either way.
 */
import { randomUUID } from 'node:crypto';
import { asId, isoDate, type CompanyId } from '@invoice/kernel';
import { appClock } from './app-clock.ts';
import {
  InMemoryAuditPort,
  InMemoryLedgerStore,
  LedgerService,
  PostgresLedgerStore,
  type TransactionParticipant,
  buildDefaultChart,
  defaultChartIdFactory,
  permissionPortFromActor,
  type Account,
  type ActorContext,
} from '@invoice/ledger';
import { InMemoryInventoryStore } from '../../../packages/inventory/src/repository.ts';
import { PostgresInventoryStore } from '../../../packages/inventory/src/postgres-store.ts';
import {
  PostgresGoodsReceiptRepository, PostgresGstinCache, PostgresMatchApprovalRepository, PostgresMatchTolerances,
  PostgresPurchaseBillRepository, PostgresPurchaseOrderRepository, PostgresRiskAcknowledgementRepository,
  PostgresRiskAssessmentRepository,
} from '../../../packages/purchasing/src/postgres-repositories.ts';
import { PostgresImportBatches, PostgresItcClaims, PostgresItcDecisions, PostgresPortalRecords } from '../../../packages/itc/src/postgres-repository.ts';
import { PostgresReturnNoteRepository } from '../../../packages/returns/src/postgres-repository.ts';
import { PostgresEInvoicePolicies, PostgresEInvoiceRepository } from '../../../packages/gst/src/einvoice-postgres.ts';
import {
  PostgresConsolidatedTripRepository, PostgresEwayBillPolicies, PostgresEwayBillRepository, PostgresSuitabilityRepository,
  PostgresVehicleRecordCache, PostgresVehicleRecordConsents, PostgresVehicleRecordFreshness, PostgresVehicleSuitabilityPolicies,
} from '../../../packages/transport/src/postgres-repositories.ts';
import { PostgresAuditLog } from '../../../packages/platform/src/postgres-audit.ts';
import { PostgresVersionedStore } from '../../../packages/masters/src/postgres-masters.ts';
import type { TransactionalExecutor } from '../../../packages/platform/src/database.ts';
import { MEMORY, recordId, stableUuid, type Persistence } from './persistence.ts';
import { InventoryService } from '../../../packages/inventory/src/service.ts';
import { ledgerStockBooks } from '../../../packages/inventory/src/ledger-adapter.ts';
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
  InMemoryImportBatches, InMemoryItcClaims, InMemoryItcDecisions, InMemoryPortalRecords, gstr2bSignalPort,
  purchaseBillToBookDocument, purchaseReturnToBookDocument,
} from '../../../packages/itc/src/adapters.ts';
import { InMemoryReturnNoteRepository } from '../../../packages/returns/src/repository.ts';
import type { BookPurchaseDocument, TaxPeriod } from '../../../packages/itc/src/types.ts';
import { EInvoiceService } from '../../../packages/gst/src/einvoice-service.ts';
import {
  InMemoryEInvoicePolicies, InMemoryEInvoiceStore, SyntheticIrp, irpAdapter,
} from '../../../packages/gst/src/einvoice-adapters.ts';
import { openWhitebooksCredentialVault, whitebooksIrpConnectorFromVault } from '../../../packages/gst/src/whitebooks-connector.ts';
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
import type { Vehicle, Warehouse as MasterWarehouse } from '../../../packages/masters/src/types.ts';
import { billingAddressOf, items as catalogueItems, suppliers, type CatalogueSeed } from './catalogue-application.ts';
import { businessDetailsOf, turnoverAnswerForYear } from './business-details-application.ts';

// Read once when the application starts. An absent file keeps local development synthetic.
const whitebooksVault = openWhitebooksCredentialVault();

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
  /** Issue #181 — the customer and items this company opens with, as master-data records. */
  readonly catalogue: CatalogueSeed;
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

  constructor(location: string, warehouseId: string, soapIds: readonly string[]) {
    this.#warehouse = { warehouseId, name: location };
    // One box of this soap is 24 pieces, whichever of its ids a screen names it by.
    for (const itemId of ['SOAP', ...soapIds]) {
      this.#units.registerConversion({ fromUnit: 'BOX', toUnit: 'PCS', numerator: 24n, denominator: 1n, itemId });
    }
  }

  /**
   * Issue #181 — stock is held against the items the business keeps, so an item somebody added is
   * an item that can be sold, returned and counted. The three short ids below are the purchase
   * screens' own catalogue, which is separate.
   */
  item(companyId: CompanyId, itemId: string): StockItem | undefined {
    const fromCatalogue = catalogueItems(companyId).find((item) => item.id === itemId);
    if (fromCatalogue !== undefined) {
      return { itemId, name: fromCatalogue.name, baseUnit: fromCatalogue.baseUnit, tracksBatches: fromCatalogue.trackBatches, tracksSerials: fromCatalogue.trackSerials };
    }
    return ITEMS.find((item) => item.itemId === itemId);
  }
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
  'ledger.post.journal', 'ledger.reverse', 'inventory.move', 'inventory.adjust',
  'ledger.post.credit_note', 'ledger.post.debit_note', 'returns.create',
  'sales.draft.write', 'sales.finalise', 'sales.approve', 'sales.cancel', 'payments.record', 'payments.allocate',
  'payments.reverse', 'payments.write_off', 'dashboard.read',
  'notification.send', 'collections.manage', 'collections.send',
  'collections.reminders.view', 'collections.reminders.send', 'collections.promise.record', 'collections.dispute.manage',
  'bank.balance.read', 'bank.feed.manage', 'bank.feed.sync',
  'purchase.order.write', 'purchase.order.cancel', 'purchase.receipt.write', 'purchase.match.approve', 'purchase.inbox.manage',
  'supplier.risk.view', 'supplier.risk.acknowledge',
  'einvoice.view', 'einvoice.generate', 'einvoice.cancel',
  'itc.view', 'itc.import', 'itc.decide', 'itc.claim_at_risk',
  'eway.view', 'eway.generate', 'eway.update', 'eway.cancel', 'challan.issue', 'challan.cancel',
  'quotation.issue', 'quotation.cancel', 'proforma.issue', 'proforma.cancel',
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

/** The main godown's id: `wh-main` in memory, a stable UUID in PostgreSQL. */
export const mainWarehouseId = (persistence: Persistence, companyId: string): string => recordId(persistence, companyId, 'wh-main');

export async function createCompanyShop(seed: CompanySeed, persistence: Persistence = MEMORY) {
  // Issue #340 — every store with a PostgreSQL repository uses it when the app has a database. The
  // in-memory ledger store rolls its participants back together; on PostgreSQL the unit of work does.
  const db: TransactionalExecutor | null = persistence.kind === 'postgres' ? persistence.db : null;
  const pick = <M, P>(memory: () => M, postgres: (db: TransactionalExecutor) => P): M | P => db === null ? memory() : postgres(db);
  const store = pick(() => new InMemoryLedgerStore(), (db) => new PostgresLedgerStore(db));
  const participate = (...participants: readonly unknown[]): void => {
    if (store instanceof InMemoryLedgerStore) for (const participant of participants) store.join(participant as TransactionParticipant);
  };
  const inventory = pick(() => new InMemoryInventoryStore(), (db) => new PostgresInventoryStore(db));
  const bills = pick(() => new InMemoryPurchaseBillStore(), (db) => new PostgresPurchaseBillRepository(db));
  const orders = pick(() => new InMemoryPurchaseOrderStore(), (db) => new PostgresPurchaseOrderRepository(db));
  const receipts = pick(() => new InMemoryGoodsReceiptStore(), (db) => new PostgresGoodsReceiptRepository(db));
  const approvals = pick(() => new InMemoryMatchApprovalStore(), (db) => new PostgresMatchApprovalRepository(db));
  // Issue #249 — the credit and debit notes live here, beside the bills, because the purchase
  // comparison reads both: goods sent back to a supplier take their credit off the bill they correct.
  const returnNotes = store instanceof PostgresLedgerStore ? new PostgresReturnNoteRepository(store) : new InMemoryReturnNoteRepository();
  participate(inventory, bills, orders, receipts, approvals, returnNotes);
  const audit = pick(() => new InMemoryAuditPort(), (db) => new PostgresAuditLog(db));
  participate(audit);
  // Memory keeps readable ids (`<company>:bill:7`); the database keeps UUIDs, and a counter that
  // restarts at 1 with the process would hand out an id already in the books.
  let sequence = 0;
  const nextId = (kind: string): string => db === null ? `${seed.companyId}:${kind}:${sequence += 1}` : randomUUID();
  const warehouseId = mainWarehouseId(persistence, seed.companyId);
  // Issue #234 — the real clock (tests pin it through app-clock.ts). It used to be frozen at
  // 29 Aug 2026, so an e-way bill raised in September was "valid until" a day in August.
  const clock = appClock;
  const masters = new CompanyMasters(seed.location, warehouseId,
    seed.catalogue.items.filter((item) => item.id.endsWith(':item:SOAP') || item.name === 'Herbal Bath Soap 100g').map((item) => item.id));
  const ledger = new LedgerService({ store, permissions: permissionPortFromActor, audit, clock });
  const inventoryService = new InventoryService({
    store,
    inventory,
    masterData: masters,
    permissions: permissionPortFromActor,
    audit,
    clock,
    policy: { reservationMinutes: 120, valuationMethod: 'WEIGHTED_AVERAGE' },
    idFactory: () => nextId('movement'),
    // Issue #229 — every movement writes its value into the books, in the same transaction.
    books: ledgerStockBooks(store, ledger),
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
    idFactory: () => nextId('bill'),
  });
  // Issue #18. One per company, sharing this company's store and godown, so an order raised on
  // the screen and the stock it later moves are the same records the tests exercise.
  const matching = new ThreeWayMatchingService({
    store,
    inventory: purchaseInventoryPort(inventoryService, masters),
    orders, receipts, approvals,
    audit,
    clock,
    tolerance: pick(() => new InMemoryMatchTolerances(), (db) => new PostgresMatchTolerances(db)),
    idFactory: () => nextId('doc'),
  });
  const riskAssessments = pick(() => new InMemoryRiskAssessmentStore(), (db) => new PostgresRiskAssessmentRepository(db));
  const riskAcknowledgements = pick(() => new InMemoryRiskAcknowledgementStore(), (db) => new PostgresRiskAcknowledgementRepository(db));
  participate(riskAssessments, riskAcknowledgements);

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
   * The supplier's registration comes from their master record rather than being guessed from the bill: a
   * purchase whose supplier we have no GST number for is reported as uncomparable, which is the
   * honest answer and the one the screen shows.
   */
  const itcRecords = pick(() => new InMemoryPortalRecords(), (db) => new PostgresPortalRecords(db));
  const itcBatches = pick(() => new InMemoryImportBatches(), (db) => new PostgresImportBatches(db));
  const itcDecisions = pick(() => new InMemoryItcDecisions(), (db) => new PostgresItcDecisions(db));
  const itcClaims = pick(() => new InMemoryItcClaims(), (db) => new PostgresItcClaims(db));
  // Issue #228 — whichever supplier the bill was posted to, read from their master record. Only the
  // seed supplier used to be known here, so a bill from anyone else could never be compared.
  const gstinOfParty = (partyId: string): string | null =>
    billingAddressOf(seed.companyId, partyId)?.gstin
      ?? (partyId === seed.supplierId && seed.supplierGstin !== undefined ? seed.supplierGstin : null);
  // A seller registered for nothing but exempt supplies (s.23(1)(a)) sells exempt goods: Table 5.
  const registrationOfParty = (partyId: string): string | null => {
    const party = suppliers(seed.companyId).find((candidate) => candidate.id === partyId);
    return party === undefined ? null : party.gstRegistrationType === 'unregistered' && party.unregisteredBasis === 'EXEMPT_ONLY' ? 'exempt_only' : party.gstRegistrationType;
  };
  const itc = new ItcReconciliationService({
    books: {
      async documentsFor(companyId: CompanyId, period: TaxPeriod): Promise<readonly BookPurchaseDocument[]> {
        const posted = await bills.list(companyId);
        const fromBills = posted
          .filter((bill) => bill.invoiceDate.slice(0, 7) <= period)
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
            // Issue #289 — a seller who is not registered sells taxable goods without GST; that is not
            // a Table 5 supply (composition, exempt, nil-rated or non-GST).
            {
              gstin: gstinOfParty(bill.supplierPartyId),
              ...(registrationOfParty(bill.supplierPartyId) === 'unregistered' ? { inTable5: false } : {}),
              ...(['unregistered', 'exempt_only', 'composition'].includes(registrationOfParty(bill.supplierPartyId) ?? '') ? { outsideGstr2b: true as const } : {}),
            },
          ));
        // Issue #249 — every return of goods to a supplier, as a credit note linked to its bill, from
        // the month of the return. It used to be left out, so the credit stayed at the full bill.
        const returned = await Promise.all((await returnNotes.list(companyId))
          .filter((note) => note.kind === 'PURCHASE_RETURN' && note.documentDate.slice(0, 7) <= period)
          .map(async (note) => {
            const bill = await bills.findById(companyId, note.originalDocument.id);
            return purchaseReturnToBookDocument(note, {
              gstin: gstinOfParty(String(note.partyId)),
              name: bill?.supplierName ?? String(note.partyId),
            });
          }));
        return [...fromBills, ...returned];
      },
    },
    records: itcRecords,
    batches: itcBatches,
    decisions: itcDecisions,
    claims: itcClaims,
    audit,
    clock,
    idFactory: () => nextId('itc'),
  });

  const risk = new SupplierRiskService({
    gstin: gstinStatusAdapter({
      gateway: new ConnectorGateway([portal], new SyntheticCredentialVault(), new StaticWebhookVerifier()),
      cache: pick(() => new InMemoryGstinCache(), (db) => new PostgresGstinCache(db)),
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
  const irpPortal = whitebooksVault === null
    ? new SyntheticIrp(() => clock.now())
    : whitebooksIrpConnectorFromVault(whitebooksVault, businessDetailsOf(seed.companyId)?.email ?? '');
  const irpVault = whitebooksVault ?? new SyntheticCredentialVault();
  const eInvoices = pick(() => new InMemoryEInvoiceStore(), (db) => new PostgresEInvoiceRepository(db));
  const eInvoicePolicies = pick(() => new InMemoryEInvoicePolicies(), (db) => new PostgresEInvoicePolicies(db));
  participate(eInvoices);
  const irp = irpAdapter({
    gateway: new ConnectorGateway([irpPortal], irpVault, new StaticWebhookVerifier()),
    clock: () => clock.now(),
  });
  // Issue #345 — for the worker's crash test only, and only against the synthetic portal: wait
  // after the portal has answered, so a test can stop the worker before the answer is saved.
  const answerDelayMs = whitebooksVault === null ? Number(process.env.SYNTHETIC_IRP_ANSWER_DELAY_MS ?? 0) : 0;
  const eInvoice = new EInvoiceService({
    irp: answerDelayMs > 0
      ? { ...irp, async generate(...args) { const answer = await irp.generate(...args); await new Promise((done) => setTimeout(done, answerDelayMs)); return answer; } }
      : irp,
    records: eInvoices,
    audit,
    clock,
    policy: eInvoicePolicies,
    idFactory: () => nextId('einv'),
  });
  // Issue #27. The e-way bill portal behind the same gateway; development runs against a synthetic
  // one that enforces the real windows, so expiry and the 24-hour cancellation are genuinely tried.
  const ewayPortal = new SyntheticEwayBillPortal(() => clock.now());
  const ewayBills = pick(() => new InMemoryEwayBillStore(), (db) => new PostgresEwayBillRepository(db));
  const ewayTrips = pick(() => new InMemoryConsolidatedTripStore(), (db) => new PostgresConsolidatedTripRepository(db));
  const ewayPolicies = pick(() => new InMemoryEwayBillPolicies(), (db) => new PostgresEwayBillPolicies(db));
  participate(ewayBills, ewayTrips);
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
    // Issue #187 — how many HSN digits the portal needs depends on the business's turnover answer.
    turnoverAbove5Crore: (financialYear) => turnoverAnswerForYear(seed.companyId, financialYear),
    idFactory: () => nextId('ewb'),
  });
  // Issue #29. The registering authority, reached the way production reaches it: this product's
  // verification service, over issue #8's connector gateway, with a synthetic VAHAN at the far end.
  // Only that last hop is fake, so the consent check, the field narrowing, the masking, the caching
  // and the audit trail are all the real ones on the screen.
  const vahan = new SyntheticVahanConnector();
  const vehicleRecordCache = pick(() => new InMemoryVehicleRecordCache(), (db) => new PostgresVehicleRecordCache(db));
  const vehicleRecordConsents = pick(() => new InMemoryVehicleRecordConsents(), (db) => new PostgresVehicleRecordConsents(db));
  const vehicleRecordFreshness = pick(() => new InMemoryVehicleRecordFreshness(), (db) => new PostgresVehicleRecordFreshness(db));
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
  // The demo shop connected the service when it was set up, and agreed to the whole allow-list. A
  // business that had not would see "we could not ask", which is its own state on the screen. A real
  // company (PostgreSQL) gives its own consent through `VehicleRecordService.grantConsent`.
  if (vehicleRecordConsents instanceof InMemoryVehicleRecordConsents) vehicleRecordConsents.seed({
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
  const vehicleChecks = pick(() => new InMemorySuitabilityStore(), (db) => new PostgresSuitabilityRepository(db));
  const vehiclePolicies = pick(() => new InMemoryVehicleSuitabilityPolicies(), (db) => new PostgresVehicleSuitabilityPolicies(db));
  participate(vehicleChecks);
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
    idFactory: () => nextId('vsc'),
  });
  const accountId = db === null ? defaultChartIdFactory(seed.companyId) : (code: string) => asId<'Account'>(stableUuid(seed.companyId, 'account', code));
  const chart = buildDefaultChart(seed.companyId, accountId);
  const liabilities = chart.find((account) => account.code === '2000');
  const bankParent = chart.find((account) => account.code === '1120');
  const additions: Account[] = [
    {
      id: accountId('1121'), companyId: seed.companyId, code: '1121',
      name: 'Current bank account', type: 'ASSET', parentId: bankParent?.id ?? null,
      isGroup: false, active: true, partyId: null, systemRole: null,
    },
  ];
  // On PostgreSQL the books are set up once, the first time the company is opened; after a restart
  // they are already there. The demo's own customer and supplier exist only in memory.
  if (db !== null) {
    // The books and the main godown, set up together the first time the company is opened. Checked
    // inside the unit of work, under the company's lock, so two servers opening it at once set it up once.
    await db.unitOfWork(seed.companyId, async ({ sql }) => {
      if ((await sql.query('SELECT 1 FROM ledger_settings WHERE company_id = $1', [seed.companyId])).rows.length > 0) return;
      await ledger.initialiseCompany(setupActor, { booksStartDate: isoDate('2026-04-01'), accounts: [...chart, ...additions] });
      await new PostgresVersionedStore<MasterWarehouse>(db, 'warehouse').append(
        { id: warehouseId, companyId: seed.companyId, code: 'MAIN', name: seed.location, addressLine: '', city: seed.location, stateCode: seed.gstin.slice(0, 2), pincode: '', active: true },
        isoDate('2026-04-01'), seed.setupUserId, 'The main godown, set up with the books',
      );
    });
  }
  if (db === null) await ledger.initialiseCompany(setupActor, { booksStartDate: isoDate('2026-04-01'), accounts: [...chart, ...additions] });
  if (db === null) {
    await ledger.openPartyAccount(setupActor, { partyId: seed.supplierId, name: seed.supplierName, kind: 'SUPPLIER' });
    await ledger.openPartyAccount(setupActor, { partyId: seed.customerId, name: seed.customerName, kind: 'CUSTOMER' });
  }
  return {
    persistence, warehouseId, nextId,
    store, inventory, inventoryService, bills, returnNotes, orders, receipts, approvals, audit, clock, ledger, posting,
    matching, masters, risk, portal, riskAssessments, riskAcknowledgements,
    itc, itcRecords, itcBatches, itcDecisions, itcClaims,
    eInvoice, eInvoices, eInvoicePolicies, irpPortal,
    ewayBill, ewayBills, ewayTrips, ewayPolicies, ewayPortal,
    vehicleSuitability, vehicleChecks, vehiclePolicies, vehicleRecords, vehicleRecordCache,
    vehicleRecordConsents, vehicleRecordFreshness, vahan, plateReader, setupActor,
  };
}
