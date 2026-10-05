/**
 * Issue #286 — the GSTR-1 and GSTR-3B upload files, section by section, from a month of real papers
 * made through the running app.
 *
 * June 2026: a sale of goods to a business, a sale to a consumer, a service to a business, an export
 * under LUT with its shipping bill, an advance for a service (not billed in June), an advance for
 * goods, and a job-work challan. July 2026: the June service advance is used against its bill.
 *
 * Every name, GST number and figure below is synthetic and belongs to nobody.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { sells, stockEverything } from './stock-helper.ts';
import { useFixedAppClock } from '../src/app-clock.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const COMPANY_A = '00000000-0000-4000-8000-000000000001';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  if (sells(method, path)) await stockEverything(sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const ok = async (method: string, path: string, body: Record<string, unknown>, session: string) => {
  const response = await request(method, path, body, session);
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(response.body)}`);
  return response.body;
};

const signIn = async (): Promise<string> =>
  (await ok('POST', '/api/auth/login', { companyId: COMPANY_A, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' }, '')).sessionId as string;

const approve = async (session: string, period: string) => {
  await ok('POST', '/api/gst-returns/prepare', { period }, session);
  await ok('POST', '/api/gst-returns/approve', { period, note: 'checked' }, session);
};

const file = async (session: string, period: string, returnType: 'GSTR1' | 'GSTR3B') =>
  (await ok('POST', '/api/gst-returns/export', { period, returnType }, session)).payload as Record<string, any>;

let session = '';
let june: Record<string, any> = {};
let numbers: Record<string, string> = {};

test('June: every kind of paper is made through the app', async () => {
  session = await signIn();
  const consumer = await ok('POST', '/api/customers', { legalName: 'Lakshmi Stores', registration: 'unregistered', stateCode: '29', line1: '12, 4th Cross', city: 'Bengaluru', pincode: '560011' }, session);
  const abroad = await ok('POST', '/api/customers', { legalName: 'Gulf Steel LLC', registration: 'overseas', line1: 'Plot 9, Industrial Area 4', city: 'Sharjah, United Arab Emirates' }, session);
  await ok('POST', '/api/items', { name: 'Press servicing 286', kind: 'service', hsnSac: '998719', unit: 'NOS', ratePercent: '18', reference: 'item-286' }, session);

  const sale = (body: Record<string, unknown>) => ok('POST', '/api/sales/record', { terms: '0', ...body }, session);
  numbers.b2b = (await sale({ party: 'ABC Traders', item: 'Herbal Bath Soap 100g', quantity: '10', rate: '100', date: '2026-06-10', reference: 'b2b-286' })).invoice.number;
  numbers.b2c = (await sale({ customerId: consumer.customer.id, item: 'Herbal Bath Soap 100g', quantity: '5', rate: '100', date: '2026-06-11', reference: 'b2c-286' })).invoice.number;
  numbers.service = (await sale({ party: 'ABC Traders', item: 'Press servicing 286', quantity: '1', rate: '2000', date: '2026-06-12', reference: 'svc-286' })).invoice.number;
  numbers.export = (await sale({
    customerId: abroad.customer.id, item: 'Herbal Bath Soap 100g', quantity: '50', rate: '100', date: '2026-06-15',
    underLut: 'yes', exportCountry: 'AE', exportCurrency: 'USD', exchangeRate: '84',
    shippingBillNumber: '1234567', shippingBillDate: '2026-06-16', portCode: 'INMAA1', reference: 'exp-286',
  })).invoice.number;

  // A services advance: GST is due when the money arrives. Not billed in June.
  const pi = await ok('POST', '/api/presale/issue', { kind: 'PROFORMA', date: '2026-06-20', customerId: 'ABC Traders', item: 'Press servicing 286', quantity: '1', rate: '10000', purpose: 'Advance for servicing', reference: 'pi-286' }, session);
  const advance = await ok('POST', '/api/presale/advance', { document: pi.document.id, amount: '11800', date: '2026-06-20', mode: 'UPI', reference: 'adv-286' }, session);
  numbers.advance = advance.advance.number;
  numbers.proforma = pi.document.id;
  // A goods advance: no GST, but the receipt voucher's number is counted.
  const goodsPi = await ok('POST', '/api/presale/issue', { kind: 'PROFORMA', date: '2026-06-21', customerId: 'ABC Traders', item: 'Herbal Bath Soap 100g', quantity: '100', rate: '25', purpose: 'Advance for soap', reference: 'pi-286-goods' }, session);
  numbers.goodsAdvance = (await ok('POST', '/api/presale/advance', { document: goodsPi.document.id, amount: '1000', date: '2026-06-21', mode: 'CASH', reference: 'adv-286-goods' }, session)).advance.number;
  // A job-work challan.
  numbers.challan = (await ok('POST', '/api/challans/issue', { reason: 'JOB_WORK', date: '2026-06-22', customerId: 'ABC Traders', item: 'Herbal Bath Soap 100g', quantity: '20', rate: '40', reference: 'dc-286' }, session)).challan.number;

  await approve(session, '2026-06');
  june = await file(session, '2026-06', 'GSTR1');
});

test('table 12 is split into a B2B tab and a B2C tab, and a services code has UQC NA and no quantity', () => {
  const hsn = june.hsn;
  assert.equal(hsn.data, undefined, 'the old single list is gone');
  assert.ok(Array.isArray(hsn.hsn_b2b) && Array.isArray(hsn.hsn_b2c), JSON.stringify(hsn));
  const soapB2b = hsn.hsn_b2b.find((row: any) => row.hsn_sc === '34011190');
  const soapB2c = hsn.hsn_b2c.find((row: any) => row.hsn_sc === '34011190');
  // Our 10 to ABC Traders, plus the demo shop's own June bill to them (1 piece).
  assert.equal(soapB2b?.qty, 11, 'the business sales');
  assert.equal(soapB2c?.qty, 55, 'the consumer sale and the export');
  const service = hsn.hsn_b2b.find((row: any) => row.hsn_sc === '998719');
  assert.equal(service?.uqc, 'NA');
  assert.equal(service?.qty, 0);
  for (const tab of [hsn.hsn_b2b, hsn.hsn_b2c]) {
    assert.deepEqual(tab.map((row: any) => row.num), tab.map((_: unknown, index: number) => index + 1), 'each tab numbers from 1');
  }
});

test('table 13 uses the portal\'s fixed codes and counts receipt vouchers and challans', () => {
  const byCode = Object.fromEntries(june.doc_issue.doc_det.map((row: any) => [row.doc_num, row]));
  assert.equal(byCode[1]?.doc_typ, 'Invoices for outward supply');
  assert.equal(byCode[6]?.doc_typ, 'Receipt Voucher');
  assert.equal(byCode[6].docs[0].totnum, 2, 'the services advance and the goods advance');
  assert.equal(byCode[9]?.doc_typ, 'Delivery Challan for job work');
  assert.equal(byCode[9].docs[0].from, numbers.challan);
});

test('table 6A lists the export under LUT as WOPAY with its shipping bill', () => {
  const [entry] = june.exp;
  assert.equal(entry.exp_typ, 'WOPAY');
  const [invoice] = entry.inv;
  assert.equal(invoice.inum, numbers.export);
  assert.equal(invoice.sbnum, '1234567');
  assert.equal(invoice.sbpcode, 'INMAA1');
  assert.equal(invoice.sbdt, '16-06-2026');
  assert.deepEqual(invoice.itms[0], { txval: 5000, rt: 5, iamt: 0, csamt: 0 }, 'soap is 5%, carried at nil under LUT');
});

test('table 11A carries the June services advance, by place of supply and rate', () => {
  const [entry] = june.at;
  assert.equal(entry.pos, '29');
  assert.equal(entry.sply_ty, 'INTRA');
  assert.deepEqual(entry.itms[0], { rt: 18, ad_amt: 10000, iamt: 0, camt: 900, samt: 900, csamt: 0 });
  assert.equal(june.txpd, undefined, 'nothing used in June');
});

test('July: the June advance used against its bill goes in table 11B', async () => {
  const bill = await ok('POST', '/api/sales/record', { party: 'ABC Traders', item: 'Press servicing 286', quantity: '1', rate: '10000', date: '2026-07-05', terms: '0', reference: 'svc-286-july' }, session);
  await ok('POST', '/api/presale/link-invoice', { document: numbers.proforma, invoice: bill.invoice.id }, session);
  await approve(session, '2026-07');
  const july = await file(session, '2026-07', 'GSTR1');
  const [entry] = july.txpd;
  assert.equal(entry.pos, '29');
  assert.deepEqual(entry.itms[0], { rt: 18, ad_amt: 10000, iamt: 0, camt: 900, samt: 900, csamt: 0 });
  assert.equal(july.at, undefined, 'no new advance in July');
});

test('GSTR-3B writes table 3.1.1 and both rows of table 5', async () => {
  const threeB = await file(session, '2026-06', 'GSTR3B');
  assert.ok(threeB.eco_dtls?.eco_sup !== undefined && threeB.eco_dtls?.eco_reg_sup !== undefined, JSON.stringify(threeB));
  assert.deepEqual(threeB.inward_sup.isup_details.map((row: any) => row.ty), ['GST', 'NONGST']);
  assert.equal(threeB.sup_details.osup_zero.txval, 5000, 'the export is zero-rated');
  // 3.1(a) includes the services advance's ₹1,800 of GST as well as the June bills.
  assert.ok(threeB.sup_details.osup_det.camt >= 900);
});

/**
 * Part 5 — every section's shape, field by field, as the offline tool's GSTR-1 JSON writes it.
 * Transcribed from the published format; it is not the GSTN schema file itself.
 */
const SHAPES: Record<string, Record<string, 'string' | 'number' | 'array' | 'object'>> = {
  hsnRow: { num: 'number', hsn_sc: 'string', desc: 'string', uqc: 'string', qty: 'number', rt: 'number', txval: 'number', iamt: 'number', camt: 'number', samt: 'number', csamt: 'number' },
  docDet: { doc_num: 'number', doc_typ: 'string', docs: 'array' },
  docs: { num: 'number', from: 'string', to: 'string', totnum: 'number', cancel: 'number', net_issue: 'number' },
  exp: { exp_typ: 'string', inv: 'array' },
  expInv: { inum: 'string', idt: 'string', val: 'number', itms: 'array' },
  expItm: { txval: 'number', rt: 'number', iamt: 'number', csamt: 'number' },
  advance: { pos: 'string', sply_ty: 'string', itms: 'array' },
  advanceItm: { rt: 'number', ad_amt: 'number', iamt: 'number', camt: 'number', samt: 'number', csamt: 'number' },
};
const kindOf = (value: unknown): string => (Array.isArray(value) ? 'array' : typeof value);
const shaped = (value: Record<string, unknown>, shape: keyof typeof SHAPES) => {
  for (const [field, kind] of Object.entries(SHAPES[shape]!)) {
    assert.equal(kindOf(value[field]), kind, `${shape}.${field} should be a ${kind}: ${JSON.stringify(value)}`);
  }
};

test('every section of the June file has the offline tool\'s shape', () => {
  assert.equal(june.fp, '062026');
  for (const row of [...june.hsn.hsn_b2b, ...june.hsn.hsn_b2c]) shaped(row, 'hsnRow');
  for (const row of june.doc_issue.doc_det) {
    shaped(row, 'docDet');
    for (const docs of row.docs) shaped(docs, 'docs');
  }
  for (const entry of june.exp) {
    shaped(entry, 'exp');
    assert.ok(['WPAY', 'WOPAY'].includes(entry.exp_typ));
    for (const invoice of entry.inv) {
      shaped(invoice, 'expInv');
      assert.match(invoice.idt, /^\d{2}-\d{2}-\d{4}$/);
      for (const item of invoice.itms) shaped(item, 'expItm');
    }
  }
  for (const entry of june.at) {
    shaped(entry, 'advance');
    assert.ok(['INTER', 'INTRA'].includes(entry.sply_ty));
    for (const item of entry.itms) shaped(item, 'advanceItm');
  }
});
