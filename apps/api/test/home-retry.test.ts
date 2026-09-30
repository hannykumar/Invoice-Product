/**
 * Issues #310 and #311 — when the e-way bill that should have been raised by itself at Make bill, or
 * the e-invoice sent by itself, got no number because the government site did not answer, Home says
 * so and its button sends the same request again. Once it goes through, the task is gone.
 *
 * The portals are the synthetic ones the app runs against in development, driven into an outage.
 * Every name, GST number and address below is synthetic and belongs to nobody.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { apiRuntime } from '../src/runtime.ts';
import { eInvoiceTask, ewayTask } from '../src/home-application.ts';
import { sells, stockEverything } from './stock-helper.ts';
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

/** The synthetic portals this company's app talks to; test-only reach past `private`. */
const portals = async (session: string) => {
  const runtime = apiRuntime();
  const app = await runtime.application(runtime.authenticate(`Bearer ${session}`)) as any;
  return { eway: app.shop.ewayPortal, irp: app.shop.irpPortal } as { eway: { setMode(mode: string): void }; irp: { setMode(mode: string): void } };
};

const ensure = async (session: string, path: string, body: Record<string, unknown>, listKey: string, nameKey: string, name: string): Promise<string> => {
  const existing = (await request('GET', '/api/catalogue', {}, session)).body[listKey].find((row: Record<string, string>) => row.name === name);
  if (existing !== undefined) return existing.id as string;
  const created = await request('POST', path, body, session);
  assert.equal(created.status, 200, created.body.message);
  return created.body[nameKey].id as string;
};

const PUNE = { legalName: 'Bhosari Fabricators', registration: 'regular', gstin: '27AAACM1234K1ZN', line1: 'Plot 22, MIDC Bhosari', city: 'Pune', pincode: '411026' };
const GRANULES = { name: 'LDPE Granules', kind: 'goods', hsnSac: '39011000', unit: 'KGS', taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'The rate our accountant uses for granules' };

const sell = async (session: string, reference: string, extra: Record<string, unknown> = {}) => {
  const customerId = await ensure(session, '/api/customers', PUNE, 'customers', 'customer', PUNE.legalName);
  const itemId = await ensure(session, '/api/items', GRANULES, 'items', 'item', GRANULES.name);
  const recorded = await request('POST', '/api/sales/record', {
    customerId, lines: [{ itemId, quantity: '1000', rate: '60' }], date: '2026-09-28', terms: '30', reference, ...extra,
  }, session);
  assert.equal(recorded.status, 200, recorded.body.message);
  return recorded.body;
};

const homeTask = async (session: string, id: string) =>
  ((await request('GET', '/api/dashboard', {}, session)).body.home.tasks as any[]).find((task) => task.id === id);

/** What the web app does with a `post` action: send it as it is. */
const press = (session: string, task: any) => request('POST', task.action.post.path, task.action.post.body, session);

// ------------------------------------------------------------------------------ the builders

const bill = { id: 'inv-1', number: 'INV/1', customer: 'Bhosari Fabricators' };

test('e-way task: nothing tried yet opens the screen; the portal down offers Retry; a refusal opens it', () => {
  const untried = ewayTask({ ...bill, failure: null }, true);
  assert.deepEqual(untried.action, { label: { 'en-IN': 'Raise', 'hi-IN': 'बनाइए' }, open: { view: 'eway', bill: 'inv-1' } });

  const down = ewayTask({ ...bill, failure: { retryable: true, distanceKm: 0 } }, true);
  assert.equal(down.title['en-IN'], 'The e-way bill for INV/1 could not be made — the government site did not answer');
  assert.equal(down.title['hi-IN'], 'INV/1 का ई-वे बिल नहीं बना — सरकारी साइट ने जवाब नहीं दिया');
  assert.deepEqual(down.action, { label: { 'en-IN': 'Retry', 'hi-IN': 'फिर भेजिए' }, post: { path: '/api/eway/generate', body: { invoice: 'inv-1', reason: 'SUPPLY' } } });
  // A typed distance is sent again, so a same-PIN delivery does not come back asking for it.
  assert.equal((ewayTask({ ...bill, failure: { retryable: true, distanceKm: 12 } }, true).action as any).post.body.distanceKm, '12');

  const refused = ewayTask({ ...bill, failure: { retryable: false, distanceKm: 0 } }, true);
  assert.match(refused.title['en-IN'], /refused it/);
  assert.deepEqual((refused.action as any).open, { view: 'eway', bill: 'inv-1' });

  // Seen by someone who may not raise one: the task, never the button.
  assert.equal(ewayTask({ ...bill, failure: { retryable: true, distanceKm: 0 } }, false).action, null);
});

test('e-invoice task: the portal down says so and offers Retry; a refusal says refused and opens the bill', () => {
  const down = eInvoiceTask({ id: 'inv-1', number: 'INV/1', eInvoiceStatus: 'FAILED', needed: 'YES', canRetry: true }, true);
  assert.equal(down?.title['en-IN'], 'The e-invoice for INV/1 could not be sent — the government site did not answer');
  assert.deepEqual(down?.action, { label: { 'en-IN': 'Retry', 'hi-IN': 'फिर भेजिए' }, post: { path: '/api/einvoices/register', body: { invoice: 'inv-1' } } });
  const refused = eInvoiceTask({ id: 'inv-1', number: 'INV/1', eInvoiceStatus: 'FAILED', needed: 'YES', canRetry: false }, true);
  assert.equal(refused?.title['en-IN'], 'INV/1: the government refused the e-invoice');
  assert.deepEqual((refused?.action as any).open, { view: 'einvoice', bill: 'inv-1' });
  assert.equal(eInvoiceTask({ id: 'inv-1', number: 'INV/1', eInvoiceStatus: 'FAILED', needed: 'YES', canRetry: true }, false)?.action, null);
});

// -------------------------------------------------------------------------- through the app

test('#311: the e-way bill not raised by itself because the portal was down is a Retry on Home, and gone once it goes through', async () => {
  const session = await signIn();
  const { eway } = await portals(session);
  eway.setMode('outage');
  let sold;
  try {
    sold = await sell(session, 'home-retry-eway', { vehicleNumber: 'KA01AB1234' });
  } finally { eway.setMode('healthy'); }
  assert.equal(sold.ewayRaised.status, 'FAILED', 'Make bill tried, and the portal did not answer');
  assert.equal(sold.ewayRaised.failure.retryable, true);

  const row = (await request('GET', '/api/eway/bills', {}, session)).body.invoices.find((entry: any) => entry.id === sold.invoice.id);
  assert.equal(row.status, 'NEEDED');
  assert.equal(row.failure.retryable, true);

  const task = await homeTask(session, `eway:${sold.invoice.id}`);
  assert.equal(task.title['en-IN'], `The e-way bill for ${sold.invoice.number} could not be made — the government site did not answer`);
  assert.equal(task.action.label['hi-IN'], 'फिर भेजिए');
  assert.equal(task.action.post.path, '/api/eway/generate');

  const retried = await press(session, task);
  assert.equal(retried.status, 200, retried.body.message);
  assert.equal(retried.body.status, 'ACTIVE', 'the vehicle on the bill went with it');
  assert.match(retried.body.ewayBillNumber, /^\d{12}$/);
  assert.equal(await homeTask(session, `eway:${sold.invoice.id}`), undefined, 'done, so off Home');
});

test('#311: no vehicle on the bill is not a Retry: only a person can give it, so the task opens the e-way screen', async () => {
  const session = await signIn();
  const sold = await sell(session, 'home-retry-eway-no-vehicle');
  assert.equal(sold.ewayRaised, null);
  const task = await homeTask(session, `eway:${sold.invoice.id}`);
  assert.deepEqual(task.action.open, { view: 'eway', bill: sold.invoice.id });
});

test('#310: an e-invoice the portal did not answer for is a Retry on Home, and gone once it is registered', async () => {
  const session = await signIn();
  const current = await request('GET', '/api/business-details', {}, session);
  assert.equal((await request('POST', '/api/business-details', { ...current.body.details, turnoverAbove5Crore: 'YES' }, session)).status, 200);
  const { irp } = await portals(session);
  irp.setMode('outage');
  let sold;
  try {
    sold = await sell(session, 'home-retry-einvoice');
    assert.equal(sold.eInvoice.needed, 'YES');
    // The send is started, not awaited: give it its moment while the portal is still down.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally { irp.setMode('healthy'); }

  const task = await homeTask(session, `einvoice:${sold.invoice.id}`);
  assert.equal(task.title['en-IN'], `The e-invoice for ${sold.invoice.number} could not be sent — the government site did not answer`);
  assert.deepEqual(task.action.post, { path: '/api/einvoices/register', body: { invoice: sold.invoice.id } });

  const retried = await press(session, task);
  assert.equal(retried.status, 200, retried.body.message);
  assert.equal(retried.body.status, 'REGISTERED');
  assert.equal(await homeTask(session, `einvoice:${sold.invoice.id}`), undefined, 'done, so off Home');
});
