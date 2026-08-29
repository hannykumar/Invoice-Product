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
}

const ITEMS: readonly StockItem[] = [
  { itemId: 'TMT12', name: 'TMT Steel Bar 12mm', baseUnit: 'KGS', tracksBatches: false, tracksSerials: false },
  { itemId: 'SOAP', name: 'Herbal Bath Soap 100g', baseUnit: 'PCS', tracksBatches: true, tracksSerials: false },
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

const SETUP_PERMISSIONS = [
  'ledger.setup', 'ledger.post.purchase', 'ledger.post.sale', 'ledger.post.receipt', 'ledger.post.payment',
  'ledger.post.journal', 'ledger.reverse', 'inventory.move', 'inventory.adjust', 'inventory.override_negative',
  'sales.draft.write', 'sales.finalise', 'sales.approve', 'sales.cancel', 'payments.record', 'payments.allocate',
  'payments.reverse', 'payments.write_off', 'dashboard.read',
];

export async function createCompanyShop(seed: CompanySeed) {
  const store = new InMemoryLedgerStore();
  const inventory = new InMemoryInventoryStore();
  const bills = new InMemoryPurchaseBillStore();
  store.join(inventory).join(bills);
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
    accountCodes: { servicesCost: '5900', reverseChargePayable: '2260' },
    idFactory: () => `${seed.companyId}:bill:${sequence += 1}`,
  });
  const setupActor: ActorContext = {
    companyId: seed.companyId,
    branchId: seed.branchId,
    userId: seed.setupUserId,
    permissions: SETUP_PERMISSIONS,
  };
  const chart = buildDefaultChart(seed.companyId, defaultChartIdFactory(seed.companyId));
  const liabilities = chart.find((account) => account.code === '2000');
  const bankParent = chart.find((account) => account.code === '1120');
  const additions: Account[] = [
    {
      id: asId<'Account'>(`${seed.companyId}:acc:2260`), companyId: seed.companyId, code: '2260',
      name: 'GST payable under reverse charge', type: 'LIABILITY', parentId: liabilities?.id ?? null,
      isGroup: false, active: true, partyId: null, systemRole: null,
    },
    {
      id: asId<'Account'>(`${seed.companyId}:acc:1121`), companyId: seed.companyId, code: '1121',
      name: 'Current bank account', type: 'ASSET', parentId: bankParent?.id ?? null,
      isGroup: false, active: true, partyId: null, systemRole: null,
    },
  ];
  await ledger.initialiseCompany(setupActor, { booksStartDate: isoDate('2026-04-01'), accounts: [...chart, ...additions] });
  await ledger.openPartyAccount(setupActor, { partyId: seed.supplierId, name: seed.supplierName, kind: 'SUPPLIER' });
  await ledger.openPartyAccount(setupActor, { partyId: seed.customerId, name: seed.customerName, kind: 'CUSTOMER' });
  return { store, inventory, inventoryService, bills, audit, ledger, posting, setupActor };
}
