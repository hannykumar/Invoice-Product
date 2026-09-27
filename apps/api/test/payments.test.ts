/**
 * Issue #230 — money received from the customer who paid, and money paid to the supplier who was paid.
 *
 * Before this, every receipt was posted to the demo customer ABC Traders whatever name was typed,
 * only ABC Traders' bills were offered, every payment was recorded as cash, and there was no way at
 * all to record paying a supplier. The trade below is steps 1, 3, 7 and 8 of the full trade check.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { useFixedAppClock } from '../src/app-clock.ts';

// Issue #234 — the running app reads the real clock; this file pins it so its dates do not drift.
useFixedAppClock('2026-09-28T10:00:00.000Z');

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const SHREE_RAM = 'sampoorna:party:supplier';
const DATE = '2026-09-27';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const signIn = async (): Promise<string> => {
  const response = await request('POST', '/api/auth/login', { companyId: SAMPOORNA, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' });
  assert.equal(response.status, 200);
  return response.body.sessionId as string;
};

/** Buy SRS-101, add Mehta, sell to Mehta: ₹37,760 owed to Shree Ram and ₹50,150 owed by Mehta. */
const trade = (() => {
  let done: Promise<{ owner: string; mehta: string; bill: { id: string; number: string }; srs: string }> | null = null;
  return () => done ??= (async () => {
    const owner = await signIn();
    const bought = await request('POST', '/api/purchases/record', {
      supplierId: SHREE_RAM, reference: 'SRS-101', date: DATE,
      lines: [{ item: 'TMT Steel Bar 12mm', quantity: '500', rate: '64', gst: '1800' }],
    }, owner);
    assert.equal(bought.status, 200, JSON.stringify(bought.body));
    const customer = await request('POST', '/api/customers', {
      legalName: 'Mehta Construction Supplies', registration: 'regular', gstin: '27AAACM1234K1ZN',
      line1: 'Plot 22, MIDC Bhosari', city: 'Pune', pincode: '411026',
    }, owner);
    assert.equal(customer.status, 200, JSON.stringify(customer.body));
    const sold = await request('POST', '/api/sales/record', {
      customerId: customer.body.customer.id, item: 'TMT Steel Bar 12mm', quantity: '450', rate: '90',
      freight: '2000', vehicle: 'KA01AB1234', date: DATE, terms: '30', reference: 'payments-230-sale',
    }, owner);
    assert.equal(sold.status, 200, JSON.stringify(sold.body));
    assert.equal(sold.body.invoice.total ?? sold.body.amount ?? 50150, 50150);
    return { owner, mehta: customer.body.customer.id as string, bill: { id: sold.body.invoice.id as string, number: sold.body.invoice.number as string }, srs: bought.body.bill.id as string };
  })();
})();

const receivable = async (owner: string, party: string) =>
  (await request('GET', '/api/reports', {}, owner)).body.dues.receivables.rows.find((row: any) => row.party === party);

test('the open-bill list for Mehta holds only Mehta\'s bill, not ABC Traders\' bills', async () => {
  const { owner, mehta, bill } = await trade();
  const open = await request('POST', '/api/payments/open-bills', { partyId: mehta, date: DATE }, owner);
  assert.equal(open.status, 200, JSON.stringify(open.body));
  assert.equal(open.body.party.name, 'Mehta Construction Supplies');
  assert.deepEqual(open.body.bills.map((b: any) => [b.number, b.outstanding]), [[bill.number, 50150]]);
  const abc = await request('POST', '/api/payments/open-bills', { party: 'ABC Traders', date: DATE }, owner);
  assert.equal(abc.body.bills.some((b: any) => b.id === bill.id), false);
  assert.equal(abc.body.owed, 1838);
});

test('a payment with nobody chosen is refused, never given to the demo customer', async () => {
  const { owner } = await trade();
  for (const path of ['/api/payments/preview', '/api/payments/record']) {
    const refused = await request('POST', path, { amount: '100', date: DATE, method: 'UPI', requestId: 'nobody-230' }, owner);
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'PAYMENT_CUSTOMER_REQUIRED');
  }
  const noMode = await request('POST', '/api/payments/preview', { party: 'ABC Traders', amount: '100', date: DATE, requestId: 'no-mode-230' }, owner);
  assert.equal(noMode.body.code, 'PAYMENT_MODE_REQUIRED');
});

test('money from Mehta cannot be put against a bill of ABC Traders', async () => {
  const { owner, mehta } = await trade();
  const abc = await request('POST', '/api/payments/open-bills', { party: 'ABC Traders', date: DATE }, owner);
  const theirs = abc.body.bills[0].id as string;
  const refused = await request('POST', '/api/payments/record', { partyId: mehta, amount: '500', date: DATE, method: 'UPI', bills: [theirs], requestId: 'wrong-party-230' }, owner);
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'PAYMENT_BILL_NOT_THEIRS');
  assert.match(refused.body.message, /Mehta Construction Supplies/);
  assert.equal((await receivable(owner, 'ABC Traders')).outstanding, 1838, 'ABC Traders is untouched');
});

test('₹30,000 by bank transfer from Mehta: the review names Mehta, the bill keeps ₹20,150 due, ABC Traders stays at ₹1,838', async () => {
  const { owner, mehta, bill } = await trade();
  const input = { partyId: mehta, amount: '30000', date: DATE, method: 'Bank transfer', bills: JSON.stringify([bill.id]), requestId: 'mehta-30000' };
  const preview = await request('POST', '/api/payments/preview', input, owner);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.message, '₹30,000.00 will reduce what Mehta Construction Supplies owes.');
  assert.doesNotMatch(JSON.stringify(preview.body), /ABC Traders/);
  assert.ok(preview.body.effects.includes(`${bill.number}: ₹50,150.00 − ₹30,000.00 = ₹20,150.00 still due on this bill`), preview.body.effects.join('\n'));

  const recorded = await request('POST', '/api/payments/record', input, owner);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.equal(recorded.body.mode, 'BANK_TRANSFER', 'the mode recorded is the one chosen');
  assert.equal(recorded.body.outstanding, 20150);
  assert.deepEqual(recorded.body.settled, [{ number: bill.number, amount: 30000 }]);

  // Pressed again: one payment, not two.
  const again = await request('POST', '/api/payments/record', input, owner);
  assert.equal(again.body.deduplicated, true);
  assert.equal(again.body.paymentId, recorded.body.paymentId);

  assert.equal((await receivable(owner, 'Mehta Construction Supplies')).outstanding, 20150);
  assert.equal((await receivable(owner, 'ABC Traders')).outstanding, 1838);

  const voucher = await request('POST', '/api/payments/voucher', { paymentId: recorded.body.paymentId }, owner);
  assert.equal(voucher.status, 200, JSON.stringify(voucher.body));
  assert.match(voucher.body.html, /<h1>Receipt<\/h1>/);
  assert.match(voucher.body.html, /Mehta Construction Supplies/);
  assert.match(voucher.body.html, /Rupees thirty thousand only/);
  assert.match(voucher.body.html, /Bank transfer/);
  assert.ok(voucher.body.html.includes(bill.number));
});

test('each mode is recorded as chosen, and a cheque asks for its number and date', async () => {
  const { owner } = await trade();
  for (const [method, mode] of [['UPI', 'UPI'], ['Cash', 'CASH']] as const) {
    const paid = await request('POST', '/api/payments/record', { party: 'ABC Traders', amount: '10', date: DATE, method, requestId: `mode-${method}` }, owner);
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.mode, mode);
  }
  const noCheque = await request('POST', '/api/payments/record', { party: 'ABC Traders', amount: '10', date: DATE, method: 'Cheque', requestId: 'mode-cheque' }, owner);
  assert.equal(noCheque.body.code, 'PAYMENT_CHEQUE_DETAILS_REQUIRED');
  const cheque = await request('POST', '/api/payments/record', { party: 'ABC Traders', amount: '10', date: DATE, method: 'Cheque', chequeNumber: '004512', chequeDate: DATE, requestId: 'mode-cheque' }, owner);
  assert.equal(cheque.body.mode, 'CHEQUE');
});

test('paying more than the bill leaves the extra on account for that customer', async () => {
  const owner = await signIn();
  const abc = await request('POST', '/api/payments/open-bills', { party: 'ABC Traders', date: DATE }, owner);
  const smallest = [...abc.body.bills].sort((a: any, b: any) => a.outstanding - b.outstanding)[0];
  const extra = 100;
  const preview = await request('POST', '/api/payments/preview', { party: 'ABC Traders', amount: String(smallest.outstanding + extra), date: DATE, method: 'UPI', bills: [smallest.id], requestId: 'over-230' }, owner);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.ok(preview.body.effects.some((line: string) => line.includes('₹100.00 is more than the bills chosen, so it stays on account for ABC Traders.')), preview.body.effects.join('\n'));
  const recorded = await request('POST', '/api/payments/record', { party: 'ABC Traders', amount: String(smallest.outstanding + extra), date: DATE, method: 'UPI', bills: [smallest.id], requestId: 'over-230' }, owner);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.ok(recorded.body.onAccount >= extra);
  assert.ok((await receivable(owner, 'ABC Traders')).onAccount >= extra);
});

test('paying Shree Ram ₹37,760 against SRS-101 by bank transfer leaves nothing owed to suppliers, once', async () => {
  const { owner, srs } = await trade();
  const reports = async () => (await request('GET', '/api/reports', {}, owner)).body.dues.payables;
  assert.equal((await reports()).total, 37760);

  const open = await request('POST', '/api/payments/open-bills', { direction: 'PAYMENT', partyId: SHREE_RAM, date: DATE }, owner);
  assert.deepEqual(open.body.bills.map((b: any) => [b.number, b.outstanding]), [['SRS-101', 37760]]);

  // A supplier payment against a customer's bill, or to nobody, is refused.
  const abc = await request('POST', '/api/payments/open-bills', { party: 'ABC Traders', date: DATE }, owner);
  const wrong = await request('POST', '/api/payments/record', { direction: 'PAYMENT', partyId: SHREE_RAM, amount: '100', date: DATE, method: 'UPI', bills: [abc.body.bills[0].id], requestId: 'srs-wrong' }, owner);
  assert.equal(wrong.body.code, 'PAYMENT_BILL_NOT_THEIRS');
  const nobody = await request('POST', '/api/payments/record', { direction: 'PAYMENT', amount: '100', date: DATE, method: 'UPI', requestId: 'srs-nobody' }, owner);
  assert.equal(nobody.body.code, 'PAYMENT_SUPPLIER_REQUIRED');

  const input = { direction: 'PAYMENT', partyId: SHREE_RAM, amount: '37760', date: DATE, method: 'Bank transfer', bills: [srs], requestId: 'srs-37760' };
  const preview = await request('POST', '/api/payments/preview', input, owner);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.message, '₹37,760.00 will reduce what you owe Shree Ram Steels Private Limited.');
  const paid = await request('POST', '/api/payments/record', input, owner);
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.mode, 'BANK_TRANSFER');
  assert.equal(paid.body.outstanding, 0);
  // Retried: still one payment, and payables fall by exactly ₹37,760, not twice that.
  const again = await request('POST', '/api/payments/record', input, owner);
  assert.equal(again.body.paymentId, paid.body.paymentId);
  const after = await reports();
  assert.equal(after.total, 0);
  assert.equal(after.rows.some((row: any) => row.party === 'Shree Ram Steels Private Limited'), false);
  assert.equal((await request('GET', '/api/dashboard', {}, owner)).body.supplier.outstanding, 0);

  const voucher = await request('POST', '/api/payments/voucher', { paymentId: paid.body.paymentId }, owner);
  assert.match(voucher.body.html, /<h1>Payment Voucher<\/h1>/);
  assert.match(voucher.body.html, /Rupees thirty-?seven thousand seven hundred (and )?sixty only/i);
  assert.ok(voucher.body.html.includes('SRS-101'));
});

test('a supplier is not paid more than the bills chosen', async () => {
  const owner = await signIn();
  const bought = await request('POST', '/api/purchases/record', {
    supplierId: SHREE_RAM, reference: 'SRS-230-X', date: DATE,
    lines: [{ item: 'TMT Steel Bar 12mm', quantity: '10', rate: '100', gst: '1800' }],
  }, owner);
  assert.equal(bought.status, 200, JSON.stringify(bought.body));
  const refused = await request('POST', '/api/payments/preview', { direction: 'PAYMENT', partyId: SHREE_RAM, amount: '2000', date: DATE, method: 'Cash', bills: [bought.body.bill.id], requestId: 'srs-over' }, owner);
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'PAYMENT_MORE_THAN_BILLS');
  assert.match(refused.body.message, /₹2,000.00 − ₹1,180.00 = ₹820.00/);
});
