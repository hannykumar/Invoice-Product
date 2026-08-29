/** Issue #12 [E12] — a wholesaler with two godowns, batched apples and serialised weighing scales. */
import { asId, fixedClock, isoDate, rupees, type CompanyId, type IsoDate, type Money } from '@invoice/kernel';
import {
  InMemoryAuditPort,
  InMemoryLedgerStore,
  permissionPortFromActor,
  type ActorContext,
} from '@invoice/ledger';
import { UnitRegistry, createDefaultUnitRegistry, quantity, type Quantity } from '../../masters/src/units.ts';
import { InMemoryInventoryStore } from '../src/repository.ts';
import { InventoryService } from '../src/service.ts';
import type { StockItem, StockMasterData, Warehouse } from '../src/ports.ts';
import type { InventoryPolicy } from '../src/policy.ts';

export const COMPANY: CompanyId = asId<'Company'>('inv-co');
export const OTHER: CompanyId = asId<'Company'>('inv-other');
export const PRIYA = asId<'User'>('inv-priya');

export const ALL_PERMISSIONS = [
  'ledger.setup',
  'inventory.move',
  'inventory.adjust',
  'inventory.transfer',
  'inventory.override_negative',
];

export const actorWith = (permissions: readonly string[], companyId: CompanyId = COMPANY): ActorContext => ({
  companyId,
  branchId: asId<'Branch'>('main'),
  userId: PRIYA,
  permissions,
});

const ITEMS: StockItem[] = [
  { itemId: 'APL-BOX-10', name: 'Apple box, 10 kg', baseUnit: 'KGS', tracksBatches: false, tracksSerials: false },
  { itemId: 'CRATE-P', name: 'Plastic crate', baseUnit: 'PCS', tracksBatches: false, tracksSerials: false },
  { itemId: 'MILK-1L', name: 'Milk, 1 litre', baseUnit: 'PCS', tracksBatches: true, tracksSerials: false },
  { itemId: 'SCALE', name: 'Weighing scale', baseUnit: 'PCS', tracksBatches: false, tracksSerials: true },
];

const WAREHOUSES: Warehouse[] = [
  { warehouseId: 'narela', name: 'Narela godown' },
  { warehouseId: 'shop', name: 'Karol Bagh shop' },
];

class Masters implements StockMasterData {
  readonly #registry: UnitRegistry;
  constructor() {
    this.#registry = createDefaultUnitRegistry();
    // One box of apples is exactly ten kilos. Item-specific, as it should be.
    this.#registry.registerConversion({ fromUnit: 'BOX', toUnit: 'KGS', numerator: 10n, denominator: 1n, itemId: 'APL-BOX-10' });
  }
  item(_companyId: CompanyId, itemId: string): StockItem | undefined {
    return ITEMS.find((i) => i.itemId === itemId);
  }
  warehouse(_companyId: CompanyId, warehouseId: string): Warehouse | undefined {
    return WAREHOUSES.find((w) => w.warehouseId === warehouseId);
  }
  units(): UnitRegistry {
    return this.#registry;
  }
}

let counter = 0;

export interface Godown {
  service: InventoryService;
  store: InMemoryLedgerStore;
  inventory: InMemoryInventoryStore;
  audit: InMemoryAuditPort;
  actor: ActorContext;
}

export const makeGodown = (options: { policy?: Partial<InventoryPolicy>; permissions?: readonly string[] } = {}): Godown => {
  const store = new InMemoryLedgerStore();
  const inventory = new InMemoryInventoryStore();
  store.join(inventory);
  const audit = new InMemoryAuditPort();
  counter += 1;
  let n = 0;
  const idFactory = (): string => `mv${counter}-${String((n += 1)).padStart(6, '0')}`;
  const service = new InventoryService({
    store,
    inventory,
    masterData: new Masters(),
    permissions: permissionPortFromActor,
    audit,
    clock: fixedClock('2026-08-29T10:00:00.000Z'),
    policy: {
      negativeStock: 'BLOCK',
      reservationMinutes: 120,
      valuationMethod: 'WEIGHTED_AVERAGE',
      ...options.policy,
    },
    idFactory,
  });
  return { service, store, inventory, audit, actor: actorWith(options.permissions ?? ALL_PERMISSIONS) };
};

export const qty = (value: string, unit: string): Quantity => quantity(value, unit);
export const on = (date: string): IsoDate => isoDate(date);
export const inr = (whole: number, paise = 0): Money => rupees(whole, paise);
export const source = (id: string, kind = 'sales_invoice') => ({ kind, id, number: null });
