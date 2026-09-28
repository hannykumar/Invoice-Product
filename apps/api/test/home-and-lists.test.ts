/**
 * Issue #237 — the Home screen, the reminders and every dialog, checked against one real trade.
 *
 * Before this, Home named every sale "ABC Traders", counted only ABC Traders' bills as owed
 * (₹1,838 when Reports said ₹51,988), showed one fixed stock item, setting up a business offered 12
 * states, a promise or dispute about any bill was recorded against ABC Traders, and dialogs printed
 * money as "7650.00" and "₹47790.00". The trade is steps 1 to 3 of the full trade check.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { appToday, useFixedAppClock } from '../src/app-clock.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const SHREE_RAM = 'sampoorna:party:supplier';
const DATE = appToday();
const MEHTA = 'Mehta Construction Supplies';

/** Every server-built response in this file, so the money in each can be read afterwards. */
const seen: { path: string; body: unknown }[] = [];

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  const parsed = JSON.parse(String(response.body)) as Record<string, any>;
  if (path !== '/api/auth/login') seen.push({ path, body: parsed });
  return { status: response.status, body: parsed };
};

const signIn = async (): Promise<string> => {
  const response = await request('POST', '/api/auth/login', { companyId: SAMPOORNA, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' });
  assert.equal(response.status, 200);
  return response.body.sessionId as string;
};

/** Buy 500 kg, add Mehta (with a phone of their own), sell Mehta 450 kg at ₹90 with ₹2,000 freight. */
const trade = (() => {
  let done: Promise<{ owner: string; mehta: string; bill: { id: string; number: string } }> | null = null;
  return () => done ??= (async () => {
    const owner = await signIn();
    const line = { item: 'TMT Steel Bar 12mm', quantity: '500', rate: '64', gst: '1800' };
    assert.equal((await request('POST', '/api/purchases/preview', { supplierId: SHREE_RAM, reference: 'SRS-101', date: DATE, lines: [line] }, owner)).status, 200);
    const bought = await request('POST', '/api/purchases/record', { supplierId: SHREE_RAM, reference: 'SRS-101', date: DATE, lines: [line] }, owner);
    assert.equal(bought.status, 200, JSON.stringify(bought.body));
    // The purchase answers with the stock of the goods it brought in.
    assert.equal(bought.body.stock.name, 'TMT Steel Bar 12mm');
    assert.equal(bought.body.stock.quantity, 500);
    const customer = await request('POST', '/api/customers', {
      legalName: MEHTA, registration: 'regular', gstin: '27AAACM1234K1ZN',
      line1: 'Plot 22, MIDC Bhosari', city: 'Pune', pincode: '411026', phone: '+91 90000 00027',
    }, owner);
    assert.equal(customer.status, 200, JSON.stringify(customer.body));
    const sale = {
      customerId: customer.body.customer.id, item: 'TMT Steel Bar 12mm', quantity: '450', rate: '90',
      freight: '2000', vehicle: 'KA01AB1234', date: DATE, terms: '30', reference: 'home-237-sale',
    };
    const reviewed = await request('POST', '/api/sales/preview', sale, owner);
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
    const sold = await request('POST', '/api/sales/record', sale, owner);
    assert.equal(sold.status, 200, JSON.stringify(sold.body));
    return { owner, mehta: customer.body.customer.id as string, bill: { id: sold.body.invoice.id as string, number: sold.body.invoice.number as string } };
  })();
})();

test('Home: what customers owe is every customer, the same figure as Reports (₹1,838 + ₹50,150 = ₹51,988)', async () => {
  const { owner } = await trade();
  const home = (await request('GET', '/api/dashboard', {}, owner)).body;
  const reports = (await request('GET', '/api/reports', {}, owner)).body;
  assert.equal(reports.dues.receivables.total, 51988);
  assert.equal(home.metrics.customersOwe, 51988);
  assert.equal(home.metrics.customersOwe, reports.dues.receivables.total);
  assert.equal(home.customer.outstanding, 51988);
  assert.ok(home.customer.documents.some((document: any) => document.party === MEHTA && document.outstanding === 50150));
});

test('Home: the sale to Mehta is shown under Mehta, not ABC Traders', async () => {
  const { owner, bill } = await trade();
  const home = (await request('GET', '/api/dashboard', {}, owner)).body;
  const row = home.activity.find((entry: any) => entry.id === bill.id);
  assert.equal(row.title, `${bill.number} · ${MEHTA}`);
  // The three opening bills really are ABC Traders', and are still named so.
  assert.equal(home.activity.filter((entry: any) => entry.kind === 'sale' && entry.title.endsWith('· ABC Traders')).length, 3);
});

test('Home: the stock tile lists the goods, least left first, not one fixed item', async () => {
  const { owner } = await trade();
  const home = (await request('GET', '/api/dashboard', {}, owner)).body;
  const names = home.stockItems.map((item: any) => item.name);
  assert.ok(names.includes('TMT Steel Bar 12mm') && names.includes('Herbal Bath Soap 100g'), names.join(', '));
  const steel = home.stockItems.find((item: any) => item.name === 'TMT Steel Bar 12mm');
  assert.equal(steel.quantity, 50);
  const quantities = home.stockItems.filter((item: any) => !item.needsAttention).map((item: any) => item.quantity);
  assert.deepEqual(quantities, [...quantities].sort((a, b) => a - b));
  assert.deepEqual(home.stock, home.stockItems[0]);
  for (const item of home.stockItems) assert.equal(item.needsAttention, item.quantity <= 0);
});

test('a new bill is already in the e-invoice, e-way bill, returns and payment lists', async () => {
  const { owner, mehta, bill } = await trade();
  const issued = (await request('GET', '/api/einvoices/invoices', {}, owner)).body.invoices;
  assert.ok(issued.some((invoice: any) => invoice.id === bill.id));
  const returnable = (await request('GET', '/api/returns/documents', {}, owner)).body.documents;
  assert.ok(returnable.some((document: any) => document.id === bill.id));
  const open = (await request('POST', '/api/payments/open-bills', { partyId: mehta, date: DATE }, owner)).body.bills;
  assert.ok(open.some((document: any) => document.id === bill.id));
});

test('setting up a business offers every current state, the same list as Business details', async () => {
  const { owner } = await trade();
  const setup = (await request('GET', '/api/states', {}, owner)).body.states;
  const business = (await request('GET', '/api/business-details', {}, owner)).body.states;
  const catalogue = (await request('GET', '/api/catalogue', {}, owner)).body.states;
  assert.deepEqual(setup, business);
  assert.deepEqual(setup, catalogue);
  const codes = setup.map((state: any) => state.code);
  for (const wanted of ['10', '30', '32', '26', '37', '38', '97', '29', '27']) assert.ok(codes.includes(wanted), `state ${wanted} missing`);
  for (const retired of ['25', '28', '96']) assert.equal(codes.includes(retired), false, `${retired} is offered`);
  assert.equal(codes.length, 37);
  assert.deepEqual(codes, [...codes].sort(), 'listed in code order, 01 first');
  assert.equal(setup[0].name, 'Jammu and Kashmir');

  const refused = await request('POST', '/api/onboarding/preview', { legalName: 'Old Diu Stores', businessType: 'RETAIL', stateCode: '25' }, owner);
  const problem = refused.body.problems.find((entry: any) => entry.field === 'stateCode');
  assert.equal(problem.message, 'State code 25 is no longer used. Choose the state as it is today.');
});

test('a promise and a dispute about Mehta\'s bill are recorded against Mehta, and the reminder goes to Mehta\'s own phone', async () => {
  const { owner, mehta, bill } = await trade();
  const promised = await request('POST', '/api/reminders/promise', { documentId: bill.id, amount: '20000', promisedOn: '2026-10-15', note: 'Cheque on the 15th' }, owner);
  assert.equal(promised.status, 200, JSON.stringify(promised.body));
  assert.equal(promised.body.partyId, mehta);
  assert.equal(promised.body.message, `${MEHTA} promised ₹20,000.00 against ${bill.number} by 2026-10-15. Reminders for this bill are paused until then.`);

  const workspace = (await request('GET', '/api/reminders', {}, owner)).body;
  const promise = workspace.promises.find((entry: any) => entry.documentId === bill.id);
  assert.equal(promise.partyId, mehta);
  assert.equal(promise.party, MEHTA);

  // A promise about a bill that is not ours is refused rather than filed under somebody else.
  const unknown = await request('POST', '/api/reminders/promise', { documentId: 'no-such-bill', amount: '1', promisedOn: '2026-10-15' }, owner);
  assert.equal(unknown.status, 404);

  // Forty days on, Mehta's bill is late; the reminder is Mehta's and goes to Mehta's phone.
  const later = '2026-11-20';
  const sent = await request('POST', '/api/reminders/send', { documentId: bill.id, today: later }, owner);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.reminder.partyId, mehta);
  const outbox = (await request('GET', '/api/reminders', {}, owner)).body.outbox;
  assert.ok(outbox.some((message: any) => message.to === '9000000027'), JSON.stringify(outbox));
  assert.equal(outbox.some((message: any) => message.to.startsWith('abc-traders') && message.body.includes(bill.number)), false);

  const disputed = await request('POST', '/api/reminders/dispute', { documentId: bill.id, reason: 'Ten bars were bent' }, owner);
  assert.equal(disputed.status, 200, JSON.stringify(disputed.body));
  assert.equal(disputed.body.partyId, mehta);

  const stopped = await request('POST', '/api/reminders/stop', { partyId: mehta, reason: 'Call instead' }, owner);
  assert.equal(stopped.body.message, `${MEHTA} will not receive automatic reminders.`);
  const nobody = await request('POST', '/api/reminders/stop', { reason: 'no customer chosen' }, owner);
  assert.equal(nobody.status, 422);
  const resumed = await request('POST', '/api/reminders/resume', { partyId: mehta }, owner);
  assert.equal(resumed.body.message, `${MEHTA} will receive automatic reminders again.`);
});

test('a cancelled bill is not owed and does not appear as a sale on Home', async () => {
  const { owner, mehta } = await trade();
  const extra = await request('POST', '/api/sales/record', {
    customerId: mehta, item: 'TMT Steel Bar 12mm', quantity: '10', rate: '90', date: DATE, terms: '30', reference: 'home-237-cancel',
  }, owner);
  assert.equal(extra.status, 200, JSON.stringify(extra.body));
  const before = (await request('GET', '/api/dashboard', {}, owner)).body;
  assert.ok(before.activity.some((entry: any) => entry.id === extra.body.invoice.id));
  assert.equal((await request('POST', '/api/sales/cancel/preview', { invoice: extra.body.invoice.id }, owner)).status, 200);
  const cancelled = await request('POST', '/api/sales/cancel', { invoice: extra.body.invoice.id, reason: 'typed twice' }, owner);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const after = (await request('GET', '/api/dashboard', {}, owner)).body;
  const reports = (await request('GET', '/api/reports', {}, owner)).body;
  assert.equal(after.activity.some((entry: any) => entry.id === extra.body.invoice.id), false);
  assert.equal(after.metrics.customersOwe, reports.dues.receivables.total);
  // 10 × ₹90 = ₹900, plus 18% IGST of ₹162 = ₹1,062, owed before the cancel and not after it.
  assert.equal(before.metrics.customersOwe - after.metrics.customersOwe, 1062);
});

test('money received, a return and the government papers are built the same way', async () => {
  const { owner, mehta, bill } = await trade();
  const payment = { partyId: mehta, amount: '30000', date: DATE, method: 'BANK_TRANSFER', bills: [bill.id], requestId: 'home-237-receipt' };
  assert.equal((await request('POST', '/api/payments/preview', payment, owner)).status, 200);
  assert.equal((await request('POST', '/api/payments/record', payment, owner)).status, 200);
  const documents = (await request('GET', '/api/returns/documents', {}, owner)).body.documents;
  const original = documents.find((document: any) => document.id === bill.id);
  const back = { kind: 'SALES_RETURN', documentId: bill.id, lineId: original.lines[0].id, quantity: '50', unit: 'KGS', date: DATE, reason: 'Bent bars', disposition: 'ACCEPTED', reference: 'home-237-return' };
  const previewed = await request('POST', '/api/returns/preview', back, owner);
  assert.equal(previewed.status, 200, JSON.stringify(previewed.body));
  assert.equal((await request('POST', '/api/returns/record', back, owner)).status, 200);
  await request('POST', '/api/eway/preview', { invoice: bill.id, distanceKm: '840', vehicle: 'KA01AB1234', reason: 'SUPPLY' }, owner);
  await request('POST', '/api/einvoices/preview', { invoice: bill.id, turnover: '80000000' }, owner);
  // A payment larger than the bill is refused with a sentence that names both amounts.
  await request('POST', '/api/payments/preview', { ...payment, amount: '90000', requestId: 'home-237-too-much' }, owner);
});

/**
 * Every amount a dialog shows is written the Indian way, with the rupee sign: ₹50,150.00, never
 * "50150.00", "7650.00" or "₹47790.00". Runs last, over every response the tests above received.
 */
const AMOUNT = /(?<![\w.,])(-?₹?)(\d[\d,]*\.\d{2})(?![\d%]|\.\d)/g;
const INDIAN = /^(\d{1,3}|\d{1,2}(,\d{2})*,\d{3})\.\d{2}$/;
const SKIP_KEYS = /html|json|svg|qr|datauri|payload|signature|upi|irn/i;

const badAmounts = (value: unknown, key = '', found: string[] = []): string[] => {
  if (SKIP_KEYS.test(key)) return found;
  if (typeof value === 'string') {
    for (const match of value.matchAll(AMOUNT)) {
      const [, sign = '', digits = ''] = match;
      if (!sign.includes('₹') || !INDIAN.test(digits)) found.push(`${key}: "${match[0]}" in "${value}"`);
    }
    for (const match of value.matchAll(/₹\d{4,}/g)) found.push(`${key}: "${match[0]}" in "${value}"`);
  } else if (Array.isArray(value)) value.forEach((entry) => badAmounts(entry, key, found));
  else if (value !== null && typeof value === 'object') for (const [name, entry] of Object.entries(value)) badAmounts(entry, name, found);
  return found;
};

test('every amount in every dialog and preview reads like ₹50,150.00', async () => {
  await trade();
  assert.ok(seen.length > 20, `only ${seen.length} responses were read`);
  const problems = seen.flatMap(({ path, body }) => badAmounts(body).map((problem) => `${path} → ${problem}`));
  assert.deepEqual(problems, []);
});

test('the scan itself catches the old ways of writing money', () => {
  assert.deepEqual(badAmounts({ message: 'GST of ₹7,650.00 has been added to ₹42,500.00.' }), []);
  assert.equal(badAmounts({ message: 'GST of 7650.00 has been added to 42500.00.' }).length, 2);
  assert.equal(badAmounts({ effects: ['Supplier due: 37760.00'] }).length, 1);
  assert.equal(badAmounts({ message: 'CN/1 credits ₹47790.00 against INV/1.' }).length, 2);
  assert.deepEqual(badAmounts({ message: 'Rule 2026.04.01, 450.000 KGS at 18.00%' }), []);
});
