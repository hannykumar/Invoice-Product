/**
 * Issue #210 part 3 — when a bill is finalised, it is sent for its government e-invoice number
 * automatically, and issuing the bill never waits on the government.
 *
 * Reverting the fix fails all of these: the bill is issued with nothing sent, and a person has to
 * remember to open the E-invoice screen and press a button.
 *
 * Every name, GST number and figure below is synthetic and belongs to nobody.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { syntheticGstin } from '../../../packages/masters/src/fixtures.ts';

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

/** The business's own answer to the ₹5 crore question — the only turnover fact the product holds. */
const answerTurnover = async (session: string, answer: 'YES' | 'NO') => {
  const current = await request('GET', '/api/business-details', {}, session);
  const saved = await request('POST', '/api/business-details', { ...current.body.details, turnoverAbove5Crore: answer }, session);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
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
  legalName: 'Deccan Hardware Traders', registration: 'regular', gstin: syntheticGstin('27', 'AAFCD1234K'),
  line1: '22, Laxmi Road', city: 'Pune', pincode: '411030',
}, 'Deccan Hardware Traders');

const consumer = (session: string) => ensure(session, 'customers', {
  legalName: 'Walk-in Customer', registration: 'unregistered', stateCode: '29',
  line1: '5, Market Road', city: 'Bengaluru', pincode: '560058',
}, 'Walk-in Customer');

const anItem = (session: string) => ensure(session, 'items', {
  name: 'TMT Steel Bar 12mm', kind: 'goods', hsnSac: '72142090', unit: 'KGS',
  taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'The rate our accountant uses for steel bar',
}, 'TMT Steel Bar 12mm');

/** The portal answers in a moment; give the un-awaited send that moment before looking. */
const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setTimeout(resolve, 50)); };

const recordOf = async (session: string, invoiceId: string) => {
  const invoices = await request('GET', '/api/einvoices/invoices', {}, session);
  return invoices.body.invoices.find((row: { id: string }) => row.id === invoiceId);
};

/** What the government actually sent back for this bill, read through the reconcile route. */
const acknowledgementOf = async (session: string, invoiceId: string) =>
  (await request('POST', '/api/einvoices/reconcile', { invoice: invoiceId }, session)).body;

test('a bill that must be registered is sent by itself, and the person is told on the spot', async () => {
  const session = await signIn();
  await answerTurnover(session, 'YES');
  const customerId = await registeredBuyer(session);
  const itemId = await anItem(session);

  const recorded = await request('POST', '/api/sales/record', {
    customerId, lines: [{ itemId, quantity: '2000', rate: '40' }], date: '2026-09-17', terms: '30', reference: 'auto-irn-yes',
  }, session);

  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.equal(recorded.body.eInvoice.expected, true);
  assert.match(String(recorded.body.eInvoice.message), /already issued/);

  await settle();
  const record = await recordOf(session, recorded.body.invoice.id);
  assert.ok(record !== undefined, 'the issued bill is on the e-invoice list');
  assert.equal(record.eInvoiceStatus, 'REGISTERED', JSON.stringify(record));

  const acknowledgement = await acknowledgementOf(session, recorded.body.invoice.id);
  assert.equal(acknowledgement.status, 'REGISTERED', JSON.stringify(acknowledgement));
  assert.match(String(acknowledgement.irn ?? ''), /^[0-9a-f]{64}$/);
  assert.ok(String(acknowledgement.ackNumber ?? '').length > 0, 'the acknowledgement number is stored against the bill');
  assert.ok(String(acknowledgement.ackDate ?? '').length > 0, 'the acknowledgement date is stored against the bill');
  assert.ok(String(acknowledgement.signedQrCode ?? '').length > 0, 'the signed QR is kept exactly as received');
});

test('a bill that does not have to be registered is never sent', async () => {
  const session = await signIn();
  await answerTurnover(session, 'YES');
  const customerId = await consumer(session);
  const itemId = await anItem(session);

  // A sale to somebody with no GST number is never given an IRN, however large the bill.
  const recorded = await request('POST', '/api/sales/record', {
    customerId, lines: [{ itemId, quantity: '2000', rate: '40' }], date: '2026-09-17', terms: '30', reference: 'auto-irn-b2c',
  }, session);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));

  await settle();
  const record = await recordOf(session, recorded.body.invoice.id);
  assert.ok(record === undefined || record.eInvoiceStatus !== 'REGISTERED', 'nothing was sent for a bill to a consumer');
  assert.equal(recorded.body.eInvoice.expected, false);
});

test('a business under the limit sends nothing at all', async () => {
  const session = await signIn();
  await answerTurnover(session, 'NO');
  const customerId = await registeredBuyer(session);
  const itemId = await anItem(session);

  const recorded = await request('POST', '/api/sales/record', {
    customerId, lines: [{ itemId, quantity: '100', rate: '40' }], date: '2026-09-17', terms: '30', reference: 'auto-irn-under',
  }, session);

  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.equal(recorded.body.eInvoice.expected, false);
  await settle();
  const record = await recordOf(session, recorded.body.invoice.id);
  assert.ok(record === undefined || record.eInvoiceStatus !== 'REGISTERED');
});

test('sending the same bill again produces no second IRN', async () => {
  const session = await signIn();
  await answerTurnover(session, 'YES');
  const customerId = await registeredBuyer(session);
  const itemId = await anItem(session);
  const recorded = await request('POST', '/api/sales/record', {
    customerId, lines: [{ itemId, quantity: '2000', rate: '40' }], date: '2026-09-17', terms: '30', reference: 'auto-irn-twice',
  }, session);
  await settle();
  const first = await acknowledgementOf(session, recorded.body.invoice.id);
  assert.equal(first.status, 'REGISTERED');

  // The button on the E-invoice screen, pressed after the automatic send already succeeded.
  const again = await request('POST', '/api/einvoices/register', { invoice: recorded.body.invoice.id, turnover: '60000000' }, session);

  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.irn, first.irn, 'the same IRN comes back, not a second one');
});
