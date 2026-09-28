/**
 * Issue #256 — a sale the app refused, or a review replaced by a later one, is not "a bill waiting".
 *
 * Found by the full trade check (#242): after 600 KGS was refused with 50 KGS in the godown, Reports
 * said "1 bill is waiting and has not been given to anyone yet". There was no such bill: it was the
 * draft the refused review had left behind. A bill held back on purpose — sent for approval — is
 * still reported, and none of this touches the bill numbers.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { useFixedAppClock } from '../src/app-clock.ts';
import { apiRuntime } from '../src/runtime.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const SHREE_RAM = 'sampoorna:party:supplier';
const DATE = '2026-09-27';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const signIn = async (): Promise<string> => {
  const response = await request('POST', '/api/auth/login', { companyId: SAMPOORNA, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' });
  assert.equal(response.status, 200);
  return response.body.sessionId as string;
};

const waiting = async (owner: string) =>
  (await request('GET', '/api/reports', {}, owner)).body.exceptions.items.filter((item: any) => item.code === 'BILL_STUCK_BEFORE_ISSUE');

const billNumbers = async (owner: string): Promise<string[]> =>
  ((await request('GET', '/api/reports', {}, owner)).body.sales.rows ?? []).map((row: any) => row.number).sort();

/** The sales service and its store behind the running app, to look at what is really kept. */
const internals = async (owner: string) => {
  const runtime = apiRuntime();
  const context = runtime.authenticate(`Bearer ${owner}`);
  const app = await runtime.application(context) as any;
  return { app, actor: runtime.actor(context), unissued: async () => (await app.salesRepository.list(runtime.actor(context).companyId)).filter((invoice: any) => invoice.state !== 'FINAL' && invoice.state !== 'CANCELLED') };
};

test('refused, replaced and issued reviews leave nothing waiting; a bill held for approval still does', async () => {
  const owner = await signIn();
  const { app, actor, unissued } = await internals(owner);
  assert.deepEqual(await waiting(owner), [], 'a fresh company has nothing waiting');
  const numbersBefore = await billNumbers(owner);

  const bought = await request('POST', '/api/purchases/record', {
    supplierId: SHREE_RAM, reference: 'SRS-256', date: DATE,
    lines: [{ item: 'TMT Steel Bar 12mm', quantity: '50', rate: '64', gst: '1800' }],
  }, owner);
  assert.equal(bought.status, 200, JSON.stringify(bought.body));
  const customer = await request('POST', '/api/customers', {
    legalName: 'Mehta Construction Supplies', registration: 'regular', gstin: '27AAACM1234K1ZN',
    line1: 'Plot 22, MIDC Bhosari', city: 'Pune', pincode: '411026',
  }, owner);
  assert.equal(customer.status, 200, JSON.stringify(customer.body));
  const sale = (quantity: string, requestId: string, replaces?: string) => ({
    customerId: customer.body.customer.id, item: 'TMT Steel Bar 12mm', quantity, rate: '90',
    date: DATE, terms: '30', requestId, ...(replaces === undefined ? {} : { replaces }),
  });

  // 1. 600 KGS with 50 KGS in the godown: refused at the review and again at Record. Nothing is kept.
  for (const path of ['/api/sales/preview', '/api/sales/record']) {
    const refused = await request('POST', path, sale('600', 'review-256-too-much'), owner);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'SALES_STOCK_NOT_ENOUGH');
  }
  assert.deepEqual(await waiting(owner), [], 'the refused sale is not "a bill waiting"');
  assert.deepEqual(await unissued(), [], 'no draft of the refused sale is stored');
  assert.deepEqual(await billNumbers(owner), numbersBefore, 'no bill number was used');

  // 2. Three reviews of the same sale form (10, then 20, then 30 KGS), then Record: one bill, nothing left over.
  const first = await request('POST', '/api/sales/preview', sale('10', 'review-256-a'), owner);
  const second = await request('POST', '/api/sales/preview', sale('20', 'review-256-b', 'review-256-a'), owner);
  const third = await request('POST', '/api/sales/preview', sale('30', 'review-256-c', 'review-256-b'), owner);
  for (const review of [first, second, third]) assert.equal(review.status, 200, JSON.stringify(review.body));
  assert.equal((await unissued()).length, 1, 'only the latest review is kept while the form is open');
  const recorded = await request('POST', '/api/sales/record', sale('30', 'review-256-c', 'review-256-b'), owner);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.deepEqual(await unissued(), [], 'the replaced reviews are gone and the last one is the issued bill');
  assert.deepEqual(await waiting(owner), []);
  const numbersAfter = await billNumbers(owner);
  assert.equal(numbersAfter.length, numbersBefore.length + 1);
  const last = Number(String(numbersBefore.at(-1)).split('/').pop());
  assert.equal(recorded.body.invoice.number, `INV/26-27/${String(last + 1).padStart(6, '0')}`, 'the next number, with no gap');

  // 3. A review corrected after a refusal: the refused one was already forgotten, the new one is issued.
  const tooMuch = await request('POST', '/api/sales/preview', sale('600', 'review-256-d', 'review-256-c'), owner);
  assert.equal(tooMuch.status, 409);
  const corrected = await request('POST', '/api/sales/record', sale('5', 'review-256-e', 'review-256-d'), owner);
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
  assert.equal(corrected.body.invoice.number, `INV/26-27/${String(last + 2).padStart(6, '0')}`);
  assert.deepEqual(await unissued(), []);

  // 4. Someone else's review key cannot be used to throw away their review.
  const other = await app.sales.createDraft({ ...actor, userId: 'someone-else' }, {
    idempotencyKey: 'web-sale:review-256-theirs',
    input: app.saleInput(sale('1', 'review-256-theirs')),
  });
  await request('POST', '/api/sales/preview', sale('1', 'review-256-f', 'review-256-theirs'), owner);
  assert.notEqual(await app.salesRepository.findById(actor.companyId, other.id), null, 'another person\'s review is left alone');
  await app.sales.discardDraft(actor, other.id, 'test tidy-up');

  // 5. A bill deliberately held back for approval is still reported, once.
  const draft = await app.sales.createDraft(actor, { idempotencyKey: 'held-256', input: app.saleInput(sale('2', 'held-256')) });
  const held = await app.sales.submitForApproval(actor, draft.id);
  assert.equal(held.state, 'PENDING_APPROVAL');
  const found = await waiting(owner);
  assert.equal(found.length, 1);
  assert.match(found[0].what['en-IN'], /^1 bill is waiting/);
  // And a later review of a sale form cannot throw it away, even by naming it.
  await request('POST', '/api/sales/preview', sale('1', 'review-256-g', 'held-256'), owner);
  assert.equal((await waiting(owner)).length, 1);
});
