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

test('reports require a session and are computed from that company alone', async () => {
  // Without a session the reports are refused, like every other company surface.
  assert.equal((await request('GET', '/api/reports')).status, 401);

  const owner = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');
  // Record a real purchase and a real sale into this company, then read the reports.
  await request('POST', '/api/purchases/record', { party: 'Shree Ram Steels Private Limited', reference: 'REPORTS-35-BUY', date: '2026-08-29', amount: '1750.50' }, owner);
  const sale = { party: 'ABC Traders', item: 'Herbal Bath Soap 100g', quantity: '3', rate: '400', date: '2026-08-29', terms: '15', reference: 'WEB-REPORTS-35' };
  const recorded = await request('POST', '/api/sales/record', sale, owner);
  assert.equal(recorded.body.state, 'recorded');

  const reports = await request('GET', '/api/reports', {}, owner);
  assert.equal(reports.status, 200);

  // The books hold together, and the report says so from the real ledger, not a stored flag.
  assert.equal(reports.body.trialBalance.balanced, true);
  assert.equal(reports.body.trialBalance.totalDebits, reports.body.trialBalance.totalCredits);

  // What the owner earned reconciles to the bills that produced it — the acceptance criterion.
  assert.equal(reports.body.profitAndLoss.income.total, reports.body.sales.total);

  // The sale just recorded is in the register and in the drill-down behind the income total.
  assert.ok(reports.body.sales.rows.some((row: { number: string }) => row.number === recorded.body.invoice.number));
  assert.ok(reports.body.profitAndLoss.income.drill.some((entry: { number: string | null }) => entry.number === recorded.body.invoice.number));

  // A purchase was recorded earlier in this file against the same singleton company, so the
  // purchase side is real and present rather than the "not built yet" placeholder.
  assert.equal(reports.body.purchases.available, true);
  assert.ok(reports.body.purchases.total > 0);

  // Every exception carries a machine code and a plain-language explanation in both languages.
  // The code is for callers; the wording is for the person, and neither language may be missing.
  assert.ok(Array.isArray(reports.body.exceptions.items));
  for (const item of reports.body.exceptions.items as { code: string; what: Record<string, string> }[]) {
    assert.equal(typeof item.code, 'string');
    assert.equal(typeof item.what['en-IN'], 'string');
    assert.equal(typeof item.what['hi-IN'], 'string');
  }

  // Nothing on the page is served in one language only: a Hindi reader gets a Hindi report.
  for (const heading of [reports.body.profitAndLoss.title, reports.body.stock.sentence, reports.body.gst.caution]) {
    assert.equal(typeof heading['en-IN'], 'string');
    assert.equal(typeof heading['hi-IN'], 'string');
    assert.notEqual(heading['hi-IN'], heading['en-IN'], 'the two languages should not be the same string');
  }
});

test('business setup runs the real onboarding service and opens a balanced set of books', async () => {
  // Setting up a business needs a signed-in session, like the rest of the app.
  assert.equal((await request('POST', '/api/onboarding/preview', {})).status, 401);
  const owner = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');

  // A mistyped GST number is caught by the real validator and nothing is created.
  const mistyped = await request('POST', '/api/onboarding/preview', {
    legalName: 'Meera Bakers', businessType: 'BAKERY', stateCode: '08',
    registration: 'REGULAR', gstin: '08AAAAA0000A1Z9', filingFrequency: 'QUARTERLY',
    booksStartDate: '2026-04-01', itemName: 'Chocolate cake 500g',
  }, owner);
  assert.equal(mistyped.body.ok, false);
  assert.ok(mistyped.body.problems.some((p: { field: string | null }) => p.field === 'gstin'));

  // The corrected setup passes the check without creating anything yet.
  const good = {
    legalName: 'Meera Bakers', businessType: 'BAKERY', stateCode: '08',
    registration: 'REGULAR', gstin: '08AAAAA0000A1Z2', filingFrequency: 'QUARTERLY',
    booksStartDate: '2026-04-01', itemName: 'Chocolate cake 500g', itemKind: 'GOODS', itemUnit: 'PCS', itemHsn: '1905',
    rateCode: '1905', ratePercent: '5', rateBasis: 'The rate my accountant has always used',
    openingCash: '8000',
  };
  const preview = await request('POST', '/api/onboarding/preview', good, owner);
  assert.equal(preview.body.ok, true);
  assert.equal(preview.body.result, undefined, 'a preview creates nothing');

  // Finishing runs the real service: it posts an opening voucher, declares the rate, and the new
  // company's own trial balance — read back from the ledger — balances.
  const finished = await request('POST', '/api/onboarding/finish', good, owner);
  assert.equal(finished.body.ok, true);
  const result = finished.body.result;
  assert.ok(result.openingVoucherId, 'an opening balance voucher was posted');
  assert.equal(result.ratesDeclared, 1);
  assert.equal(result.trialBalance.balanced, true);
  assert.equal(result.trialBalance.totalDebits, result.trialBalance.totalCredits);
  assert.equal(result.trialBalance.totalDebits, 8000);
});
