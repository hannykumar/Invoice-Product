/**
 * Issue #44 — two things happening at once.
 *
 * Every guarantee in this product is easy to hold when one person is using it. The ones that matter
 * are the ones that hold when two tills sell the last of the stock at the same moment, or when a
 * shopkeeper on a bad connection presses "record payment" twice while the first request is still in
 * flight. Those are not hypothetical: they are the ordinary Tuesday of a shop with a counter and a
 * phone, and they are invisible to a feature test that awaits one call at a time.
 *
 * What is asserted here is never "the fast one wins". It is that whatever the order, the invariant
 * survives: stock never goes negative, one idempotency key never becomes two vouchers, and the
 * books balance afterwards.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isoDate, quantityFromString, rupees, toDecimalString } from '@invoice/kernel';
import { partyBalance, trialBalance } from '@invoice/ledger';
import { COMPANY, CUSTOMER, makeBusiness, purchase } from './harness.ts';

const stocked = async () => {
  const shop = await makeBusiness();
  await shop.posting.post(
    shop.actor,
    purchase({ id: 'e2e-conc-buy', sourceDocumentId: 'e2e-conc-source', invoiceNumber: 'E2E/CONC/BUY' }),
    'e2e:concurrency:purchase',
  );
  return shop;
};

const draftFor = async (shop: Awaited<ReturnType<typeof makeBusiness>>, key: string, kilos: string) => {
  const draft = await shop.sales.createDraft(shop.actor, {
    idempotencyKey: `e2e:conc:${key}:draft`,
    input: {
      partyId: CUSTOMER,
      customerType: 'B2B',
      supplyKind: 'GOODS',
      documentDate: isoDate('2026-08-29'),
      dueDate: isoDate('2026-09-28'),
      lines: [{
        lineId: 'steel', itemId: 'TMT12', quantity: quantityFromString(kilos, 'KGS'),
        unitPrice: rupees(100), priceBasis: 'EXCLUSIVE', warehouseId: 'wh-main',
      }],
    },
  });
  return draft;
};

test('two tills cannot sell the same last of the stock', async () => {
  // 500 kg in the godown and two bills for 300 kg each. One of them has to lose, and the loser must
  // lose completely: no voucher, no movement, no half-reduced balance.
  const shop = await stocked();
  const first = await draftFor(shop, 'till-a', '300');
  const second = await draftFor(shop, 'till-b', '300');

  const outcomes = await Promise.allSettled([
    shop.sales.finalise(shop.actor, { idempotencyKey: 'e2e:conc:till-a:final', invoiceId: first.id }),
    shop.sales.finalise(shop.actor, { idempotencyKey: 'e2e:conc:till-b:final', invoiceId: second.id }),
  ]);

  const issued = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  assert.equal(issued.length, 1, 'exactly one of the two bills may become final');

  const stock = (await shop.inventoryService.balance(shop.actor, { itemId: 'TMT12', warehouseId: 'wh-main' })).physical.scaled;
  assert.equal(stock, 200_000000n, 'one sale of 300 kg out of 500 leaves 200');
  assert.ok(stock >= 0n, 'stock may never go negative without an authorised override');
  assert.equal(toDecimalString((await partyBalance(shop.store.read(), COMPANY, CUSTOMER)).balance), '35400.00');
  assert.equal((await trialBalance(shop.store.read(), COMPANY)).balanced, true);
});

test('two sales that both fit are both allowed', async () => {
  // The mirror of the test above, and the one that stops "make it safe" turning into "make it
  // serial and slow": concurrency must not refuse work there was room for.
  const shop = await stocked();
  const first = await draftFor(shop, 'fits-a', '200');
  const second = await draftFor(shop, 'fits-b', '200');

  const outcomes = await Promise.allSettled([
    shop.sales.finalise(shop.actor, { idempotencyKey: 'e2e:conc:fits-a:final', invoiceId: first.id }),
    shop.sales.finalise(shop.actor, { idempotencyKey: 'e2e:conc:fits-b:final', invoiceId: second.id }),
  ]);

  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 2);
  assert.equal((await shop.inventoryService.balance(shop.actor, { itemId: 'TMT12', warehouseId: 'wh-main' })).physical.scaled, 100_000000n);
  assert.equal((await trialBalance(shop.store.read(), COMPANY)).balanced, true);
});

test('a payment button pressed twice on a bad connection records one payment', async () => {
  const shop = await stocked();
  const draft = await draftFor(shop, 'pay', '100');
  const issued = await shop.sales.finalise(shop.actor, { idempotencyKey: 'e2e:conc:pay:final', invoiceId: draft.id });

  const command = {
    idempotencyKey: 'e2e:conc:receipt',
    direction: 'RECEIPT' as const,
    partyId: CUSTOMER,
    mode: 'BANK_TRANSFER' as const,
    bankAccountCode: '1121',
    amount: rupees(5_000),
    date: isoDate('2026-09-01'),
    reference: 'UTR-CONC-5000',
    allocations: [{
      documentId: issued.invoice.id,
      documentNumber: issued.invoice.number ?? issued.invoice.id,
      amount: rupees(5_000),
    }],
  };

  const outcomes = await Promise.allSettled([
    shop.receivables.recordPayment(shop.actor, command),
    shop.receivables.recordPayment(shop.actor, command),
  ]);

  // The invariant is the money, and it holds: one payment exists whatever the two calls did.
  assert.equal((await shop.paymentRepository.list(COMPANY)).length, 1, 'only one payment may exist');

  // The loser of the race is refused rather than handed back the payment that already exists.
  // That is safe — nothing is recorded twice — but it is not the same experience as the sequential
  // retry in `business-cycle.test.ts`, which returns the original payment. Pinned here so the
  // difference is a known, deliberate behaviour rather than something discovered by a shopkeeper.
  const refused = outcomes.filter((outcome) => outcome.status === 'rejected');
  assert.equal(refused.length, 1);
  assert.match((refused[0] as PromiseRejectedResult).reason.message, /already recorded/);
  // ₹11,800 owed less one ₹5,000 receipt. Twice would be ₹1,800, and the customer would be told
  // they had paid money they had not paid.
  assert.equal(toDecimalString((await partyBalance(shop.store.read(), COMPANY, CUSTOMER)).balance), '6800.00');
  assert.equal((await trialBalance(shop.store.read(), COMPANY)).balanced, true);
});

test('a supplier bill posted twice at once creates one bill and one payable', async () => {
  // A regression this issue found. The duplicate check used to sit outside the transaction, so two
  // posts in flight together both passed it. The ledger and the godown protected themselves — the
  // money and the stock moved once — but a second bill row was written against the same voucher,
  // and the purchase register then showed the same supplier invoice twice. See `regressions.ts`.
  const shop = await makeBusiness();
  const bill = purchase({ id: 'e2e-conc-dup', sourceDocumentId: 'e2e-conc-dup-source', invoiceNumber: 'E2E/CONC/DUP' });

  const outcomes = await Promise.allSettled([
    shop.posting.post(shop.actor, bill, 'e2e:concurrency:same-key'),
    shop.posting.post(shop.actor, bill, 'e2e:concurrency:same-key'),
  ]);

  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 2);
  const posted = outcomes.map((outcome) => (outcome as PromiseFulfilledResult<{ bill: { id: string } }>).value.bill.id);
  assert.equal(posted[0], posted[1], 'both callers must be handed the same bill');
  assert.equal((await shop.bills.list(COMPANY)).length, 1);
  assert.equal((await shop.inventoryService.balance(shop.actor, { itemId: 'TMT12', warehouseId: 'wh-main' })).physical.scaled, 500_000000n);
  assert.equal((await trialBalance(shop.store.read(), COMPANY)).balanced, true);
});
