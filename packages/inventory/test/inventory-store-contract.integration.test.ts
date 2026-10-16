/**
 * Issue #366 — the inventory store contract on a real PostgreSQL, connected as the application's
 * own role (a login that is only a member of `invoice_app`), so row-level security and the
 * database's stock rules are really in force. The owner connection only sets the scene.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import { fixedClock, isoDate, quantityFromString, rupees, type CompanyId, type UserId } from '@invoice/kernel';
import { PostgresLedgerStore, permissionPortFromActor, type ActorContext } from '@invoice/ledger';
import { createDefaultUnitRegistry } from '../../masters/src/units.ts';
import type { TransactionalExecutor } from '../../platform/src/database.ts';
import { PostgresAuditLog } from '../../platform/src/postgres-audit.ts';
import type { StockMasterData } from '../src/ports.ts';
import { InventoryService } from '../src/service.ts';
import { inventoryStoreContract, movement, type InventoryHarness, type StockShop } from './inventory-store-contract.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the inventory store database tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let harness: InventoryHarness;
const login = `invoice_app_stock_${randomBytes(6).toString('hex')}`;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import('../../platform/src/database.ts');
  const { migrate } = await import('../../platform/src/migrations.ts');
  const { PostgresInventoryStore } = await import('../src/postgres-store.ts');
  owner = createDatabase(url);
  await migrate(owner);
  const password = randomBytes(18).toString('hex');
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const appUrl = new URL(url);
  appUrl.username = login;
  appUrl.password = password;
  app = createDatabase(appUrl.toString());
  harness = {
    store: new PostgresInventoryStore(app),
    writesNeedUnitOfWork: true,
    unit: (companyId, work) => app.unitOfWork(companyId, () => work()),
    shop: async (): Promise<StockShop> => {
      const [companyId, userId, a, b, first, second, batchId] = Array.from({ length: 7 }, () => crypto.randomUUID()) as [string, string, string, string, string, string, string];
      await owner.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Stock Traders')", [companyId]);
      await owner.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Synthetic storekeeper')", [userId, `stock-${userId}@example.invalid`]);
      await owner.query(
        "INSERT INTO master_records (id, company_id, kind) VALUES ($1, $6, 'item'), ($2, $6, 'item'), ($3, $6, 'warehouse'), ($4, $6, 'warehouse'), ($5, $6, 'batch')",
        [a, b, first, second, batchId, companyId],
      );
      return { companyId: companyId as CompanyId, userId: userId as UserId, itemIds: [a, b], warehouseIds: [first, second], batchId };
    },
  };
});
after(async () => {
  await app?.close();
  if (owner !== undefined) { await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

inventoryStoreContract('postgres', () => harness, skip);

const onHand = async (shop: StockShop): Promise<bigint> => BigInt(String((await app.tenantTransaction(shop.companyId, (sql) => sql.query(
  'SELECT COALESCE(sum(on_hand_micro), 0)::text AS n FROM stock_balances WHERE company_id = $1 AND item_id = $2', [shop.companyId, shop.itemIds[0]],
))).rows[0]?.n));

test('postgres: a movement that would take stock below nothing is "not enough stock", and moves nothing', { skip }, async () => {
  const shop = await harness.shop();
  await harness.unit(shop.companyId, () => harness.store.movements.insert(movement(shop, { quantity: quantityFromString('2', 'KGS') })));
  const tooMuch = movement(shop, { kind: 'SALE_OUT', direction: 'OUT', quantity: quantityFromString('2.000001', 'KGS'), unitCost: null });
  await assert.rejects(harness.unit(shop.companyId, () => harness.store.movements.insert(tooMuch)), (error: unknown) => (error as { code?: string }).code === 'STOCK_WOULD_GO_NEGATIVE');
  assert.equal(await onHand(shop), 2_000_000n);
  assert.equal(await harness.store.movements.findById(shop.companyId, tooMuch.id), null);
});

test('postgres: fifty bills of one crate each against five in stock, at once, through the inventory service: exactly five go through', { skip }, async () => {
  const shop = await harness.shop();
  const actor: ActorContext = { companyId: shop.companyId, branchId: null, userId: shop.userId, permissions: ['inventory.move'] };
  const units = createDefaultUnitRegistry();
  const masters: StockMasterData = {
    item: (_c, id) => (id === shop.itemIds[0] ? { itemId: id, name: 'Plastic crate', baseUnit: 'PCS', tracksBatches: false, tracksSerials: false } : undefined),
    warehouse: (_c, id) => (id === shop.warehouseIds[0] ? { warehouseId: id, name: 'Main godown' } : undefined),
    units: () => units,
  };
  const service = new InventoryService({
    store: new PostgresLedgerStore(app), inventory: harness.store, masterData: masters, permissions: permissionPortFromActor,
    audit: new PostgresAuditLog(app), clock: fixedClock('2026-04-10T11:04:00.000Z'),
  });
  await service.recordMovement(actor, {
    idempotencyKey: 'opening', itemId: shop.itemIds[0], warehouseId: shop.warehouseIds[0], kind: 'OPENING', quantity: quantityFromString('5', 'PCS'),
    unitCost: rupees(100), documentDate: isoDate('2026-04-01'), source: { kind: 'opening_stock', id: 'o1', number: null },
  });

  // Each bill is its own unit of work, as each till's request is: hold the crate, then issue it.
  const sell = (documentId: string) => app.unitOfWork(shop.companyId, async () => {
    const held = await service.reserve(actor, {
      documentId, documentDate: isoDate('2026-04-10'),
      lines: [{ lineId: 'l1', itemId: shop.itemIds[0], warehouseId: shop.warehouseIds[0], quantity: quantityFromString('1', 'PCS') }],
    });
    if (!held.ok) return false;
    await service.issue(actor, { documentId, documentDate: isoDate('2026-04-10'), source: { kind: 'sales_invoice', id: documentId, number: null } });
    return true;
  });
  const results = await Promise.allSettled(Array.from({ length: 50 }, () => sell(crypto.randomUUID())));
  const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
  assert.equal(failed, undefined, String(failed?.reason));
  assert.equal(results.filter((r) => r.status === 'fulfilled' && r.value).length, 5);
  assert.equal(await onHand(shop), 0n);
  const out = await harness.store.movements.list(shop.companyId, { itemId: shop.itemIds[0] });
  assert.equal(out.filter((m) => m.kind === 'SALE_OUT').length, 5);
  assert.deepEqual(await harness.store.reservations.listHeld(shop.companyId), [], 'every hold was used; none is left holding goods');
});
