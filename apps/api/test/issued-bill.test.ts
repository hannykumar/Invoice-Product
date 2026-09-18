/**
 * Issue #189 — the bill the app hands a customer says nothing is missing.
 *
 * Every issued bill printed "Government QR, not received yet", "UPI id not saved yet" and "Signature
 * not uploaded yet". Those labels now appear only on the Bill design preview. Each test here fails
 * if the fix is reverted.
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

const NOT_YET = ['not received yet', 'not saved yet', 'not uploaded yet'];
const printed = (html: string): string => html.replace(/<style[\s\S]*?<\/style>/g, '');

test('a small business\'s issued bill: no "not yet" sentence, no e-invoice block, still signed', async () => {
  const session = await signIn();
  const invoiceId = await issueGoodsBill(session, 'issued-189-small');
  const bill = await request('POST', '/api/sales/print', { invoice: invoiceId }, session);
  assert.equal(bill.status, 200, bill.body.message);
  const html = printed(String(bill.body.html));
  for (const words of NOT_YET) assert.ok(!html.includes(words), `"${words}" must not be on a customer's bill`);
  assert.ok(!html.includes('data-reserved="einvoice.'), 'a bill nobody is registering keeps no space for it');
  assert.ok(html.includes('Authorised Signatory'));
});

test('the Bill design preview still shows the labelled boxes', async () => {
  const session = await signIn();
  const preview = await request('POST', '/api/branding/preview', {}, session);
  assert.equal(preview.status, 200);
  assert.ok(String(preview.body.html).includes('Government QR, not received yet'));
});

test('once the bill is registered, the government\'s IRN and QR print in that space', async () => {
  const session = await signIn();
  const invoiceId = await issueGoodsBill(session, 'issued-189-registered');
  const registered = await request('POST', '/api/einvoices/register', { invoice: invoiceId, turnover: '80000000' }, session);
  assert.equal(registered.body.status, 'REGISTERED', registered.body.message);

  const bill = await request('POST', '/api/sales/print', { invoice: invoiceId }, session);
  const html = printed(String(bill.body.html));
  assert.ok(html.includes(registered.body.irn), 'the IRN is printed');
  assert.ok(html.includes('class="qr-slot"'), 'with the government\'s signed QR');
  for (const words of NOT_YET) assert.ok(!html.includes(words));
});
