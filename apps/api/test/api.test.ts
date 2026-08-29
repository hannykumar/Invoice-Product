import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';

const COMPANY_A = '00000000-0000-4000-8000-000000000001';
const COMPANY_B = '00000000-0000-4000-8000-000000000011';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(response.body) as Record<string, any> };
};

const signIn = async (companyId: string, email: string, password = 'karobar-demo'): Promise<string> => {
  const response = await request('POST', '/api/auth/login', { companyId, email, password });
  assert.equal(response.status, 200);
  return response.body.sessionId as string;
};

test('the HTTP edge derives company and permissions from an authenticated session', async () => {
  assert.equal((await request('GET', '/api/dashboard')).status, 401);
  assert.equal((await request('GET', '/api/dashboard', {}, 'made-up-session')).status, 401);
  assert.equal((await request('POST', '/api/auth/login', { companyId: COMPANY_A, email: 'owner@sampoorna.example.invalid', password: 'wrong' })).status, 401);

  const sessionA = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');
  const sessionB = await signIn(COMPANY_B, 'owner@konkan.example.invalid');
  const dashboardA = await request('GET', '/api/dashboard', {}, sessionA);
  const dashboardB = await request('GET', '/api/dashboard', {}, sessionB);
  assert.equal(dashboardA.body.company.name, 'Sampoorna Traders');
  assert.equal(dashboardB.body.company.name, 'Konkan Fresh Foods');
  assert.notEqual(dashboardA.body.company.id, dashboardB.body.company.id);

  const input = {
    companyId: COMPANY_B,
    party: 'Shree Ram Steels Private Limited', reference: 'TENANT-80', date: '2026-08-29', amount: '1750.50',
  };
  const recorded = await request('POST', '/api/purchases/record', input, sessionA);
  assert.equal(recorded.status, 200);
  assert.equal(recorded.body.stock.quantity, 1);
  const afterA = await request('GET', '/api/dashboard', {}, sessionA);
  const afterB = await request('GET', '/api/dashboard', {}, sessionB);
  assert.equal(afterA.body.metrics.purchasesMonth, 1750.5, 'the session company receives the posting');
  assert.equal(afterB.body.metrics.purchasesMonth, 0, 'a caller-supplied company cannot redirect the posting');
  assert.equal(afterB.body.stock.quantity, 0, 'stock remains isolated through HTTP');
});

test('a real membership controls permissions at the domain boundary', async () => {
  const viewer = await signIn(COMPANY_A, 'viewer@sampoorna.example.invalid', 'viewer-demo');
  assert.equal((await request('GET', '/api/dashboard', {}, viewer)).status, 200);
  const denied = await request('POST', '/api/purchases/record', { reference: 'DENIED-80', date: '2026-08-29', amount: '100' }, viewer);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'PERMISSION_DENIED');
});

test('domain failures map to useful HTTP status codes', async () => {
  const owner = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');
  const invalid = await request('POST', '/api/purchases/record', { reference: 'INVALID-80', date: '2026-08-29', amount: '0' }, owner);
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.code, 'API_AMOUNT_INVALID');
  assert.equal(invalid.body.title, 'Nothing was saved');

  const missing = await request('GET', '/api/purchases/not-a-real-bill', {}, owner);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'PURCHASE_UNKNOWN');

  const unknownRoute = await request('GET', '/api/not-a-route', {}, owner);
  assert.equal(unknownRoute.status, 404);
});

test('preview remains read-only and posting remains duplicate-safe', async () => {
  const owner = await signIn(COMPANY_B, 'owner@konkan.example.invalid');
  const input = { reference: 'RETRY-80', date: '2026-08-29', amount: '900' };
  const before = await request('GET', '/api/dashboard', {}, owner);
  const preview = await request('POST', '/api/purchases/preview', input, owner);
  assert.equal(preview.body.state, 'preview');
  assert.equal((await request('GET', '/api/dashboard', {}, owner)).body.stock.quantity, before.body.stock.quantity);
  const recorded = await request('POST', '/api/purchases/record', input, owner);
  const retried = await request('POST', '/api/purchases/record', input, owner);
  assert.equal(recorded.body.deduplicated, false);
  assert.equal(retried.body.deduplicated, true);
  assert.equal(retried.body.stock.quantity, 1);
});

test('authenticated sales and customer payments still reach their service modules', async () => {
  const owner = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');
  const sale = { party: 'ABC Traders', item: 'Herbal Bath Soap 100g', quantity: '2', rate: '100', date: '2026-08-29', terms: '7', reference: 'AUTH-SALE-80' };
  const salePreview = await request('POST', '/api/sales/preview', sale, owner);
  assert.equal(salePreview.body.state, 'preview');
  const recorded = await request('POST', '/api/sales/record', sale, owner);
  assert.equal(recorded.body.state, 'recorded');
  assert.match(recorded.body.invoice.number, /^INV\/WEB\//);
  const payment = await request('POST', '/api/payments/record', { party: 'ABC Traders', amount: '50', date: '2026-08-29', reference: 'AUTH-PAY-80', invoice: recorded.body.invoice.id }, owner);
  assert.equal(payment.body.state, 'recorded');
});
