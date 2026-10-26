/**
 * Issue #295 — a bill can be settled without money: TDS the customer deducted (a receivable from
 * the government, never the customer's debt), a discount allowed, or a small balance written off.
 * The receipt prints all three, and the TDS receivable report is grouped by quarter for Form 26AS.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { useFixedAppClock } from '../src/app-clock.ts';
import { signIn as signInAs } from './sign-in-helper.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const SHREE_RAM = 'sampoorna:party:supplier';
const DATE = '2026-09-27';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

/** A fresh ₹1,180 bill to a new customer each test needs one: the same seeded item as #230 sells. */
const billed = async () => {
  const owner = await signInAs('owner@sampoorna.example.invalid', SAMPOORNA);
  // The sale needs the goods in the godown first: buy more of the seeded steel than it asks for.
  const bought = await request('POST', '/api/purchases/record', {
    supplierId: SHREE_RAM, reference: `SRS-295-${Math.random().toString(36).slice(2, 8)}`, date: DATE,
    lines: [{ item: 'TMT Steel Bar 12mm', quantity: '25', rate: '90', gst: '1800' }],
  }, owner);
  assert.equal(bought.status, 200, JSON.stringify(bought.body));
  const customer = await request('POST', '/api/customers', {
    legalName: `Tenant ${crypto.randomUUID().slice(0, 13)} Works`, registration: 'unregistered',
    line1: 'Shop 1, MG Road', city: 'Bengaluru', pincode: '560001',
  }, owner);
  assert.equal(customer.status, 200, JSON.stringify(customer.body));
  const sold = await request('POST', '/api/sales/record', {
    customerId: customer.body.customer.id, item: 'TMT Steel Bar 12mm', quantity: '10', rate: '100',
    date: DATE, terms: '30', requestId: `settle-sale-${customer.body.customer.id}`,
  }, owner);
  assert.equal(sold.status, 200, JSON.stringify(sold.body));
  return { owner, customerId: customer.body.customer.id as string, bill: { id: sold.body.invoice.id as string, number: sold.body.invoice.number as string } };
};

test('₹1,180 with ₹180 deducted as TDS: ₹1,000 received settles the bill, and it goes on the TDS report', async () => {
  const { owner, customerId, bill } = await billed();
  const open = await request('POST', '/api/payments/open-bills', { partyId: customerId, date: DATE }, owner);
  assert.equal(open.body.tdsSections.includes('194C'), true);
  assert.equal(open.body.writeOffLimit, 100);
  assert.equal(open.body.tdsQuarter, 'Q2-2026-27');

  const settlements = JSON.stringify([{ bill: bill.id, tds: { amount: '180', section: '194C', certificate: 'CERT-77' } }]);
  const input = { partyId: customerId, amount: '1000', date: DATE, method: 'UPI', settlements, requestId: 'settle-tds-1' };
  const preview = await request('POST', '/api/payments/preview', input, owner);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.ok(preview.body.effects.some((line: string) => line.includes('₹180.00 of tax deducted under s.194C (Q2-2026-27)')), preview.body.effects.join('\n'));
  // The review counts the deduction too: cash plus TDS closes the bill, so nothing is left due.
  assert.ok(preview.body.effects.some((line: string) => line.includes('₹0.00 after this')), preview.body.effects.join('\n'));

  const recorded = await request('POST', '/api/payments/record', input, owner);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.equal(recorded.body.outstanding, 0);
  assert.deepEqual(recorded.body.adjustments, [{ number: bill.number, kind: 'TDS_DEDUCTED', amount: 180, section: '194C', quarter: 'Q2-2026-27', certificate: 'CERT-77' }]);

  // Pressed again: one payment, still settled once.
  const again = await request('POST', '/api/payments/record', input, owner);
  assert.equal(again.body.deduplicated, true);
  assert.equal(again.body.paymentId, recorded.body.paymentId);

  // The customer owes nothing — the ₹180 is money the government owes, not them.
  const reports = await request('GET', '/api/reports', {}, owner);
  assert.equal(reports.body.dues.receivables.rows.some((row: any) => row.party.startsWith('Tenant') && row.outstanding > 0), false);
  const tds = reports.body.tds.rows.find((row: any) => row.bill === bill.number);
  assert.deepEqual([tds.quarter, tds.section, tds.amount], ['Q2-2026-27', '194C', 180]);

  const voucher = await request('POST', '/api/payments/voucher', { paymentId: recorded.body.paymentId }, owner);
  assert.match(voucher.body.html, /TDS deducted by the customer under s\.194C \(Q2-2026-27\)/);
  assert.match(voucher.body.html, /CERT-77/);
});

test('a discount allowed counts as an expense, and a small write-off within the owner\'s limit settles', async () => {
  const { owner, customerId, bill } = await billed();
  const settlements = JSON.stringify([{ bill: bill.id, discount: { amount: '50' }, writeOff: { amount: '30' } }]);
  const recorded = await request('POST', '/api/payments/record', {
    partyId: customerId, amount: '1100', date: DATE, method: 'Cash', settlements, requestId: 'settle-discount-1',
  }, owner);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.equal(recorded.body.outstanding, 0);
  assert.deepEqual(recorded.body.adjustments.map((a: any) => a.kind), ['DISCOUNT_ALLOWED', 'BALANCE_WRITTEN_OFF']);

  const voucher = await request('POST', '/api/payments/voucher', { paymentId: recorded.body.paymentId }, owner);
  assert.match(voucher.body.html, /Discount allowed/);
  assert.match(voucher.body.html, /Balance written off/);
});

test('a write-off past the owner\'s limit, TDS with no section, and adjustments on money paid are refused', async () => {
  const { owner, customerId, bill } = await billed();
  const over = await request('POST', '/api/payments/record', {
    partyId: customerId, amount: '1100', date: DATE, method: 'Cash', requestId: 'settle-over-limit',
    settlements: JSON.stringify([{ bill: bill.id, writeOff: { amount: '101' } }]),
  }, owner);
  assert.equal(over.status, 422, JSON.stringify(over.body));
  assert.equal(over.body.code, 'WRITE_OFF_OVER_LIMIT');

  const noSection = await request('POST', '/api/payments/preview', {
    partyId: customerId, amount: '1100', date: DATE, method: 'Cash', requestId: 'settle-no-section',
    settlements: JSON.stringify([{ bill: bill.id, tds: { amount: '80', section: '' } }]),
  }, owner);
  assert.equal(noSection.body.code, 'TDS_SECTION_REQUIRED');

  const onPaid = await request('POST', '/api/payments/record', {
    direction: 'PAYMENT', partyId: SHREE_RAM, amount: '100', date: DATE, method: 'Cash', requestId: 'settle-on-paid',
    settlements: JSON.stringify([{ bill: bill.id, writeOff: { amount: '50' } }]),
  }, owner);
  assert.equal(onPaid.body.code, 'SETTLEMENT_ON_MONEY_PAID');

  const anotherBill = await request('POST', '/api/payments/open-bills', { party: 'ABC Traders', date: DATE }, owner);
  const notTheirs = await request('POST', '/api/payments/record', {
    partyId: customerId, amount: '1100', date: DATE, method: 'Cash', requestId: 'settle-not-theirs',
    settlements: JSON.stringify([{ bill: anotherBill.body.bills[0].id, writeOff: { amount: '10' } }]),
  }, owner);
  assert.equal(notTheirs.body.code, 'SETTLEMENT_BILL_NOT_THEIRS');
});

test('a discount chosen as a GST credit note issues a real s.34 note, and needs both answers first', async () => {
  const { owner, customerId, bill } = await billed();
  // Without the two s.15(3)(b) answers the note is refused, pointing at the expense way instead.
  const noEvidence = await request('POST', '/api/payments/preview', {
    partyId: customerId, amount: '1100', date: DATE, method: 'UPI', requestId: 'settle-cn-no',
    settlements: JSON.stringify([{ bill: bill.id, discount: { amount: '80', creditNote: true } }]),
  }, owner);
  assert.equal(noEvidence.body.code, 'DISCOUNT_EVIDENCE_REQUIRED');

  const recorded = await request('POST', '/api/payments/record', {
    partyId: customerId, amount: '1100', date: DATE, method: 'UPI', requestId: 'settle-cn-yes',
    settlements: JSON.stringify([{ bill: bill.id, discount: { amount: '80', creditNote: true, agreedBeforeSupply: true, buyerReversedItc: true } }]),
  }, owner);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.equal(recorded.body.outstanding, 0, 'cash plus the note settles the bill');
  assert.equal(recorded.body.creditNotes.length >= 1, true);
  const voucher = await request('POST', '/api/payments/voucher', { paymentId: recorded.body.paymentId }, owner);
  assert.match(voucher.body.html, /Credit note issued for the discount/);
});

test('a later receipt on the same bill does not claim an earlier receipt\'s credit note', async () => {
  const { owner, customerId, bill } = await billed();
  // First receipt: ₹1,000 cash and an ₹80 GST credit note, leaving ₹100 owed.
  const first = await request('POST', '/api/payments/record', {
    partyId: customerId, amount: '1000', date: DATE, method: 'UPI', requestId: 'settle-cn-first',
    settlements: JSON.stringify([{ bill: bill.id, discount: { amount: '80', creditNote: true, agreedBeforeSupply: true, buyerReversedItc: true } }]),
  }, owner);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.outstanding, 100);

  // Second receipt: the last ₹100 in cash against the same bill, no adjustment of its own.
  const second = await request('POST', '/api/payments/record', {
    partyId: customerId, amount: '100', date: DATE, method: 'Cash', requestId: 'settle-cn-second', bills: [bill.id],
  }, owner);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.outstanding, 0);

  const firstVoucher = await request('POST', '/api/payments/voucher', { paymentId: first.body.paymentId }, owner);
  assert.match(firstVoucher.body.html, /Credit note issued for the discount/);
  const secondVoucher = await request('POST', '/api/payments/voucher', { paymentId: second.body.paymentId }, owner);
  assert.doesNotMatch(secondVoucher.body.html, /Credit note issued for the discount/);
});
