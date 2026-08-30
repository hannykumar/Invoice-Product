import assert from 'node:assert/strict';
import test from 'node:test';
import { asId, fixedClock, isoDate, quantityFromString, toDecimalString } from '@invoice/kernel';
import { partyBalance, permissionPortFromActor } from '@invoice/ledger';
import { ALL_PERMISSIONS, COMPANY, SUPPLIER, makeShop, purchase } from '../../purchasing/src/posting-fixtures.ts';
import {
  InMemoryReturnNoteRepository, ReturnService, purchaseReturnSource, returnInventoryAdapter,
  type PurchaseReturnCommand,
} from '../src/index.ts';

const permissions = [...ALL_PERMISSIONS, 'ledger.post.debit_note', 'returns.create'];
const setup = async (over: Parameters<typeof purchase>[0] = {}) => {
  const shop = await makeShop({ permissions });
  const actor = { ...shop.actor, permissions };
  const { bill } = await shop.posting.post(actor, purchase(over), 'original-purchase');
  const notes = new InMemoryReturnNoteRepository();
  shop.store.join(notes);
  let id = 0;
  const service = new ReturnService({
    store: shop.store, ledger: shop.ledger, repository: notes,
    sales: { async findSalesDocument() { return null; } }, purchases: purchaseReturnSource(shop.bills),
    inventory: returnInventoryAdapter(shop.inventoryService), permissions: permissionPortFromActor,
    audit: shop.audit, clock: fixedClock('2026-08-30T10:00:00.000Z'), idFactory: () => `purchase-return-${++id}`,
  });
  return { ...shop, actor, bill, notes, service };
};

const command = (billId: string, over: Partial<PurchaseReturnCommand> = {}): PurchaseReturnCommand => ({
  idempotencyKey: 'return-steel-100', originalBillId: billId, documentDate: isoDate('2026-08-30'),
  reason: 'The supplier accepted the bent bars back.',
  lines: [{ originalLineId: '1', quantity: quantityFromString('100', 'KGS'), disposition: 'ACCEPTED' }],
  ...over,
});

test('a partial purchase return posts a debit note, reverses input GST and removes stock atomically', async () => {
  const f = await setup();
  const preview = await f.service.previewPurchase(f.actor, command(f.bill.id));
  assert.equal(toDecimalString(preview.totals.taxableValue), '6400.00');
  assert.equal(toDecimalString(preview.totals.igst), '1152.00');
  assert.equal(toDecimalString(preview.totals.total), '7552.00');

  const { note } = await f.service.postPurchase(f.actor, command(f.bill.id));
  assert.equal(note.kind, 'PURCHASE_RETURN');
  assert.match(note.number, /^DN\/000001$/);
  const supplier = await partyBalance(f.store.read(), COMPANY, asId<'Party'>(SUPPLIER));
  assert.equal(toDecimalString(supplier.balance), '-30208.00');
  const stock = await f.inventoryService.balance(f.actor, { itemId: 'TMT12', warehouseId: 'wh-main' });
  assert.equal(stock.physical.scaled, quantityFromString('400', 'KGS').scaled);
  const voucher = await f.store.read().vouchers.findById(COMPANY, note.voucherId);
  assert.equal(voucher?.type, 'DEBIT_NOTE');
  assert.equal(voucher?.source?.number, note.number);
});

test('a full purchase return clears the supplier balance and removes the entire received quantity', async () => {
  const f = await setup();
  const { note } = await f.service.postPurchase(f.actor, command(f.bill.id, {
    idempotencyKey: 'full-purchase-return',
    lines: [{ originalLineId: '1', quantity: quantityFromString('500', 'KGS'), disposition: 'ACCEPTED' }],
  }));
  assert.equal(toDecimalString(note.totals.total), '37760.00');
  assert.equal(toDecimalString((await partyBalance(f.store.read(), COMPANY, asId<'Party'>(SUPPLIER))).balance), '0.00');
  assert.equal((await f.inventoryService.balance(f.actor, { itemId: 'TMT12', warehouseId: 'wh-main' })).physical.scaled, 0n);
});

test('purchase-return retries and concurrent quantity eligibility cannot double a debit note', async () => {
  const f = await setup();
  const first = await f.service.postPurchase(f.actor, command(f.bill.id));
  const retry = await f.service.postPurchase(f.actor, command(f.bill.id));
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.note.id, first.note.id);
  await assert.rejects(
    f.service.previewPurchase(f.actor, command(f.bill.id, { idempotencyKey: 'too-many', lines: [{ originalLineId: '1', quantity: quantityFromString('401', 'KGS'), disposition: 'ACCEPTED' }] })),
    (error: any) => error.code === 'RETURN_QUANTITY_EXCEEDS_ELIGIBLE',
  );
  const attempts = await Promise.allSettled([
    f.service.postPurchase(f.actor, command(f.bill.id, { idempotencyKey: 'two-fifty-a', lines: [{ originalLineId: '1', quantity: quantityFromString('250', 'KGS'), disposition: 'ACCEPTED' }] })),
    f.service.postPurchase(f.actor, command(f.bill.id, { idempotencyKey: 'two-fifty-b', lines: [{ originalLineId: '1', quantity: quantityFromString('250', 'KGS'), disposition: 'ACCEPTED' }] })),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
});

test('stock refusal rolls the supplier debit, GST reversal, sequence and note back', async () => {
  const f = await setup();
  await f.inventoryService.recordMovement(f.actor, {
    idempotencyKey: 'sold-most-steel', itemId: 'TMT12', warehouseId: 'wh-main', kind: 'SALE_OUT',
    quantity: quantityFromString('450', 'KGS'), documentDate: isoDate('2026-08-25'),
    source: { kind: 'sales_invoice', id: 'later-sale', number: 'INV/99' },
  });
  await assert.rejects(f.service.postPurchase(f.actor, command(f.bill.id)), (error: any) => error.code === 'STOCK_WOULD_GO_NEGATIVE');
  assert.equal((await f.notes.listForOriginal(COMPANY, f.bill.id)).length, 0);
  assert.equal((await f.store.read().vouchers.list(COMPANY, { types: ['DEBIT_NOTE'] })).length, 0);
  const supplier = await partyBalance(f.store.read(), COMPANY, asId<'Party'>(SUPPLIER));
  assert.equal(toDecimalString(supplier.balance), '-37760.00');
});

test('a reverse-charge purchase return also reverses the government liability', async () => {
  const f = await setup({ taxLiability: 'REVERSE_CHARGE', invoiceTotalPaise: 32_000_00n });
  const { note } = await f.service.postPurchase(f.actor, command(f.bill.id));
  assert.equal(toDecimalString(note.totals.total), '6400.00');
  assert.equal(toDecimalString(note.totals.reverseChargeTax), '1152.00');
  const voucher = await f.store.read().vouchers.findById(COMPANY, note.voucherId);
  assert.ok(voucher);
  const roleOf = async (line: (typeof voucher.lines)[number]) => (await f.store.read().accounts.findById(COMPANY, line.accountId))?.systemRole;
  const roles = await Promise.all(voucher.lines.map(roleOf));
  assert.ok(roles.includes('REVERSE_CHARGE_PAYABLE'));
});

test('a purchase return cannot cross companies or omit its dedicated permission', async () => {
  const f = await setup();
  await assert.rejects(
    f.service.previewPurchase({ ...f.actor, companyId: 'other-company' as any }, command(f.bill.id)),
    (error: any) => error.code === 'RETURN_ORIGINAL_NOT_FOUND',
  );
  await assert.rejects(
    f.service.previewPurchase({ ...f.actor, permissions: permissions.filter((permission) => permission !== 'returns.create') }, command(f.bill.id)),
    (error: any) => error.code === 'PERMISSION_DENIED',
  );
});
