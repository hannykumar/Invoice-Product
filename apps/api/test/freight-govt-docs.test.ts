/**
 * Issue #231 — a goods bill with freight could not get an e-way bill or an e-invoice, and the GSTR-1
 * code-wise table was short by the freight.
 *
 * Freight the seller charges for delivering its own goods is part of the value of those goods and is
 * taxed with them. The printed bill keeps it as a row of its own and folds it under the goods' code in
 * the HSN summary (#188). The government documents must say the same: no item without a goods code,
 * the goods item carrying its share, and totals equal to the bill.
 *
 * The worked bill is the full trade check's step 3: 450 KGS TMT Steel Bar 12mm at ₹90 = ₹40,500,
 * freight ₹2,000, IGST 18% on ₹42,500 = ₹7,650, total ₹50,150. Every name, GST number and address
 * below is synthetic.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { sells, stockEverything } from './stock-helper.ts';

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

const MEHTA = {
  legalName: 'Mehta Construction Supplies', registration: 'regular', gstin: '27AAACM1234K1ZN',
  line1: 'Plot 22, MIDC Bhosari', city: 'Pune', pincode: '411026',
};

const customer = async (session: string): Promise<string> => {
  const existing = (await request('GET', '/api/catalogue', {}, session)).body.customers
    .find((row: Record<string, string>) => row.name === MEHTA.legalName);
  if (existing !== undefined) return existing.id as string;
  const created = await request('POST', '/api/customers', MEHTA, session);
  assert.equal(created.status, 200, created.body.message);
  return created.body.customer.id as string;
};

const hsnRow = async (session: string, code: string) => {
  const workspace = await request('POST', '/api/gst-returns', { period: '2026-09' }, session);
  assert.equal(workspace.status, 200, workspace.body.message);
  const row = (workspace.body.hsn as Record<string, any>[]).find((r) => r.hsn === code && r.rate === 18);
  return { workspace: workspace.body, taxable: Number(row?.taxableValue ?? 0), igst: Number(row?.igst ?? 0), bills: (row?.bills ?? []) as string[] };
};

test('#231 a goods bill with freight gets an e-way bill and an e-invoice, and GSTR-1 carries the freight under the goods code', async () => {
  const session = await signIn();
  const before = await hsnRow(session, '72142090');

  const recorded = await request('POST', '/api/sales/record', {
    customerId: await customer(session),
    lines: [{ itemId: 'sampoorna:item:TMT12', quantity: '450', rate: '90' }],
    freight: '2000', date: '2026-09-17', terms: '30', reference: 'freight-231',
  }, session);
  assert.equal(recorded.status, 200, recorded.body.message);
  const invoice = recorded.body.invoice.id as string;
  const number = recorded.body.invoice.number as string;

  // The printed bill does not change: freight is still its own row.
  const printed = await request('POST', '/api/sales/print', { invoice, format: 'A4', locale: 'en-IN' }, session);
  assert.equal(printed.status, 200);
  assert.match(printed.body.html, /Freight/);

  // E-way bill: ready, no complaint about a line with no HSN code.
  const dispatch = { invoice, distanceKm: '840', vehicle: 'KA01AB1234', reason: 'SUPPLY' };
  const check = await request('POST', '/api/eway/preview', dispatch, session);
  assert.equal(check.status, 200, check.body.message);
  assert.deepEqual(check.body.problems, []);
  assert.equal(check.body.title, 'Ready to raise');
  assert.equal(check.body.consignmentValue, 50150);

  const eway = await request('POST', '/api/eway/offline', dispatch, session);
  assert.equal(eway.status, 200, eway.body.message);
  const bill = (JSON.parse(String(eway.body.json)) as { billLists: Record<string, any>[] }).billLists[0] as Record<string, any>;
  assert.equal(bill.itemList.length, 1, 'freight is not an item of its own');
  assert.equal(bill.itemList[0].hsnCode, '72142090');
  assert.equal(bill.itemList[0].taxableAmount, 42500);
  assert.equal(bill.itemList[0].igstRate, 18);
  assert.equal(bill.totalValue, 42500);
  assert.equal(bill.igstValue, 7650);
  assert.equal(bill.totInvValue, 50150);
  assert.equal(bill.otherValue ?? 0, 0, 'taxable freight is never put in "other value"');

  const raised = await request('POST', '/api/eway/generate', dispatch, session);
  assert.equal(raised.status, 200, raised.body.message);

  // E-invoice: ready, one item carrying the freight, no "other charges".
  const einvoice = await request('POST', '/api/einvoices/preview', { invoice, turnover: '80000000' }, session);
  assert.equal(einvoice.status, 200, einvoice.body.message);
  assert.deepEqual(einvoice.body.problems, []);
  assert.equal(einvoice.body.ready, true);

  const file = await request('POST', '/api/einvoices/offline', { invoice, turnover: '80000000' }, session);
  assert.equal(file.status, 200, file.body.message);
  const payload = JSON.parse(String(file.body.json)).InvoiceList[0];
  assert.equal(payload.ItemList.length, 1);
  const [item] = payload.ItemList;
  assert.equal(item.HsnCd, '72142090');
  assert.equal(item.AssAmt, 42500);
  assert.equal(item.TotAmt - item.Discount, item.AssAmt, 'gross less discount is the assessable value');
  assert.equal(item.IgstAmt, 7650);
  assert.equal(item.TotItemVal, 50150);
  assert.equal(payload.ValDtls.AssVal, 42500);
  assert.equal(payload.ValDtls.IgstVal, 7650);
  assert.equal(payload.ValDtls.TotInvVal, 50150);
  assert.equal(payload.ValDtls.OthChrg ?? 0, 0);

  // GSTR-1: the code-wise table carries every rupee of the bill, and nothing is said to be missing.
  const after = await hsnRow(session, '72142090');
  assert.equal(after.taxable - before.taxable, 42500);
  assert.equal(after.igst - before.igst, 7650);
  assert.ok(after.bills.includes(number));
  assert.equal(after.workspace.findings.some((f: { code: string }) => f.code === 'GSTR1_HSN_MISSING'), false);
});
