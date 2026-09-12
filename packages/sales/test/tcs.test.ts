/**
 * Issue #145 — the year's sales to one customer, and the tax collected at source once they cross.
 *
 * The calculator's arithmetic is tested in `packages/gst-calc`. What is tested here is the part
 * only the sales module can get right: remembering the year, counting the right bills into it, and
 * recording the collected amount as money held for the government rather than as income or GST.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toDecimalString } from '@invoice/kernel';
import { partyBalance, trialBalance } from '@invoice/ledger';
import { DEFAULT_TCS_POLICY } from '@invoice/gst-calc';
import { ABC, GURUGRAM, actorWith, ALL_PERMISSIONS, inr, makeTill, on, qty } from './fixtures.ts';
import type { DraftInvoiceInput } from '../src/model.ts';

const COLLECTING = { tcs: { ...DEFAULT_TCS_POLICY, collects: true } };

/** ₹50,00,000 of crates, which comes to ₹59,00,000 with GST — enough to cross in one go. */
const fiftyLakhBill = (overrides: Partial<DraftInvoiceInput> = {}): DraftInvoiceInput => ({
  partyId: ABC,
  customerType: 'B2B',
  supplyKind: 'GOODS',
  documentDate: on('2026-04-10'),
  lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: qty('5000', 'PCS'), unitPrice: inr(1000), priceBasis: 'EXCLUSIVE' }],
  ...overrides,
});

let key = 0;
const issue = async (till: Awaited<ReturnType<typeof makeTill>>, input: DraftInvoiceInput) => {
  key += 1;
  const draft = await till.service.createDraft(till.actor, { idempotencyKey: `tcs-k${key}`, input });
  return till.service.finalise(till.actor, { idempotencyKey: `tcs-f${key}`, invoiceId: draft.id });
};

test('the first bill that takes the year past the threshold collects on the part above it', async () => {
  const till = await makeTill({ policy: COLLECTING });
  const { invoice } = await issue(till, fiftyLakhBill());

  // ₹59,00,000 with GST, of which ₹9,00,000 is above ₹50,00,000, at 0.10%.
  assert.equal(toDecimalString(invoice.pricing?.totals.tcs ?? inr(0)), '900.00');
  assert.equal(toDecimalString(invoice.pricing?.totals.invoiceValue ?? inr(0)), '5900900.00');
  assert.equal(toDecimalString(invoice.pricing?.tcs?.chargedOn ?? inr(0)), '900000.00');
});

test('the next bill to the same customer is charged in full, because the year is already past', async () => {
  const till = await makeTill({ policy: COLLECTING });
  await issue(till, fiftyLakhBill());
  const { invoice } = await issue(till, fiftyLakhBill());

  assert.equal(toDecimalString(invoice.pricing?.tcs?.priorSalesThisYear ?? inr(0)), '5900000.00');
  assert.equal(toDecimalString(invoice.pricing?.totals.tcs ?? inr(0)), '5900.00');
});

test('what was collected is held for the government, not taken as income or as GST', async () => {
  const till = await makeTill({ policy: COLLECTING });
  const result = await issue(till, fiftyLakhBill());
  const voucher = await till.ledger.getVoucher(till.actor, result.voucherId);
  assert.ok(voucher !== null);

  const held = voucher.lines.find((l) => l.accountId === till.account('TCS_PAYABLE'));
  assert.ok(held !== undefined, 'the collected amount must be posted somewhere of its own');
  assert.equal(toDecimalString(held.credit), '900.00');

  const sales = voucher.lines.find((l) => l.accountId === till.account('SALES_GOODS'));
  assert.equal(toDecimalString(sales?.credit ?? inr(0)), '5000000.00', 'income is the sale, without it');
  const cgst = voucher.lines.find((l) => l.accountId === till.account('OUTPUT_CGST'));
  assert.equal(toDecimalString(cgst?.credit ?? inr(0)), '450000.00', 'GST is the GST, without it');

  const debits = voucher.lines.reduce((a, l) => a + l.debit.minor, 0n);
  const credits = voucher.lines.reduce((a, l) => a + l.credit.minor, 0n);
  assert.equal(debits, credits, 'the entry balances');
  const owed = await partyBalance(till.store.read(), till.actor.companyId, ABC);
  assert.equal(toDecimalString(owed.balance), '5900900.00', 'the customer owes the bill including it');
  assert.ok((await trialBalance(till.store.read(), till.actor.companyId)).balanced);
});

test('a cancelled bill is not a sale, so it stops counting towards the threshold', async () => {
  const till = await makeTill({ policy: COLLECTING });
  const first = await issue(till, fiftyLakhBill());
  await till.service.cancel(actorWith(ALL_PERMISSIONS), {
    idempotencyKey: 'tcs-cancel',
    invoiceId: first.invoice.id,
    reason: 'Customer returned the whole lot',
    today: on('2026-04-12'),
  });

  const { invoice } = await issue(till, fiftyLakhBill());
  assert.equal(toDecimalString(invoice.pricing?.tcs?.priorSalesThisYear ?? inr(-1)), '0.00');
  assert.equal(toDecimalString(invoice.pricing?.totals.tcs ?? inr(0)), '900.00');
});

test('each customer has a threshold of their own', async () => {
  const till = await makeTill({ policy: COLLECTING });
  await issue(till, fiftyLakhBill());
  const { invoice } = await issue(till, fiftyLakhBill({ partyId: GURUGRAM }));

  assert.equal(toDecimalString(invoice.pricing?.tcs?.priorSalesThisYear ?? inr(-1)), '0.00');
  assert.equal(toDecimalString(invoice.pricing?.totals.tcs ?? inr(0)), '900.00');
});

test('the count starts again in the new financial year', async () => {
  const till = await makeTill({ policy: COLLECTING });
  await issue(till, fiftyLakhBill());
  const { invoice } = await issue(till, fiftyLakhBill({ documentDate: on('2027-04-10') }));

  assert.equal(invoice.financialYear, '2027-28');
  assert.equal(toDecimalString(invoice.pricing?.tcs?.priorSalesThisYear ?? inr(-1)), '0.00');
  // ₹56,00,000 with GST on this date, of which ₹6,00,000 is above the threshold, at 0.10%. The
  // crate rate in the fixtures drops to 12% from 1 July, which is why the figure is not ₹900.
  assert.equal(toDecimalString(invoice.pricing?.totals.tcs ?? inr(0)), '600.00');
});

test('a business that has not been told to collect adds nothing to any bill', async () => {
  const till = await makeTill();
  await issue(till, fiftyLakhBill());
  const { invoice, voucherId } = await issue(till, fiftyLakhBill());

  assert.equal(invoice.pricing?.tcs, null);
  assert.equal(toDecimalString(invoice.pricing?.totals.tcs ?? inr(-1)), '0.00');
  assert.equal(toDecimalString(invoice.pricing?.totals.invoiceValue ?? inr(0)), '5900000.00');
  const voucher = await till.ledger.getVoucher(till.actor, voucherId);
  assert.equal(voucher?.lines.find((l) => l.accountId === till.account('TCS_PAYABLE')), undefined);
});
