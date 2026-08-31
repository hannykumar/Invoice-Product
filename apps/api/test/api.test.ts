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

test('migration workspaces belong to the exact signed-in session that opened them', async () => {
  assert.equal((await request('POST', '/api/migration/start')).status, 401);
  const ownerA = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');
  const ownerB = await signIn(COMPANY_B, 'owner@konkan.example.invalid');
  const started = await request('POST', '/api/migration/start', {}, ownerA);
  assert.equal(started.status, 200);
  const sample = started.body.samples[0];
  const input = { workspaceId: started.body.workspaceId, fileName: sample.fileName, content: sample.content };

  const stolen = await request('POST', '/api/migration/analyse', input, ownerB);
  assert.equal(stolen.status, 404);
  assert.equal(stolen.body.code, 'TENANT_ISOLATION');
  const secondSession = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');
  const crossedSession = await request('POST', '/api/migration/analyse', input, secondSession);
  assert.equal(crossedSession.status, 404);
  assert.equal(crossedSession.body.code, 'TENANT_ISOLATION');

  const missing = await request('POST', '/api/migration/analyse', { fileName: sample.fileName, content: sample.content }, ownerA);
  assert.equal(missing.status, 404, 'only the start route may create a workspace');

  const own = await request('POST', '/api/migration/analyse', input, ownerA);
  assert.equal(own.status, 200);
  assert.equal(own.body.workspaceId, started.body.workspaceId);
  assert.equal(own.body.state, 'ANALYSED');
});

test('a real membership controls permissions at the domain boundary', async () => {
  const viewer = await signIn(COMPANY_A, 'viewer@sampoorna.example.invalid', 'viewer-demo');
  assert.equal((await request('GET', '/api/dashboard', {}, viewer)).status, 200);
  const denied = await request('POST', '/api/purchases/record', { reference: 'DENIED-80', date: '2026-08-29', amount: '100' }, viewer);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'PERMISSION_DENIED');
});

test('operations API exposes tenant-safe failures and replays only safe jobs', async () => {
  const ownerA = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');
  const ownerB = await signIn(COMPANY_B, 'owner@konkan.example.invalid');
  const workspaceA = await request('GET', '/api/operations', {}, ownerA);
  const workspaceB = await request('GET', '/api/operations', {}, ownerB);
  assert.equal(workspaceA.status, 200);
  assert.equal(workspaceA.body.health.state, 'healthy');
  assert.equal(workspaceA.body.failures[0].companyId, COMPANY_A);
  assert.equal(workspaceB.body.failures[0].companyId, COMPANY_B);
  assert.notEqual(workspaceA.body.failures[0].correlationId, workspaceB.body.failures[0].correlationId);
  const job = workspaceA.body.jobs.find((candidate: any) => candidate.state === 'failure');
  assert.ok(job.idempotent);
  const replayed = await request('POST', '/api/operations/jobs/replay', { jobId: job.id }, ownerA);
  assert.equal(replayed.body.state, 'draft');
  assert.equal((await request('POST', '/api/operations/jobs/replay', { jobId: job.id }, ownerB)).status, 404);
  const grant = await request('POST', '/api/operations/support-grants', { supportActorId: '00000000-0000-4000-8000-000000000099', reason: 'Customer asked support to inspect IRP error codes', scopes: ['external-failures'], durationMinutes: 30 }, ownerA);
  assert.equal(grant.status, 200);
  assert.deepEqual(grant.body.scopes, ['external-failures']);
  assert.equal((await request('GET', '/api/operations', {}, await signIn(COMPANY_A, 'viewer@sampoorna.example.invalid', 'viewer-demo'))).status, 403);
  const publicStatus = await request('GET', '/api/status');
  assert.equal(publicStatus.status, 200);
  assert.equal(publicStatus.body.incidents[0].state, 'resolved');
});

test('live bank feed API requires consent, syncs once and preserves history on disconnect', async () => {
  const owner = await signIn(COMPANY_B, 'owner@konkan.example.invalid');
  const started = await request('POST', '/api/bank-feeds/consent', { provider: 'sandbox-aa', redirectUri: 'https://app.example/bank/callback' }, owner);
  assert.equal(started.status, 200);
  assert.equal(started.body.connection.status, 'PENDING_CONSENT');
  const connectionId = started.body.connection.id;
  const completed = await request('POST', '/api/bank-feeds/consent/complete', { connectionId, authorizationCode: 'sandbox-approved' }, owner);
  assert.equal(completed.body.connection.status, 'CONNECTED');
  const synced = await request('POST', '/api/bank-feeds/sync', { connectionId, idempotencyKey: 'api-sync-once' }, owner);
  assert.equal(synced.body.imported, 2);
  const retried = await request('POST', '/api/bank-feeds/sync', { connectionId, idempotencyKey: 'api-sync-once' }, owner);
  assert.equal(retried.body.imported, 2);
  const disconnected = await request('POST', '/api/bank-feeds/disconnect', { connectionId, idempotencyKey: 'api-disconnect-once' }, owner);
  assert.equal(disconnected.body.connection.status, 'DISCONNECTED');
  const workspace = await request('GET', '/api/bank-feeds', {}, owner);
  assert.equal(workspace.body.connections[0].transactions.length, 2);
  assert.equal(JSON.stringify(workspace.body).includes('sandbox-approved'), false);

  const viewer = await signIn(COMPANY_A, 'viewer@sampoorna.example.invalid', 'viewer-demo');
  assert.equal((await request('GET', '/api/bank-feeds', {}, viewer)).status, 403);
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

test('authenticated customer and supplier returns preview and post through real domain services', async () => {
  const owner = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');
  const sale = { party: 'ABC Traders', item: 'Herbal Bath Soap 100g', quantity: '5', rate: '100', date: '2026-08-29', terms: '7', reference: 'RETURN-SALE-45' };
  const recordedSale = await request('POST', '/api/sales/record', sale, owner);
  assert.equal(recordedSale.status, 200);
  const saleReturn = {
    kind: 'SALES_RETURN', documentId: recordedSale.body.invoice.id, lineId: 'line-1', unit: 'PCS', quantity: '2',
    disposition: 'SCRAPPED', reason: 'Customer returned two unusable pieces.', date: '2026-08-30', reference: 'CN-API-45',
  };
  const salePreview = await request('POST', '/api/returns/preview', saleReturn, owner);
  assert.equal(salePreview.body.state, 'preview');
  assert.equal(salePreview.body.amount, 200);
  const postedSaleReturn = await request('POST', '/api/returns/record', saleReturn, owner);
  assert.equal(postedSaleReturn.body.note.kind, 'SALES_RETURN');
  assert.match(postedSaleReturn.body.note.number, /^CN\//);
  assert.equal((await request('POST', '/api/returns/record', saleReturn, owner)).body.deduplicated, true);

  const purchaseInput = { party: 'Shree Ram Steels Private Limited', reference: 'RETURN-PURCHASE-45', date: '2026-08-29', item: 'TMT12', quantity: '10', rate: '100', gst: '1800', supplierState: 'other' };
  const purchase = await request('POST', '/api/purchases/record', purchaseInput, owner);
  assert.equal(purchase.status, 200);
  const choices = await request('GET', '/api/returns/documents', {}, owner);
  const bill = choices.body.documents.find((document: any) => document.kind === 'PURCHASE_RETURN' && document.number === 'RETURN-PURCHASE-45');
  assert.ok(bill);
  const purchaseReturn = {
    kind: 'PURCHASE_RETURN', documentId: bill.id, lineId: '1', unit: 'KGS', quantity: '2',
    disposition: 'DAMAGED', reason: 'Bent bars accepted back by the supplier.', date: '2026-08-30', reference: 'DN-API-45',
  };
  const purchasePreview = await request('POST', '/api/returns/preview', purchaseReturn, owner);
  assert.equal(purchasePreview.body.amount, 236);
  const postedPurchaseReturn = await request('POST', '/api/returns/record', purchaseReturn, owner);
  assert.equal(postedPurchaseReturn.body.note.kind, 'PURCHASE_RETURN');
  assert.match(postedPurchaseReturn.body.note.number, /^DN\//);

  const excessive = await request('POST', '/api/returns/preview', { ...purchaseReturn, reference: 'DN-TOO-MUCH-45', quantity: '9' }, owner);
  assert.equal(excessive.status, 409);
  assert.equal(excessive.body.code, 'RETURN_QUANTITY_EXCEEDS_ELIGIBLE');
});

test('return APIs require both a session and the dedicated permission', async () => {
  assert.equal((await request('GET', '/api/returns/documents')).status, 401);
  const viewer = await signIn(COMPANY_A, 'viewer@sampoorna.example.invalid', 'viewer-demo');
  const denied = await request('GET', '/api/returns/documents', {}, viewer);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'PERMISSION_DENIED');
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

/**
 * Issue #19 — supplier warnings over the HTTP surface, through a real signed-in session.
 */
test('the HTTP surface explains a cancelled GST number with its evidence', async () => {
  const session = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');

  const checked = await request('POST', '/api/suppliers/check', {
    party: 'Deccan Hardware Traders', gstin: '29AAFCD1234K1ZN',
    reference: 'DHW/2026/114', date: '2026-07-04',
  }, session);
  assert.equal(checked.status, 200);
  assert.equal(checked.body.level, 'SERIOUS');
  assert.equal(checked.body.cleared, false);
  assert.equal(checked.body.confidence, 'COMPLETE');

  const cancelled = checked.body.warnings.find((warning: Record<string, any>) => warning.code === 'GSTIN_CANCELLED_BEFORE_INVOICE');
  assert.ok(cancelled, 'the cancellation must be explained');
  assert.match(cancelled.message, /cancelled on 12 March 2026/);
  assert.match(cancelled.message, /before the date on this bill/);

  // Every warning names its evidence, with a source and the dates behind it.
  for (const warning of checked.body.warnings) {
    assert.ok(warning.evidence.length > 0, `${warning.code} must name its evidence`);
    for (const evidence of warning.evidence) {
      assert.ok(['GST_PORTAL', 'IMS_GSTR2B', 'OUR_RECORDS', 'SUPPLIER_DOCUMENT'].includes(evidence.source));
    }
  }
  const portal = cancelled.evidence.find((evidence: Record<string, any>) => evidence.source === 'GST_PORTAL');
  assert.equal(portal.effectiveFrom, '2026-03-12');
  assert.equal(portal.stale, false);

  // And which sources answered is stated, so a clean result cannot be confused with an unchecked one.
  const sources = Object.fromEntries(checked.body.sources.map((source: Record<string, any>) => [source.source, source]));
  assert.equal(sources.GST_PORTAL.answered, true);
  assert.equal(sources.IMS_GSTR2B.answered, false, 'GSTR-2B is not connected yet (#31)');
  assert.match(sources.IMS_GSTR2B.note, /not connected yet/);

  const accepted = await request('POST', '/api/suppliers/check/acknowledge', {
    party: 'Deccan Hardware Traders', gstin: '29AAFCD1234K1ZN',
    reference: 'DHW/2026/114', date: '2026-07-04',
    reason: 'Spoke to the owner; they are re-registering',
  }, session);
  assert.equal(accepted.body.cleared, true);
  assert.match(accepted.body.message, /re-registering/);
});

test('a model score cannot make a supplier look serious over HTTP either', async () => {
  const session = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');
  const scored = await request('POST', '/api/suppliers/check', {
    party: 'Shree Ram Steels Private Limited', gstin: '27AAECS5678D1ZK', modelHint: 'unusual purchase pattern',
  }, session);
  assert.equal(scored.body.level, 'INFORMATION');
  const hint = scored.body.warnings.find((warning: Record<string, any>) => warning.code === 'MODEL_HINT');
  assert.ok(hint);
  assert.equal(hint.level, 'INFORMATION');
  assert.match(hint.message, /a guess from a pattern/);
});

test('supplier checks are scoped to the signed-in company', async () => {
  const konkan = await signIn(COMPANY_B, 'owner@konkan.example.invalid');
  const checked = await request('POST', '/api/suppliers/check', {
    party: 'Western Coast Supplies', gstin: '30AAFCW7788Q1ZP',
  }, konkan);
  assert.equal(checked.status, 200);
  assert.equal(checked.body.supplier, 'Western Coast Supplies');
  assert.equal(checked.body.raw.companyId, COMPANY_B);
});

/**
 * Issue #26 — e-invoice applicability and the IRN lifecycle over the HTTP surface.
 */
test('the HTTP surface refuses to assume every bill needs an IRN', async () => {
  const session = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');
  const { invoices } = (await request('GET', '/api/einvoices/invoices', {}, session)).body;
  const invoice = invoices[0].id;
  assert.equal(invoices[0].eInvoiceStatus, 'NOT_SENT', "the bill's state and the government's are separate");

  // A small trader is told plainly that nothing needs sending, with the rule that decided it.
  const small = await request('POST', '/api/einvoices/preview', { invoice, turnover: '9000000' }, session);
  assert.equal(small.body.outcome, 'NOT_APPLICABLE');
  assert.equal(small.body.ready, false);
  assert.equal(small.body.ruleId, 'EINV.THRESHOLD.5CR');
  assert.match(small.body.sourceRef, /Notification 10\/2023/);
  assert.match(small.body.reason, /It is an ordinary GST bill/);

  // A turnover we were never given is a question, not a guess in either direction.
  const unknown = await request('POST', '/api/einvoices/preview', { invoice }, session);
  assert.equal(unknown.body.outcome, 'CANNOT_DECIDE');
  assert.equal(unknown.body.ready, false);

  // And sending one that does not need it is refused outright.
  const refused = await request('POST', '/api/einvoices/register', { invoice, turnover: '9000000' }, session);
  assert.equal(refused.status, 409);
  assert.match(refused.body.message, /does not need an e-invoice number/);
});

test('the HTTP surface registers once, verifies the reply, and cannot make a second IRN', async () => {
  const session = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');
  const { invoices } = (await request('GET', '/api/einvoices/invoices', {}, session)).body;
  const invoice = invoices[0].id;

  const preview = await request('POST', '/api/einvoices/preview', { invoice, turnover: '80000000' }, session);
  assert.equal(preview.body.outcome, 'APPLICABLE');
  assert.equal(preview.body.ready, true);
  assert.match(preview.body.expectedIrn, /^[0-9a-f]{64}$/);
  assert.equal(preview.body.reportableUntil.length, 10);

  const registered = await request('POST', '/api/einvoices/register', { invoice, turnover: '80000000' }, session);
  assert.equal(registered.body.status, 'REGISTERED');
  // What we predicted is what came back, which is the verification working end to end.
  assert.equal(registered.body.irn, preview.body.expectedIrn);
  assert.ok(registered.body.ackNumber.length > 0);
  assert.ok(registered.body.signedQrCode.length > 0, 'the signed QR is kept for the customer copy');
  assert.ok(registered.body.cancellableUntil.length > 0);

  const again = await request('POST', '/api/einvoices/register', { invoice, turnover: '80000000' }, session);
  assert.equal(again.body.irn, registered.body.irn, 'a retry never produces a second IRN');

  const cancelled = await request('POST', '/api/einvoices/cancel', {
    invoice, turnover: '80000000', reasonCode: 'DATA_ENTRY_MISTAKE', reason: "The buyer's GST number was typed wrong",
  }, session);
  assert.equal(cancelled.body.status, 'CANCELLED');
  assert.match(cancelled.body.message, /The bill in your books is unchanged/);
});

test('the offline export is offered and says it is not yet an e-invoice', async () => {
  const session = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');
  const { invoices } = (await request('GET', '/api/einvoices/invoices', {}, session)).body;
  const exported = await request('POST', '/api/einvoices/offline', { invoice: invoices[0].id, turnover: '80000000' }, session);
  assert.equal(exported.status, 200);
  assert.match(exported.body.fileName, /^einvoice-.*\.json$/);
  const file = JSON.parse(exported.body.json);
  assert.equal(file.InvoiceList.length, 1);
  assert.match(file._karobar.note, /not an e-invoice until the government returns an IRN/);
});

test('e-invoices belong to the signed-in company alone', async () => {
  const konkan = await signIn(COMPANY_B, 'owner@konkan.example.invalid');
  const stolen = await request('POST', '/api/einvoices/preview', { invoice: 'not-ours', turnover: '80000000' }, konkan);
  assert.equal(stolen.status, 404);
});

// ---------------------------------------------------------------------------- issue #23 [E23]
// Reminders over HTTP, against the same live company: the plan is computed from the receivables
// position the ledger produces, and a payment recorded through the payments API stops the chase.

test('the HTTP surface plans reminders from real positions and explains every bill it leaves alone', async () => {
  const owner = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');
  const plan = await request('GET', '/api/reminders', {}, owner);
  assert.equal(plan.status, 200);
  assert.equal(plan.body.asOf, '2026-08-29');

  // Only one message a day to one customer: the oldest bill is chased and the rest say why not.
  assert.equal(plan.body.counts.toSend, 1);
  const sending = plan.body.candidates.find((c: { decision: string }) => c.decision === 'SEND');
  assert.ok(sending, 'the oldest overdue bill is proposed');
  assert.ok(sending.daysOverdue >= 60, 'and it is the oldest one');
  assert.ok(sending.outstanding > 0, 'with the amount still outstanding, not the invoice value');

  const waiting = plan.body.candidates.find((c: { reason: string }) => c.reason === 'TOO_SOON');
  assert.ok(waiting, 'the second overdue bill waits its turn rather than sending a second message');
  const notYet = plan.body.candidates.find((c: { reason: string }) => c.reason === 'NOT_YET_DUE');
  assert.ok(notYet, 'and a bill that is not due yet is left alone');

  // A shopkeeper reads this screen in their own language, so no explanation may be missing one.
  for (const candidate of plan.body.candidates as { explanation: Record<string, string> }[]) {
    assert.equal(typeof candidate.explanation['en-IN'], 'string');
    assert.equal(typeof candidate.explanation['hi-IN'], 'string');
  }
});

test('a reminder sent over HTTP goes out once, and asking again does not send a second', async () => {
  const owner = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');
  const plan = await request('GET', '/api/reminders', {}, owner);
  const target = plan.body.candidates.find((c: { decision: string }) => c.decision === 'SEND');

  const sent = await request('POST', '/api/reminders/send', { documentId: target.documentId }, owner);
  assert.equal(sent.status, 200);
  assert.equal(sent.body.reminder.state, 'SENT');
  assert.match(sent.body.reminder.message['en-IN'], /Sampoorna Traders/);

  const after = await request('GET', '/api/reminders', {}, owner);
  assert.equal(after.body.history.length, 1);
  assert.equal(after.body.outbox.length, 1, 'exactly one message left the building');

  const again = await request('POST', '/api/reminders/send', { documentId: target.documentId }, owner);
  assert.equal(again.body.reminder.id, sent.body.reminder.id, 'the same reminder, not a new one');
  const afterAgain = await request('GET', '/api/reminders', {}, owner);
  assert.equal(afterAgain.body.outbox.length, 1, 'and still one message');
});

test('a bill that is paid or disputed is not chased, over HTTP either', async () => {
  const owner = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');
  const before = await request('GET', '/api/reminders', {}, owner);
  const open = before.body.candidates.find((c: { reason: string }) => c.reason === 'TOO_SOON');
  assert.ok(open, 'the second overdue bill is still open');

  // The customer queries it. Nothing goes out until that is settled.
  const dispute = await request('POST', '/api/reminders/dispute', { documentId: open.documentId, reason: 'They say one carton never arrived.' }, owner);
  assert.equal(dispute.status, 200);
  const held = await request('GET', '/api/reminders', {}, owner);
  assert.equal(held.body.candidates.find((c: { documentId: string }) => c.documentId === open.documentId).reason, 'DISPUTED');
  const refused = await request('POST', '/api/reminders/send', { documentId: open.documentId }, owner);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'REMINDER_NOT_APPLICABLE');

  // Settled, and then actually paid through the real payments API.
  const disputeId = held.body.disputes[0].id;
  assert.equal((await request('POST', '/api/reminders/dispute/resolve', { disputeId, resolution: 'The carton was found.' }, owner)).status, 200);
  const paid = await request('POST', '/api/payments/record', { party: 'ABC Traders', amount: String(open.outstanding), date: '2026-08-29', reference: 'REMINDER-23-PAID', invoice: open.documentId }, owner);
  assert.equal(paid.body.state, 'recorded');

  const settled = await request('GET', '/api/reminders', {}, owner);
  assert.equal(settled.body.candidates.find((c: { documentId: string }) => c.documentId === open.documentId).reason, 'SETTLED');
  const afterPayment = await request('POST', '/api/reminders/send', { documentId: open.documentId }, owner);
  assert.equal(afterPayment.status, 409, 'a paid bill is never chased');
});

test('reminders need a session, the right permission, and belong to one company only', async () => {
  assert.equal((await request('GET', '/api/reminders')).status, 401);

  const viewer = await signIn(COMPANY_A, 'viewer@sampoorna.example.invalid', 'viewer-demo');
  assert.equal((await request('GET', '/api/reminders', {}, viewer)).status, 403);
  assert.equal((await request('POST', '/api/reminders/send', { documentId: 'anything' }, viewer)).status, 403);

  const konkan = await signIn(COMPANY_B, 'owner@konkan.example.invalid');
  const theirs = await request('GET', '/api/reminders', {}, konkan);
  assert.equal(theirs.status, 200);
  assert.deepEqual(theirs.body.history, [], 'nothing sent from the other company appears here');
  assert.equal(theirs.body.outbox.length, 0);
});

// ---------------------------------------------------------------------------- issue #42 [E42]
// The plan over HTTP, against the same live company: the limit actually stops a bill, the bills
// that were already issued are untouched, and no plan can switch a compliance warning off.

test('the plan is enforced on a real write path, and counted only when the work succeeded', async () => {
  const owner = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');

  const before = await request('GET', '/api/subscription', {}, owner);
  assert.equal(before.status, 200);
  assert.equal(before.body.plan.id, 'free', 'a business with no plan on file is treated as free, not as stopped');
  const invoicesUsed = before.body.usage.find((total: { meter: string }) => total.meter === 'invoices');
  assert.ok(invoicesUsed.used >= 1, 'the bills this company has already issued were counted');

  // Every essential capability is allowed on the smallest plan. This is the acceptance criterion.
  for (const capability of ['gst.compliance_warning', 'supplier.risk_warning', 'data.export']) {
    const check = before.body.checks.find((entry: { capability: string }) => entry.capability === capability);
    assert.equal(check.outcome, 'ALLOWED', `${capability} is never withheld`);
    assert.equal(check.essential, true);
  }

  // Fill the free plan's monthly allowance, then try one more.
  const remaining = invoicesUsed.remaining as number;
  for (let i = 0; i < remaining; i += 1) {
    const filled = await request('POST', '/api/sales/record', {
      party: 'ABC Traders', item: 'Herbal Bath Soap 100g', quantity: '1', rate: '1',
      date: '2026-08-29', terms: '30', reference: `PLAN-42-${i}`,
    }, owner);
    assert.equal(filled.status, 200, 'bills inside the plan are issued normally');
  }

  const overLimit = await request('POST', '/api/sales/record', {
    party: 'ABC Traders', item: 'Herbal Bath Soap 100g', quantity: '1', rate: '1',
    date: '2026-08-29', terms: '30', reference: 'PLAN-42-OVER',
  }, owner);
  assert.equal(overLimit.status, 403);
  assert.equal(overLimit.body.code, 'ENTITLEMENT_LIMIT_REACHED');
  assert.match(overLimit.body.message, /safe and unchanged/);

  const backdated = await request('POST', '/api/sales/record', {
    party: 'ABC Traders', item: 'Herbal Bath Soap 100g', quantity: '1', rate: '1',
    date: '2026-07-01', terms: '30', reference: 'PLAN-42-BACKDATED',
  }, owner);
  assert.equal(backdated.status, 403, 'a document date cannot bypass the current subscription limit');
  assert.equal(backdated.body.code, 'ENTITLEMENT_LIMIT_REACHED');

  // Nothing was half-done: the refused bill does not exist and the books still balance.
  const reports = await request('GET', '/api/reports', {}, owner);
  assert.equal(reports.body.trialBalance.balanced, true);
  assert.ok(!reports.body.sales.rows.some((row: { number: string }) => row.number === undefined));

  // The warnings still work while the plan is exhausted.
  const exhausted = await request('GET', '/api/subscription', {}, owner);
  assert.equal(exhausted.body.checks.find((entry: { capability: string }) => entry.capability === 'sales.issue_invoice').outcome, 'BLOCKED_LIMIT');
  assert.equal(exhausted.body.checks.find((entry: { capability: string }) => entry.capability === 'gst.compliance_warning').outcome, 'ALLOWED');

  // Upgrading lifts it at once, and the bills already issued are still there.
  const upgraded = await request('POST', '/api/subscription/plan', { planId: 'growth', reason: 'Busy season' }, owner);
  assert.equal(upgraded.status, 200);
  const after = await request('GET', '/api/subscription', {}, owner);
  assert.equal(after.body.plan.id, 'growth');
  assert.equal(
    after.body.usage.find((total: { meter: string }) => total.meter === 'invoices').used,
    exhausted.body.usage.find((total: { meter: string }) => total.meter === 'invoices').used,
    'a plan change never rewrites what was already done',
  );
  const allowedAgain = await request('POST', '/api/sales/record', {
    party: 'ABC Traders', item: 'Herbal Bath Soap 100g', quantity: '1', rate: '1',
    date: '2026-08-29', terms: '30', reference: 'PLAN-42-AFTER',
  }, owner);
  assert.equal(allowedAgain.status, 200);
});

test('the subscription screen needs a session and its own permission, and is company-scoped', async () => {
  assert.equal((await request('GET', '/api/subscription')).status, 401);
  const viewer = await signIn(COMPANY_A, 'viewer@sampoorna.example.invalid', 'viewer-demo');
  assert.equal((await request('GET', '/api/subscription', {}, viewer)).status, 403);

  const konkan = await signIn(COMPANY_B, 'owner@konkan.example.invalid');
  const theirs = await request('GET', '/api/subscription', {}, konkan);
  assert.equal(theirs.status, 200);
  assert.equal(theirs.body.plan.id, 'free', 'another company is on its own plan, not this one’s');
  const konkanInvoices = theirs.body.usage.find((total: { meter: string }) => total.meter === 'invoices');
  assert.ok(konkanInvoices.used < 50, 'and on its own count');
});

test('paying for the service is idempotent and never touches the books', async () => {
  const owner = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');
  const before = await request('GET', '/api/reports', {}, owner);

  const paid = await request('POST', '/api/subscription/pay', {}, owner);
  assert.equal(paid.status, 200);
  const again = await request('POST', '/api/subscription/pay', {}, owner);
  assert.equal(again.body.message, paid.body.message, 'asking twice pays once');

  const account = await request('GET', '/api/subscription', {}, owner);
  assert.equal(account.body.invoices.length, 1, 'one invoice for the month, however often it is asked for');
  assert.equal(account.body.invoices[0].state, 'PAID');

  const after = await request('GET', '/api/reports', {}, owner);
  assert.deepEqual(after.body.trialBalance, before.body.trialBalance, 'our own billing is not their books');
});
