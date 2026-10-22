/**
 * Issue #299 — the demo seed's own books told two lies and hid a third.
 *
 *   - the three seeded bills were entered newest-first, so `INV/…/000001` carried the newest date
 *     and the oldest bill the newest number — numbers and dates climbed in opposite directions;
 *   - the opening stock entry parked its ₹1,400 cost in the opening-balance-difference account,
 *     leaving the demo's trial balance showing a suspense balance nobody ever explained;
 *   - the suspense account exists for a real difference the owner has not decided yet. The demo
 *     knows where the stock came from — the owner put it in — so it belongs in Capital.
 *
 * Both are checked the way a person sees them: the bill register and the trial balance report.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { useFixedAppClock } from '../src/app-clock.ts';
import { apiRuntime } from '../src/runtime.ts';
import { signIn as signInAs } from './sign-in-helper.ts';

// 10:00 in India on 29 August 2026, the day the newest seeded bill is dated.
useFixedAppClock('2026-08-29T04:30:00.000Z');

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';

const signIn = async (): Promise<string> =>
  signInAs('owner@sampoorna.example.invalid', SAMPOORNA);

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

test('seeded bill numbers climb with the bill dates', async () => {
  const owner = await signIn();
  const runtime = apiRuntime();
  const context = await runtime.authenticate(`Bearer ${owner}`);
  const app = (await runtime.application(context)) as any;
  const companyId = runtime.actor(context).companyId;

  const bills = (await app.salesRepository.list(companyId)) as Array<{ number: string | null; documentDate: string }>;
  const byDate = new Map(bills.filter((bill) => bill.number !== null).map((bill) => [bill.documentDate, bill.number as string]));
  const oldest = byDate.get('2026-06-15');
  const middle = byDate.get('2026-07-20');
  const newest = byDate.get('2026-08-29');
  assert.ok(oldest && middle && newest, 'the three seeded bills should be in the register');
  assert.ok(oldest < middle, `${oldest} (June bill) should number before ${middle} (July bill)`);
  assert.ok(middle < newest, `${middle} (July bill) should number before ${newest} (August bill)`);
});

test('the demo books carry no unexplained difference — opening stock sits in capital', async () => {
  const owner = await signIn();
  const reports = await request('GET', '/api/reports', {}, owner);
  assert.equal(reports.status, 200, JSON.stringify(reports.body));

  const rows = reports.body.trialBalance.rows as Array<{ code: string; name: string; closing: number; side: string }>;
  const difference = rows.find((row) => row.code === '3900');
  assert.equal(difference?.closing ?? 0, 0, `"Opening balance difference" should hold nothing — found ${difference?.closing}`);

  const capital = rows.find((row) => row.code === '3100');
  assert.ok(capital, 'the Capital account should be on the trial balance');
  assert.equal(capital.closing, 1400, 'the owner put in the ₹1,400 of opening soap');
  assert.equal(capital.side, 'CREDIT');

  assert.equal(reports.body.trialBalance.balanced, true);
});
