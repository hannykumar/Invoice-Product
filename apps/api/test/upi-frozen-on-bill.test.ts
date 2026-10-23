/**
 * Issue #390 — the pay-by-scan square on an issued bill pays the UPI id the bill was issued with.
 *
 * Every reprint and PDF used to read the company's current UPI id, so one change on the Bill design
 * screen silently re-pointed the square on every old unpaid bill. The id is now frozen with the rest
 * of the bill at issue (CGST Rule 56(8): an issued document is not overwritten), and a new payee only
 * reaches a customer on a new bill.
 *
 * Every name and id below is synthetic and belongs to nobody.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { stockEverything } from './stock-helper.ts';
import { useFixedAppClock } from '../src/app-clock.ts';
import { signIn as signInAs } from './sign-in-helper.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const SOAP = 'Herbal Bath Soap 100g';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

let owner: Promise<string> | null = null;
const ownerSession = () => owner ??= (async () => {
  const session = await signInAs('owner@sampoorna.example.invalid', SAMPOORNA);
  await stockEverything(`Bearer ${session}`);
  return session;
})();

const setUpi = async (session: string, body: Record<string, unknown>) => {
  const saved = await request('POST', '/api/branding/upi', body, session);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
};

const sale = (requestId: string) => ({ party: 'ABC Traders', item: SOAP, quantity: '3', rate: '40', date: '2026-09-28', terms: '7', requestId });

const sell = async (session: string, requestId: string) => {
  const sold = await request('POST', '/api/sales/record', sale(requestId), session);
  assert.equal(sold.status, 200, JSON.stringify(sold.body));
  return sold.body;
};

const reprint = async (session: string, invoiceId: string): Promise<string> => {
  const printed = await request('POST', '/api/sales/print', { invoice: invoiceId }, session);
  assert.equal(printed.status, 200, JSON.stringify(printed.body));
  return String(printed.body.html);
};

test('#390: changing the UPI id does not change the square on a bill already issued', async () => {
  const session = await ownerSession();
  await setUpi(session, { upiId: 'shop@okicici' });
  const sold = await sell(session, 'upi-390-before-change');
  assert.match(sold.upiLink, /^upi:\/\/pay\?pa=shop@okicici&/);
  assert.match(await reprint(session, sold.invoice.id), /data-upi="shop@okicici"/);

  await setUpi(session, { upiId: 'someone-else@ybl' });

  const html = await reprint(session, sold.invoice.id);
  assert.match(html, /data-upi="shop@okicici"/, 'the reprint still pays the id the bill was issued with');
  assert.ok(!html.includes('someone-else@ybl'), 'the new id never appears on the old bill');
  const preview = await request('GET', `/api/sales/${sold.invoice.id}/preview`, {}, session);
  assert.equal(preview.status, 200);
  assert.ok(!String(preview.body.html).includes('someone-else@ybl'));
  assert.match(String(preview.body.html), /data-upi="shop@okicici"/);
  const pdf = await handleApi('GET', `/api/sales/${sold.invoice.id}/pdf`, {}, `Bearer ${session}`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers['content-type'], 'application/pdf');

  // Pressing Record again for the same sale hands back the same bill — with the same payee.
  const again = await sell(session, 'upi-390-before-change');
  assert.equal(again.invoice.id, sold.invoice.id);
  assert.match(again.upiLink, /^upi:\/\/pay\?pa=shop@okicici&/);

  // A bill issued after the change is a new document, and carries the new id.
  const next = await sell(session, 'upi-390-after-change');
  assert.match(next.upiLink, /^upi:\/\/pay\?pa=someone-else@ybl&/);
  assert.match(await reprint(session, next.invoice.id), /data-upi="someone-else@ybl"/);
});

test('#390: taking the UPI id off, or adding one later, leaves issued bills as they were', async () => {
  const session = await ownerSession();
  await setUpi(session, { upiId: 'shop@okicici' });
  const withId = await sell(session, 'upi-390-issued-with-id');
  await setUpi(session, { clear: true });
  const withoutId = await sell(session, 'upi-390-issued-without-id');
  assert.equal(withoutId.upiLink, null, 'no id saved, so a new bill has no UPI link');
  assert.ok(!(await reprint(session, withoutId.invoice.id)).includes('data-upi='));

  assert.match(await reprint(session, withId.invoice.id), /data-upi="shop@okicici"/, 'removing the id does not rewrite an issued bill');

  await setUpi(session, { upiId: 'someone-else@ybl' });
  const html = await reprint(session, withoutId.invoice.id);
  assert.ok(!html.includes('data-upi='), 'a bill issued with no UPI id never gains a square later');
  assert.ok(!html.includes('someone-else@ybl'));
});
