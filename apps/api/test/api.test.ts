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

test('a sale preview carries the agreed price and the credit warning from the real terms service', async () => {
  const owner = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');

  // The company is seeded with one issued sale, so this customer has a price on record.
  const small = await request('POST', '/api/sales/preview', {
    party: 'ABC Traders', item: 'Herbal Bath Soap 100g', quantity: '1', rate: '250',
    date: '2026-08-29', terms: '30', reference: 'TERMS-11-SMALL',
  }, owner);
  assert.equal(small.status, 200);
  assert.equal(small.body.terms.lines[0].priceSource, 'LAST_AGREED', 'what they last paid, not a guess');
  assert.match(small.body.terms.lines[0].priceSentence['en-IN'], /Last time you charged them/);
  assert.equal(small.body.terms.credit.outcome, 'ALLOW');

  // A bill far beyond the limit is warned about, with the excess worked out from real positions.
  const big = await request('POST', '/api/sales/preview', {
    party: 'ABC Traders', item: 'Herbal Bath Soap 100g', quantity: '40', rate: '250',
    date: '2026-08-29', terms: '30', reference: 'TERMS-11-BIG',
  }, owner);
  assert.equal(big.body.terms.credit.outcome, 'WARN');
  assert.ok(big.body.terms.credit.excess > 0, 'the amount over the limit is stated');
  assert.match(big.body.terms.credit.sentence['en-IN'], /more than you allow/);
  assert.equal(typeof big.body.terms.credit.sentence['hi-IN'], 'string', 'both languages, like every other page');

  // Unissued drafts count towards the limit: that is what stops two tills spending it twice.
  assert.ok(big.body.terms.credit.pending > 0, "an earlier unfinished bill is counted");
});

/**
 * Issue #18 — the order, the delivery and the comparison, over the same HTTP surface the browser
 * uses, through a real signed-in session.
 */
test('the HTTP surface holds a bill that charges for more than the godown kept', async () => {
  const session = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');

  const order = await request('POST', '/api/purchase-orders', {
    orderNumber: 'PO/TEST/0001', item: 'SOAP', quantity: '100', rate: '240', gst: 1800, date: '2026-08-15',
  }, session);
  assert.equal(order.status, 200);
  assert.equal(order.body.order.state, 'PLACED');
  // An order is a promise. It must not put anything on the shelf.
  assert.equal(order.body.stock.onShelf, '0 PCS');

  const receipt = await request('POST', '/api/goods-receipts', {
    receiptNumber: 'GRN/TEST/0001', orderNumber: 'PO/TEST/0001', item: 'SOAP',
    received: '100', accepted: '90', rejectionNote: '10 boxes soaked in the rain', date: '2026-08-20',
  }, session);
  assert.equal(receipt.status, 200);
  // Only the 90 boxes that were kept: 90 × 24 pieces to a box.
  assert.equal(receipt.body.stock.onShelf, '2160 PCS');
  assert.equal(receipt.body.order.state, 'PARTIALLY_RECEIVED');
  assert.match(receipt.body.message, /90 BOX went into your stock/);

  const match = await request('POST', '/api/purchases/match', {
    reference: 'SRS/TEST/0001', orderNumber: 'PO/TEST/0001', item: 'SOAP',
    quantity: '100', rate: '240', gst: 1800, date: '2026-08-22',
  }, session);
  assert.equal(match.body.outcome, 'HOLD_FOR_APPROVAL');
  assert.equal(match.body.cleared, false);
  // Checking a bill records nothing and moves nothing.
  assert.equal(match.body.stock.onShelf, '2160 PCS');

  const row = match.body.rows[0];
  assert.deepEqual(
    { ordered: row.ordered, received: row.received, accepted: row.accepted, rejected: row.rejected, invoiced: row.invoiced },
    { ordered: '100 BOX', received: '100 BOX', accepted: '90 BOX', rejected: '10 BOX', invoiced: '100 BOX' },
  );

  const overcharge = match.body.findings.find((finding: Record<string, any>) => finding.code === 'INVOICED_ABOVE_ACCEPTED');
  assert.ok(overcharge, 'the overcharge must be explained');
  assert.equal(overcharge.severity, 'HOLD');
  assert.equal(overcharge.field, 'lines[1].quantity');
  assert.equal(overcharge.orderSays, '100 BOX');
  assert.equal(overcharge.receiptSays, '90 BOX');
  assert.equal(overcharge.invoiceSays, '100 BOX');

  const approved = await request('POST', '/api/purchases/match/approve', {
    reference: 'SRS/TEST/0001', orderNumber: 'PO/TEST/0001', item: 'SOAP',
    quantity: '100', rate: '240', gst: 1800, date: '2026-08-22',
    reason: 'Supplier agreed to send the 10 boxes free next week',
  }, session);
  assert.equal(approved.body.cleared, true);
  assert.match(approved.body.message, /free next week/);
});

test('orders, deliveries and stock belong to the signed-in company alone', async () => {
  const konkan = await signIn(COMPANY_B, 'owner@konkan.example.invalid');

  // Sampoorna raised PO/TEST/0001 above. Konkan must not be able to see or receive against it.
  const stolen = await request('POST', '/api/goods-receipts', {
    receiptNumber: 'GRN/TEST/9999', orderNumber: 'PO/TEST/0001', item: 'SOAP',
    received: '10', accepted: '10', rate: '240', date: '2026-08-21',
  }, konkan);
  assert.equal(stolen.status, 404);
  assert.match(stolen.body.message, /no order numbered PO\/TEST\/0001/);

  // And Konkan's own godown is untouched by Sampoorna's delivery.
  const own = await request('POST', '/api/goods-receipts', {
    receiptNumber: 'GRN/TEST/9998', orderNumber: '', item: 'SOAP',
    received: '3', accepted: '3', rate: '240', date: '2026-08-21',
  }, konkan);
  assert.equal(own.status, 200);
  assert.equal(own.body.stock.onShelf, '72 PCS', 'only Konkan\'s own 3 boxes');
});

test('the HTTP surface never forces a purchase order on a small business', async () => {
  const session = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');
  const receipt = await request('POST', '/api/goods-receipts', {
    receiptNumber: 'GRN/TEST/0002', orderNumber: '', item: 'SOAP',
    received: '12', accepted: '12', rate: '240', date: '2026-08-26',
  }, session);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.order, null, 'no order should be involved at all');

  const match = await request('POST', '/api/purchases/match', {
    reference: 'SRS/TEST/0002', orderNumber: '', item: 'SOAP',
    quantity: '102', rate: '240', gst: 1800, date: '2026-08-26',
  }, session);
  assert.equal(match.body.kind, 'TWO_WAY_RECEIPT');
  assert.equal(match.body.cleared, true);
  assert.equal(match.body.rows[0].ordered, null, 'nothing was ordered, so the column is empty');
  const noOrder = match.body.findings.find((finding: Record<string, any>) => finding.code === 'NO_ORDER');
  assert.equal(noOrder.severity, 'INFORMATION');
  assert.match(noOrder.message, /perfectly normal for everyday buying/);
});

test('a delivery that keeps more than arrived is refused over HTTP, and nothing moves', async () => {
  const session = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');
  const refused = await request('POST', '/api/goods-receipts', {
    receiptNumber: 'GRN/TEST/0003', orderNumber: '', item: 'SOAP',
    received: '5', accepted: '9', rate: '240', date: '2026-08-27',
  }, session);
  // A refusal the caller can fix by editing the form: 422, not a generic 400.
  assert.equal(refused.status, 422);
  assert.equal(refused.body.state, 'failed');
  assert.match(refused.body.message, /cannot keep more than came/);
});

test('ordering and receiving need permission, not just a session', async () => {
  // The read-only session the platform seeds carries `dashboard.read` and nothing else.
  const readOnly = await signIn(COMPANY_A, 'viewer@sampoorna.example.invalid').catch(() => null);
  if (readOnly === null) return; // no read-only credential seeded in this build
  const refused = await request('POST', '/api/purchase-orders', {
    orderNumber: 'PO/TEST/0009', item: 'SOAP', quantity: '10', rate: '240', gst: 1800, date: '2026-08-15',
  }, readOnly);
  assert.equal(refused.status, 403);
});
