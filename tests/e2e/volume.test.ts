/**
 * Issue #44 — the initial target volumes, run for real.
 *
 * The target this product is being built for is a small Indian business: a shop or a trading firm
 * raising tens of bills a day, not thousands. So "performance testing" here does not mean a
 * benchmark suite; it means proving that a month of that business's actual work goes through the
 * real services in a sensible time, and — the part that actually bites — that nothing in the cycle
 * is quietly quadratic.
 *
 * A cost that grows with the square of the number of bills is invisible at ten and fatal at five
 * hundred: the first month is instant, the sixth takes a minute, and the shopkeeper decides the
 * product is broken. That is what the second test measures, and it measures a *shape* rather than a
 * time, because a wall-clock budget on a shared CI runner is a flaky test waiting to happen.
 *
 * The budgets below are deliberately loose. They exist to catch something becoming ten times
 * slower, not to police a hundred milliseconds.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isoDate, quantityFromString, rupees } from '@invoice/kernel';
import { partyBalance, trialBalance } from '@invoice/ledger';
import { COMPANY, CUSTOMER, makeBusiness, purchase, steelLine } from './harness.ts';

/** A busy small trader: about twenty bills a working day. */
const BILLS_IN_A_MONTH = 500;

/** Generous enough to survive a loaded CI runner; tight enough to notice a tenfold regression. */
const MONTH_BUDGET_MS = 30_000;
const REPORT_BUDGET_MS = 2_000;

const stockedForVolume = async () => {
  const shop = await makeBusiness();
  // Enough steel for the whole month: 500 bills of 1 kg each, bought in one delivery.
  await shop.posting.post(
    shop.actor,
    purchase({
      id: 'e2e-vol-buy',
      sourceDocumentId: 'e2e-vol-source',
      invoiceNumber: 'E2E/VOL/BUY',
      lines: [steelLine({ quantity: quantityFromString('5000', 'KGS'), taxableValuePaise: 320_000_00n })],
      invoiceTotalPaise: 377_600_00n,
    }),
    'e2e:volume:purchase',
  );
  return shop;
};

const sellOne = async (shop: Awaited<ReturnType<typeof makeBusiness>>, index: number) => {
  const draft = await shop.sales.createDraft(shop.actor, {
    idempotencyKey: `e2e:vol:${index}:draft`,
    input: {
      partyId: CUSTOMER, customerType: 'B2B', supplyKind: 'GOODS',
      documentDate: isoDate('2026-08-29'), dueDate: isoDate('2026-09-28'),
      lines: [{
        lineId: 'steel', itemId: 'TMT12', quantity: quantityFromString('1', 'KGS'),
        unitPrice: rupees(100), priceBasis: 'EXCLUSIVE', warehouseId: 'wh-main',
      }],
    },
  });
  return shop.sales.finalise(shop.actor, { idempotencyKey: `e2e:vol:${index}:final`, invoiceId: draft.id });
};

test('a month of a busy small trader goes through in a sensible time and still balances', async () => {
  const shop = await stockedForVolume();

  const started = performance.now();
  for (let index = 0; index < BILLS_IN_A_MONTH; index += 1) await sellOne(shop, index);
  const elapsed = performance.now() - started;

  // Correctness first: a fast wrong answer is worthless.
  assert.equal((await shop.salesRepository.list(COMPANY, { state: 'FINAL' })).length, BILLS_IN_A_MONTH);
  assert.equal(
    (await shop.inventoryService.balance(shop.actor, { itemId: 'TMT12', warehouseId: 'wh-main' })).physical.scaled,
    4_500_000000n,
    '5,000 kg in less 500 kg out',
  );
  const owed = await partyBalance(shop.store.read(), COMPANY, CUSTOMER);
  assert.equal(owed.balance.minor, 500n * 118_00n, '500 bills of ₹118 including tax');

  const books = await trialBalance(shop.store.read(), COMPANY);
  assert.equal(books.balanced, true, 'five hundred bills later, the books still balance');

  assert.ok(
    elapsed < MONTH_BUDGET_MS,
    `${BILLS_IN_A_MONTH} bills took ${Math.round(elapsed)}ms, over the ${MONTH_BUDGET_MS}ms budget`,
  );
});

test('the cost of one more bill does not grow with the number of bills already there', async () => {
  // The shape test. Ten bills are timed at the start of the month and ten more at the end; if
  // anything in the cycle is scanning everything that came before, the second batch is dramatically
  // slower. The allowance is wide because these are small numbers on a shared machine — it is
  // catching an order of magnitude, not a percentage.
  const shop = await stockedForVolume();

  const timeTen = async (offset: number): Promise<number> => {
    const started = performance.now();
    for (let index = 0; index < 10; index += 1) await sellOne(shop, offset + index);
    return performance.now() - started;
  };

  const early = await timeTen(0);
  for (let index = 0; index < 300; index += 1) await sellOne(shop, 100 + index);
  const late = await timeTen(1_000);

  assert.ok(
    late < Math.max(early * 8, 1_000),
    `ten bills cost ${Math.round(early)}ms at the start of the month and ${Math.round(late)}ms after 300 more, which looks like a cost that grows with the size of the books`,
  );
  assert.equal((await trialBalance(shop.store.read(), COMPANY)).balanced, true);
});

test('reading the whole month back is fast enough to put on a screen', async () => {
  const shop = await stockedForVolume();
  for (let index = 0; index < 200; index += 1) await sellOne(shop, index);

  const started = performance.now();
  const books = await trialBalance(shop.store.read(), COMPANY);
  const outstanding = await shop.receivables.position(shop.actor, CUSTOMER, isoDate('2026-09-01'));
  const elapsed = performance.now() - started;

  assert.equal(books.balanced, true);
  assert.equal(outstanding.totalOutstanding.minor, 200n * 118_00n);
  assert.ok(elapsed < REPORT_BUDGET_MS, `the month's figures took ${Math.round(elapsed)}ms to read back`);
});
