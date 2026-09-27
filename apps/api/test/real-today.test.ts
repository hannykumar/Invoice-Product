/**
 * Issue #234 — the running app has one "today": the real date in India.
 *
 * Before this, the server's clock was frozen at 29 Aug 2026 while the sale screen used the real
 * date, and Reports counted days late up to 31 March. On 27 Sep 2026 that showed:
 *
 *   a sale due 27 Oct 2026                  155 days late (27 Oct 2026 to 31 Mar 2027)   right: 0
 *   ABC Traders' bill due 30 Jun 2026       274 days late (to 31 Mar 2027)                right: 89
 *   an e-way bill for 840 km raised 27 Sep  "valid until 04/09/2026", before the bill's own date
 *
 * The worked numbers, on 27 Sep 2026 at 11:00 in India:
 *
 *   ABC Traders' bill of 15 Jun 2026 with 15 days to pay is due 30 Jun 2026.
 *     1 Jul to 31 Jul = 31 days, 1 Aug to 31 Aug = 31 days, 1 Sep to 27 Sep = 27 days: 31 + 31 + 27 = 89
 *   An e-way bill for 840 km: 840 ÷ 200 = 4.2, and part of a day counts as a day, so 5 days.
 *     Raised 27 Sep, valid to the end of 27 + 5 = 2 Oct, which is midnight going into 3 Oct.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { indiaDateOf } from '@invoice/kernel';
import { handleApi } from '../src/server.ts';
import { stockEverything } from './stock-helper.ts';
import { useFixedAppClock, useSystemAppClock } from '../src/app-clock.ts';

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const signIn = async (): Promise<string> => {
  const response = await request('POST', '/api/auth/login', { companyId: SAMPOORNA, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' });
  assert.equal(response.status, 200);
  return response.body.sessionId as string;
};

const lateness = async (session: string, party: string): Promise<number | undefined> =>
  (await request('GET', '/api/reports', {}, session)).body.dues.receivables.rows
    .find((row: Record<string, unknown>) => row.party === party)?.oldestDaysOverdue;

test('#234 on 27 Sep 2026: a sale due in 30 days is 0 days late, ABC Traders is 89, and an 840 km e-way bill runs to the end of 2 Oct', async () => {
  // 11:00 in India on 27 Sep 2026.
  useFixedAppClock('2026-09-27T05:30:00.000Z');
  const session = await signIn();
  await stockEverything(`Bearer ${session}`);

  const home = await request('GET', '/api/dashboard', {}, session);
  assert.equal(home.body.today, '2026-09-27');

  const mehta = await request('POST', '/api/customers', {
    legalName: 'Mehta Construction Supplies', registration: 'regular', gstin: '27AAACM1234K1ZN',
    line1: 'Plot 22, MIDC Bhosari', city: 'Pune', pincode: '411026',
  }, session);
  assert.equal(mehta.status, 200, mehta.body.message);
  const sold = await request('POST', '/api/sales/record', {
    customerId: mehta.body.customer.id, lines: [{ itemId: 'sampoorna:item:TMT12', quantity: '450', rate: '90' }],
    freight: '2000', date: '2026-09-27', terms: '30', reference: 'real-today-234',
  }, session);
  assert.equal(sold.status, 200, sold.body.message);

  const reports = await request('GET', '/api/reports', {}, session);
  assert.deepEqual(reports.body.period, { from: '2026-04-01', to: '2027-03-31', lateCountedTo: '2026-09-27' });
  assert.equal(await lateness(session, 'Mehta Construction Supplies'), 0, 'due 27 Oct 2026: not yet due');
  assert.equal(await lateness(session, 'ABC Traders'), 89, 'due 30 Jun 2026: 31 + 31 + 27 days');

  // Home: this sale is today's; the seeded bills of June to August are not.
  const after = await request('GET', '/api/dashboard', {}, session);
  assert.equal(after.body.metrics.salesToday, 50150);

  const raised = await request('POST', '/api/eway/generate', { invoice: sold.body.invoice.id, distanceKm: '840', vehicle: 'KA01AB1234', reason: 'SUPPLY' }, session);
  assert.equal(raised.status, 200, raised.body.message);
  // Midnight going into 3 Oct in India is 18:30 on 2 Oct in UTC.
  assert.equal(new Date(raised.body.validUntil).toISOString(), '2026-10-02T18:30:00.000Z');
  assert.equal(raised.body.validUntilLabel, '02/10/2026 23:59:59 (Indian time)', '27 Sep + 5 days = 2 Oct, to the end of that day');
  assert.ok(new Date(raised.body.validUntil) > new Date('2026-09-27T18:30:00.000Z'), 'valid until is after the bill date');
});

test('#234 a day later the same bills are one day later, with nothing else changed', async () => {
  useFixedAppClock('2026-09-28T05:30:00.000Z');
  const session = await signIn();
  assert.equal(await lateness(session, 'ABC Traders'), 90);
  assert.equal(await lateness(session, 'Mehta Construction Supplies'), 0);
  assert.equal((await request('GET', '/api/dashboard', {}, session)).body.metrics.salesToday, 0, 'yesterday\'s sale is not today\'s');
});

test('#234 without a pinned clock, the app\'s today is the machine\'s date in India', async () => {
  useSystemAppClock();
  const session = await signIn();
  const before = indiaDateOf(new Date());
  const home = await request('GET', '/api/dashboard', {}, session);
  const reports = await request('GET', '/api/reports', {}, session);
  const after = indiaDateOf(new Date());
  assert.ok([before, after].includes(home.body.today), `${home.body.today} is today in India`);
  assert.ok([before, after].includes(reports.body.period.lateCountedTo));
  const year = Number(home.body.today.slice(0, 4)) - (Number(home.body.today.slice(5, 7)) >= 4 ? 0 : 1);
  assert.equal(reports.body.period.from, `${year}-04-01`, 'the financial year today is in');
  assert.equal(reports.body.period.to, `${year + 1}-03-31`);
});
