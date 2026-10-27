/**
 * Issue #296 — a business on the composition scheme, end to end over the real routes: choosing the
 * scheme (previewed, then approved), a Bill of Supply with the Rule 5 words and no GST, other-state
 * sales refused, purchase GST going into cost, GSTR-1/3B refused, and CMP-08 booked once.
 *
 * The test order matters: the company starts as a regular taxpayer and each test moves it on.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { sells, stockEverything } from './stock-helper.ts';
import { forgetBusinessDetails } from '../src/business-details-application.ts';
import { useFixedAppClock } from '../src/app-clock.ts';
import { SAMPOORNA_VIEWER, signIn as signInAs } from './sign-in-helper.ts';

useFixedAppClock('2026-09-05T10:00:00.000Z');

const COMPANY_A = '00000000-0000-4000-8000-000000000001';
const LEGEND = 'Composition taxable person, not eligible to collect tax on supplies';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  if (sells(method, path)) await stockEverything(sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const owner = () => signInAs('owner@sampoorna.example.invalid', COMPANY_A);

const ADDRESS = {
  legalName: 'Sampoorna Traders', address1: 'No. 14, 2nd Main, Peenya Industrial Area', city: 'Bengaluru',
  pincode: '560058', stateCode: '29', phone: '080 4000 1234', pan: 'AAAAA0000A',
};
const sale = { party: 'ABC Traders', item: 'Herbal Bath Soap 100g', quantity: '4', rate: '250', date: '2026-09-05', terms: '30' };

const CHOICE = {
  scheme: 'COMPOSITION', effectiveFrom: '2026-09-05', category: 'MANUFACTURER_OR_TRADER', newlyRegistered: true,
  withinLimit: true, noInterState: true, noEcommerce: true, rateConfirmed: true, requestId: 'scheme-1',
};

test('a regular business shows as regular, and a viewer cannot change the scheme', async () => {
  const session = await owner();
  forgetBusinessDetails(COMPANY_A);
  assert.equal((await request('POST', '/api/business-details', ADDRESS, session)).status, 200);
  const read = await request('GET', '/api/composition/scheme', {}, session);
  assert.equal(read.status, 200);
  assert.equal(read.body.scheme, 'REGULAR');
  assert.equal(read.body.legend, LEGEND);

  const viewer = await signInAs(SAMPOORNA_VIEWER, COMPANY_A);
  const refused = await request('POST', '/api/composition/scheme/preview', CHOICE, viewer);
  assert.equal(refused.status, 403);
  assert.equal((await request('POST', '/api/composition/scheme', CHOICE, viewer)).status, 403);
  assert.equal((await request('GET', '/api/composition/scheme', {}, undefined)).status, 401);
});

test('the change is previewed in plain words first, and cannot be applied without the preview or with a stale one', async () => {
  const session = await owner();
  // Missing promises are listed, not silently accepted.
  const incomplete = await request('POST', '/api/composition/scheme/preview', { ...CHOICE, withinLimit: false, noEcommerce: false }, session);
  assert.equal(incomplete.status, 200);
  assert.equal(incomplete.body.ok, false);
  assert.equal(incomplete.body.token, null);
  assert.equal(incomplete.body.blockers.length, 2);

  // The suggested rate has not been checked against a notice, so it must be confirmed.
  const unconfirmed = await request('POST', '/api/composition/scheme/preview', { ...CHOICE, rateConfirmed: false }, session);
  assert.equal(unconfirmed.body.ok, false);
  assert.match(unconfirmed.body.blockers[0], /rate/);

  // A mid-year start needs "newly registered".
  const midYear = await request('POST', '/api/composition/scheme/preview', { ...CHOICE, newlyRegistered: false }, session);
  assert.equal(midYear.body.ok, false);
  assert.match(midYear.body.blockers.join(' '), /1 April/);

  const ok = await request('POST', '/api/composition/scheme/preview', CHOICE, session);
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body.blockers));
  assert.equal(typeof ok.body.token, 'string');
  assert.ok(ok.body.whatChanges.some((line: string) => /Bills of Supply/.test(line)));
  assert.ok(ok.body.warnings.some((line: string) => /ITC-03/.test(line)));
  // Previewing changes nothing.
  assert.equal((await request('GET', '/api/composition/scheme', {}, session)).body.scheme, 'REGULAR');

  const noToken = await request('POST', '/api/composition/scheme', CHOICE, session);
  assert.equal(noToken.status, 422);
  assert.equal(noToken.body.code, 'COMPOSITION_NOT_PREVIEWED');
  const stale = await request('POST', '/api/composition/scheme', { ...CHOICE, token: 'not-the-token' }, session);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'COMPOSITION_CHANGED_SINCE_PREVIEW');
  const noRequestId = await request('POST', '/api/composition/scheme', { ...CHOICE, requestId: '', token: ok.body.token }, session);
  assert.equal(noRequestId.status, 422);
});

test('applying it twice with one request id applies it once, and leaves an audit entry', async () => {
  const session = await owner();
  const preview = await request('POST', '/api/composition/scheme/preview', CHOICE, session);
  const applied = await request('POST', '/api/composition/scheme', { ...CHOICE, token: preview.body.token }, session);
  assert.equal(applied.status, 200, applied.body.message);
  assert.equal(applied.body.scheme, 'COMPOSITION');
  assert.equal(applied.body.deduplicated, false);
  assert.equal(applied.body.ratePercent, 1);
  assert.equal(applied.body.rateBasis, 'BUSINESS_DECLARED', 'the owner confirmed the usual rate, so it is recorded as theirs, not as checked law');
  const again = await request('POST', '/api/composition/scheme', { ...CHOICE, token: preview.body.token }, session);
  assert.equal(again.status, 200);
  assert.equal(again.body.deduplicated, true);
  assert.equal(again.body.history.length, 1);
  // Already on the scheme, on these terms: a second, different request is refused.
  const duplicate = await request('POST', '/api/composition/scheme/preview', { ...CHOICE, requestId: 'scheme-2', effectiveFrom: '2026-09-01' }, session);
  assert.equal(duplicate.body.ok, false);
});

test('a sale is a Bill of Supply from its own series, headed by the Rule 5 words, with no GST anywhere', async () => {
  const session = await owner();
  const recorded = await request('POST', '/api/sales/record', { ...sale, reference: 'bos-1', requestId: 'bos-1' }, session);
  assert.equal(recorded.status, 200, recorded.body.message);
  assert.match(String(recorded.body.invoice.number), /^BOS\/26-27\/0000\d\d$/);
  assert.equal(recorded.body.invoice.amount, 1000, 'four at ₹250: no GST is added');

  const printed = await request('POST', '/api/sales/print', { invoice: recorded.body.invoice.id }, session);
  assert.equal(printed.status, 200, printed.body.message);
  const html = String(printed.body.html);
  assert.ok(html.includes(LEGEND));
  assert.ok(html.includes('Bill of Supply'));
  assert.ok(!html.includes('Tax Invoice'));
  for (const gst of ['CGST', 'SGST', 'IGST']) assert.ok(!html.includes(gst), `no ${gst} on a bill of supply`);
  const body = html.slice(html.indexOf('<body'));
  assert.ok(body.indexOf(LEGEND) < body.indexOf(String(recorded.body.invoice.number)), 'the words are at the top');

  // Pressing record again with the same id gives the same bill, not a second number.
  const again = await request('POST', '/api/sales/record', { ...sale, reference: 'bos-1', requestId: 'bos-1' }, session);
  assert.equal(again.body.invoice.number, recorded.body.invoice.number);
});

test('a sale to a customer in another state is refused, in words, and uses no number', async () => {
  const session = await owner();
  const customer = await request('POST', '/api/customers', {
    legalName: 'Delhi Polymers', registration: 'regular', gstin: '07EEEEE4444E1ZG', line1: 'Plot 7, Bawana Industrial Area',
    city: 'New Delhi', pincode: '110039', phone: '9811100022',
  }, session);
  const customerId = customer.status === 200
    ? customer.body.customer.id
    : (await request('GET', '/api/catalogue', {}, session)).body.customers.find((c: { name: string }) => c.name === 'Delhi Polymers').id;
  const item = (await request('GET', '/api/catalogue', {}, session)).body.items.find((i: { kind: string }) => i.kind === 'goods');
  const refused = await request('POST', '/api/sales/record', {
    customerId, lines: [{ itemId: item.id, quantity: '2', rate: '100' }], date: '2026-09-05', terms: '30', reference: 'bos-other-state', requestId: 'bos-other-state',
  }, session);
  assert.notEqual(refused.status, 200);
  assert.match(JSON.stringify(refused.body), /composition scheme/);
  assert.match(JSON.stringify(refused.body), /another state/);
});

test('a purchase bill puts its GST into cost: nothing is claimed back', async () => {
  const session = await owner();
  const preview = await request('POST', '/api/purchases/preview', {
    supplierId: 'sampoorna:party:supplier', reference: 'COMP-BUY-1', date: '2026-09-05',
    lines: [{ item: 'TMT Steel Bar 12mm', quantity: '1', rate: '1000', gst: '1800' }],
  }, session);
  assert.equal(preview.status, 200, preview.body.message);
  assert.match(JSON.stringify(preview.body), /composition scheme/);
  const recorded = await request('POST', '/api/purchases/record', {
    supplierId: 'sampoorna:party:supplier', reference: 'COMP-BUY-1', date: '2026-09-05',
    lines: [{ item: 'TMT Steel Bar 12mm', quantity: '1', rate: '1000', gst: '1800' }],
  }, session);
  assert.equal(recorded.status, 200, recorded.body.message);
  // The supplier is still owed the whole ₹1,180, but none of its GST is booked as credit to claim.
  assert.equal(recorded.body.bill.total, 1180);
  assert.equal(recorded.body.bill.cgst + recorded.body.bill.sgst + recorded.body.bill.igst, 0);
  assert.equal(recorded.body.purchaseCheck.outcome, 'BLOCKED_IN_BOOKS');
});

test('GSTR-1 and GSTR-3B are refused for a composition month, pointing to CMP-08', async () => {
  const session = await owner();
  for (const path of ['/api/gst-returns', '/api/gst-returns/prepare', '/api/gst-returns/approve', '/api/gst-returns/export']) {
    const refused = await request('POST', path, { period: '2026-10', returnType: 'GSTR1' }, session);
    assert.equal(refused.status, 422, `${path}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.code, 'GST_RETURN_NOT_FOR_COMPOSITION');
    assert.match(refused.body.message, /CMP-08/);
  }
  // September is the month the business moved to the scheme (on the 5th): one return cannot cover it.
  const mixed = await request('POST', '/api/gst-returns', { period: '2026-09' }, session);
  assert.equal(mixed.status, 422);
  assert.equal(mixed.body.code, 'GST_RETURN_MIXED_SCHEME_MONTH');
  // August, before the change, is an ordinary month and still prepares as before.
  const before = await request('POST', '/api/gst-returns', { period: '2026-08' }, session);
  assert.equal(before.status, 200, JSON.stringify(before.body).slice(0, 200));
});

test('CMP-08 for the quarter is worked out from the bills, approved against a token, and booked once', async () => {
  const session = await owner();
  const list = await request('POST', '/api/composition/statements', {}, session);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.onComposition, true);
  const quarter = list.body.quarters.find((q: { quarterKey: string }) => q.quarterKey === '2026-27-Q2');
  assert.ok(quarter, 'July–September 2026 is the running quarter');
  assert.equal(quarter.dueDate, '2026-10-18');
  assert.equal(quarter.ratePercent, 1);
  assert.equal(quarter.state, 'NOT_BOOKED');
  // ₹1,000 of bills of supply today at 1%: ₹10, half central and half State.
  assert.equal(quarter.taxableTurnover, '100000');
  assert.equal(quarter.totalPayable, '1000');
  assert.equal(quarter.centralTax, '500');
  assert.equal(quarter.stateTax, '500');

  const noToken = await request('POST', '/api/composition/approve', { quarter: '2026-27-Q2' }, session);
  assert.equal(noToken.status, 422);
  const stale = await request('POST', '/api/composition/approve', { quarter: '2026-27-Q2', token: 'old' }, session);
  assert.equal(stale.status, 409);

  const approved = await request('POST', '/api/composition/approve', { quarter: '2026-27-Q2', token: quarter.fingerprint }, session);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.state, 'BOOKED');
  assert.equal(approved.body.alreadyBooked, '1000');
  // The same approval pressed again books nothing more.
  const twice = await request('POST', '/api/composition/approve', { quarter: '2026-27-Q2', token: quarter.fingerprint }, session);
  assert.equal(twice.status, 200);
  assert.equal(twice.body.alreadyBooked, '1000');

  // A viewer may look but not approve.
  const viewer = await signInAs(SAMPOORNA_VIEWER, COMPANY_A);
  assert.equal((await request('POST', '/api/composition/approve', { quarter: '2026-27-Q2', token: quarter.fingerprint }, viewer)).status, 403);
});

test('a bill added after approval is shown as a change, and approving again books only the difference', async () => {
  const session = await owner();
  const more = await request('POST', '/api/sales/record', { ...sale, reference: 'bos-2', requestId: 'bos-2' }, session);
  assert.equal(more.status, 200, more.body.message);
  const quarter = (await request('POST', '/api/composition/statement', { quarter: '2026-27-Q2' }, session)).body;
  assert.equal(quarter.state, 'CHANGED_AFTER_BOOKING');
  assert.equal(quarter.alreadyBooked, '1000');
  assert.equal(quarter.totalPayable, '2000');
  assert.equal(quarter.stillToBook, '1000');
  const approved = await request('POST', '/api/composition/approve', { quarter: '2026-27-Q2', token: quarter.fingerprint }, session);
  assert.equal(approved.body.state, 'BOOKED');
  assert.equal(approved.body.alreadyBooked, '2000');
});

test('filing is recorded only after approval, with the portal reference', async () => {
  const session = await owner();
  const bad = await request('POST', '/api/composition/filed', { quarter: '2026-27-Q2', reference: 'x' }, session);
  assert.equal(bad.status, 422);
  const filed = await request('POST', '/api/composition/filed', { quarter: '2026-27-Q2', reference: 'AA2910260000123', filedOn: '2026-10-10' }, session);
  assert.equal(filed.status, 200, JSON.stringify(filed.body));
  assert.equal(filed.body.state, 'FILED');
  const again = await request('POST', '/api/composition/filed', { quarter: '2026-27-Q2', reference: 'AA2910260000123' }, session);
  assert.equal(again.status, 409);
  const notYet = await request('POST', '/api/composition/filed', { quarter: '2026-27-Q1', reference: 'AA2910260000999' }, session);
  assert.equal(notYet.status, 422, 'a quarter with nothing approved cannot be marked filed');
});

test('GSTR-4 adds the quarters and compares them with what was booked', async () => {
  const session = await owner();
  const yearly = await request('POST', '/api/composition/yearly', { financialYear: '2026-27' }, session);
  assert.equal(yearly.status, 200, JSON.stringify(yearly.body));
  assert.equal(yearly.body.dueDate, '2027-06-30');
  assert.equal(yearly.body.taxPayable, '2000');
  assert.equal(yearly.body.taxBooked, '2000');
  assert.equal(yearly.body.difference, '0');
  assert.equal(yearly.body.quarters.length, 4);
  assert.ok(yearly.body.notes.length > 0);
});

test('leaving the scheme: tax invoices again from the new date, and the old bills stay bills of supply', async () => {
  const session = await owner();
  const leave = { scheme: 'REGULAR', effectiveFrom: '2026-10-01', requestId: 'scheme-leave' };
  const early = await request('POST', '/api/composition/scheme/preview', { ...leave, effectiveFrom: '2026-08-01' }, session);
  assert.equal(early.body.ok, false, 'a date before the last change, or covering issued bills, is refused');
  assert.match(early.body.blockers.join(' '), /bill/);
  const preview = await request('POST', '/api/composition/scheme/preview', leave, session);
  assert.equal(preview.body.ok, true, JSON.stringify(preview.body.blockers));
  assert.ok(preview.body.warnings.some((line: string) => /ITC-01/.test(line)));
  const applied = await request('POST', '/api/composition/scheme', { ...leave, token: preview.body.token }, session);
  assert.equal(applied.status, 200, applied.body.message);
  // Today (5 Sep) is still inside the scheme, so a bill dated today is still a bill of supply.
  const today = await request('POST', '/api/sales/record', { ...sale, reference: 'bos-3', requestId: 'bos-3' }, session);
  assert.match(String(today.body.invoice.number), /^BOS\//);
  assert.equal((await request('GET', '/api/composition/scheme', {}, session)).body.history.length, 2);
});
