/**
 * Issue #266 — the date on a new bill is never passed over in silence.
 *
 * A tax invoice carries the date it is issued. Before this, the server took any date it was sent:
 * a draft left on the device from yesterday issued today's bill dated yesterday, with a later
 * number than bills already dated today, and nothing on the review said so. Now:
 *
 *   dated today                       no extra line
 *   dated before today                allowed, and the review says "This bill will be dated …, which is before today"
 *   dated before a bill already out   allowed, and the review names that bill and says the numbers and dates cross
 *   dated after today                 refused, at the review and at Record
 *   dated in an approved GST month    allowed, and the review says that return must be approved again
 *   dated in a month sent for filing  refused, at the review and at Record
 *
 * Refusals keep nothing behind: no draft, and no number used up.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { useFixedAppClock } from '../src/app-clock.ts';
import { apiRuntime } from '../src/runtime.ts';

// 11:30 in India on 29 September 2026.
useFixedAppClock('2026-09-29T06:00:00.000Z');

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const SHREE_RAM = 'sampoorna:party:supplier';
const ABC = 'sampoorna:party:customer';
const TODAY = '2026-09-29';
const YESTERDAY = '2026-09-28';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const signIn = async (): Promise<string> => {
  const response = await request('POST', '/api/auth/login', { companyId: SAMPOORNA, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' });
  assert.equal(response.status, 200);
  return response.body.sessionId as string;
};

const internals = async (owner: string) => {
  const runtime = apiRuntime();
  const context = runtime.authenticate(`Bearer ${owner}`);
  const app = await runtime.application(context) as any;
  const companyId = runtime.actor(context).companyId;
  return {
    bills: async () => (await app.salesRepository.list(companyId)) as any[],
  };
};

const sale = (date: string, requestId: string) => ({
  customerId: ABC, item: 'TMT Steel Bar 12mm', quantity: '10', rate: '90', date, terms: 'now', requestId,
});

test('a bill dated before today is said on the review; after today or in an approved month it is refused', async () => {
  const owner = await signIn();
  const { bills } = await internals(owner);
  const bought = await request('POST', '/api/purchases/record', {
    supplierId: SHREE_RAM, reference: 'SRS-266', date: YESTERDAY,
    lines: [{ item: 'TMT Steel Bar 12mm', quantity: '100', rate: '64', gst: '1800' }],
  }, owner);
  assert.equal(bought.status, 200, JSON.stringify(bought.body));

  // Today: nothing extra to say.
  const todays = await request('POST', '/api/sales/preview', sale(TODAY, 'date-266-today'), owner);
  assert.equal(todays.status, 200, JSON.stringify(todays.body));
  assert.equal(todays.body.dateNotice, null);
  const issued = await request('POST', '/api/sales/record', sale(TODAY, 'date-266-today'), owner);
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  const todaysNumber = issued.body.invoice.number as string;

  // Yesterday: allowed, and said, including that a bill dated today already has an earlier number.
  const backdated = await request('POST', '/api/sales/preview', sale(YESTERDAY, 'date-266-yesterday'), owner);
  assert.equal(backdated.status, 200, JSON.stringify(backdated.body));
  assert.equal(
    backdated.body.dateNotice,
    `This bill will be dated 28 September 2026, which is before today, 29 September 2026. Bill ${todaysNumber} is already issued with the date 29 September 2026, so this bill will get a later number with an earlier date.`,
  );
  const recorded = await request('POST', '/api/sales/record', sale(YESTERDAY, 'date-266-yesterday'), owner);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  const kept = (await bills()).find((bill) => bill.number === recorded.body.invoice.number);
  assert.equal(kept.documentDate, YESTERDAY, 'the date the person saw on the review is the date on the bill');

  // Tomorrow: refused at the review and at Record, and nothing is kept or numbered.
  const before = (await bills()).length;
  for (const path of ['/api/sales/preview', '/api/sales/record']) {
    const refused = await request('POST', path, sale('2026-09-30', 'date-266-tomorrow'), owner);
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'SALE_DATE_AFTER_TODAY');
    assert.equal(refused.body.message, 'A bill cannot be dated after today. This one says 30 September 2026, and today is 29 September 2026. Date it today, or the day the goods left if that was earlier.');
  }
  assert.equal((await bills()).length, before, 'a refused date leaves no draft behind');

  // A month whose GST return is approved but not yet sent: allowed, and the review says the
  // return has to be approved again.
  const prepared = await request('POST', '/api/gst-returns/prepare', { period: '2026-08' }, owner);
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  const approved = await request('POST', '/api/gst-returns/approve', { period: '2026-08', note: 'checked' }, owner);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const intoApproved = await request('POST', '/api/sales/preview', sale('2026-08-20', 'date-266-august-approved'), owner);
  assert.equal(intoApproved.status, 200, JSON.stringify(intoApproved.body));
  assert.match(intoApproved.body.dateNotice, /^This bill will be dated 20 August 2026, which is before today, 29 September 2026\. The GST return for August 2026 is already approved without it, so that return will have to be reopened and approved again\./);
  const afterApproved = (await bills()).length;

  // Once the month's return has been downloaded for filing, a new bill dated in it is refused.
  const exported = await request('POST', '/api/gst-returns/export', { period: '2026-08', returnType: 'GSTR1' }, owner);
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  for (const path of ['/api/sales/preview', '/api/sales/record']) {
    const refused = await request('POST', path, sale('2026-08-20', 'date-266-august'), owner);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'SALE_DATE_MONTH_CLOSED');
    assert.equal(refused.body.message, 'This bill says 20 August 2026, but the GST return for August 2026 has already been downloaded for filing, so a new bill cannot be dated in that month. Date it today, 29 September 2026.');
  }
  assert.equal((await bills()).length, afterApproved, 'no draft and no number for the refused August bill');
});
