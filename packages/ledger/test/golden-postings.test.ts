/**
 * Issue #4 [E04] — golden posting tests for every voucher type.
 *
 * These are the worked examples from docs/product/05-worked-examples.md, posted for real. If a
 * number here changes, the specification changed, and that is a decision, not a refactor.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fromDecimalString, isoDate, rupees, toDecimalString, zero } from '@invoice/kernel';
import { accountBalance, partyBalance, trialBalance } from '../src/balances.ts';
import { checkBalance } from '../src/domain/posting.ts';
import { ABC_TRADERS, makeLedger, NASHIK_FARMS, key } from './fixtures.ts';

const nil = zero();

test('PURCHASE — nil-rated goods increase stock cost and create a payable (worked example 1)', async () => {
  const l = await makeLedger();
  const value = rupees(50000);
  const { voucher } = await l.service.postVoucher(l.actor, {
    idempotencyKey: key('nf-1187'),
    type: 'PURCHASE',
    date: isoDate('2026-04-04'),
    source: { kind: 'purchase_invoice', id: 'pi-1', number: 'NF/1187' },
    lines: [
      { accountId: l.account('PURCHASES_GOODS'), debit: value, credit: nil },
      { accountId: l.nashikFarmsAccount, partyId: NASHIK_FARMS, debit: nil, credit: value },
    ],
  });

  assert.equal(voucher.state, 'FINAL');
  assert.equal(voucher.type, 'PURCHASE');
  assert.equal(voucher.number, 'PURCHASE/2026-27/000001');
  assert.ok(checkBalance(voucher.lines).balanced);

  const supplier = await partyBalance(l.store.read(), l.actor.companyId, NASHIK_FARMS);
  // The supplier is owed, so the debit-side view is negative: we owe ₹50,000.
  assert.equal(toDecimalString(supplier.balance), '-50000.00');
  const purchases = await accountBalance(l.store.read(), l.actor.companyId, l.account('PURCHASES_GOODS'));
  assert.equal(toDecimalString(purchases.balance), '50000.00');
});

test('PURCHASE — inter-state goods carry input IGST only (worked example 2)', async () => {
  const l = await makeLedger();
  const taxable = rupees(40000);
  const igst = rupees(7200);
  const total = rupees(47200);
  const { voucher } = await l.service.postVoucher(l.actor, {
    idempotencyKey: key('nf-1191'),
    type: 'PURCHASE',
    date: isoDate('2026-04-06'),
    source: { kind: 'purchase_invoice', id: 'pi-2', number: 'NF/1191' },
    lines: [
      { accountId: l.account('PURCHASES_GOODS'), debit: taxable, credit: nil },
      { accountId: l.account('INPUT_IGST'), debit: igst, credit: nil },
      { accountId: l.nashikFarmsAccount, partyId: NASHIK_FARMS, debit: nil, credit: total },
    ],
  });

  const check = checkBalance(voucher.lines);
  assert.ok(check.balanced);
  assert.equal(toDecimalString(check.totalDebit), '47200.00');
  const inputCgst = await accountBalance(l.store.read(), l.actor.companyId, l.account('INPUT_CGST'));
  assert.equal(toDecimalString(inputCgst.balance), '0.00', 'an inter-state purchase must not touch CGST');
});

test('SALE — an intra-state sale splits CGST and SGST and balances after round-off (worked example 3)', async () => {
  const l = await makeLedger();
  const taxable = fromDecimalString('999.99');
  const cgst = rupees(90);
  const sgst = rupees(90);
  const roundOff = fromDecimalString('0.01');
  const invoiceValue = rupees(1180);

  const { voucher } = await l.service.postVoucher(l.actor, {
    idempotencyKey: key('inv-41'),
    type: 'SALE',
    date: isoDate('2026-04-10'),
    source: { kind: 'sales_invoice', id: 'si-41', number: 'INV/KB/2026-27/00041' },
    lines: [
      { accountId: l.abcTradersAccount, partyId: ABC_TRADERS, debit: invoiceValue, credit: nil },
      { accountId: l.account('SALES_GOODS'), debit: nil, credit: taxable },
      { accountId: l.account('OUTPUT_CGST'), debit: nil, credit: cgst },
      { accountId: l.account('OUTPUT_SGST'), debit: nil, credit: sgst },
      { accountId: l.account('ROUND_OFF'), debit: nil, credit: roundOff },
    ],
  });

  const check = checkBalance(voucher.lines);
  assert.ok(check.balanced, 'rounding must not break the balance');
  assert.equal(toDecimalString(check.totalDebit), '1180.00');
  assert.equal(voucher.lines.length, 5);

  const customer = await partyBalance(l.store.read(), l.actor.companyId, ABC_TRADERS);
  assert.equal(toDecimalString(customer.balance), '1180.00');
});

test('RECEIPT, cheque clearing and a second RECEIPT leave the exact outstanding (worked example 5)', async () => {
  const l = await makeLedger();
  const invoiceValue = rupees(100000);
  await l.service.postVoucher(l.actor, {
    idempotencyKey: key('inv-44'),
    type: 'SALE',
    date: isoDate('2026-04-15'),
    source: { kind: 'sales_invoice', id: 'si-44', number: 'INV/KB/2026-27/00044' },
    lines: [
      { accountId: l.abcTradersAccount, partyId: ABC_TRADERS, debit: invoiceValue, credit: nil },
      { accountId: l.account('SALES_GOODS'), debit: nil, credit: invoiceValue },
    ],
  });

  const cheque = rupees(30000);
  await l.service.postVoucher(l.actor, {
    idempotencyKey: key('rcpt-cheque'),
    type: 'RECEIPT',
    date: isoDate('2026-04-20'),
    source: { kind: 'payment', id: 'pay-1', number: 'CHQ 112233' },
    lines: [
      { accountId: l.account('CHEQUES_IN_HAND'), debit: cheque, credit: nil },
      { accountId: l.abcTradersAccount, partyId: ABC_TRADERS, debit: nil, credit: cheque },
    ],
  });

  await l.service.postVoucher(l.actor, {
    idempotencyKey: key('cheque-cleared'),
    type: 'JOURNAL',
    date: isoDate('2026-04-24'),
    narration: 'Cheque 112233 cleared',
    lines: [
      { accountId: l.hdfcAccount, debit: cheque, credit: nil },
      { accountId: l.account('CHEQUES_IN_HAND'), debit: nil, credit: cheque },
    ],
  });

  const transfer = rupees(20000);
  await l.service.postVoucher(l.actor, {
    idempotencyKey: key('rcpt-transfer'),
    type: 'RECEIPT',
    date: isoDate('2026-04-28'),
    source: { kind: 'payment', id: 'pay-2', number: 'HDFCN26041800123' },
    lines: [
      { accountId: l.hdfcAccount, debit: transfer, credit: nil },
      { accountId: l.abcTradersAccount, partyId: ABC_TRADERS, debit: nil, credit: transfer },
    ],
  });

  const customer = await partyBalance(l.store.read(), l.actor.companyId, ABC_TRADERS);
  assert.equal(toDecimalString(customer.balance), '50000.00', 'ABC Traders still owes ₹50,000');

  const chequesInHand = await accountBalance(l.store.read(), l.actor.companyId, l.account('CHEQUES_IN_HAND'));
  assert.equal(toDecimalString(chequesInHand.balance), '0.00', 'the cheque has cleared out of the holding account');

  const bank = await accountBalance(l.store.read(), l.actor.companyId, l.hdfcAccount);
  assert.equal(toDecimalString(bank.balance), '50000.00');
});

test('CREDIT_NOTE — a partial return reduces the customer balance (worked example 6)', async () => {
  const l = await makeLedger();
  await l.service.postVoucher(l.actor, {
    idempotencyKey: key('inv-44b'),
    type: 'SALE',
    date: isoDate('2026-04-15'),
    lines: [
      { accountId: l.abcTradersAccount, partyId: ABC_TRADERS, debit: rupees(100000), credit: nil },
      { accountId: l.account('SALES_GOODS'), debit: nil, credit: rupees(100000) },
    ],
  });

  const returnValue = rupees(20000);
  const { voucher } = await l.service.postVoucher(l.actor, {
    idempotencyKey: key('cn-3'),
    type: 'CREDIT_NOTE',
    date: isoDate('2026-05-02'),
    source: { kind: 'credit_note', id: 'cn-3', number: 'CN/KB/2026-27/0003' },
    lines: [
      { accountId: l.account('SALES_RETURNS'), debit: returnValue, credit: nil },
      { accountId: l.abcTradersAccount, partyId: ABC_TRADERS, debit: nil, credit: returnValue },
    ],
  });

  assert.equal(voucher.number, 'CREDIT_NOTE/2026-27/000001');
  const customer = await partyBalance(l.store.read(), l.actor.companyId, ABC_TRADERS);
  assert.equal(toDecimalString(customer.balance), '80000.00');
});

test('DEBIT_NOTE — a purchase return reduces what we owe the supplier', async () => {
  const l = await makeLedger();
  await l.service.postVoucher(l.actor, {
    idempotencyKey: key('pi-dn'),
    type: 'PURCHASE',
    date: isoDate('2026-04-04'),
    lines: [
      { accountId: l.account('PURCHASES_GOODS'), debit: rupees(50000), credit: nil },
      { accountId: l.nashikFarmsAccount, partyId: NASHIK_FARMS, debit: nil, credit: rupees(50000) },
    ],
  });
  await l.service.postVoucher(l.actor, {
    idempotencyKey: key('dn-1'),
    type: 'DEBIT_NOTE',
    date: isoDate('2026-04-18'),
    lines: [
      { accountId: l.nashikFarmsAccount, partyId: NASHIK_FARMS, debit: rupees(2500), credit: nil },
      { accountId: l.account('PURCHASE_RETURNS'), debit: nil, credit: rupees(2500) },
    ],
  });
  const supplier = await partyBalance(l.store.read(), l.actor.companyId, NASHIK_FARMS);
  assert.equal(toDecimalString(supplier.balance), '-47500.00');
});

test('PAYMENT — money going out to a supplier', async () => {
  const l = await makeLedger();
  await l.service.postVoucher(l.actor, {
    idempotencyKey: key('pi-pay'),
    type: 'PURCHASE',
    date: isoDate('2026-04-04'),
    lines: [
      { accountId: l.account('PURCHASES_GOODS'), debit: rupees(50000), credit: nil },
      { accountId: l.nashikFarmsAccount, partyId: NASHIK_FARMS, debit: nil, credit: rupees(50000) },
    ],
  });
  await l.service.postVoucher(l.actor, {
    idempotencyKey: key('pay-nf'),
    type: 'PAYMENT',
    date: isoDate('2026-04-25'),
    lines: [
      { accountId: l.nashikFarmsAccount, partyId: NASHIK_FARMS, debit: rupees(20000), credit: nil },
      { accountId: l.hdfcAccount, debit: nil, credit: rupees(20000) },
    ],
  });
  const supplier = await partyBalance(l.store.read(), l.actor.companyId, NASHIK_FARMS);
  assert.equal(toDecimalString(supplier.balance), '-30000.00');
});

test('OPENING_BALANCE — what the business already had on the day it started', async () => {
  const l = await makeLedger();
  const { voucher } = await l.service.postVoucher(l.actor, {
    idempotencyKey: key('opening'),
    type: 'OPENING_BALANCE',
    date: isoDate('2026-04-01'),
    narration: 'Balances carried in on 1 April 2026',
    lines: [
      { accountId: l.account('CASH_IN_HAND'), debit: rupees(200000), credit: nil },
      { accountId: l.abcTradersAccount, partyId: ABC_TRADERS, debit: rupees(40000), credit: nil },
      { accountId: l.nashikFarmsAccount, partyId: NASHIK_FARMS, debit: nil, credit: rupees(60000) },
      { accountId: l.account('OPENING_BALANCE_DIFFERENCE'), debit: nil, credit: rupees(180000) },
    ],
  });
  assert.ok(checkBalance(voucher.lines).balanced);
  const tb = await trialBalance(l.store.read(), l.actor.companyId);
  assert.ok(tb.balanced, 'the books balance immediately after opening balances');
  assert.equal(toDecimalString(tb.totalDebit), '240000.00');
});

test('the whole example month reconciles: both sides of the books match', async () => {
  const l = await makeLedger();
  const post = (k: string, type: 'SALE' | 'PURCHASE' | 'RECEIPT', date: string, lines: Parameters<typeof l.service.postVoucher>[1]['lines']) =>
    l.service.postVoucher(l.actor, { idempotencyKey: key(k), type, date: isoDate(date), lines });

  await post('m-pi1', 'PURCHASE', '2026-04-04', [
    { accountId: l.account('PURCHASES_GOODS'), debit: rupees(50000), credit: nil },
    { accountId: l.nashikFarmsAccount, partyId: NASHIK_FARMS, debit: nil, credit: rupees(50000) },
  ]);
  await post('m-si1', 'SALE', '2026-04-12', [
    { accountId: l.abcTradersAccount, partyId: ABC_TRADERS, debit: rupees(56000), credit: nil },
    { accountId: l.account('SALES_GOODS'), debit: nil, credit: rupees(56000) },
  ]);
  await post('m-rc1', 'RECEIPT', '2026-04-20', [
    { accountId: l.hdfcAccount, debit: rupees(30000), credit: nil },
    { accountId: l.abcTradersAccount, partyId: ABC_TRADERS, debit: nil, credit: rupees(30000) },
  ]);

  const tb = await trialBalance(l.store.read(), l.actor.companyId, { from: isoDate('2026-04-01'), to: isoDate('2026-04-30') });
  assert.ok(tb.balanced, `trial balance is off by ${toDecimalString(tb.difference)}`);
  assert.equal(toDecimalString(tb.totalDebit), toDecimalString(tb.totalCredit));

  // Every total drills back to the lines that produced it.
  const customer = await partyBalance(l.store.read(), l.actor.companyId, ABC_TRADERS);
  assert.equal(toDecimalString(customer.balance), '26000.00');
});
