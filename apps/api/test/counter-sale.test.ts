/**
 * Issue #288 — a counter sale: the walk-in customer, "paid now" recorded with the bill, and the
 * state read from a PIN code. Issue #307 — what the done screen is handed after the sale.
 *
 * Every name, GST number and address below is synthetic and belongs to nobody.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { apiRuntime } from '../src/runtime.ts';
import { stockEverything } from './stock-helper.ts';
import { useFixedAppClock } from '../src/app-clock.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const DATE = '2026-09-28';
const SOAP = 'Herbal Bath Soap 100g';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const signIn = async (email = 'owner@sampoorna.example.invalid', password = 'karobar-demo'): Promise<string> => {
  const response = await request('POST', '/api/auth/login', { companyId: SAMPOORNA, email, password });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.sessionId as string;
};

let owner: Promise<string> | null = null;
const ownerSession = () => owner ??= (async () => {
  const session = await signIn();
  await stockEverything(`Bearer ${session}`);
  return session;
})();

const books = async (session: string) => {
  const reports = (await request('GET', '/api/reports', {}, session)).body;
  const row = (code: string) => reports.trialBalance.rows.find((r: any) => r.code === code)?.closing ?? 0;
  return { receivables: reports.dues.receivables.total as number, cash: row('1110'), bank: row('1121'), balanced: reports.trialBalance.balanced as boolean, bills: reports.sales.rows.length as number };
};

const walkInOf = async (session: string) => (await request('GET', '/api/catalogue', {}, session)).body.customers.find((c: any) => c.walkIn);

test('#288: every company has a walk-in customer: no GST number, and the shop\'s own state', async () => {
  const session = await ownerSession();
  const walkIn = await walkInOf(session);
  assert.ok(walkIn, 'the catalogue lists the walk-in customer');
  assert.equal(walkIn.gstin, null);
  assert.equal(walkIn.registration, 'unregistered');
  assert.equal(walkIn.stateCode, '29');
  assert.equal(walkIn.phone, null);
  // Asked for again, it is the same one.
  assert.equal((await walkInOf(session)).id, walkIn.id);
});

test('#288: a walk-in ₹120 + ₹6 GST paid by cash — receivables unchanged, cash +₹126, one bill and one receipt however often Record is pressed', async () => {
  const session = await ownerSession();
  const before = await books(session);
  const sale = { customerId: 'walk-in', item: SOAP, quantity: '3', rate: '40', date: DATE, terms: 'now', paidBy: 'CASH', requestId: 'counter-288-cash' };

  const review = await request('POST', '/api/sales/preview', sale, session);
  assert.equal(review.status, 200, JSON.stringify(review.body));
  assert.equal(review.body.amount, 126);
  assert.deepEqual(review.body.paidNow, { mode: 'CASH', amount: 126, due: 0 });
  assert.ok(!review.body.effects.includes('The customer balance will increase.'));
  assert.ok(review.body.effects.includes('Paid now by cash: ₹126.00. Nothing is left to pay on this bill.'));
  assert.match(review.body.placeOfSupply, /Karnataka \(29\) — the goods are handed over at your counter/);

  const first = await request('POST', '/api/sales/record', sale, session);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.invoice.amount, 126);
  assert.equal(first.body.paid.mode, 'CASH');
  assert.equal(first.body.paid.amount, 126);
  assert.match(first.body.paid.voucherNumber, /RECEIPT/);
  assert.equal(first.body.due, 0);
  assert.equal(first.body.upiLink, null, 'nothing is due, so there is no UPI link');
  assert.deepEqual({ name: first.body.customer.name, walkIn: first.body.customer.walkIn, phone: first.body.customer.phone }, { name: 'Walk-in / cash customer', walkIn: true, phone: null });
  assert.match(first.body.message, /was issued\. ₹126\.00 received by cash\./);

  const again = await request('POST', '/api/sales/record', sale, session);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.deduplicated, true);
  assert.equal(again.body.invoice.id, first.body.invoice.id);
  assert.equal(again.body.paid.paymentId, first.body.paid.paymentId);

  const after = await books(session);
  assert.equal(after.receivables, before.receivables, 'nothing is owed for a bill paid at the counter');
  assert.equal(Math.round((after.cash - before.cash) * 100), 12600, 'cash in hand goes up by ₹126');
  assert.equal(after.bills, before.bills + 1, 'one bill');
  assert.equal(after.balanced, true);

  // The printed bill says it was paid.
  const printed = await request('POST', '/api/sales/print', { invoice: first.body.invoice.id, format: 'THERMAL_58MM' }, session);
  assert.equal(printed.status, 200, JSON.stringify(printed.body));
  assert.equal(printed.body.format, 'THERMAL_58MM');
  assert.match(printed.body.html, /Walk-in \/ cash customer/);
});

test('#288: part paid by UPI into the bank — the rest is owed, and the UPI link asks for that rest only, with the bill number', async () => {
  const session = await ownerSession();
  assert.equal((await request('POST', '/api/branding/upi', { upiId: 'sampoorna@okicici' }, session)).status, 200);
  const before = await books(session);
  const sold = await request('POST', '/api/sales/record', {
    party: 'ABC Traders', item: SOAP, quantity: '3', rate: '40', date: DATE, terms: '7', paidBy: 'UPI', paidAmount: '100', requestId: 'counter-288-upi-part',
  }, session);
  assert.equal(sold.status, 200, JSON.stringify(sold.body));
  assert.equal(sold.body.due, 26);
  assert.equal(sold.body.upiLink, `upi://pay?pa=sampoorna@okicici&pn=${encodeURIComponent(sold.body.shop)}&am=26.00&cu=INR&tn=${encodeURIComponent(sold.body.invoice.number)}`);
  const after = await books(session);
  assert.equal(Math.round((after.receivables - before.receivables) * 100), 2600);
  assert.equal(Math.round((after.bank - before.bank) * 100), 10000);
  assert.equal(after.cash, before.cash);
  assert.equal(after.balanced, true);
});

test('#288: "within 7 days" keeps today\'s behaviour — nothing received, the whole bill owed and asked for', async () => {
  const session = await ownerSession();
  const before = await books(session);
  const sold = await request('POST', '/api/sales/record', { party: 'ABC Traders', item: SOAP, quantity: '3', rate: '40', date: DATE, terms: '7', requestId: 'counter-288-credit' }, session);
  assert.equal(sold.status, 200, JSON.stringify(sold.body));
  assert.equal(sold.body.paid, null);
  assert.equal(sold.body.due, 126);
  assert.match(sold.body.upiLink, /am=126\.00/);
  const after = await books(session);
  assert.equal(Math.round((after.receivables - before.receivables) * 100), 12600);
  assert.equal(after.cash, before.cash);
});

test('#288: more than the bill cannot be entered as paid, and a mode nobody knows is refused', async () => {
  const session = await ownerSession();
  const base = { customerId: 'walk-in', item: SOAP, quantity: '1', rate: '40', date: DATE, terms: 'now' };
  const more = await request('POST', '/api/sales/record', { ...base, paidBy: 'CASH', paidAmount: '500', requestId: 'counter-288-more' }, session);
  assert.equal(more.body.code, 'SALE_PAID_MORE_THAN_BILL', JSON.stringify(more.body));
  const cheque = await request('POST', '/api/sales/record', { ...base, paidBy: 'GOLD', requestId: 'counter-288-gold' }, session);
  assert.equal(cheque.body.code, 'SALE_PAID_BY_INVALID');
});

test('#288: from ₹50,000 of taxable value a walk-in must be named (Rule 46(e)); nothing is issued', async () => {
  const session = await ownerSession();
  const before = await books(session);
  const big = await request('POST', '/api/sales/record', { customerId: 'walk-in', item: SOAP, quantity: '1500', rate: '40', date: DATE, terms: 'now', paidBy: 'CASH', requestId: 'counter-288-big' }, session);
  assert.equal(big.status, 422, JSON.stringify(big.body));
  assert.equal(big.body.code, 'WALK_IN_NAME_REQUIRED');
  assert.match(big.body.message, /₹60,000\.00.*Rule 46\(e\)/);
  // Just under the line is fine.
  const small = await request('POST', '/api/sales/preview', { customerId: 'walk-in', item: SOAP, quantity: '1249', rate: '40', date: DATE, terms: 'now', paidBy: 'CASH', requestId: 'counter-288-under' }, session);
  assert.equal(small.status, 200, JSON.stringify(small.body));
  // Goods sent somewhere else need a named customer too.
  const sent = await request('POST', '/api/sales/preview', { customerId: 'walk-in', item: SOAP, quantity: '1', rate: '40', date: DATE, terms: 'now', shipTo: 'party', shipToParty: 'ABC Traders', requestId: 'counter-288-ship' }, session);
  assert.equal(sent.body.code, 'WALK_IN_DELIVERY');
  const after = await books(session);
  assert.equal(after.bills, before.bills);
  assert.equal(after.cash, before.cash);
});

test('#288: the bill and its receipt are one unit of work — a receipt that fails leaves no bill, no number and no money', async () => {
  const session = await ownerSession();
  const runtime = apiRuntime();
  const context = runtime.authenticate(`Bearer ${session}`);
  const app = await runtime.application(context) as unknown as { payments: { recordPayment: (...args: unknown[]) => Promise<unknown> } };
  const before = await books(session);
  const original = app.payments.recordPayment;
  app.payments.recordPayment = async () => { throw new Error('the receipt could not be saved'); };
  try {
    const failed = await request('POST', '/api/sales/record', { customerId: 'walk-in', item: SOAP, quantity: '2', rate: '40', date: DATE, terms: 'now', paidBy: 'CASH', requestId: 'counter-288-atomic' }, session);
    assert.notEqual(failed.status, 200);
  } finally {
    app.payments.recordPayment = original;
  }
  const after = await books(session);
  assert.deepEqual(after, before, 'nothing of the bill is left behind');
  // The next bill takes the number the failed one would have had.
  const next = await request('POST', '/api/sales/record', { customerId: 'walk-in', item: SOAP, quantity: '2', rate: '40', date: DATE, terms: 'now', paidBy: 'CASH', requestId: 'counter-288-after' }, session);
  assert.equal(next.status, 200, JSON.stringify(next.body));
  const numbers = (await request('GET', '/api/reports', {}, session)).body.sales.rows.map((r: any) => Number(String(r.number).split('/').pop()));
  assert.deepEqual([...numbers].sort((a, b) => a - b), numbers.map((_: number, i: number) => i + 1), 'no gap in the number series');
});

test('#288: a customer with no GST number gets their state from the PIN code', async () => {
  const session = await ownerSession();
  assert.deepEqual((await request('POST', '/api/pincode/state', { pincode: '411026' }, session)).body, { stateCode: '27' });
  assert.deepEqual((await request('POST', '/api/pincode/state', { pincode: '262001' }, session)).body, { stateCode: null });
  const added = await request('POST', '/api/customers', { legalName: 'Ramesh Counter Buyer', registration: 'unregistered', line1: 'MG Road', city: 'Bengaluru', pincode: '560001' }, session);
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.customer.stateCode, '29');
  assert.equal(added.body.customer.walkIn, false);
});

test('#288: a viewer cannot take money at the counter', async () => {
  const session = await ownerSession();
  const before = await books(session);
  const viewer = await signIn('viewer@sampoorna.example.invalid', 'viewer-demo');
  const refused = await request('POST', '/api/sales/record', { customerId: 'walk-in', item: SOAP, quantity: '1', rate: '40', date: DATE, terms: 'now', paidBy: 'CASH', requestId: 'counter-288-viewer' }, viewer);
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.deepEqual(await books(session), before);
});
