/**
 * Issue #311 — the purchase check (#31, GSTR-2B/IMS) shows on the supplier bill itself: the moment
 * it is recorded, and again once the government's row for it is in, without visiting the Purchase
 * check screen. Every GST number and bill below is synthetic.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { useFixedAppClock } from '../src/app-clock.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

test('#311: a recorded supplier bill carries its purchase check, before and after the portal row is in', async () => {
  const login = await request('POST', '/api/auth/login', { companyId: SAMPOORNA, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' });
  const session = login.body.sessionId as string;
  const input = { supplierId: 'sampoorna:party:supplier', reference: 'SRS-311-1', date: '2026-09-02', lines: [{ item: 'TMT Steel Bar 12mm', quantity: '10', rate: '64', gst: '1800' }] };

  const recorded = await request('POST', '/api/purchases/record', input, session);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  const before = recorded.body.purchaseCheck;
  assert.ok(before, 'the bill carries its purchase check');
  assert.equal(before.portalDataPresent, false);
  assert.notEqual(before.status, 'EXACT', 'nothing from the portal yet, so it cannot agree');
  assert.ok(before['en-IN'].length > 0 && before['hi-IN'].length > 0, 'said in both languages');

  // The government's row, typed as the portal shows it: the same bill now agrees.
  const typed = await request('POST', '/api/itc/typed', {
    period: '2026-09', gstin: '27AAECS5678D1Z4', supplierName: 'Shree Ram Steels Private Limited', number: 'SRS-311-1',
    date: '2026-09-02', taxableValue: '640', igst: '115.20', invoiceValue: '755.20',
  }, session);
  assert.equal(typed.status, 200, JSON.stringify(typed.body));
  const again = await request('POST', '/api/purchases/record', input, session);
  assert.equal(again.body.deduplicated, true);
  assert.equal(again.body.purchaseCheck.portalDataPresent, true);
  assert.equal(again.body.purchaseCheck.status, 'EXACT', again.body.purchaseCheck['en-IN']);
});
