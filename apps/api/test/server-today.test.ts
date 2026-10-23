/**
 * Issue #403 — the assistant and payment reminders read "today" from the server's clock, never from
 * the request.
 *
 * Before this, `{"today":"2027-12-31"}` sent to `/api/reminders/send-all` (or to `/api/agent/plan`
 * with "remind everyone") treated a bill that is not yet due as long overdue: the customer was
 * chased early, with stronger wording, and the reminder log recorded a date that never happened.
 *
 * The worked dates: the server's clock says 28 Sep 2026 in India. Clock Test Traders' bill of
 * 28 Sep 2026 with 30 days to pay is due 28 Oct 2026, so on 28 Sep it is not yet due, whatever the
 * request says. On 20 Nov 2026 by the server's clock it is 23 days late and is chased.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { stockEverything } from './stock-helper.ts';
import { useFixedAppClock } from '../src/app-clock.ts';
import { signIn as signInAs } from './sign-in-helper.ts';

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const SERVER_TODAY = '2026-09-28';
const CLIENT_TODAY = '2027-12-31';
const CUSTOMER = 'Clock Test Traders';

useFixedAppClock('2026-09-28T05:30:00.000Z');

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const notYetDue = (() => {
  let done: Promise<{ owner: string; bill: { id: string; number: string } }> | null = null;
  return () => done ??= (async () => {
    const owner = await signInAs('owner@sampoorna.example.invalid', SAMPOORNA);
    await stockEverything(`Bearer ${owner}`);
    const customer = await request('POST', '/api/customers', {
      legalName: CUSTOMER, registration: 'regular', gstin: '27AAACM1234K1ZN',
      line1: 'Plot 9, MIDC Bhosari', city: 'Pune', pincode: '411026', phone: '+91 90000 00403',
    }, owner);
    assert.equal(customer.status, 200, JSON.stringify(customer.body));
    const sold = await request('POST', '/api/sales/record', {
      customerId: customer.body.customer.id, lines: [{ itemId: 'sampoorna:item:TMT12', quantity: '10', rate: '90' }],
      date: SERVER_TODAY, terms: '30', reference: 'server-today-403',
    }, owner);
    assert.equal(sold.status, 200, JSON.stringify(sold.body));
    return { owner, bill: { id: sold.body.invoice.id as string, number: sold.body.invoice.number as string } };
  })();
})();

test('#403 the reminders screen is as on the server\'s today, not the date the request names', async () => {
  const { owner, bill } = await notYetDue();
  const screen = await request('GET', '/api/reminders', { today: CLIENT_TODAY }, owner);
  assert.equal(screen.status, 200, JSON.stringify(screen.body));
  assert.equal(screen.body.asOf, SERVER_TODAY);
  const candidate = screen.body.candidates.find((entry: any) => entry.documentId === bill.id);
  assert.ok(candidate, 'the open bill is on the plan');
  assert.equal(candidate.decision, 'SKIP', 'due 28 Oct 2026, so not chased on 28 Sep 2026');
  assert.equal(candidate.daysOverdue, -30, 'due in 30 days, not 429 days late');
});

test('#403 sending one reminder with a future "today" does not chase a bill that is not yet due', async () => {
  const { owner, bill } = await notYetDue();
  const sent = await request('POST', '/api/reminders/send', { documentId: bill.id, today: CLIENT_TODAY }, owner);
  assert.notEqual(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.code, 'REMINDER_NOT_APPLICABLE');
});

test('#403 "send everything agreed" with a future "today" leaves a bill that is not yet due alone, and logs the real date', async () => {
  const { owner, bill } = await notYetDue();
  const sent = await request('POST', '/api/reminders/send-all', { today: CLIENT_TODAY }, owner);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.reminders.some((reminder: any) => reminder.documentId === bill.id), false, 'the bill is not chased');
  for (const reminder of sent.body.reminders) assert.equal(reminder.asOf, SERVER_TODAY, 'the log records the day it really was');
  const history = (await request('GET', '/api/reminders', {}, owner)).body.history;
  assert.equal(history.some((reminder: any) => reminder.documentId === bill.id), false);
  assert.ok(history.every((reminder: any) => reminder.asOf === SERVER_TODAY), JSON.stringify(history.map((r: any) => r.asOf)));
});

test('#403 the assistant asked to remind everyone with a future "today" plans no reminder for a bill that is not yet due', async () => {
  const { owner } = await notYetDue();
  const planned = await request('POST', '/api/agent/plan', { request: 'Send reminders for every unpaid bill', today: CLIENT_TODAY }, owner);
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  const sends = planned.body.steps.filter((step: any) => step.tool === 'reminders.send');
  assert.equal(sends.some((step: any) => step.party === CUSTOMER), false, JSON.stringify(sends));
});

test('#403 when the server\'s clock really reaches 20 Nov 2026, the same bill is 23 days late and is chased', async () => {
  const { owner, bill } = await notYetDue();
  useFixedAppClock('2026-11-20T05:30:00.000Z');
  const screen = await request('GET', '/api/reminders', {}, owner);
  assert.equal(screen.body.asOf, '2026-11-20');
  const candidate = screen.body.candidates.find((entry: any) => entry.documentId === bill.id);
  assert.equal(candidate.daysOverdue, 23, '28 Oct to 20 Nov: 3 + 20 days');
  assert.notEqual(candidate.decision, 'SKIP');
  const planned = await request('POST', '/api/agent/plan', { request: 'Send reminders for every unpaid bill' }, owner);
  assert.ok(planned.body.steps.some((step: any) => step.tool === 'reminders.send' && step.party === CUSTOMER), JSON.stringify(planned.body.steps));
});
