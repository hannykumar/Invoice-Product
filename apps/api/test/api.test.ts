import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';

const request = async (method: string, path: string, body: Record<string, unknown> = {}) => {
  const response = await handleApi(method, path, body);
  return { status: response.status, body: JSON.parse(response.body) as Record<string, any> };
};

test('the demo HTTP surface previews, posts, and deduplicates a supplier bill', async () => {
  const before = await request('GET', '/api/dashboard');
  assert.equal(before.status, 200);
  assert.equal(before.body.company.name, 'Sampoorna Traders');
  assert.equal(before.body.stock.quantity, 0);
  assert.equal(before.body.supplier.outstanding, 0);

  const input = {
    party: 'Shree Ram Steels Private Limited',
    reference: 'WEB-ISSUE-72',
    date: '2026-08-29',
    amount: '1750.50',
  };
  const preview = await request('POST', '/api/purchases/preview', input);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.state, 'preview');

  const afterPreview = await request('GET', '/api/dashboard');
  assert.equal(afterPreview.body.stock.quantity, 0, 'preview must not alter stock');
  assert.equal(afterPreview.body.supplier.outstanding, 0, 'preview must not alter payables');

  const recorded = await request('POST', '/api/purchases/record', input);
  assert.equal(recorded.status, 200);
  assert.equal(recorded.body.state, 'recorded');
  assert.equal(recorded.body.deduplicated, false);
  assert.equal(recorded.body.stock.quantity, 1);
  assert.equal(recorded.body.supplier.outstanding, 1750.5);

  const retried = await request('POST', '/api/purchases/record', input);
  assert.equal(retried.body.deduplicated, true);
  assert.equal(retried.body.stock.quantity, 1, 'retry must not double stock');
  assert.equal(retried.body.supplier.outstanding, 1750.5, 'retry must not double the supplier balance');

  const failed = await request('POST', '/api/purchases/record', { ...input, reference: 'INVALID-72', amount: '0' });
  assert.equal(failed.status, 400);
  assert.equal(failed.body.state, 'failed');
  assert.equal(failed.body.title, 'Nothing was saved');
});

test('sales and customer payments reach their real service modules', async () => {
  const sale = { party: 'ABC Traders', item: 'Herbal Bath Soap 100g', quantity: '2', rate: '100', date: '2026-08-29', terms: '7', reference: 'WEB-SALE-72' };
  const preview = await request('POST', '/api/sales/preview', sale);
  assert.equal(preview.body.state, 'preview');
  assert.equal(preview.body.amount, 200);

  const recorded = await request('POST', '/api/sales/record', sale);
  assert.equal(recorded.body.state, 'recorded');
  assert.match(recorded.body.invoice.number, /^INV\/WEB\//);

  const paymentPreview = await request('POST', '/api/payments/preview', { party: 'ABC Traders', amount: '50', date: '2026-08-29' });
  assert.equal(paymentPreview.body.state, 'preview');
  const payment = await request('POST', '/api/payments/record', { party: 'ABC Traders', amount: '50', date: '2026-08-29', reference: 'WEB-PAY-72', invoice: recorded.body.invoice.id });
  assert.equal(payment.body.state, 'recorded');
  assert.ok(payment.body.customerOutstanding >= 0);
});

test('the reports surface is computed from the same live company the other calls mutate', async () => {
  // Record a real sale, then read the reports. Nothing about the pack is typed in; every figure is
  // folded from the ledger, sales, stock and receivables that this same demo application drives.
  const sale = { party: 'ABC Traders', item: 'Herbal Bath Soap 100g', quantity: '3', rate: '400', date: '2026-08-29', terms: '15', reference: 'WEB-REPORTS-35' };
  const recorded = await request('POST', '/api/sales/record', sale);
  assert.equal(recorded.body.state, 'recorded');

  const reports = await request('GET', '/api/reports');
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

  // Every exception carries a machine code and a plain-language explanation.
  assert.ok(Array.isArray(reports.body.exceptions.items));
  for (const item of reports.body.exceptions.items as { code: string; what: string }[]) {
    assert.equal(typeof item.code, 'string');
    assert.equal(typeof item.what, 'string');
  }
});
