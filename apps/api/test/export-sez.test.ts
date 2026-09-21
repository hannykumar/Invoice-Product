/**
 * Issue #143 — export and SEZ bills, through the running app: a customer abroad or in an SEZ is
 * saved, a sale is made to them, and the bill, the e-invoice and the return all say the same thing.
 *
 * Every name, GST number and address below is synthetic and belongs to nobody.
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

const ensure = async (session: string, kind: 'customers' | 'items', body: Record<string, unknown>): Promise<string> => {
  const name = kind === 'customers' ? body.legalName : body.name;
  const existing = (await request('GET', '/api/catalogue', {}, session)).body[kind]
    .find((row: { name: string }) => row.name === name);
  if (existing !== undefined) return existing.id as string;
  const created = await request('POST', `/api/${kind}`, body, session);
  assert.equal(created.status, 200, created.body.message);
  return (kind === 'customers' ? created.body.customer.id : created.body.item.id) as string;
};

const DUBAI = { legalName: 'Gulf Polymer Trading FZE', registration: 'overseas', line1: 'Warehouse 14, Jebel Ali Free Zone', city: 'Dubai, United Arab Emirates' };
const SEZ = { legalName: 'Sriperumbudur SEZ Moulders', registration: 'sez_without_payment', gstin: '33SSSSS1234S1ZA', line1: 'Plot 4, SEZ Phase II', city: 'Sriperumbudur', pincode: '602105' };
const GRANULES = {
  name: 'LDPE Granules', kind: 'goods', hsnSac: '39011000', unit: 'KGS',
  taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'The rate our accountant uses for granules',
};
const printOf = async (session: string, invoiceId: string): Promise<string> => {
  const printed = await request('POST', '/api/sales/print', { invoice: invoiceId }, session);
  assert.equal(printed.status, 200, printed.body.message);
  return String(printed.body.html);
};

test('a customer abroad is saved with no GST number, no PIN code and no Indian state', async () => {
  const session = await signIn();
  const id = await ensure(session, 'customers', DUBAI);
  const customer = (await request('GET', '/api/catalogue', {}, session)).body.customers.find((row: { id: string }) => row.id === id);
  assert.equal(customer.gstin, null);
  assert.equal(customer.stateName, 'Outside India');
  assert.deepEqual(customer.addressLines, ['Warehouse 14, Jebel Ali Free Zone', 'Dubai, United Arab Emirates']);
  const withGstin = await request('POST', '/api/customers', { ...DUBAI, legalName: 'Another Gulf Buyer', gstin: '29GGGGG6666G1ZG' }, session);
  assert.equal(withGstin.status, 422);
  assert.match(withGstin.body.message, /no Indian GST number/);
});

test('an export under LUT: no tax, the endorsement, the shipping bill and the dollars on the printed bill', async () => {
  const session = await signIn();
  const customerId = await ensure(session, 'customers', DUBAI);
  const itemId = await ensure(session, 'items', GRANULES);
  const sale = {
    customerId, lines: [{ itemId, quantity: '1000', rate: '100' }], date: '2026-09-17', terms: '30',
    underLut: 'yes', exportCountry: 'ae', exportCurrency: 'usd', exchangeRate: '83.25',
    shippingBillNumber: '4455667', shippingBillDate: '2026-09-19', portCode: 'innsa1',
  };

  const checked = await request('POST', '/api/sales/preview', { ...sale, reference: 'export-143-lut' }, session);
  assert.equal(checked.status, 200, checked.body.message);
  assert.match(String(checked.body.exportSupply.endorsement), /UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT/);
  assert.match(String(checked.body.message), /no GST is charged/);
  assert.equal(checked.body.amount, 100000);

  const recorded = await request('POST', '/api/sales/record', { ...sale, reference: 'export-143-lut-2' }, session);
  assert.equal(recorded.status, 200, recorded.body.message);
  const invoiceId = recorded.body.invoice.id as string;
  const html = await printOf(session, invoiceId);
  for (const expected of [
    'Tax Invoice — Export',
    'SUPPLY MEANT FOR EXPORT UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX',
    'United Arab Emirates', '4455667, 19', 'INNSA1', '1 USD = ₹83.25', 'USD 1201.20',
    'IGST (not charged: under bond or LUT)', 'Outside India',
  ]) assert.ok(html.includes(expected), `the bill must print "${expected}"`);
  assert.ok(!html.includes('999999'), 'the placeholder PIN is never printed');

  // The e-invoice is built from the same particulars: the same supply type, shipping bill and currency.
  const offline = await request('POST', '/api/einvoices/offline', { invoice: invoiceId, turnover: '600000000' }, session);
  assert.equal(offline.status, 200, offline.body.message);
  const payload = JSON.parse(String(offline.body.json)).InvoiceList[0];
  assert.equal(payload.TranDtls.SupTyp, 'EXPWOP');
  assert.deepEqual(payload.ExpDtls, { ShipBNo: '4455667', ShipBDt: '19/09/2026', Port: 'INNSA1', CntCode: 'AE', ForCur: 'USD' });
  assert.equal(payload.ValDtls.IgstVal, 0);
  assert.equal(payload.BuyerDtls.Stcd, '96');
});

test('an export on payment of IGST charges integrated tax and says so', async () => {
  const session = await signIn();
  const customerId = await ensure(session, 'customers', DUBAI);
  const itemId = await ensure(session, 'items', GRANULES);
  const recorded = await request('POST', '/api/sales/record', {
    customerId, lines: [{ itemId, quantity: '10', rate: '1000' }], date: '2026-09-17', terms: '30',
    underLut: 'no', exportCountry: 'US', reference: 'export-143-igst',
  }, session);
  assert.equal(recorded.status, 200, recorded.body.message);
  const html = await printOf(session, recorded.body.invoice.id);
  assert.ok(html.includes('SUPPLY MEANT FOR EXPORT ON PAYMENT OF INTEGRATED TAX'));
  assert.ok(html.includes('18,000.00') || html.includes('1,800.00'), 'IGST at 18% is on the bill');
  assert.ok(!/>CGST</.test(html), 'an export is never CGST and SGST');
  assert.ok(!html.includes('Exchange Rate'), 'a sale in rupees prints no rate');
});

test('a sale to an SEZ unit under LUT prints as a supply to SEZ, with no tax', async () => {
  const session = await signIn();
  const customerId = await ensure(session, 'customers', SEZ);
  const itemId = await ensure(session, 'items', GRANULES);
  const recorded = await request('POST', '/api/sales/record', {
    customerId, lines: [{ itemId, quantity: '10', rate: '1000' }], date: '2026-09-17', terms: '30', reference: 'sez-143',
  }, session);
  assert.equal(recorded.status, 200, recorded.body.message);
  const html = await printOf(session, recorded.body.invoice.id);
  assert.ok(html.includes('Tax Invoice — Supply to SEZ'));
  assert.ok(html.includes('SUPPLY TO SEZ UNIT OR SEZ DEVELOPER FOR AUTHORISED OPERATIONS UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX'));
  assert.ok(html.includes('IGST (not charged: under bond or LUT)'));
});

test('a wrong export form is refused before anything is drafted, every problem at once', async () => {
  const session = await signIn();
  const customerId = await ensure(session, 'customers', DUBAI);
  const itemId = await ensure(session, 'items', GRANULES);
  const refused = await request('POST', '/api/sales/preview', {
    customerId, lines: [{ itemId, quantity: '1', rate: '100' }], date: '2026-09-17', terms: '30',
    exportCountry: '', exportCurrency: 'USD', exchangeRate: '', portCode: 'NHAVA', reference: 'export-143-bad',
  }, session);
  assert.equal(refused.status, 422);
  assert.match(refused.body.message, /which country/);
  assert.match(refused.body.message, /how many rupees one USD/);
  assert.match(refused.body.message, /port code/);
});

test('GSTR-1 reports the export and the SEZ sale the way their bills were printed', async () => {
  const session = await signIn();
  const abroad = await ensure(session, 'customers', DUBAI);
  const sez = await ensure(session, 'customers', SEZ);
  const itemId = await ensure(session, 'items', GRANULES);
  const sell = async (customerId: string, reference: string, extra: Record<string, unknown> = {}) => {
    const recorded = await request('POST', '/api/sales/record', {
      customerId, lines: [{ itemId, quantity: '5', rate: '1000' }], date: '2026-08-12', terms: '0', reference, ...extra,
    }, session);
    assert.equal(recorded.status, 200, recorded.body.message);
    return String(recorded.body.invoice.number);
  };
  const exported = await sell(abroad, 'gstr-143-exp', { exportCountry: 'AE' });
  const toSez = await sell(sez, 'gstr-143-sez');

  const prepared = await request('POST', '/api/gst-returns/prepare', { period: '2026-08' }, session);
  assert.equal(prepared.status, 200, prepared.body.message);
  const sectionOf = (number: string) => prepared.body.sections
    .find((section: any) => section.rows.some((row: any) => row.sources.some((source: any) => source.number === number)))?.id;
  assert.equal(sectionOf(exported), 'EXP', 'an export is reported with the exports, not as a local sale');
  assert.ok(sectionOf(toSez) !== undefined, 'the SEZ sale is on the return');
  const held = JSON.stringify(prepared.body.exceptions ?? []);
  assert.ok(!held.includes(exported) && !held.includes(toSez), `neither bill is held back: ${held}`);
});
