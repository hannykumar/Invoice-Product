/**
 * Issue #398 — parallel `GET /api/sales/:id/pdf` requests share one browser instead of starting a
 * Chromium each, and a company still cannot print another company's bill.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { handleApi } from '../src/server.ts';
import { sells, stockEverything } from './stock-helper.ts';
import { useFixedAppClock } from '../src/app-clock.ts';
import { signIn } from './sign-in-helper.ts';
import { closePdfRenderer } from '../../../packages/invoice-templates/src/pdf.ts';

useFixedAppClock('2026-08-29T10:00:00.000Z');

const COMPANY_A = '00000000-0000-4000-8000-000000000001';
const COMPANY_B = '00000000-0000-4000-8000-000000000011';

const call = async (method: string, path: string, body: Record<string, unknown>, session: string) => {
  if (sells(method, path)) await stockEverything(`Bearer ${session}`);
  return handleApi(method, path, body, `Bearer ${session}`);
};

test('#398: ten bill PDFs asked for at once start one browser, not ten', async (context) => {
  await closePdfRenderer();
  context.after(() => closePdfRenderer());
  const realLaunch = puppeteer.launch.bind(puppeteer);
  const launch = context.mock.method(puppeteer, 'launch', realLaunch);
  const owner = await signIn('owner@sampoorna.example.invalid', COMPANY_A);
  const sale = { party: 'ABC Traders', item: 'Herbal Bath Soap 100g', quantity: '1', rate: '100', date: '2026-08-29', terms: '7', reference: 'PDF-POOL-398', requestId: 'pdf-pool-398', approvalReason: 'Agreed with the owner' };
  // Every bill carries the caller's entry number (#392); without it the sale is refused and there is nothing to print.
  const made = await call('POST', '/api/sales/record', sale, owner);
  assert.equal(made.status, 200, String(made.body));
  const recorded = JSON.parse(String(made.body)) as { invoice: { id: string } };
  const files = await Promise.all(Array.from({ length: 10 }, () => call('GET', `/api/sales/${recorded.invoice.id}/pdf`, {}, owner)));
  for (const file of files) {
    assert.equal(file.status, 200, String(file.body));
    assert.ok(Buffer.isBuffer(file.body));
    assert.equal(file.body.subarray(0, 5).toString(), '%PDF-');
  }
  assert.equal(launch.mock.callCount(), 1);
  const other = await signIn('owner@konkan.example.invalid', COMPANY_B);
  assert.equal((await call('GET', `/api/sales/${recorded.invoice.id}/pdf`, {}, other)).status, 404);
});
