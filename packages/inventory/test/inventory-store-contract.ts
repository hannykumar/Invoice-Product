/**
 * Issue #366 — one contract for the inventory store (stock movements and holds), run against
 * `InMemoryInventoryStore` (inventory-store-contract.test.ts) and `PostgresInventoryStore`
 * (inventory-store-contract.integration.test.ts). Synthetic data only.
 *
 * Neither repository keeps a version: a movement never changes, and a hold only ever moves on from
 * HELD, so there is no "someone else changed it" case to test.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { money, quantityFromString, type CompanyId, type IsoDate, type UserId } from '@invoice/kernel';
import type { Reservation, StockMovement } from '../src/model.ts';
import type { InventoryStore } from '../src/ports.ts';

/** A company wherever the implementation keeps one: a person, two items, two godowns and a batch. */
export interface StockShop {
  readonly companyId: CompanyId;
  readonly userId: UserId;
  readonly itemIds: readonly [string, string];
  readonly warehouseIds: readonly [string, string];
  readonly batchId: string;
}

export interface InventoryHarness {
  readonly store: InventoryStore;
  shop(): Promise<StockShop>;
  /** One unit of work of that company: everything in `work` is saved together, or nothing is. */
  unit<T>(companyId: CompanyId, work: () => Promise<T>): Promise<T>;
  /** True where a write outside a unit of work must be refused (PostgreSQL). */
  readonly writesNeedUnitOfWork: boolean;
}

const code = (...expected: string[]) => (error: unknown) => expected.includes((error as { code?: string }).code ?? '');
const byId = <T extends { id: string }>(rows: readonly T[]): T[] => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));

export const movement = (shop: StockShop, over: Partial<StockMovement> = {}): StockMovement => {
  const id = crypto.randomUUID();
  return {
    id, companyId: shop.companyId, itemId: shop.itemIds[0], warehouseId: shop.warehouseIds[0], batchId: null, serialNumbers: [],
    kind: 'PURCHASE_IN', direction: 'IN', quantity: quantityFromString('12.5', 'KGS'), enteredQuantity: quantityFromString('1.25', 'BOX'),
    unitCost: money(8_000_000_000_001n), documentDate: '2026-04-10' as IsoDate, source: { kind: 'purchase_bill', id: `bill-${id}`, number: null },
    postedBy: shop.userId, postedAt: '2026-04-10T11:04:00.123Z', idempotencyKey: `move:${id}`, reversesMovementId: null, reason: null, ...over,
  };
};

const hold = (shop: StockShop, over: Partial<Reservation> = {}): Reservation => ({
  id: crypto.randomUUID(), companyId: shop.companyId, documentId: `doc-${crypto.randomUUID()}`, lineId: 'l1', itemId: shop.itemIds[0],
  warehouseId: shop.warehouseIds[0], batchId: null, quantity: quantityFromString('2', 'KGS'), state: 'HELD', createdBy: shop.userId,
  createdAt: '2026-04-10T11:04:00.000Z', expiresAt: '2026-04-10T13:04:00.000Z', settledAt: null, ...over,
});

export function inventoryStoreContract(label: string, harness: () => InventoryHarness, skip: false | string = false): void {
  const setUp = async () => {
    const h = harness();
    const shop = await h.shop();
    return { h, shop, write: <T>(work: () => Promise<T>) => h.unit(shop.companyId, work) };
  };

  test(`${label}: a movement reads back exactly, by id and by key, and a repeated key is refused`, { skip }, async () => {
    const { h, shop, write } = await setUp();
    const inward = movement(shop, { serialNumbers: ['SN-1', 'SN-2'], batchId: shop.batchId, source: { kind: 'purchase_bill', id: 'b1', number: 'SUP/001' } });
    const outward = movement(shop, {
      kind: 'SALE_OUT', direction: 'OUT', quantity: quantityFromString('0.000001', 'KGS'), enteredQuantity: quantityFromString('0.000001', 'KGS'),
      unitCost: null, batchId: shop.batchId, documentDate: '2026-04-11' as IsoDate, reason: 'Synthetic sale',
    });
    await write(async () => { await h.store.movements.insert(inward); await h.store.movements.insert(outward); });
    assert.deepEqual(await h.store.movements.findById(shop.companyId, inward.id), inward);
    assert.deepEqual(await h.store.movements.findById(shop.companyId, outward.id), outward);
    assert.deepEqual(await h.store.movements.findByIdempotencyKey(shop.companyId, inward.idempotencyKey), inward);
    assert.equal(await h.store.movements.findById(shop.companyId, crypto.randomUUID()), null);
    assert.equal(await h.store.movements.findByIdempotencyKey(shop.companyId, 'no such key'), null);
    await assert.rejects(write(() => h.store.movements.insert(movement(shop, { idempotencyKey: inward.idempotencyKey }))), code('STOCK_DUPLICATE_MOVEMENT'));
    const reversal = movement(shop, { kind: 'REVERSAL_IN', reversesMovementId: outward.id, reason: 'Bill cancelled', batchId: shop.batchId });
    await write(() => h.store.movements.insert(reversal));
    assert.deepEqual(await h.store.movements.findById(shop.companyId, reversal.id), reversal);
  });

  test(`${label}: movements are found by item, godown, batch, dates and source, and page by page each exactly once`, { skip }, async () => {
    const { h, shop, write } = await setUp();
    const [a, b] = shop.itemIds;
    const [first, second] = shop.warehouseIds;
    const rows = [
      movement(shop, { itemId: a, warehouseId: first, documentDate: '2026-04-01' as IsoDate }),
      movement(shop, { itemId: a, warehouseId: first, batchId: shop.batchId, documentDate: '2026-04-05' as IsoDate }),
      movement(shop, { itemId: a, warehouseId: second, documentDate: '2026-04-09' as IsoDate, source: { kind: 'stock_transfer', id: 't1', number: null } }),
      movement(shop, { itemId: b, warehouseId: first, quantity: quantityFromString('3', 'PCS'), enteredQuantity: quantityFromString('3', 'PCS'), documentDate: '2026-04-20' as IsoDate, source: { kind: 'stock_transfer', id: 't1', number: null } }),
    ];
    await write(async () => { for (const row of rows) await h.store.movements.insert(row); });
    const [r0, r1, r2, r3] = rows as [StockMovement, StockMovement, StockMovement, StockMovement];
    const list = async (filter: Parameters<InventoryStore['movements']['list']>[1]) => byId(await h.store.movements.list(shop.companyId, filter));
    assert.deepEqual(await list({}), byId(rows));
    assert.deepEqual(await list({ itemId: a, warehouseId: first }), byId([r0, r1]));
    assert.deepEqual(await list({ itemId: a, warehouseId: first, batchId: null }), [r0], 'null is the stock in no batch');
    assert.deepEqual(await list({ itemId: a, batchId: shop.batchId }), [r1]);
    assert.deepEqual(await list({ from: '2026-04-05' as IsoDate, to: '2026-04-09' as IsoDate }), byId([r1, r2]));
    assert.deepEqual(byId(await h.store.movements.listBySource(shop.companyId, 'stock_transfer', 't1')), byId([r2, r3]));
    const seen: StockMovement[] = [];
    for (let after: string | undefined; ;) {
      const page = await h.store.movements.list(shop.companyId, {}, { limit: 3, ...(after === undefined ? {} : { after }) });
      if (page.length === 0) break;
      seen.push(...page);
      after = page.at(-1)?.id;
    }
    assert.deepEqual(seen, byId(rows), 'every movement once, in id order');
    assert.deepEqual(await h.store.movements.listBySource(shop.companyId, 'stock_transfer', 't1', { limit: 1, after: byId([r2, r3])[0]?.id as string }), [byId([r2, r3])[1]]);
  });

  test(`${label}: a hold reads back exactly, moves on from HELD, and is listed by goods and by document, page by page`, { skip }, async () => {
    const { h, shop, write } = await setUp();
    const held = hold(shop);
    const batched = hold(shop, { batchId: shop.batchId, documentId: held.documentId, lineId: 'l2' });
    const elsewhere = hold(shop, { warehouseId: shop.warehouseIds[1], itemId: shop.itemIds[1], quantity: quantityFromString('1', 'PCS') });
    await write(async () => { for (const r of [held, batched, elsewhere]) await h.store.reservations.insert(r); });
    assert.deepEqual(await h.store.reservations.findById(shop.companyId, held.id), held);
    assert.equal(await h.store.reservations.findById(shop.companyId, crypto.randomUUID()), null);
    assert.deepEqual(byId(await h.store.reservations.listForDocument(shop.companyId, held.documentId)), byId([held, batched]));
    assert.deepEqual(byId(await h.store.reservations.listHeld(shop.companyId, { itemId: shop.itemIds[0], warehouseId: shop.warehouseIds[0] })), byId([held, batched]));
    assert.deepEqual(await h.store.reservations.listHeld(shop.companyId, { itemId: shop.itemIds[0], batchId: null }), [held]);
    assert.deepEqual(await h.store.reservations.listHeld(shop.companyId, { batchId: shop.batchId }), [batched]);

    const released: Reservation = { ...held, state: 'RELEASED', settledAt: '2026-04-10T11:30:00.000Z' };
    await write(() => h.store.reservations.update(released));
    assert.deepEqual(await h.store.reservations.findById(shop.companyId, held.id), released);
    assert.deepEqual(byId(await h.store.reservations.listHeld(shop.companyId)), byId([batched, elsewhere]), 'a released hold holds nothing');
    await assert.rejects(write(() => h.store.reservations.update(hold(shop))), code('STOCK_RESERVATION_NOT_FOUND'));

    const first = await h.store.reservations.listHeld(shop.companyId, {}, { limit: 1 });
    const rest = await h.store.reservations.listHeld(shop.companyId, {}, { limit: 10, after: first[0]?.id as string });
    assert.deepEqual([...first, ...rest], byId([batched, elsewhere]));
    assert.deepEqual(await h.store.reservations.listForDocument(shop.companyId, held.documentId, { limit: 1 }), byId([released, batched]).slice(0, 1));
  });

  test(`${label}: one company cannot read or change another company's stock`, { skip }, async () => {
    const { h, shop, write } = await setUp();
    const theirs = await h.shop();
    const inward = movement(shop);
    const held = hold(shop);
    await write(async () => { await h.store.movements.insert(inward); await h.store.reservations.insert(held); });
    assert.equal(await h.store.movements.findById(theirs.companyId, inward.id), null);
    assert.equal(await h.store.movements.findByIdempotencyKey(theirs.companyId, inward.idempotencyKey), null);
    assert.deepEqual(await h.store.movements.list(theirs.companyId), []);
    assert.deepEqual(await h.store.movements.listBySource(theirs.companyId, inward.source.kind, inward.source.id), []);
    assert.equal(await h.store.reservations.findById(theirs.companyId, held.id), null);
    assert.deepEqual(await h.store.reservations.listHeld(theirs.companyId), []);
    assert.deepEqual(await h.store.reservations.listForDocument(theirs.companyId, held.documentId), []);
    await assert.rejects(h.unit(theirs.companyId, () => h.store.reservations.update({ ...held, companyId: theirs.companyId, state: 'RELEASED', settledAt: held.createdAt })), code('STOCK_RESERVATION_NOT_FOUND'));
    assert.deepEqual(await h.store.reservations.findById(shop.companyId, held.id), held);
  });

  test(`${label}: a unit of work that fails leaves no movement and no hold`, { skip }, async () => {
    const { h, shop, write } = await setUp();
    const inward = movement(shop);
    const held = hold(shop);
    await assert.rejects(write(async () => {
      await h.store.movements.insert(inward);
      await h.store.reservations.insert(held);
      throw new Error('the till lost power');
    }), /the till lost power/);
    assert.equal(await h.store.movements.findById(shop.companyId, inward.id), null);
    assert.equal(await h.store.reservations.findById(shop.companyId, held.id), null);
  });

  test(`${label}: a write outside a unit of work is refused, not saved on its own`, { skip }, async () => {
    const { h, shop, write } = await setUp();
    if (!h.writesNeedUnitOfWork) return;
    const held = hold(shop);
    await assert.rejects(h.store.movements.insert(movement(shop)), code('NO_UNIT_OF_WORK'));
    await assert.rejects(h.store.reservations.insert(held), code('NO_UNIT_OF_WORK'));
    await write(() => h.store.reservations.insert(held));
    await assert.rejects(h.store.reservations.update({ ...held, state: 'RELEASED', settledAt: held.createdAt }), code('NO_UNIT_OF_WORK'));
    assert.deepEqual(await h.store.movements.list(shop.companyId), []);
    assert.deepEqual(await h.store.reservations.findById(shop.companyId, held.id), held);
  });
}
