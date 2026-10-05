/**
 * Issue #284 — a credit note against an e-invoiced bill is reported to the government as a CRN,
 * and a bill the app knows can never get an e-invoice number is not issued.
 *
 * The business is "₹10 crore and above", so its bills to registered buyers must be e-invoiced and
 * the portal's 30-day reporting limit applies. Reverting the fix fails these: the note is never
 * sent, and the 39-day-old bill is issued and uses up a number.
 *
 * Every name, GST number and figure below is synthetic and belongs to nobody.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { sells, stockEverything } from './stock-helper.ts';
import { saveTurnoverBand } from './turnover-helper.ts';
import { useFixedAppClock } from '../src/app-clock.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const COMPANY_A = '00000000-0000-4000-8000-000000000001';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  if (sells(method, path)) await stockEverything(sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  const text = Buffer.isBuffer(response.body) ? '{}' : String(response.body);
  return { status: response.status, body: JSON.parse(text) as Record<string, any> };
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

const mehta = (session: string) => ensure(session, 'customers', {
  legalName: 'Mehta Construction Supplies', registration: 'regular', gstin: '27AAACM1234K1ZN',
  line1: 'Plot 22, MIDC Bhosari', city: 'Pune', pincode: '411026',
}, 'Mehta Construction Supplies');

const consumer = (session: string) => ensure(session, 'customers', {
  legalName: 'Walk-in Customer', registration: 'unregistered', stateCode: '29',
  line1: '5, Market Road', city: 'Bengaluru', pincode: '560058',
}, 'Walk-in Customer');

const steel = (session: string) => ensure(session, 'items', {
  name: 'TMT Steel Bar 12mm', kind: 'goods', hsnSac: '72142090', unit: 'KGS',
  taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'The rate our accountant uses for steel bar',
}, 'TMT Steel Bar 12mm');

/** The portal answers in a moment; give the un-awaited send that moment before looking. */
const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setTimeout(resolve, 50)); };

const sell = (session: string, customerId: string, itemId: string, date: string, reference: string) =>
  request('POST', '/api/sales/record', { customerId, lines: [{ itemId, quantity: '600', rate: '95' }], date, terms: '30', reference }, session);

const returnTen = async (session: string, invoiceId: string, reference: string) => {
  const documents = (await request('GET', '/api/returns/documents', {}, session)).body.documents;
  const line = documents.find((d: { id: string }) => d.id === invoiceId).lines[0];
  return request('POST', '/api/returns/record', {
    kind: 'SALES_RETURN', documentId: invoiceId, lineId: line.id, quantity: '10', unit: 'KGS',
    disposition: 'ACCEPTED', date: '2026-09-28', reference, reason: 'Ten kilograms were bent in transit.',
  }, session);
};

const listed = async (session: string, id: string) =>
  (await request('GET', '/api/einvoices/invoices', {}, session)).body.invoices.find((row: { id: string }) => row.id === id);

test('a credit note to a registered buyer is sent as a CRN by itself, listed, and prints its IRN', async () => {
  const session = await signIn();
  await saveTurnoverBand(session, '10_CRORE_AND_ABOVE');
  const sold = await sell(session, await mehta(session), await steel(session), '2026-09-28', 'cn-284-sale');
  assert.equal(sold.status, 200, JSON.stringify(sold.body));
  await settle();
  assert.equal((await listed(session, sold.body.invoice.id))?.eInvoiceStatus, 'REGISTERED');

  const returned = await returnTen(session, sold.body.invoice.id, 'cn-284-return');
  assert.equal(returned.status, 200, JSON.stringify(returned.body));
  assert.match(returned.body.message, /credit note has to carry a government e-invoice number\. It is being sent now/);
  await settle();

  const note = returned.body.note as { id: string; number: string };
  const row = await listed(session, note.id);
  assert.ok(row !== undefined, 'the credit note is on the E-invoice screen');
  assert.equal(row.kind, 'CREDIT_NOTE');
  assert.equal(row.number, note.number);
  assert.equal(row.eInvoiceStatus, 'REGISTERED', JSON.stringify(row));
  assert.equal(row.canCancel, true);

  const record = (await request('POST', '/api/einvoices/reconcile', { invoice: note.id }, session)).body;
  assert.equal(record.status, 'REGISTERED', JSON.stringify(record));
  assert.match(String(record.irn), /^[0-9a-f]{64}$/);
  assert.notEqual(record.irn, (await request('POST', '/api/einvoices/reconcile', { invoice: sold.body.invoice.id }, session)).body.irn, 'the note has its own IRN, not the bill\'s');

  const printed = await request('POST', '/api/returns/print', { note: note.id }, session);
  assert.equal(printed.status, 200, JSON.stringify(printed.body));
  assert.ok(String(printed.body.html).includes(String(record.irn)), 'the IRN prints on the credit note');
  assert.ok(String(printed.body.html).includes('<svg'), 'the signed QR prints on the credit note');
});

test('a credit note to a consumer is not sent and not listed', async () => {
  const session = await signIn();
  await saveTurnoverBand(session, '10_CRORE_AND_ABOVE');
  const sold = await sell(session, await consumer(session), await steel(session), '2026-09-28', 'cn-284-b2c-sale');
  assert.equal(sold.status, 200, JSON.stringify(sold.body));
  const returned = await returnTen(session, sold.body.invoice.id, 'cn-284-b2c-return');
  assert.equal(returned.status, 200, JSON.stringify(returned.body));
  assert.doesNotMatch(returned.body.message, /e-invoice/);
  await settle();
  assert.equal(await listed(session, returned.body.note.id), undefined);
});

test('a bill that needs an IRN but is past the 30-day limit is refused, and no number is used', async () => {
  const session = await signIn();
  await saveTurnoverBand(session, '10_CRORE_AND_ABOVE');
  const customerId = await mehta(session);
  const itemId = await steel(session);
  const before = await sell(session, customerId, itemId, '2026-09-28', 'late-284-before');
  assert.equal(before.status, 200, JSON.stringify(before.body));

  // 20 August is 39 days before 28 September.
  const late = await sell(session, customerId, itemId, '2026-08-20', 'late-284');
  assert.notEqual(late.status, 200);
  assert.equal(late.body.code, 'SALE_EINVOICE_TOO_LATE');
  assert.match(late.body.message, /more than 30 days old/);
  assert.match(late.body.message, /no bill number was used/);
  assert.equal(late.body.details?.today, '2026-09-28', 'the way through: date it today');

  const after = await sell(session, customerId, itemId, '2026-09-28', 'late-284-after');
  assert.equal(after.status, 200, JSON.stringify(after.body));
  const serial = (number: string) => Number(number.split('/').pop());
  assert.equal(serial(after.body.invoice.number), serial(before.body.invoice.number) + 1, 'the refusal used no number');
});
