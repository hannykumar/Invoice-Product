/**
 * Issue #183 — the app's own bill carries its copy marking.
 *
 * The printing code could mark copies since #137, but the app never asked for one, so the bill on
 * screen, the bill that printed and the PDF the customer received were all a single unmarked page.
 * CGST Rule 48 prepares a goods invoice in triplicate and a services invoice in duplicate, each
 * copy marked in the words the rule gives.
 *
 * Each test here fails if the fix is reverted.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';

const COMPANY_A = '00000000-0000-4000-8000-000000000001';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const signIn = async (): Promise<string> => {
  const response = await request('POST', '/api/auth/login', { companyId: COMPANY_A, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' });
  assert.equal(response.status, 200);
  return response.body.sessionId as string;
};

const ensureCustomer = async (session: string, body: Record<string, unknown>): Promise<string> => {
  const existing = (await request('GET', '/api/catalogue', {}, session)).body.customers
    .find((customer: { name: string }) => customer.name === body.legalName);
  if (existing !== undefined) return existing.id as string;
  const created = await request('POST', '/api/customers', body, session);
  assert.equal(created.status, 200, created.body.message);
  return created.body.customer.id as string;
};

const ensureItem = async (session: string, body: Record<string, unknown>): Promise<string> => {
  const existing = (await request('GET', '/api/catalogue', {}, session)).body.items
    .find((item: { name: string }) => item.name === body.name);
  if (existing !== undefined) return existing.id as string;
  const created = await request('POST', '/api/items', body, session);
  assert.equal(created.status, 200, created.body.message);
  return created.body.item.id as string;
};

const CUSTOMER = {
  legalName: 'Yeshwanthpur Traders', registration: 'regular', gstin: '29GGGGG6666G1ZG',
  line1: '9, Yeshwanthpur Industrial Suburb', city: 'Bengaluru', pincode: '560022',
};
const GOODS = {
  name: 'PVC Sheets', kind: 'goods', hsnSac: '39204900', unit: 'KGS',
  taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'The rate our accountant uses for PVC',
};

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

const issueGoodsBill = async (session: string, reference: string): Promise<string> => {
  const customerId = await ensureCustomer(session, CUSTOMER);
  const itemId = await ensureItem(session, GOODS);
  const recorded = await request('POST', '/api/sales/record', {
    customerId, lines: [{ itemId, quantity: '100', rate: '250' }],
    date: '2026-09-17', terms: '30', reference,
  }, session);
  assert.equal(recorded.status, 200, recorded.body.message);
  return recorded.body.invoice.id as string;
};

test('the bill on screen is the copy the customer is given, marked once', async () => {
  const session = await signIn();
  const invoiceId = await issueGoodsBill(session, 'copies-183-screen');

  const printed = await request('POST', '/api/sales/print', { invoice: invoiceId }, session);
  assert.equal(printed.status, 200, printed.body.message);
  assert.equal(count(String(printed.body.html), 'ORIGINAL FOR RECIPIENT'), 1);
  assert.equal(count(String(printed.body.html), 'DUPLICATE FOR TRANSPORTER'), 0);
  assert.equal(count(String(printed.body.html), 'TRIPLICATE FOR SUPPLIER'), 0);
  // The screen also says how many sheets one press of Print will produce.
  assert.equal(printed.body.copies, 3);
  assert.deepEqual(printed.body.copyMarkings, ['ORIGINAL FOR RECIPIENT', 'DUPLICATE FOR TRANSPORTER', 'TRIPLICATE FOR SUPPLIER']);
});

test('printing a goods bill produces all three marked copies, in order, each once', async () => {
  const session = await signIn();
  const invoiceId = await issueGoodsBill(session, 'copies-183-all');

  const printed = await request('POST', '/api/sales/print', { invoice: invoiceId, copies: 'all' }, session);
  assert.equal(printed.status, 200, printed.body.message);
  const html = String(printed.body.html);
  for (const marking of ['ORIGINAL FOR RECIPIENT', 'DUPLICATE FOR TRANSPORTER', 'TRIPLICATE FOR SUPPLIER']) {
    assert.equal(count(html, marking), 1, `${marking} appears exactly once`);
  }
  assert.ok(
    html.indexOf('ORIGINAL FOR RECIPIENT') < html.indexOf('DUPLICATE FOR TRANSPORTER')
      && html.indexOf('DUPLICATE FOR TRANSPORTER') < html.indexOf('TRIPLICATE FOR SUPPLIER'),
    'in the order the rule names them',
  );
  assert.match(html, /page-break|break-before|break-after/, 'each copy starts on a fresh sheet');
});

test('a till roll prints one slip, marked Original, and never three', async () => {
  const session = await signIn();
  const invoiceId = await issueGoodsBill(session, 'copies-183-roll');

  const printed = await request('POST', '/api/sales/print', { invoice: invoiceId, format: 'THERMAL_80MM', copies: 'all' }, session);
  assert.equal(printed.status, 200, printed.body.message);
  const html = String(printed.body.html);
  assert.equal(count(html, 'ORIGINAL FOR RECIPIENT'), 1);
  assert.equal(count(html, 'DUPLICATE FOR TRANSPORTER'), 0, 'three counter slips would be waste, not compliance');
  // Issue #183 — and the slip still carries what the law asks of a tax invoice.
  assert.ok(html.includes('39204900'), 'the HSN code');
  assert.match(html, /Reverse Charge/, 'the reverse-charge question');
  assert.ok(html.includes('Authorised Signatory'), 'and a space to sign');
});

test('the phone layout carries the marking, the HSN code and the signature too', async () => {
  const session = await signIn();
  const invoiceId = await issueGoodsBill(session, 'copies-183-phone');

  const printed = await request('POST', '/api/sales/print', { invoice: invoiceId, format: 'MOBILE' }, session);
  const html = String(printed.body.html);
  assert.equal(count(html, 'ORIGINAL FOR RECIPIENT'), 1);
  assert.ok(html.includes('39204900'));
  assert.ok(html.includes('Authorised Signatory'));
});

test('the PDF the customer downloads is the Original alone', async () => {
  const session = await signIn();
  const invoiceId = await issueGoodsBill(session, 'copies-183-pdf');

  // Asserted on the HTML that is handed to the browser engine, which is what the PDF is made from.
  const printed = await request('POST', '/api/sales/print', { invoice: invoiceId }, session);
  const html = String(printed.body.html);
  assert.ok(html.includes('ORIGINAL FOR RECIPIENT'));
  assert.ok(!html.includes('DUPLICATE'), 'the transporter’s copy is never the one sent to a customer');

  const pdf = await handleApi('GET', `/api/sales/${invoiceId}/pdf`, {}, `Bearer ${session}`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers['content-type'], 'application/pdf');
});
