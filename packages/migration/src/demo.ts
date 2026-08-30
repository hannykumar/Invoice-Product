/**
 * Issue #37 [E37] — a business moving in, start to finish, in one script.
 *
 * `npm run demo:migration`. Everything it prints comes out of the real ledger, the real master data
 * and the real stock ledger; nothing here is staged. It walks the four things a shopkeeper actually
 * has to do — customers, items, counts, balances — and then shows the two ways it can go wrong: the
 * same file sent twice, and an import that has to be taken back out.
 */
import { asId, fixedClock, formatINR, isoDate, toQuantityString, type CompanyId } from '@invoice/kernel';
import {
  InMemoryAuditPort,
  InMemoryLedgerStore,
  LedgerService,
  buildDefaultChart,
  defaultChartIdFactory,
  permissionPortFromActor,
  trialBalance,
  type ActorContext,
} from '@invoice/ledger';
import { InMemoryInventoryStore } from '../../inventory/src/repository.ts';
import { InventoryService } from '../../inventory/src/service.ts';
import { MasterDataService } from '../../masters/src/masters.ts';
import { syntheticGstin } from '../../masters/src/fixtures.ts';
import { AuditLog, PlatformCommandService } from '../../platform/src/platform.ts';
import type { RequestContext } from '../../platform/src/types.ts';
import { InventoryMigrationAdapter, MastersStockData } from './adapters/inventory.ts';
import { MastersMigrationAdapter } from './adapters/masters.ts';
import { InMemoryMigrationStore } from './repository.ts';
import { MigrationService } from './service.ts';
import type { EntityKind } from './model.ts';

const PERMISSIONS = [
  'migration.run', 'migration.commit', 'migration.rollback',
  'ledger.setup', 'ledger.post.opening_balance', 'ledger.reverse', 'inventory.move', 'inventory.adjust',
];

const line = (text = ''): void => console.log(text);
const heading = (text: string): void => {
  line();
  line(text);
  line('─'.repeat(text.length));
};

const CUSTOMERS = [
  'Party Name,Phone No,GSTIN,Address,City,State,Pincode,Opening Balance,Dr/Cr',
  `Hotel Rajmahal,98450 12345,${syntheticGstin('29', 'AABCH4321K')},"12, Sayyaji Rao Road",Mysuru,Karnataka,570001,"₹4,500.00",Dr`,
  `Nandini Provision Stores,9880098800,${syntheticGstin('29', 'AAFCN8765J')},Ashoka Road,Mysuru,Karnataka,570001,"₹12,340.50",Dr`,
  'Anand Tea Stall,9448811223,29AABCT9999Z9,Devaraja Market,Mysuru,Karnataka,570001,"₹800",Dr',
  'Hotel Rajmahal,98450 12345,,,,,,"₹4,500.00",Dr',
  ',9000000000,,,,,,"₹100",Dr',
].join('\n');

const ITEMS = [
  'Item Code\tItem Name\tUnit\tHSN Code\tSale Price\tGST %',
  'RICE\tSona Masoori Rice\tKg\t10063020\t54.00\t0',
  'CEM53\tOPC Cement 53 Grade 50kg Bag\tBag\t25232930\t425.00\t28',
  'MISC\tAssorted hardware\tPcs\t\t100.00\t18',
].join('\n');

const STOCK = [
  'Sampoorna Traders',
  'Stock Summary : 1-Apr-2026',
  '',
  'Particulars,Godown,Closing Qty,Rate,Closing Value',
  'Sona Masoori Rice,Main godown,120 KGS,52.00,6240.00',
  'OPC Cement 53 Grade 50kg Bag,Main godown,45 BAG,410.00,18450.00',
].join('\n');

const BALANCES = [
  'Ledger Name,Group,Debit,Credit',
  'Hotel Rajmahal,Sundry Debtors,4500.00,',
  'Nandini Provision Stores,Sundry Debtors,12340.50,',
  'Shree Ram Steels,Sundry Creditors,,9800.00',
  'Cash in hand,Cash-in-Hand,7000.00,',
  'Capital,Capital Account,,14040.50',
].join('\n');

const build = async () => {
  const companyId = asId<'Company'>('demo-migration');
  const store = new InMemoryLedgerStore();
  const inventoryStore = new InMemoryInventoryStore();
  const migrationStore = new InMemoryMigrationStore();
  store.join(inventoryStore).join(migrationStore);
  const audit = new InMemoryAuditPort();
  const clock = fixedClock('2026-04-01T04:30:00.000Z');
  const actor: ActorContext = {
    companyId,
    branchId: asId<'Branch'>('main'),
    userId: asId<'User'>('owner'),
    permissions: PERMISSIONS,
  };

  const ledger = new LedgerService({ store, permissions: permissionPortFromActor, audit, clock });
  await ledger.initialiseCompany(actor, {
    booksStartDate: isoDate('2026-04-01'),
    accounts: buildDefaultChart(companyId, defaultChartIdFactory(companyId)),
  });

  const platformAudit = new AuditLog();
  const masters = new MasterDataService(new PlatformCommandService(platformAudit), platformAudit);
  const options = { branchId: 'main', sessionId: 'demo', permissions: PERMISSIONS };
  const context: RequestContext = { companyId, branchId: 'main', actorId: 'owner', permissions: new Set(), sessionId: 'demo' };
  masters.createWarehouse(
    context,
    { code: 'MAIN', name: 'Main godown', addressLine: 'Sayyaji Rao Road', city: 'Mysuru', stateCode: '29', pincode: '570001' },
    { idempotencyKey: 'demo-warehouse' },
  );

  const inventory = new InventoryService({
    store,
    inventory: inventoryStore,
    masterData: new MastersStockData(masters, options),
    permissions: permissionPortFromActor,
    audit,
    clock,
    policy: { negativeStock: 'BLOCK', reservationMinutes: 120, valuationMethod: 'WEIGHTED_AVERAGE' },
  });
  const mastersAdapter = new MastersMigrationAdapter(masters, options);
  const service = new MigrationService({
    store,
    ledger,
    batches: migrationStore,
    existing: mastersAdapter,
    masters: mastersAdapter,
    stock: new InventoryMigrationAdapter(inventory, inventoryStore, masters, options),
    permissions: permissionPortFromActor,
    audit,
    clock,
  });

  return { companyId: companyId as CompanyId, actor, context, service, ledger, masters, inventory, store };
};

const bring = async (
  shop: Awaited<ReturnType<typeof build>>,
  file: { name: string; content: string; entity?: EntityKind; warehouse?: string },
  accept?: { reason: string },
) => {
  const analysis = await shop.service.analyse(shop.actor, {
    fileName: file.name,
    content: file.content,
    asOn: isoDate('2026-04-01'),
    ...(file.entity === undefined ? {} : { entity: file.entity }),
    ...(file.warehouse === undefined ? {} : { defaultWarehouseRef: file.warehouse }),
  });

  line(`File: ${file.name}`);
  line(`  We think this is: ${analysis.batch.entity.replace('_', ' ')} (from ${analysis.batch.sourceSystem}), ${analysis.rowsInFile} rows.`);
  if (analysis.preamble.length > 0) line(`  Ignored above the headings: ${analysis.preamble.join(' / ')}`);
  for (const column of analysis.batch.proposal.columns) {
    const verdict = column.field === null ? 'not used' : `${column.field}${column.confidence < 0.8 ? ' — please confirm' : ''}`;
    line(`  "${column.header}" → ${verdict}`);
  }

  await shop.service.approveMapping(shop.actor, analysis.batch.id, {
    columns: analysis.batch.proposal.columns,
    fingerprint: analysis.batch.proposal.fingerprint,
  });

  const preview = await shop.service.preview(shop.actor, analysis.batch.id);
  line(`  ${preview.summary['en-IN']}`);
  for (const outcome of preview.outcomes) {
    for (const problem of outcome.problems) {
      line(`    row ${problem.row}: ${problem.message['en-IN']}`);
    }
  }
  if (preview.openingTotals !== null) {
    line(`  The file adds up to ${formatINR(preview.openingTotals.debit)} on one side and ${formatINR(preview.openingTotals.credit)} on the other.`);
  }

  const result = await shop.service.commit(shop.actor, analysis.batch.id, {
    idempotencyKey: `demo-${analysis.batch.id}`,
    ...(accept === undefined ? {} : { acceptDifference: accept }),
  });
  line(`  ✓ ${result.reconciliation.sentence['en-IN']}`);
  return { analysis, result };
};

const main = async (): Promise<void> => {
  const shop = await build();

  heading('1. The customer list, exported from Vyapar');
  await bring(shop, { name: 'vyapar-parties.csv', content: CUSTOMERS });

  heading('2. The item list, exported from BUSY');
  await bring(shop, { name: 'busy-items.txt', content: ITEMS });

  heading('3. The stock summary, exported from Tally');
  await bring(shop, { name: 'tally-stock.csv', content: STOCK, warehouse: 'MAIN' });

  heading("4. Last year's closing balances");
  const balances = await bring(shop, { name: 'trial-balance.csv', content: BALANCES });

  heading('What the books say now');
  const tb = await trialBalance(shop.store.read(), shop.companyId);
  for (const row of tb.rows) {
    line(`  ${row.account.name.padEnd(34)} ${row.side === 'DEBIT' ? formatINR(row.balance).padStart(14) : ''.padStart(14)} ${row.side === 'CREDIT' ? formatINR(row.balance).padStart(14) : ''}`);
  }
  line(`  ${'Do the books balance?'.padEnd(34)} ${tb.balanced ? 'yes' : 'no'}`);
  for (const item of shop.masters.items(shop.context)) {
    const balance = await shop.inventory.balance(shop.actor, { itemId: item.id, warehouseId: shop.masters.warehouses(shop.context)[0]?.id ?? '' });
    line(`  ${item.name.padEnd(34)} ${toQuantityString(balance.physical)} ${balance.physical.unit} in the godown`);
  }

  heading('5. The same file sent a second time');
  const again = await shop.service.analyse(shop.actor, { fileName: 'vyapar-parties.csv', content: CUSTOMERS, asOn: isoDate('2026-04-01') });
  line(`  State: ${again.batch.state}`);
  try {
    await shop.service.commit(shop.actor, again.batch.id, { idempotencyKey: 'demo-again' });
  } catch (error) {
    line(`  ✗ ${(error as Error).message}`);
  }

  heading('6. Taking the balances back out, because the accountant sent the wrong year');
  const rolledBack = await shop.service.rollback(shop.actor, balances.analysis.batch.id, {
    reason: 'The accountant sent last year by mistake',
  });
  line(`  State: ${rolledBack.state}`);
  const after = await trialBalance(shop.store.read(), shop.companyId);
  line(`  Every balance back to nothing: ${after.rows.every((row) => row.balance.minor === 0n) ? 'yes' : 'no'}`);
  line(`  The entries are still there to see: ${after.rows.length} accounts have movements, and the reversal says why.`);
  line();
};

await main();
