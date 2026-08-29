/**
 * Issue #12 [E12] acceptance criteria, enforced automatically.
 *
 *  - "Stock is derived from traceable movements"
 *  - "Concurrent invoices cannot oversell the same stock"
 *  - "Returns, cancellations and transfers reverse/update stock correctly"
 *
 * plus the required concurrent-reservation, unit/batch/warehouse and backdated-movement tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, toDecimalString } from '@invoice/kernel';
import { formatQuantity } from '../../masters/src/units.ts';
import { availableQuantity, valueStock } from '../src/balances.ts';
import { ALL_PERMISSIONS, COMPANY, OTHER, actorWith, inr, makeGodown, on, qty, source } from './fixtures.ts';

const buyApples = async (g: ReturnType<typeof makeGodown>, boxes: string, key: string, date = '2026-04-04') =>
  g.service.recordMovement(g.actor, {
    idempotencyKey: key,
    itemId: 'APL-BOX-10',
    warehouseId: 'narela',
    kind: 'PURCHASE_IN',
    quantity: qty(boxes, 'BOX'),
    unitCost: inr(50),
    documentDate: on(date),
    source: source(key, 'purchase_invoice'),
  });

test('stock is the sum of its movements, and every figure drills back to them', async () => {
  const g = makeGodown();
  await buyApples(g, '100', 'p1');
  await g.service.recordMovement(g.actor, {
    idempotencyKey: 's1',
    itemId: 'APL-BOX-10',
    warehouseId: 'narela',
    kind: 'SALE_OUT',
    quantity: qty('70', 'BOX'),
    documentDate: on('2026-04-12'),
    source: source('inv-42'),
  });

  const balance = await g.service.balance(g.actor, { itemId: 'APL-BOX-10', warehouseId: 'narela' });
  // 100 boxes in at 10 kg each, 70 out: 300 kg left, held in the item's base unit.
  assert.equal(formatQuantity(balance.physical), '300.000 KGS');
  assert.equal(formatQuantity(balance.available), '300.000 KGS');
  assert.equal(balance.unitCode, 'KGS');

  const movements = await g.service.movementsFor(g.actor, { itemId: 'APL-BOX-10' });
  assert.equal(movements.length, 2);
  assert.equal(movements[0]?.source.id, 'p1');
  assert.equal(formatQuantity(movements[0]?.enteredQuantity ?? qty('0', 'BOX')), '100.000 BOX', 'what was typed is kept');
  assert.equal(formatQuantity(movements[0]?.quantity ?? qty('0', 'KGS')), '1000.000 KGS', 'and the base-unit figure alongside it');
});

test('a unit that does not divide exactly is refused, not rounded', async () => {
  const g = makeGodown();
  await assert.rejects(
    () =>
      g.service.recordMovement(g.actor, {
        idempotencyKey: 'bad-unit',
        itemId: 'CRATE-P',
        warehouseId: 'narela',
        kind: 'PURCHASE_IN',
        quantity: qty('5', 'BOX'),
        documentDate: on('2026-04-04'),
        source: source('x'),
      }),
    (e: unknown) => e instanceof DomainError && e.code === 'STOCK_UNIT_CONVERSION',
  );
});

test('the last thirty boxes cannot be sold twice, however fast the tills are', async () => {
  const g = makeGodown();
  await buyApples(g, '3', 'p1'); // 30 kg
  const attempts = Array.from({ length: 20 }, (_unused, i) =>
    g.service.reserve(g.actor, {
      documentId: `bill-${i}`,
      documentDate: on('2026-04-12'),
      lines: [{ lineId: 'l1', itemId: 'APL-BOX-10', warehouseId: 'narela', quantity: qty('30', 'KGS') }],
    }),
  );
  const results = await Promise.all(attempts);

  const succeeded = results.filter((r) => r.ok);
  assert.equal(succeeded.length, 1, 'exactly one bill may hold the last thirty kilos');
  const refused = results.filter((r) => !r.ok);
  assert.equal(refused.length, 19);

  const balance = await g.service.balance(g.actor, { itemId: 'APL-BOX-10', warehouseId: 'narela' });
  assert.equal(formatQuantity(balance.physical), '30.000 KGS');
  assert.equal(formatQuantity(balance.reserved), '30.000 KGS');
  assert.equal(formatQuantity(balance.available), '0.000 KGS');
});

test('a shortfall says exactly what is missing, in the item’s own words', async () => {
  const g = makeGodown();
  await buyApples(g, '3', 'p1'); // 30 kg
  const result = await g.service.reserve(g.actor, {
    documentId: 'bill-1',
    documentDate: on('2026-04-12'),
    lines: [{ lineId: 'l1', itemId: 'APL-BOX-10', warehouseId: 'narela', quantity: qty('7', 'BOX') }],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  const shortfall = result.shortfalls[0];
  assert.equal(shortfall?.itemName, 'Apple box, 10 kg');
  assert.equal(shortfall?.warehouseName, 'Narela godown');
  assert.equal(shortfall?.available, '30.000');
  assert.equal(shortfall?.required, '70.000');
  assert.equal(shortfall?.shortfall, '40.000');
});

test('when one line falls short, nothing at all is held', async () => {
  const g = makeGodown();
  await buyApples(g, '10', 'p1');
  await g.service.recordMovement(g.actor, {
    idempotencyKey: 'p2', itemId: 'CRATE-P', warehouseId: 'narela', kind: 'PURCHASE_IN',
    quantity: qty('5', 'PCS'), documentDate: on('2026-04-04'), source: source('p2', 'purchase_invoice'),
  });

  const result = await g.service.reserve(g.actor, {
    documentId: 'bill-1',
    documentDate: on('2026-04-12'),
    lines: [
      { lineId: 'l1', itemId: 'APL-BOX-10', warehouseId: 'narela', quantity: qty('1', 'BOX') },
      { lineId: 'l2', itemId: 'CRATE-P', warehouseId: 'narela', quantity: qty('50', 'PCS') },
    ],
  });
  assert.equal(result.ok, false);
  const apples = await g.service.balance(g.actor, { itemId: 'APL-BOX-10', warehouseId: 'narela' });
  assert.equal(formatQuantity(apples.reserved), '0.000 KGS', 'a half-held bill would lock goods it never uses');
});

test('two lines of one bill cannot both claim the last box', async () => {
  const g = makeGodown();
  await buyApples(g, '1', 'p1'); // 10 kg
  const result = await g.service.reserve(g.actor, {
    documentId: 'bill-1',
    documentDate: on('2026-04-12'),
    lines: [
      { lineId: 'l1', itemId: 'APL-BOX-10', warehouseId: 'narela', quantity: qty('10', 'KGS') },
      { lineId: 'l2', itemId: 'APL-BOX-10', warehouseId: 'narela', quantity: qty('10', 'KGS') },
    ],
  });
  assert.equal(result.ok, false);
});

test('re-holding for the same bill replaces the hold rather than stacking on it', async () => {
  const g = makeGodown();
  await buyApples(g, '10', 'p1'); // 100 kg
  const first = await g.service.reserve(g.actor, {
    documentId: 'bill-1', documentDate: on('2026-04-12'),
    lines: [{ lineId: 'l1', itemId: 'APL-BOX-10', warehouseId: 'narela', quantity: qty('60', 'KGS') }],
  });
  assert.equal(first.ok, true);
  const second = await g.service.reserve(g.actor, {
    documentId: 'bill-1', documentDate: on('2026-04-12'),
    lines: [{ lineId: 'l1', itemId: 'APL-BOX-10', warehouseId: 'narela', quantity: qty('90', 'KGS') }],
  });
  assert.equal(second.ok, true, 'raising the quantity on one bill must not fight its own hold');
  const balance = await g.service.balance(g.actor, { itemId: 'APL-BOX-10', warehouseId: 'narela' });
  assert.equal(formatQuantity(balance.reserved), '90.000 KGS');
});

test('issuing turns a hold into a movement, and releasing puts it back', async () => {
  const g = makeGodown();
  await buyApples(g, '10', 'p1');
  await g.service.reserve(g.actor, {
    documentId: 'bill-1', documentDate: on('2026-04-12'),
    lines: [{ lineId: 'l1', itemId: 'APL-BOX-10', warehouseId: 'narela', quantity: qty('70', 'KGS') }],
  });
  const posted = await g.service.issue(g.actor, {
    documentId: 'bill-1', documentDate: on('2026-04-12'), source: source('bill-1'),
  });
  assert.equal(posted.length, 1);
  const after = await g.service.balance(g.actor, { itemId: 'APL-BOX-10', warehouseId: 'narela' });
  assert.equal(formatQuantity(after.physical), '30.000 KGS');
  assert.equal(formatQuantity(after.reserved), '0.000 KGS', 'the hold is consumed, not left behind');

  await g.service.reserve(g.actor, {
    documentId: 'bill-2', documentDate: on('2026-04-12'),
    lines: [{ lineId: 'l1', itemId: 'APL-BOX-10', warehouseId: 'narela', quantity: qty('30', 'KGS') }],
  });
  assert.equal((await g.service.release(g.actor, 'bill-2')), 1);
  const released = await g.service.balance(g.actor, { itemId: 'APL-BOX-10', warehouseId: 'narela' });
  assert.equal(formatQuantity(released.available), '30.000 KGS');
});

test('a cancelled bill puts the goods back as a mirrored movement, never a deletion', async () => {
  const g = makeGodown();
  await buyApples(g, '10', 'p1');
  await g.service.reserve(g.actor, {
    documentId: 'bill-1', documentDate: on('2026-04-12'),
    lines: [{ lineId: 'l1', itemId: 'APL-BOX-10', warehouseId: 'narela', quantity: qty('70', 'KGS') }],
  });
  await g.service.issue(g.actor, { documentId: 'bill-1', documentDate: on('2026-04-12'), source: source('bill-1') });

  const reversed = await g.service.returnToStock(g.actor, {
    documentId: 'bill-1', documentDate: on('2026-04-14'), source: source('bill-1'), reason: 'Customer cancelled before dispatch',
  });
  assert.equal(reversed.length, 1);
  assert.equal(reversed[0]?.kind, 'REVERSAL_IN');
  assert.ok(reversed[0]?.reversesMovementId !== null, 'the mirror points at what it undid');
  assert.equal(reversed[0]?.reason, 'Customer cancelled before dispatch');

  const balance = await g.service.balance(g.actor, { itemId: 'APL-BOX-10', warehouseId: 'narela' });
  assert.equal(formatQuantity(balance.physical), '100.000 KGS');
  const movements = await g.service.movementsFor(g.actor, { itemId: 'APL-BOX-10' });
  assert.equal(movements.length, 3, 'the sale is still visible; nothing was removed');

  // Doing it twice does not put the goods back twice.
  const again = await g.service.returnToStock(g.actor, {
    documentId: 'bill-1', documentDate: on('2026-04-14'), source: source('bill-1'), reason: 'Customer cancelled before dispatch',
  });
  assert.equal(again[0]?.id, reversed[0]?.id);
  assert.equal(formatQuantity((await g.service.balance(g.actor, { itemId: 'APL-BOX-10', warehouseId: 'narela' })).physical), '100.000 KGS');
});

test('putting goods back needs a written reason', async () => {
  const g = makeGodown();
  await assert.rejects(
    () => g.service.returnToStock(g.actor, { documentId: 'b', documentDate: on('2026-04-14'), source: source('b'), reason: '  ' }),
    (e: unknown) => e instanceof DomainError && e.code === 'STOCK_REASON_REQUIRED',
  );
});

test('a transfer moves goods between godowns without changing the total', async () => {
  const g = makeGodown();
  await buyApples(g, '10', 'p1');
  await g.service.transfer(g.actor, {
    idempotencyKey: 't1',
    itemId: 'APL-BOX-10',
    fromWarehouseId: 'narela',
    toWarehouseId: 'shop',
    quantity: qty('4', 'BOX'),
    documentDate: on('2026-04-15'),
    reason: 'Weekend counter stock',
  });
  const narela = await g.service.balance(g.actor, { itemId: 'APL-BOX-10', warehouseId: 'narela' });
  const shop = await g.service.balance(g.actor, { itemId: 'APL-BOX-10', warehouseId: 'shop' });
  assert.equal(formatQuantity(narela.physical), '60.000 KGS');
  assert.equal(formatQuantity(shop.physical), '40.000 KGS');
  assert.equal(narela.physical.micro + shop.physical.micro, 100_000000n, 'the business still has the same goods');

  await assert.rejects(
    () =>
      g.service.transfer(g.actor, {
        idempotencyKey: 't2', itemId: 'APL-BOX-10', fromWarehouseId: 'shop', toWarehouseId: 'shop',
        quantity: qty('1', 'BOX'), documentDate: on('2026-04-15'), reason: 'x',
      }),
    (e: unknown) => e instanceof DomainError && e.code === 'STOCK_TRANSFER_SAME_PLACE',
  );
});

test('stock in one godown cannot be sold from another', async () => {
  const g = makeGodown();
  await buyApples(g, '10', 'p1'); // all in Narela
  const result = await g.service.reserve(g.actor, {
    documentId: 'bill-1', documentDate: on('2026-04-12'),
    lines: [{ lineId: 'l1', itemId: 'APL-BOX-10', warehouseId: 'shop', quantity: qty('1', 'BOX') }],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.shortfalls[0]?.warehouseName, 'Karol Bagh shop');
});

test('a batched item must say which batch, and batches are counted separately', async () => {
  const g = makeGodown();
  await assert.rejects(
    () =>
      g.service.recordMovement(g.actor, {
        idempotencyKey: 'm1', itemId: 'MILK-1L', warehouseId: 'shop', kind: 'PURCHASE_IN',
        quantity: qty('20', 'PCS'), documentDate: on('2026-04-04'), source: source('m1', 'purchase_invoice'),
      }),
    (e: unknown) => e instanceof DomainError && e.code === 'STOCK_BATCH_REQUIRED',
  );

  await g.service.recordMovement(g.actor, {
    idempotencyKey: 'm2', itemId: 'MILK-1L', warehouseId: 'shop', batchId: 'B-01', kind: 'PURCHASE_IN',
    quantity: qty('20', 'PCS'), documentDate: on('2026-04-04'), source: source('m2', 'purchase_invoice'),
  });
  await g.service.recordMovement(g.actor, {
    idempotencyKey: 'm3', itemId: 'MILK-1L', warehouseId: 'shop', batchId: 'B-02', kind: 'PURCHASE_IN',
    quantity: qty('5', 'PCS'), documentDate: on('2026-04-06'), source: source('m3', 'purchase_invoice'),
  });

  const first = await g.service.balance(g.actor, { itemId: 'MILK-1L', warehouseId: 'shop', batchId: 'B-01' });
  const second = await g.service.balance(g.actor, { itemId: 'MILK-1L', warehouseId: 'shop', batchId: 'B-02' });
  assert.equal(formatQuantity(first.physical), '20.000 PCS');
  assert.equal(formatQuantity(second.physical), '5.000 PCS');

  // Selling from the empty batch is refused even though the shop has milk.
  const result = await g.service.reserve(g.actor, {
    documentId: 'bill-1', documentDate: on('2026-04-12'),
    lines: [{ lineId: 'l1', itemId: 'MILK-1L', warehouseId: 'shop', batchId: 'B-02', quantity: qty('10', 'PCS') }],
  });
  assert.equal(result.ok, false);
});

test('a serialised item needs one serial number per piece', async () => {
  const g = makeGodown();
  await assert.rejects(
    () =>
      g.service.recordMovement(g.actor, {
        idempotencyKey: 'sc1', itemId: 'SCALE', warehouseId: 'shop', kind: 'PURCHASE_IN',
        quantity: qty('3', 'PCS'), serialNumbers: ['A1', 'A2'],
        documentDate: on('2026-04-04'), source: source('sc1', 'purchase_invoice'),
      }),
    (e: unknown) => e instanceof DomainError && e.code === 'STOCK_SERIALS_MISMATCH',
  );
  const ok = await g.service.recordMovement(g.actor, {
    idempotencyKey: 'sc2', itemId: 'SCALE', warehouseId: 'shop', kind: 'PURCHASE_IN',
    quantity: qty('3', 'PCS'), serialNumbers: ['A1', 'A2', 'A3'],
    documentDate: on('2026-04-04'), source: source('sc2', 'purchase_invoice'),
  });
  assert.deepEqual(ok.serialNumbers, ['A1', 'A2', 'A3']);
});

test('by default, stock cannot go below zero', async () => {
  const g = makeGodown();
  await buyApples(g, '1', 'p1'); // 10 kg
  await assert.rejects(
    () =>
      g.service.recordMovement(g.actor, {
        idempotencyKey: 'over', itemId: 'APL-BOX-10', warehouseId: 'narela', kind: 'SALE_OUT',
        quantity: qty('20', 'KGS'), documentDate: on('2026-04-12'), source: source('bill-x'),
      }),
    (e: unknown) =>
      e instanceof DomainError && e.code === 'STOCK_WOULD_GO_NEGATIVE' && e.messageId === 'stock.not_enough',
  );
  const balance = await g.service.balance(g.actor, { itemId: 'APL-BOX-10', warehouseId: 'narela' });
  assert.equal(formatQuantity(balance.physical), '10.000 KGS', 'a refused movement writes nothing');
});

test('a business that allows it can go negative, but only named and reasoned', async () => {
  const g = makeGodown({ policy: { negativeStock: 'WARN_WITH_OVERRIDE' } });
  await buyApples(g, '1', 'p1');

  await assert.rejects(
    () =>
      g.service.recordMovement(g.actor, {
        idempotencyKey: 'o1', itemId: 'APL-BOX-10', warehouseId: 'narela', kind: 'SALE_OUT',
        quantity: qty('20', 'KGS'), documentDate: on('2026-04-12'), source: source('bill-x'),
      }),
    (e: unknown) => e instanceof DomainError && e.code === 'STOCK_OVERRIDE_REASON_REQUIRED',
  );

  const clerk = actorWith(ALL_PERMISSIONS.filter((p) => p !== 'inventory.override_negative'));
  await assert.rejects(
    () =>
      g.service.recordMovement(clerk, {
        idempotencyKey: 'o2', itemId: 'APL-BOX-10', warehouseId: 'narela', kind: 'SALE_OUT',
        quantity: qty('20', 'KGS'), documentDate: on('2026-04-12'), source: source('bill-x'),
        negativeOverride: { reason: 'goods received, bill pending' },
      }),
    (e: unknown) => e instanceof DomainError && e.kind === 'FORBIDDEN',
  );

  const allowed = await g.service.recordMovement(g.actor, {
    idempotencyKey: 'o3', itemId: 'APL-BOX-10', warehouseId: 'narela', kind: 'SALE_OUT',
    quantity: qty('20', 'KGS'), documentDate: on('2026-04-12'), source: source('bill-x'),
    negativeOverride: { reason: 'goods received, supplier bill still coming' },
  });
  assert.equal(allowed.negativeOverride?.reason, 'goods received, supplier bill still coming');
  assert.equal(allowed.negativeOverride?.allowedBy, g.actor.userId);

  const audited = g.audit.events.filter((e) => e.action === 'inventory.negative_stock_allowed');
  assert.equal(audited.length, 1);
  assert.match(audited[0]?.overrideReason ?? '', /supplier bill still coming/);

  const balance = await g.service.balance(g.actor, { itemId: 'APL-BOX-10', warehouseId: 'narela' });
  assert.equal(formatQuantity(balance.physical), '-10.000 KGS', 'the shortfall is visible, not hidden');
});

test('the same movement recorded twice moves stock once', async () => {
  const g = makeGodown();
  const first = await buyApples(g, '10', 'retry');
  const second = await buyApples(g, '10', 'retry');
  assert.equal(second.id, first.id);
  const balance = await g.service.balance(g.actor, { itemId: 'APL-BOX-10', warehouseId: 'narela' });
  assert.equal(formatQuantity(balance.physical), '100.000 KGS');
});

test('a backdated movement changes what stock was on that day, and what it is now', async () => {
  const g = makeGodown();
  await buyApples(g, '10', 'p1', '2026-04-10');
  await g.service.recordMovement(g.actor, {
    idempotencyKey: 's1', itemId: 'APL-BOX-10', warehouseId: 'narela', kind: 'SALE_OUT',
    quantity: qty('30', 'KGS'), documentDate: on('2026-04-20'), source: source('bill-1'),
  });
  // A purchase invoice that arrives late, dated before the sale.
  await buyApples(g, '5', 'p2', '2026-04-05');

  const movements = await g.service.movementsFor(g.actor, { itemId: 'APL-BOX-10' });
  const onThe15th = movements.filter((m) => m.documentDate <= '2026-04-15');
  assert.equal(onThe15th.length, 2, 'the backdated purchase counts on the 15th');

  const now = await g.service.balance(g.actor, { itemId: 'APL-BOX-10', warehouseId: 'narela' });
  assert.equal(formatQuantity(now.physical), '120.000 KGS');
});

test('holds expire, so an abandoned draft cannot lock goods for ever', async () => {
  const g = makeGodown({ policy: { reservationMinutes: 30 } });
  await buyApples(g, '10', 'p1');
  await g.service.reserve(g.actor, {
    documentId: 'abandoned', documentDate: on('2026-04-12'),
    lines: [{ lineId: 'l1', itemId: 'APL-BOX-10', warehouseId: 'narela', quantity: qty('70', 'KGS') }],
  });
  const before = await g.service.balance(g.actor, { itemId: 'APL-BOX-10', warehouseId: 'narela' });
  assert.equal(formatQuantity(before.available), '30.000 KGS');

  const expired = await g.service.expireStaleReservations(g.actor, new Date('2026-08-29T11:00:00.000Z'));
  assert.equal(expired, 1);
  const after = await g.service.balance(g.actor, { itemId: 'APL-BOX-10', warehouseId: 'narela' });
  assert.equal(formatQuantity(after.available), '100.000 KGS');
});

test('an adjustment always says why', async () => {
  const g = makeGodown();
  await buyApples(g, '10', 'p1');
  await assert.rejects(
    () =>
      g.service.adjust(g.actor, {
        idempotencyKey: 'a1', itemId: 'APL-BOX-10', warehouseId: 'narela',
        quantity: qty('5', 'KGS'), direction: 'OUT', documentDate: on('2026-04-20'), reason: '  ',
      }),
    (e: unknown) => e instanceof DomainError && e.code === 'STOCK_REASON_REQUIRED',
  );
  const adjusted = await g.service.adjust(g.actor, {
    idempotencyKey: 'a2', itemId: 'APL-BOX-10', warehouseId: 'narela',
    quantity: qty('5', 'KGS'), direction: 'OUT', documentDate: on('2026-04-20'), reason: 'Two boxes spoiled in the rain',
  });
  assert.equal(adjusted.kind, 'ADJUSTMENT_OUT');
  assert.equal(adjusted.reason, 'Two boxes spoiled in the rain');
});

test('stock is valued at weighted average, and goods leaving do not move the cost of what remains', async () => {
  const g = makeGodown();
  await g.service.recordMovement(g.actor, {
    idempotencyKey: 'v1', itemId: 'CRATE-P', warehouseId: 'narela', kind: 'PURCHASE_IN',
    quantity: qty('100', 'PCS'), unitCost: inr(100), documentDate: on('2026-04-01'), source: source('v1', 'purchase_invoice'),
  });
  await g.service.recordMovement(g.actor, {
    idempotencyKey: 'v2', itemId: 'CRATE-P', warehouseId: 'narela', kind: 'PURCHASE_IN',
    quantity: qty('100', 'PCS'), unitCost: inr(200), documentDate: on('2026-04-05'), source: source('v2', 'purchase_invoice'),
  });

  const afterBuying = await g.service.value(g.actor, { itemId: 'CRATE-P' });
  assert.equal(toDecimalString(afterBuying.value), '30000.00');
  assert.equal(toDecimalString(afterBuying.averageUnitCost ?? inr(0)), '150.00');

  await g.service.recordMovement(g.actor, {
    idempotencyKey: 'v3', itemId: 'CRATE-P', warehouseId: 'narela', kind: 'SALE_OUT',
    quantity: qty('50', 'PCS'), documentDate: on('2026-04-10'), source: source('bill-1'),
  });
  const afterSelling = await g.service.value(g.actor, { itemId: 'CRATE-P' });
  assert.equal(toDecimalString(afterSelling.value), '22500.00', '150 crates at ₹150');
  assert.equal(toDecimalString(afterSelling.averageUnitCost ?? inr(0)), '150.00', 'the average does not drift when goods leave');

  const empty = valueStock([]);
  assert.equal(empty.averageUnitCost, null);
});

test('one business cannot see or move another business’s stock', async () => {
  const g = makeGodown();
  await buyApples(g, '10', 'p1');
  const outsider = actorWith(ALL_PERMISSIONS, OTHER);
  const balance = await g.service.balance(outsider, { itemId: 'APL-BOX-10', warehouseId: 'narela' });
  assert.equal(formatQuantity(balance.physical), '0.000 KGS');
  assert.equal((await g.service.movementsFor(outsider, {})).length, 0);
  void COMPANY;
});

test('permission is checked for moving, adjusting and transferring separately', async () => {
  const g = makeGodown();
  const reader = actorWith([]);
  await assert.rejects(
    () => g.service.balance(reader, { itemId: 'APL-BOX-10', warehouseId: 'narela' }).then(() =>
      g.service.recordMovement(reader, {
        idempotencyKey: 'x', itemId: 'APL-BOX-10', warehouseId: 'narela', kind: 'PURCHASE_IN',
        quantity: qty('1', 'BOX'), documentDate: on('2026-04-04'), source: source('x', 'purchase_invoice'),
      }),
    ),
    (e: unknown) => e instanceof DomainError && e.kind === 'FORBIDDEN',
  );
  const mover = actorWith(['inventory.move']);
  await assert.rejects(
    () =>
      g.service.adjust(mover, {
        idempotencyKey: 'y', itemId: 'APL-BOX-10', warehouseId: 'narela',
        quantity: qty('1', 'KGS'), direction: 'IN', documentDate: on('2026-04-04'), reason: 'count',
      }),
    (e: unknown) => e instanceof DomainError && e.kind === 'FORBIDDEN',
  );
});

test('available never quietly means physical', () => {
  const physical = { micro: 100_000000n, unitCode: 'KGS' };
  const reserved = { micro: 70_000000n, unitCode: 'KGS' };
  assert.equal(formatQuantity(availableQuantity(physical, reserved)), '30.000 KGS');
});
