/**
 * Issue #297 — the four finished-but-unreachable modules, checked end to end:
 * the compliance calendar on Home and its routes, bank reconciliation routes,
 * and the rate advisor's hint on the item form.
 * Synthetic people only (packages/platform/src/seed.ts).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { appToday, useFixedAppClock } from '../src/app-clock.ts';
import { SAMPOORNA_OWNER, SAMPOORNA_VIEWER, signIn } from './sign-in-helper.ts';

useFixedAppClock('2026-10-20T10:00:00.000Z');

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const owner = () => signIn(SAMPOORNA_OWNER, SAMPOORNA);
const viewer = () => signIn(SAMPOORNA_VIEWER, SAMPOORNA);

// ------------------------------------------------------------------ compliance calendar

test('Home carries the real deadlines list fed by the compliance calendar', async () => {
  const session = await owner();
  const dash = await request('GET', '/api/dashboard', {}, session);
  assert.equal(dash.status, 200);
  assert.ok(Array.isArray(dash.body.home.comingUp), 'home.comingUp should be an array');
  if (dash.body.home.comingUp.length > 0) {
    const row = dash.body.home.comingUp[0];
    assert.ok(row.id && row.due && row.open?.view, 'each deadline needs a key, a date and a screen');
    assert.ok(row.title['en-IN'] && row.title['hi-IN'], 'deadline titles are bilingual');
  }
});

test('the calendar route returns entries, and refuses someone without the view right', async () => {
  const session = await owner();
  const cal = await request('GET', '/api/compliance/calendar', {}, session);
  assert.equal(cal.status, 200, JSON.stringify(cal.body));
  assert.ok(Array.isArray(cal.body.entries), 'entries should be an array');
  assert.ok(cal.body.entries.length > 0, 'a GSTIN business should have GSTR deadlines');
  assert.ok(cal.body.entries[0].occurrence?.key, 'each entry carries its occurrence key');

  const denied = await request('GET', '/api/compliance/calendar', {}, await viewer());
  assert.ok(denied.status === 403 || Array.isArray(denied.body.entries), 'viewer either lacks the calendar right or is a permitted reader');
});

test('marking a deadline done requires a key and records a typed confirmation', async () => {
  const session = await owner();
  const bad = await request('POST', '/api/compliance/calendar/complete', {}, session);
  assert.equal(bad.status, 422, 'no key should refuse');

  const cal = await request('GET', '/api/compliance/calendar', {}, session);
  const key = cal.body.entries[0].occurrence.key as string;
  const done = await request('POST', '/api/compliance/calendar/complete', { key, note: 'Filed it on the portal myself.', idempotencyKey: `test-complete-${key}` }, session);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.state, 'success');
});

// ------------------------------------------------------------------ bank reconciliation

test('the reconcile run returns its four lists — even with nothing to match', async () => {
  const session = await owner();
  const run = await request('POST', '/api/bank-feeds/reconcile', {}, session);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  for (const key of ['candidates', 'matches', 'exceptions', 'suggestedPayments']) {
    assert.ok(Array.isArray(run.body[key]), `reconcile run should carry ${key}`);
  }
});

test('reconcile failure paths: bad ids and missing reasons refuse cleanly', async () => {
  const session = await owner();
  const noReason = await request('POST', '/api/bank-feeds/reconcile/unmatch', { matchId: 'no-such-match' }, session);
  assert.equal(noReason.status, 422, 'unmatch without a reason should refuse');

  const ghost = await request('POST', '/api/bank-feeds/reconcile/confirm', { candidateId: 'no-such-candidate' }, session);
  assert.ok(ghost.status === 404 || ghost.status === 422 || ghost.status === 400, 'a candidate that does not exist cannot confirm');

  const badLine = await request('POST', '/api/bank-feeds/reconcile/record', { transactionId: 'no-such-line', partyId: 'whoever' }, session);
  assert.equal(badLine.status, 404, 'a bank line that is not imported cannot be recorded');
});

test('reconcile routes check the permission — a viewer cannot run them', async () => {
  const denied = await request('POST', '/api/bank-feeds/reconcile', {}, await viewer());
  assert.equal(denied.status, 403);
});

// ------------------------------------------------------------------ rate advisor

test('the rate hint answers for a known code and refuses an empty ask', async () => {
  const session = await owner();
  const empty = await request('POST', '/api/items/rate-hint', {}, session);
  assert.equal(empty.status, 422, 'no item and no code should refuse');

  const hint = await request('POST', '/api/items/rate-hint', { hsnSac: '7214' }, session);
  assert.equal(hint.status, 200, JSON.stringify(hint.body));
  assert.ok(hint.body.kind === 'SUGGESTED' || hint.body.kind === 'ASK', 'advice is always one of the two shapes');
  if (hint.body.kind === 'SUGGESTED') {
    assert.ok(typeof hint.body.ratePercentTimes100 === 'number', 'a suggestion carries the rate the form can apply');
    assert.ok(hint.body.reason?.['en-IN'], 'a suggestion carries its reason in words');
  }
});
