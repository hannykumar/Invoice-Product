/**
 * Issue #285 — an export under LUT is zero-rated: its bill carries no IGST by law. The month's
 * return must approve with it, not hold it back as "18% tax is missing" or "the GST number is not
 * valid" for a buyer abroad who has no Indian GST number at all.
 *
 * Every name and figure below is synthetic and belongs to nobody.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { sells, stockEverything } from './stock-helper.ts';
import { useFixedAppClock } from '../src/app-clock.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const COMPANY_A = '00000000-0000-4000-8000-000000000001';
const MONTH = '2026-07';

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

const create = async (session: string, kind: 'customers' | 'items', body: Record<string, unknown>): Promise<string> => {
  const created = await request('POST', `/api/${kind}`, body, session);
  assert.equal(created.status, 200, created.body.message);
  return (kind === 'customers' ? created.body.customer.id : created.body.item.id) as string;
};

const GULF = { legalName: 'Gulf Steel LLC', registration: 'overseas', line1: 'Plot 9, Industrial Area 4', city: 'Sharjah, United Arab Emirates' };
const STEEL = {
  name: 'Export TMT Bar 16mm', kind: 'goods', hsnSac: '72142090', unit: 'KGS',
  taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'The rate our accountant uses for steel bar',
};

test('a month with an export under LUT approves, and the export is reported as zero-rated', async () => {
  const session = await signIn();
  const customerId = await create(session, 'customers', GULF);
  const itemId = await create(session, 'items', STEEL);
  const sold = await request('POST', '/api/sales/record', {
    customerId, lines: [{ itemId, quantity: '100', rate: '100' }], date: '2026-07-10', terms: '30',
    underLut: 'yes', exportCountry: 'AE', exportCurrency: 'USD', exchangeRate: '84',
    shippingBillNumber: '1234567', shippingBillDate: '2026-07-11', portCode: 'INMAA1', reference: 'lut-285',
  }, session);
  assert.equal(sold.status, 200, sold.body.message);
  const number = String(sold.body.invoice.number);

  const prepared = await request('POST', '/api/gst-returns/prepare', { period: MONTH }, session);
  assert.equal(prepared.status, 200, prepared.body.message);
  const findings = JSON.stringify(prepared.body.findings ?? prepared.body);
  assert.doesNotMatch(findings, /GSTR1_TAX_DOES_NOT_MATCH_RATE/, 'no tax is missing on a zero-rated line');
  assert.doesNotMatch(findings, /GSTR1_BAD_GSTIN/, 'a buyer abroad has no GST number to be wrong');

  const approved = await request('POST', '/api/gst-returns/approve', { period: MONTH, note: 'checked' }, session);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  const exported = await request('POST', '/api/gst-returns/export', { period: MONTH, returnType: 'GSTR1' }, session);
  assert.equal(exported.status, 200, exported.body.message);
  const file = JSON.stringify(exported.body);
  assert.ok(file.includes(number), `the export ${number} is in the upload file`);
});
