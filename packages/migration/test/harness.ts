/**
 * Issue #37 [E37] — a whole company, built from the real services.
 *
 * Nothing in these tests is a stand-in: the ledger is `LedgerService`, master data is GPT 3's
 * `MasterDataService` on GPT 2's `PlatformCommandService`, and stock is `InventoryService`. An
 * import that passes here has genuinely written into all three, which is the standard issue #76
 * sets — a test against a no-op double proves nothing.
 */
import { asId, fixedClock, isoDate, type CompanyId } from '@invoice/kernel';
import {
  InMemoryAuditPort,
  InMemoryLedgerStore,
  LedgerService,
  buildDefaultChart,
  defaultChartIdFactory,
  permissionPortFromActor,
  type ActorContext,
} from '@invoice/ledger';
import { InMemoryInventoryStore } from '../../inventory/src/repository.ts';
import { InventoryService } from '../../inventory/src/service.ts';
import { MasterDataService } from '../../masters/src/masters.ts';
import { AuditLog, PlatformCommandService } from '../../platform/src/platform.ts';
import type { RequestContext } from '../../platform/src/types.ts';
import { InventoryMigrationAdapter, MastersStockData } from '../src/adapters/inventory.ts';
import { MastersMigrationAdapter } from '../src/adapters/masters.ts';
import { InMemoryMigrationStore } from '../src/repository.ts';
import { MigrationService } from '../src/service.ts';

export const PERMISSIONS = [
  'migration.run', 'migration.commit', 'migration.rollback',
  'ledger.setup', 'ledger.post.opening_balance', 'ledger.post.sale', 'ledger.reverse',
  'inventory.move', 'inventory.adjust',
];

export interface Harness {
  readonly companyId: CompanyId;
  readonly actor: ActorContext;
  readonly context: RequestContext;
  readonly service: MigrationService;
  readonly ledger: LedgerService;
  readonly masters: MasterDataService;
  readonly inventory: InventoryService;
  readonly inventoryStore: InMemoryInventoryStore;
  readonly store: InMemoryLedgerStore;
  readonly warehouseId: string;
}

let companies = 0;

export const buildHarness = async (options: { permissions?: readonly string[] } = {}): Promise<Harness> => {
  companies += 1;
  const companyId = asId<'Company'>(`company-${companies}`);
  const store = new InMemoryLedgerStore();
  const inventoryStore = new InMemoryInventoryStore();
  const migrationStore = new InMemoryMigrationStore();
  store.join(inventoryStore).join(migrationStore);

  const audit = new InMemoryAuditPort();
  const clock = fixedClock('2026-08-30T06:00:00.000Z');
  const actor: ActorContext = {
    companyId,
    branchId: asId<'Branch'>('main'),
    userId: asId<'User'>('owner'),
    permissions: options.permissions ?? PERMISSIONS,
  };

  const ledger = new LedgerService({ store, permissions: permissionPortFromActor, audit, clock });
  await ledger.initialiseCompany(
    { ...actor, permissions: PERMISSIONS },
    { booksStartDate: isoDate('2026-04-01'), accounts: buildDefaultChart(companyId, defaultChartIdFactory(companyId)) },
  );

  const platformAudit = new AuditLog();
  const masters = new MasterDataService(new PlatformCommandService(platformAudit), platformAudit);
  const adapterOptions = { branchId: 'main', sessionId: `session-${companies}`, permissions: PERMISSIONS };
  const context: RequestContext = { companyId, branchId: 'main', actorId: 'owner', permissions: new Set(), sessionId: `session-${companies}` };

  const warehouse = masters.createWarehouse(
    context,
    { code: 'MAIN', name: 'Main godown', addressLine: 'Sayyaji Rao Road', city: 'Mysuru', stateCode: '29', pincode: '570001' },
    { idempotencyKey: `warehouse-${companies}` },
  );

  const stockData = new MastersStockData(masters, adapterOptions);
  const inventory = new InventoryService({
    store,
    inventory: inventoryStore,
    masterData: stockData,
    permissions: permissionPortFromActor,
    audit,
    clock,
    policy: { negativeStock: 'BLOCK', reservationMinutes: 120, valuationMethod: 'WEIGHTED_AVERAGE' },
  });

  const mastersAdapter = new MastersMigrationAdapter(masters, adapterOptions);
  const stockAdapter = new InventoryMigrationAdapter(inventory, inventoryStore, masters, adapterOptions);
  const service = new MigrationService({
    store,
    ledger,
    batches: migrationStore,
    existing: mastersAdapter,
    masters: mastersAdapter,
    stock: stockAdapter,
    permissions: permissionPortFromActor,
    audit,
    clock,
  });

  return { companyId, actor, context, service, ledger, masters, inventory, inventoryStore, store, warehouseId: warehouse.record.id };
};

/** analyse → approve the proposed mapping → commit, which is the ordinary path. */
export const bringIn = async (
  harness: Harness,
  file: { fileName: string; content: string; entity?: Parameters<MigrationService['analyse']>[1]['entity']; asOn?: string; defaultWarehouseRef?: string },
  commit: { idempotencyKey?: string; acceptDifference?: { reason: string } } = {},
) => {
  const analysis = await harness.service.analyse(harness.actor, {
    fileName: file.fileName,
    content: file.content,
    ...(file.entity === undefined ? {} : { entity: file.entity }),
    ...(file.asOn === undefined ? {} : { asOn: isoDate(file.asOn) }),
    ...(file.defaultWarehouseRef === undefined ? {} : { defaultWarehouseRef: file.defaultWarehouseRef }),
  });
  await harness.service.approveMapping(harness.actor, analysis.batch.id, {
    columns: analysis.batch.proposal.columns,
    fingerprint: analysis.batch.proposal.fingerprint,
  });
  const result = await harness.service.commit(harness.actor, analysis.batch.id, {
    idempotencyKey: commit.idempotencyKey ?? `commit-${analysis.batch.id}`,
    ...(commit.acceptDifference === undefined ? {} : { acceptDifference: commit.acceptDifference }),
  });
  return { analysis, result };
};
