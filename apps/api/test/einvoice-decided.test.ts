/**
 * Issue #239 — the app decides whether a bill needs a government e-invoice number, and says so.
 *
 *  - The sale review says it in one line, from what the app already knows: the buyer (registered
 *    or a consumer), the turnover band in Business details and the business's exemption.
 *  - When the turnover is not known it says so and points to Business details — never a guess.
 *  - The exemption (bank, goods transport agency, SEZ unit, …) is answered once in Business
 *    details, and a business that says it is exempt is never sent for an e-invoice number.
 *  - The E-invoice screen lists every bill with the decision and its status, and asks nothing.
 *
 * Every name, GST number and figure below is synthetic and belongs to nobody.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { saveTurnoverBand } from './turnover-helper.ts';
import { sells, stockEverything } from './stock-helper.ts';
import { syntheticGstin } from '../../../packages/masters/src/fixtures.ts';
import { useFixedAppClock } from '../src/app-clock.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const COMPANY_A = '00000000-0000-4000-8000-000000000001';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  if (sells(method, path)) await stockEverything(sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const signIn = async (): Promise<string> => {
  const response = await request('POST', '/api/auth/login', { companyId: COMPANY_A, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' });
  assert.equal(response.status, 200);
  return response.body.sessionId as string;
};

const ensure = async (session: string, path: 'customers' | 'items', body: Record<string, unknown>, name: string): Promise<string> => {
  const catalogue = (await request('GET', '/api/catalogue', {}, session)).body;
  const existing = (path === 'customers' ? catalogue.customers : catalogue.items).find((row: { name: string }) => row.name === name);
  if (existing !== undefined) return existing.id as string;
  const created = await request('POST', `/api/${path}`, body, session);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return (created.body.customer?.id ?? created.body.item?.id) as string;
};

const registeredBuyer = (session: string) => ensure(session, 'customers', {
  legalName: 'Nilgiri Hardware Mart', registration: 'regular', gstin: syntheticGstin('33', 'AAFCN2468K'),
  line1: '14, Bazaar Street', city: 'Coimbatore', pincode: '641001',
}, 'Nilgiri Hardware Mart');

const consumer = (session: string) => ensure(session, 'customers', {
  legalName: 'Counter Sale Buyer', registration: 'unregistered', stateCode: '29',
  line1: '3, Temple Road', city: 'Bengaluru', pincode: '560058',
}, 'Counter Sale Buyer');

const item = (session: string) => ensure(session, 'items', {
  name: 'Galvanised Nails 2 inch', kind: 'goods', hsnSac: '73170013', unit: 'KGS',
  taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'The rate our accountant uses for nails',
}, 'Galvanised Nails 2 inch');

const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setTimeout(resolve, 50)); };

let sales = 0;
const sale = async (session: string, customerId: string) => {
  sales += 1;
  return {
    customerId, lines: [{ itemId: await item(session), quantity: '10', rate: '100' }],
    date: '2026-09-28', terms: '30', requestId: `decided-239-${sales}`,
  };
};

const saveExemption = async (session: string, eInvoiceExemption: string) => {
  const current = (await request('GET', '/api/business-details', {}, session)).body;
  return request('POST', '/api/business-details', { ...(current.details ?? current.prefill), eInvoiceExemption }, session);
};

const NEEDED = 'This bill needs a government e-invoice number. It is sent by itself when you issue it.';
const UNKNOWN = "We don't know yet whether you need e-invoices: Business details does not say whether your turnover has been over ₹5 crore. Answer once in Business details. This bill can still be issued now.";

test('#239: the sale review says whether the bill needs an e-invoice, for each turnover answer', async () => {
  const session = await signIn();
  await saveExemption(session, 'NONE');
  const buyer = await registeredBuyer(session);

  await saveTurnoverBand(session, 'UNKNOWN');
  const unknown = await request('POST', '/api/sales/preview', await sale(session, buyer), session);
  assert.equal(unknown.status, 200, JSON.stringify(unknown.body));
  assert.deepEqual(
    { needed: unknown.body.eInvoice.needed, askTurnover: unknown.body.eInvoice.askTurnover, message: unknown.body.eInvoice.message },
    { needed: 'UNKNOWN', askTurnover: true, message: UNKNOWN },
  );

  await saveTurnoverBand(session, '5_TO_10_CRORE');
  const above = await request('POST', '/api/sales/preview', await sale(session, buyer), session);
  assert.equal(above.body.eInvoice.needed, 'YES');
  assert.equal(above.body.eInvoice.message, NEEDED);
  assert.equal(above.body.eInvoice.askTurnover, false);

  await saveTurnoverBand(session, 'UP_TO_5_CRORE_EARLIER_ABOVE');
  const earlier = await request('POST', '/api/sales/preview', await sale(session, buyer), session);
  assert.equal(earlier.body.eInvoice.needed, 'YES', 'over ₹5 crore in any year since 2017-18 still needs it');

  await saveTurnoverBand(session, 'UP_TO_5_CRORE');
  const below = await request('POST', '/api/sales/preview', await sale(session, buyer), session);
  assert.equal(below.body.eInvoice.needed, 'NO');
  assert.equal(below.body.eInvoice.message, 'This bill does not need an e-invoice number: Business details says your turnover has never been over ₹5 crore in any year since 2017-18.');
});

test('#239: a sale to a consumer never needs one — and the turnover is not asked for it', async () => {
  const session = await signIn();
  await saveExemption(session, 'NONE');
  const buyer = await consumer(session);
  for (const band of ['10_CRORE_AND_ABOVE', 'UNKNOWN'] as const) {
    await saveTurnoverBand(session, band);
    const review = await request('POST', '/api/sales/preview', await sale(session, buyer), session);
    assert.equal(review.status, 200, JSON.stringify(review.body));
    assert.equal(review.body.eInvoice.needed, 'NO');
    assert.equal(review.body.eInvoice.askTurnover, false);
    assert.equal(review.body.eInvoice.message, 'This bill does not need an e-invoice number: the customer has no GST number.');
  }
});

test('#239: the exemption is answered once in Business details, and an exempt business is never sent', async () => {
  const session = await signIn();
  await saveTurnoverBand(session, '10_CRORE_AND_ABOVE');
  assert.equal((await request('GET', '/api/business-details', {}, session)).body.eInvoiceExemption, 'NONE', 'not exempt until the business says so');

  const refused = await saveExemption(session, 'BAKERY');
  assert.equal(refused.status, 422);
  assert.equal(refused.body.code, 'BUSINESS_EINVOICE_EXEMPTION');

  const saved = await saveExemption(session, 'GOODS_TRANSPORT_AGENCY');
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.eInvoiceExemption, 'GOODS_TRANSPORT_AGENCY');
  // Saving the turnover alone (a request without the exemption) keeps the answer.
  await saveTurnoverBand(session, '10_CRORE_AND_ABOVE');
  assert.equal((await request('GET', '/api/business-details', {}, session)).body.eInvoiceExemption, 'GOODS_TRANSPORT_AGENCY');

  const buyer = await registeredBuyer(session);
  const input = await sale(session, buyer);
  const review = await request('POST', '/api/sales/preview', input, session);
  assert.equal(review.body.eInvoice.needed, 'NO');
  assert.equal(review.body.eInvoice.message, 'This bill does not need an e-invoice number: Business details says your business is a goods transport agency, and the e-invoice rules leave those out whatever the turnover.');

  // Before #239 the exemption was a question on the E-invoice screen that the automatic send never
  // saw, so an exempt business over ₹5 crore had every registered bill sent to the government.
  const bill = await request('POST', '/api/sales/record', input, session);
  assert.equal(bill.status, 200, JSON.stringify(bill.body));
  assert.equal(bill.body.eInvoice.expected, false);
  await settle();
  const row = (await request('GET', '/api/einvoices/invoices', {}, session)).body.invoices.find((entry: { id: string }) => entry.id === bill.body.invoice.id);
  assert.equal(row.eInvoiceStatus, 'NOT_SENT');
  assert.equal(row.needed, 'NO');
  assert.equal(row.statusText, 'Nothing to send.');
  // And the printed bill keeps no space for a government QR it will never get.
  const print = await request('POST', '/api/sales/print', { invoice: bill.body.invoice.id }, session);
  assert.equal(print.status, 200, JSON.stringify(print.body));
  assert.ok(!String(print.body.html).replace(/<style[\s\S]*?<\/style>/g, '').includes('data-reserved="einvoice.'));

  await saveExemption(session, 'NONE');
});

test('#239: the E-invoice list shows each bill, the decision and where it stands — and a sent bill is not "Ready to send"', async () => {
  const session = await signIn();
  await saveExemption(session, 'NONE');
  await saveTurnoverBand(session, '5_TO_10_CRORE');
  const bill = await request('POST', '/api/sales/record', await sale(session, await registeredBuyer(session)), session);
  assert.equal(bill.status, 200, JSON.stringify(bill.body));
  assert.equal(bill.body.eInvoice.needed, 'YES');
  await settle();

  const row = (await request('GET', '/api/einvoices/invoices', {}, session)).body.invoices.find((entry: { id: string }) => entry.id === bill.body.invoice.id);
  assert.equal(row.customer, 'Nilgiri Hardware Mart');
  assert.equal(row.needed, 'YES');
  assert.equal(row.decision, 'This bill needs a government e-invoice number.');
  assert.equal(row.eInvoiceStatus, 'REGISTERED');
  assert.equal(row.statusText, 'Sent. The government gave it an e-invoice number.');
  assert.equal(row.canCancel, true);
  assert.equal(row.canRetry, false);

  const opened = await request('POST', '/api/einvoices/preview', { invoice: bill.body.invoice.id }, session);
  assert.equal(opened.body.record.status, 'REGISTERED');
  assert.equal(opened.body.record.title, 'Registered with the government');

  // A bill recorded while the turnover is unknown says so on the "Sale recorded" dialog too.
  await saveTurnoverBand(session, 'UNKNOWN');
  const unsure = await request('POST', '/api/sales/record', await sale(session, await registeredBuyer(session)), session);
  assert.equal(unsure.body.eInvoice.expected, false);
  assert.equal(unsure.body.eInvoice.askTurnover, true);
  assert.equal(unsure.body.eInvoice.message, UNKNOWN);
  const unsureRow = (await request('GET', '/api/einvoices/invoices', {}, session)).body.invoices.find((entry: { id: string }) => entry.id === unsure.body.invoice.id);
  assert.equal(unsureRow.needed, 'UNKNOWN');
  assert.equal(unsureRow.askTurnover, true);
});

test('#239: the E-invoice screen asks nothing — no turnover, no exemption, no question', () => {
  const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('<section class="view" id="view-einvoice"');
  const screen = html.slice(start, html.indexOf('</section>', start));
  assert.ok(start > 0);
  assert.doesNotMatch(screen, /name="exempt"|name="turnover|id="einvoice-form"/i);
  // The only field left is the reason typed when cancelling an e-invoice already sent.
  const fields = [...screen.matchAll(/<(input|select|textarea)\b[^>]*name="([^"]+)"/g)].map((match) => match[2]);
  assert.deepEqual(fields.sort(), ['reason', 'reasonCode']);
  // The exemption is asked in Business details instead.
  assert.match(html, /<select name="eInvoiceExemption">/);
});
