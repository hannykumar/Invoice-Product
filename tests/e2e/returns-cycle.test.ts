/**
 * Issue #44 — returns, and the invariants that only break where two modules meet.
 *
 * A return is where a product most easily goes quietly wrong, because it has to undo three things
 * at once and they live in three different modules: the stock has to come back, the tax has to be
 * reversed, and the party's balance has to fall. A feature test of any one of them passes while the
 * other two disagree, and the business finds out at the end of the quarter.
 *
 * So these scenarios buy, sell and return through the real services and then assert the *whole*
 * position: the godown, the customer's balance, the supplier's balance, and a trial balance that
 * still balances. Damaged goods are the interesting case, because they come back to a different
 * place than they left from and the money moves anyway.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { asId, isoDate, quantityFromString, rupees, toDecimalString, type PartyId } from '@invoice/kernel';
import { partyBalance, trialBalance } from '@invoice/ledger';
import { COMPANY, CUSTOMER, SUPPLIER, makeBusiness, purchase } from './harness.ts';

/** 500 kg of steel in the godown and a supplier payable, which every scenario here starts from. */
const stockIn = async (shop: Awaited<ReturnType<typeof makeBusiness>>): Promise<void> => {
  await shop.posting.post(
    shop.actor,
    purchase({ id: 'e2e-ret-buy', sourceDocumentId: 'e2e-ret-source', invoiceNumber: 'E2E/RET/BUY' }),
    'e2e:returns:purchase',
  );
};

/** A 100 kg sale at ₹100 a kilo: ₹10,000 of goods and ₹1,800 of GST. */
const sell = async (shop: Awaited<ReturnType<typeof makeBusiness>>, key: string) => {
  const draft = await shop.sales.createDraft(shop.actor, {
    idempotencyKey: `e2e:returns:${key}:draft`,
    input: {
      partyId: CUSTOMER,
      customerType: 'B2B',
      supplyKind: 'GOODS',
      documentDate: isoDate('2026-08-29'),
      dueDate: isoDate('2026-09-28'),
      lines: [{
        lineId: 'steel', itemId: 'TMT12', quantity: quantityFromString('100', 'KGS'),
        unitPrice: rupees(100), priceBasis: 'EXCLUSIVE', warehouseId: 'wh-main',
      }],
    },
  });
  return shop.sales.finalise(shop.actor, { idempotencyKey: `e2e:returns:${key}:final`, invoiceId: draft.id });
};

test('a sale return puts the stock back, reverses the tax and reduces what the customer owes', async () => {
  const shop = await makeBusiness();
  const { actor, returns } = shop;
  await stockIn(shop);
  const issued = await sell(shop, 'sale');

  assert.equal((await shop.inventoryService.balance(actor, { itemId: 'TMT12', warehouseId: 'wh-main' })).physical.scaled, 400_000000n);
  assert.equal(toDecimalString((await partyBalance(shop.store.read(), COMPANY, CUSTOMER)).balance), '11800.00');

  // Twenty of the hundred kilos come back in saleable condition.
  const preview = await returns.previewSales(actor, {
    idempotencyKey: 'e2e:returns:credit:preview',
    originalInvoiceId: issued.invoice.id,
    documentDate: isoDate('2026-09-02'),
    reason: 'Customer over-ordered; twenty kilos returned unused.',
    lines: [{ originalLineId: 'steel', quantity: quantityFromString('20', 'KGS'), disposition: 'ACCEPTED', warehouseId: 'wh-main' }],
  });
  // The preview is what a person approves, so it has to state the money before anything moves.
  assert.equal(preview.totals.taxableValue.minor, 2_000_00n);
  assert.equal(preview.totals.total.minor, 2_360_00n);

  const posted = await returns.postSales(actor, {
    idempotencyKey: 'e2e:returns:credit',
    originalInvoiceId: issued.invoice.id,
    documentDate: isoDate('2026-09-02'),
    reason: 'Customer over-ordered; twenty kilos returned unused.',
    lines: [{ originalLineId: 'steel', quantity: quantityFromString('20', 'KGS'), disposition: 'ACCEPTED', warehouseId: 'wh-main' }],
  });
  assert.equal(posted.deduplicated, false);

  // All three modules, together: stock back to 420, the customer owing ₹2,360 less, books balanced.
  assert.equal((await shop.inventoryService.balance(actor, { itemId: 'TMT12', warehouseId: 'wh-main' })).physical.scaled, 420_000000n);
  assert.equal(toDecimalString((await partyBalance(shop.store.read(), COMPANY, CUSTOMER)).balance), '9440.00');
  const books = await trialBalance(shop.store.read(), COMPANY);
  assert.equal(books.balanced, true);
});

test('a retried return note records one credit note, not two', async () => {
  const shop = await makeBusiness();
  const { actor, returns } = shop;
  await stockIn(shop);
  const issued = await sell(shop, 'retry');

  const command = {
    idempotencyKey: 'e2e:returns:retry-after-timeout',
    originalInvoiceId: issued.invoice.id,
    documentDate: isoDate('2026-09-02'),
    reason: 'The reply never arrived, so the shop pressed the button again.',
    lines: [{ originalLineId: 'steel', quantity: quantityFromString('20', 'KGS'), disposition: 'ACCEPTED' as const, warehouseId: 'wh-main' }],
  };
  const first = await returns.postSales(actor, command);
  const retried = await returns.postSales(actor, command);

  assert.equal(retried.note.id, first.note.id);
  assert.equal(retried.deduplicated, true);
  assert.equal((await shop.returnRepository.list(COMPANY)).length, 1);
  // The decisive assertion: the money and the stock moved once, not twice.
  assert.equal((await shop.inventoryService.balance(actor, { itemId: 'TMT12', warehouseId: 'wh-main' })).physical.scaled, 420_000000n);
  assert.equal(toDecimalString((await partyBalance(shop.store.read(), COMPANY, CUSTOMER)).balance), '9440.00');
});

test('damaged goods are credited in full but go to quarantine, not back on the shelf', async () => {
  const shop = await makeBusiness();
  const { actor, returns } = shop;
  await stockIn(shop);
  const issued = await sell(shop, 'damaged');

  await returns.postSales(actor, {
    idempotencyKey: 'e2e:returns:damaged',
    originalInvoiceId: issued.invoice.id,
    documentDate: isoDate('2026-09-02'),
    reason: 'Twenty kilos arrived rusted and were rejected at the gate.',
    lines: [{ originalLineId: 'steel', quantity: quantityFromString('20', 'KGS'), disposition: 'DAMAGED', warehouseId: 'wh-quarantine' }],
  });

  // The customer is credited — the goods were paid for and are unusable — but the saleable godown
  // must not grow by twenty kilos nobody can sell, or the product will oversell them later.
  assert.equal(toDecimalString((await partyBalance(shop.store.read(), COMPANY, CUSTOMER)).balance), '9440.00');
  assert.equal((await shop.inventoryService.balance(actor, { itemId: 'TMT12', warehouseId: 'wh-main' })).physical.scaled, 400_000000n);
  assert.equal((await shop.inventoryService.balance(actor, { itemId: 'TMT12', warehouseId: 'wh-quarantine' })).physical.scaled, 20_000000n);
  assert.equal((await trialBalance(shop.store.read(), COMPANY)).balanced, true);
});

test('a damaged return with nowhere to put the goods is refused rather than guessed', async () => {
  // The alternative is the product choosing a godown for the shopkeeper, which is how unsaleable
  // stock ends up back on the shelf without anybody deciding it should.
  const shop = await makeBusiness();
  const { actor, returns } = shop;
  await stockIn(shop);
  const issued = await sell(shop, 'damaged-nowhere');

  await assert.rejects(
    () => returns.postSales(actor, {
      idempotencyKey: 'e2e:returns:damaged-nowhere',
      originalInvoiceId: issued.invoice.id,
      documentDate: isoDate('2026-09-02'),
      reason: 'Rusted, and nobody said where to put it.',
      lines: [{ originalLineId: 'steel', quantity: quantityFromString('20', 'KGS'), disposition: 'DAMAGED' }],
    }),
    (error: unknown) => error instanceof Error && /godown/.test(error.message),
  );
  assert.equal((await shop.returnRepository.list(COMPANY)).length, 0);
});

test('scrapped goods are credited and then leave the books as stock entirely', async () => {
  const shop = await makeBusiness();
  const { actor, returns } = shop;
  await stockIn(shop);
  const issued = await sell(shop, 'scrapped');

  await returns.postSales(actor, {
    idempotencyKey: 'e2e:returns:scrapped',
    originalInvoiceId: issued.invoice.id,
    documentDate: isoDate('2026-09-02'),
    reason: 'Twenty kilos were bent beyond use and were scrapped on arrival.',
    lines: [{ originalLineId: 'steel', quantity: quantityFromString('20', 'KGS'), disposition: 'SCRAPPED', warehouseId: 'wh-main' }],
  });

  // Scrapping brings the goods in and writes them off in the same breath, so the godown ends where
  // it started while the customer is still credited for what they paid.
  assert.equal((await shop.inventoryService.balance(actor, { itemId: 'TMT12', warehouseId: 'wh-main' })).physical.scaled, 400_000000n);
  assert.equal(toDecimalString((await partyBalance(shop.store.read(), COMPANY, CUSTOMER)).balance), '9440.00');
  assert.equal((await trialBalance(shop.store.read(), COMPANY)).balanced, true);
});

test('a return larger than the sale is refused without moving stock or money', async () => {
  const shop = await makeBusiness();
  const { actor, returns } = shop;
  await stockIn(shop);
  const issued = await sell(shop, 'over');

  const stockBefore = (await shop.inventoryService.balance(actor, { itemId: 'TMT12', warehouseId: 'wh-main' })).physical.scaled;
  const owedBefore = (await partyBalance(shop.store.read(), COMPANY, CUSTOMER)).balance.minor;
  const vouchersBefore = (await shop.store.read().vouchers.list(COMPANY, {})).length;

  await assert.rejects(() => returns.postSales(actor, {
    idempotencyKey: 'e2e:returns:over',
    originalInvoiceId: issued.invoice.id,
    documentDate: isoDate('2026-09-02'),
    reason: 'Somebody typed 120 where they meant 20.',
    lines: [{ originalLineId: 'steel', quantity: quantityFromString('120', 'KGS'), disposition: 'ACCEPTED', warehouseId: 'wh-main' }],
  }));

  assert.equal((await shop.inventoryService.balance(actor, { itemId: 'TMT12', warehouseId: 'wh-main' })).physical.scaled, stockBefore);
  assert.equal((await partyBalance(shop.store.read(), COMPANY, CUSTOMER)).balance.minor, owedBefore);
  assert.equal((await shop.store.read().vouchers.list(COMPANY, {})).length, vouchersBefore);
  assert.equal((await shop.returnRepository.list(COMPANY)).length, 0);
});

test('a purchase return sends stock back to the supplier and reduces what we owe them', async () => {
  const shop = await makeBusiness();
  const { actor, returns } = shop;
  const bought = await shop.posting.post(
    actor,
    purchase({ id: 'e2e-purret-buy', sourceDocumentId: 'e2e-purret-source', invoiceNumber: 'E2E/PURRET/BUY' }),
    'e2e:purchase-return:purchase',
  );

  assert.equal((await shop.inventoryService.balance(actor, { itemId: 'TMT12', warehouseId: 'wh-main' })).physical.scaled, 500_000000n);
  const owedBefore = (await partyBalance(shop.store.read(), COMPANY, asId<'Party'>(SUPPLIER))).balance.minor;

  // Fifty of the five hundred kilos are the wrong grade and go back on the same lorry.
  await returns.postPurchase(actor, {
    idempotencyKey: 'e2e:purchase-return:fifty',
    originalBillId: bought.bill.id,
    documentDate: isoDate('2026-09-02'),
    reason: 'Fifty kilos were the wrong grade and were sent back.',
    lines: [{ originalLineId: '1', quantity: quantityFromString('50', 'KGS'), disposition: 'ACCEPTED', warehouseId: 'wh-main' }],
  });

  assert.equal((await shop.inventoryService.balance(actor, { itemId: 'TMT12', warehouseId: 'wh-main' })).physical.scaled, 450_000000n);
  const owedAfter = (await partyBalance(shop.store.read(), COMPANY, asId<'Party'>(SUPPLIER))).balance.minor;
  // A payable is a credit balance, so owing less means the balance moves towards zero.
  assert.ok(owedAfter > owedBefore, 'a purchase return has to reduce the supplier payable');
  assert.equal((await trialBalance(shop.store.read(), COMPANY)).balanced, true);
});

test('a sale, its return and the books tell the same story about one item', async () => {
  // The cross-module invariant in one sentence: everything bought, minus everything sold, plus
  // everything returned, is what is in the godown — and the ledger agrees it was all paid for.
  const shop = await makeBusiness();
  const { actor, returns } = shop;
  await stockIn(shop);
  const issued = await sell(shop, 'invariant');
  await returns.postSales(actor, {
    idempotencyKey: 'e2e:returns:invariant',
    originalInvoiceId: issued.invoice.id,
    documentDate: isoDate('2026-09-02'),
    reason: 'Thirty kilos returned.',
    lines: [{ originalLineId: 'steel', quantity: quantityFromString('30', 'KGS'), disposition: 'ACCEPTED', warehouseId: 'wh-main' }],
  });

  const bought = 500_000000n;
  const sold = 100_000000n;
  const returned = 30_000000n;
  const inGodown = (await shop.inventoryService.balance(actor, { itemId: 'TMT12', warehouseId: 'wh-main' })).physical.scaled;
  assert.equal(inGodown, bought - sold + returned);

  const books = await trialBalance(shop.store.read(), COMPANY);
  assert.equal(books.balanced, true);
  assert.equal(books.totalDebit.minor, books.totalCredit.minor);
});
