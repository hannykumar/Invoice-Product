/**
 * Issue #301 — a sale whose review says it needs approval is never issued without one.
 *
 * Mehta Steel was last charged ₹90 a kg. A bill at ₹60 is 33.3% lower than that, more than the 10%
 * anyone may give, so:
 *   - the owner (who may approve) is asked for a reason, and the bill is issued with it;
 *   - someone at the counter (who may issue bills but approves nothing) gets a bill waiting for
 *     approval, never an issued one, and the owner approves it from the waiting list.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { appToday, useFixedAppClock } from '../src/app-clock.ts';
import { signIn as signInAs } from './sign-in-helper.ts';
import { apiRuntime } from '../src/runtime.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const SHREE_RAM = 'sampoorna:party:supplier';
const DATE = appToday();

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const setUp = (() => {
  let done: Promise<{ owner: string; counter: string; customerId: string }> | null = null;
  return () => done ??= (async () => {
    const owner = await signInAs('owner@sampoorna.example.invalid', SAMPOORNA);
    const counter = await signInAs('counter@sampoorna.example.invalid', SAMPOORNA);
    const bought = await request('POST', '/api/purchases/record', {
      supplierId: SHREE_RAM, reference: 'SRS-301', date: DATE,
      lines: [{ item: 'TMT Steel Bar 12mm', quantity: '3000', rate: '50', gst: '1800' }],
    }, owner);
    assert.equal(bought.status, 200, JSON.stringify(bought.body));
    const added = await request('POST', '/api/customers', {
      legalName: 'Mehta Steel Traders', registration: 'regular', gstin: '27AAPFU0939F1ZV', line1: 'Plot 22, MIDC Bhosari', city: 'Pune', pincode: '411026',
    }, owner);
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const customerId = String(added.body.customer.id);
    const first = await request('POST', '/api/sales/record', sale(customerId, 'mehta-301-first', '90'), owner);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.ok(first.body.invoice, 'a bill at the usual price is issued with no approval');
    return { owner, counter, customerId };
  })();
})();

const sale = (customerId: string, requestId: string, rate = '60', more: Record<string, unknown> = {}) => ({
  customerId, item: 'TMT Steel Bar 12mm', quantity: '10', rate, date: DATE, terms: '30', requestId, ...more,
});

/** The approvals in the audit trail, each with who gave it (`actorId`) and why. */
const approvals = async (session: string) => {
  const runtime = apiRuntime();
  const context = await runtime.authenticate(`Bearer ${session}`);
  const app = await runtime.application(context) as any;
  const events = (app.shop.audit.events as Record<string, any>[]).filter((event) => event.action === 'trade_terms.overridden');
  return { userId: runtime.actor(context).userId, events };
};

const issuedCount = async (session: string) => {
  const listed = await request('GET', '/api/einvoices/invoices?limit=200', {}, session);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const rows = (listed.body.invoices ?? []) as unknown[];
  return rows.length;
};

test('#301: the review says what the lower price is against, and who may approve it', async () => {
  const { owner, counter, customerId } = await setUp();
  const asOwner = await request('POST', '/api/sales/preview', sale(customerId, 'mehta-301-look'), owner);
  assert.equal(asOwner.status, 200, JSON.stringify(asOwner.body));
  assert.equal(asOwner.body.terms.outcome, 'NEEDS_APPROVAL');
  const sentence = asOwner.body.terms.lines[0].discount.sentence['en-IN'] as string;
  assert.match(sentence, /lower than the last price you charged them \(₹90\.00\)/);
  assert.match(sentence, /the owner, or someone allowed to approve discounts/);
  assert.deepEqual(asOwner.body.approval, { required: true, canApprove: true, who: 'the owner, or someone allowed to approve discounts' });

  const asCounter = await request('POST', '/api/sales/preview', sale(customerId, 'mehta-301-look-counter'), counter);
  assert.equal(asCounter.status, 200, JSON.stringify(asCounter.body));
  assert.equal(asCounter.body.approval.canApprove, false);
});

test('#301: someone who may approve is asked for a reason, and the bill is issued with it', async () => {
  const { owner, customerId } = await setUp();
  const before = await issuedCount(owner);
  const refused = await request('POST', '/api/sales/record', sale(customerId, 'mehta-301-owner'), owner);
  assert.equal(refused.body.code, 'SALE_APPROVAL_REQUIRED', JSON.stringify(refused.body));
  assert.equal(refused.body.details?.canApprove ?? 'true', 'true');
  assert.equal(await issuedCount(owner), before, 'nothing was issued');

  const blank = await request('POST', '/api/sales/record', sale(customerId, 'mehta-301-owner', '60', { approvalReason: '   ' }), owner);
  assert.equal(blank.body.code, 'SALE_APPROVAL_REQUIRED', 'a blank reason is no reason');

  const approved = await request('POST', '/api/sales/record', sale(customerId, 'mehta-301-owner', '60', { approvalReason: 'Old stock, agreed with Mr Mehta.' }), owner);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.ok(approved.body.invoice, 'issued once approved');
  assert.equal(await issuedCount(owner), before + 1);
  const trail = await approvals(owner);
  assert.ok(trail.events.some((event) => event.actorId === trail.userId && JSON.stringify(event).includes('Old stock, agreed with Mr Mehta.')), 'who approved it and why is kept');
});

test('#301: someone who cannot approve gets a bill waiting for approval, never an issued one', async () => {
  const { owner, counter, customerId } = await setUp();
  const before = await issuedCount(owner);

  const held = await request('POST', '/api/sales/record', sale(customerId, 'mehta-301-counter'), counter);
  assert.equal(held.status, 200, JSON.stringify(held.body));
  assert.equal(held.body.state, 'waiting');
  assert.equal(held.body.invoice, undefined);
  assert.match(held.body.message, /not issued\. It is waiting for approval from the owner, or someone allowed to approve discounts\./);
  const token = String(held.body.token);

  // Pressing Record again holds the same bill; it still does not issue it.
  const again = await request('POST', '/api/sales/record', sale(customerId, 'mehta-301-counter'), counter);
  assert.equal(again.body.state, 'waiting');
  assert.equal(again.body.token, token);

  // Giving a reason is not approving it, when one may not approve.
  const selfApproved = await request('POST', '/api/sales/record', sale(customerId, 'mehta-301-counter-2', '60', { approvalReason: 'I said so.' }), counter);
  assert.equal(selfApproved.status, 403, JSON.stringify(selfApproved.body));
  assert.equal(selfApproved.body.code, 'SALE_APPROVAL_NOT_ALLOWED');

  const counterApproves = await request('POST', '/api/sales/approve', { token, reason: 'I said so.' }, counter);
  assert.equal(counterApproves.status, 403, JSON.stringify(counterApproves.body));
  assert.equal(await issuedCount(owner), before, 'nothing was issued');

  const waiting = await request('GET', '/api/sales/waiting', {}, owner);
  assert.equal(waiting.status, 200, JSON.stringify(waiting.body));
  const row = (waiting.body.bills as Record<string, any>[]).find((bill) => bill.token === token);
  assert.ok(row, 'the owner sees it waiting');
  assert.equal(row.canApprove, true);
  assert.match(row.why[0]['en-IN'], /lower than the last price you charged them/);

  const noReason = await request('POST', '/api/sales/approve', { token, reason: '' }, owner);
  assert.equal(noReason.body.code, 'SALE_APPROVAL_REASON_REQUIRED');

  const approved = await request('POST', '/api/sales/approve', { token, reason: 'Old stock, agreed with Mr Mehta.' }, owner);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.ok(approved.body.invoice, 'issued once approved');
  assert.equal(await issuedCount(owner), before + 1);
  const trail = await approvals(owner);
  assert.ok(trail.events.some((event) => event.actorId === trail.userId && event.details?.documentId === token), 'the approval names the held bill and the owner');

  const twice = await request('POST', '/api/sales/approve', { token, reason: 'Again.' }, owner);
  assert.equal(twice.body.code, 'SALE_NOT_WAITING');
  const after = await request('GET', '/api/sales/waiting', {}, owner);
  assert.equal((after.body.bills as Record<string, any>[]).some((bill) => bill.token === token), false);
});
