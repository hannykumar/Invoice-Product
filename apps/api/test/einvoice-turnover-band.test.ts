/**
 * Issue #236 — the turnover question has bands, and each fact that hangs off it reads the right one.
 *
 *  - The 30-day reporting limit is for ₹10 crore and above only (GSTN advisory, 5 November 2024).
 *  - E-invoicing is for a business that went over ₹5 crore in any year from 2017-18 on.
 *  - HSN digits (6 above ₹5 crore last year, 4 below) and sending a bill by itself on issue (#210)
 *    behave as before for each band.
 *  - An old yes/no answer is asked again rather than guessed.
 *
 * Every name, GST number and figure below is synthetic and belongs to nobody.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { saveTurnoverBand, type TurnoverBandAnswer } from './turnover-helper.ts';
import { sells, stockEverything } from './stock-helper.ts';
import { syntheticGstin } from '../../../packages/masters/src/fixtures.ts';
import { useFixedAppClock } from '../src/app-clock.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const COMPANY_A = '00000000-0000-4000-8000-000000000001';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  if (sells(method, path)) await stockEverything(sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const signIn = async (): Promise<string> => {
  const response = await request('POST', '/api/auth/login', { companyId: COMPANY_A, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' });
  assert.equal(response.status, 200);
  return response.body.sessionId as string;
};

const ensure = async (session: string, path: 'customers' | 'items', body: Record<string, unknown>, name: string): Promise<string> => {
  const catalogue = (await request('GET', '/api/catalogue', {}, session)).body;
  const existing = (path === 'customers' ? catalogue.customers : catalogue.items).find((row: { name: string }) => row.name === name);
  if (existing !== undefined) return existing.id as string;
  const created = await request('POST', `/api/${path}`, body, session);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return (created.body.customer?.id ?? created.body.item?.id) as string;
};

const registeredBuyer = (session: string) => ensure(session, 'customers', {
  legalName: 'Malabar Cement Stockists', registration: 'regular', gstin: syntheticGstin('32', 'AAFCM4321K'),
  line1: '9, Market Road', city: 'Kochi', pincode: '682011',
}, 'Malabar Cement Stockists');

/** Eight digits: fine for every band. */
const fullCodeItem = (session: string) => ensure(session, 'items', {
  name: 'GI Wire 8 gauge', kind: 'goods', hsnSac: '72172000', unit: 'KGS',
  taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'The rate our accountant uses for wire',
}, 'GI Wire 8 gauge');

/** Four digits: enough up to ₹5 crore, too short above it. */
const fourDigitItem = (session: string) => ensure(session, 'items', {
  name: 'Binding wire bundle', kind: 'goods', hsnSac: '7217', unit: 'KGS',
  taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'The rate our accountant uses for wire',
}, 'Binding wire bundle');

const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setTimeout(resolve, 50)); };

let sales = 0;
const sell = async (session: string, itemId: string, date: string) => {
  sales += 1;
  const customerId = await registeredBuyer(session);
  return request('POST', '/api/sales/record', {
    customerId, lines: [{ itemId, quantity: '10', rate: '100' }], date, terms: '30', reference: `band-236-${sales}`,
  }, session);
};

const statusOf = async (session: string, invoiceId: string) =>
  (await request('GET', '/api/einvoices/invoices', {}, session)).body.invoices.find((row: { id: string }) => row.id === invoiceId)?.eInvoiceStatus;

test('#236: ₹5 to ₹10 crore needs an e-invoice with no deadline; ₹10 crore and above has the 30-day one', async () => {
  const session = await signIn();
  await saveTurnoverBand(session, 'UNKNOWN'); // nothing is sent on issue while we set up the bill
  const bill = await sell(session, await fullCodeItem(session), '2026-09-27');
  assert.equal(bill.status, 200, JSON.stringify(bill.body));

  await saveTurnoverBand(session, '5_TO_10_CRORE');
  const middle = await request('POST', '/api/einvoices/preview', { invoice: bill.body.invoice.id }, session);
  assert.equal(middle.body.outcome, 'APPLICABLE');
  assert.equal(middle.body.reportableUntil, null, 'no "must be reported by" under ₹10 crore');
  assert.equal(middle.body.deadline.kind, 'NO_LIMIT');

  await saveTurnoverBand(session, '10_CRORE_AND_ABOVE');
  const large = await request('POST', '/api/einvoices/preview', { invoice: bill.body.invoice.id }, session);
  assert.equal(large.body.outcome, 'APPLICABLE');
  // Dated 27 September: the bill's own date is day 1, so day 30 is 26 October.
  assert.equal(large.body.reportableUntil, '2026-10-26');
  assert.equal(large.body.reportableUntilLabel, '26 Oct 2026');
});

test('#236: a ₹10 crore business is not sent a bill the portal will refuse, and is told what to do', async () => {
  const session = await signIn();
  await saveTurnoverBand(session, '10_CRORE_AND_ABOVE');
  // Issue #284 — such a bill is now refused at issue, before a number is used.
  const refusedAtIssue = await sell(session, await fullCodeItem(session), '2026-08-01');
  assert.notEqual(refusedAtIssue.status, 200);
  assert.equal(refusedAtIssue.body.code, 'SALE_EINVOICE_TOO_LATE');
  assert.match(refusedAtIssue.body.message, /portal would refuse it/);

  // A bill issued before the turnover was answered (so not sent), judged once it says ₹10 crore.
  await saveTurnoverBand(session, 'UNKNOWN');
  const old = await sell(session, await fullCodeItem(session), '2026-08-01');
  assert.equal(old.status, 200, JSON.stringify(old.body));
  await saveTurnoverBand(session, '10_CRORE_AND_ABOVE');

  const preview = await request('POST', '/api/einvoices/preview', { invoice: old.body.invoice.id }, session);
  assert.equal(preview.body.ready, false);
  assert.match(preview.body.message, /The last day to send it was 30 Aug 2026/);
  const refused = await request('POST', '/api/einvoices/register', { invoice: old.body.invoice.id }, session);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'EINVOICE_REPORTING_TIME_LIMIT_PASSED');

  // The same bill for a ₹5 to ₹10 crore business has no time limit and is sent.
  await saveTurnoverBand(session, '5_TO_10_CRORE');
  const sent = await request('POST', '/api/einvoices/register', { invoice: old.body.invoice.id }, session);
  assert.equal(sent.body.status, 'REGISTERED', JSON.stringify(sent.body));
});

const cases: readonly { band: TurnoverBandAnswer; sentByItself: boolean; fourDigitsAllowed: boolean }[] = [
  { band: 'UP_TO_5_CRORE', sentByItself: false, fourDigitsAllowed: true },
  { band: 'UP_TO_5_CRORE_EARLIER_ABOVE', sentByItself: true, fourDigitsAllowed: true },
  { band: '5_TO_10_CRORE', sentByItself: true, fourDigitsAllowed: false },
  { band: '10_CRORE_AND_ABOVE', sentByItself: true, fourDigitsAllowed: false },
  { band: 'UNKNOWN', sentByItself: false, fourDigitsAllowed: false },
];

for (const { band, sentByItself, fourDigitsAllowed } of cases) {
  test(`#236: ${band} — HSN digits and sending on issue`, async () => {
    const session = await signIn();
    await saveTurnoverBand(session, band);

    const bill = await sell(session, await fullCodeItem(session), '2026-09-27');
    assert.equal(bill.status, 200, JSON.stringify(bill.body));
    assert.equal(bill.body.eInvoice.expected, sentByItself);
    await settle();
    const status = await statusOf(session, bill.body.invoice.id);
    if (sentByItself) assert.equal(status, 'REGISTERED');
    else assert.notEqual(status, 'REGISTERED');

    const short = await sell(session, await fourDigitItem(session), '2026-09-27');
    if (fourDigitsAllowed) assert.equal(short.status, 200, JSON.stringify(short.body));
    else assert.match(JSON.stringify(short.body), /at least 6 digits/);
  });
}

test('#236: an old "yes" or "no" is kept, shown for what it was, and asked again — never guessed', async () => {
  const session = await signIn();
  const current = await request('GET', '/api/business-details', {}, session);

  // The old "yes": over ₹5 crore, but nothing said about ₹10 crore.
  await request('POST', '/api/business-details', { ...current.body.details, turnoverAbove5Crore: 'YES' }, session);
  const yes = (await request('GET', '/api/business-details', {}, session)).body.turnover;
  assert.equal(yes.band, null, 'no band is ticked');
  assert.equal(yes.askAgain, 'YES');
  const bill = await sell(session, await fullCodeItem(session), '2026-09-27');
  assert.equal(bill.body.eInvoice.expected, true, 'still sent by itself: over ₹5 crore is known');
  const preview = await request('POST', '/api/einvoices/preview', { invoice: bill.body.invoice.id }, session);
  assert.equal(preview.body.reportableUntil, null, 'no deadline asserted for a business that may be under ₹10 crore');
  assert.equal(preview.body.deadline.kind, 'UNKNOWN');
  assert.match(preview.body.deadline.message, /Business details/);

  // The old "no": ₹5 crore or less last year, but nothing said about the years before.
  await request('POST', '/api/business-details', { ...current.body.details, turnoverAbove5Crore: 'NO' }, session);
  const no = (await request('GET', '/api/business-details', {}, session)).body.turnover;
  assert.equal(no.band, null);
  assert.equal(no.askAgain, 'NO');
  const preview2 = await request('POST', '/api/einvoices/preview', { invoice: bill.body.invoice.id }, session);
  assert.equal(preview2.body.outcome, 'CANNOT_DECIDE');
  // Four HSN digits still do for last year under ₹5 crore.
  const short = await sell(session, await fourDigitItem(session), '2026-09-27');
  assert.equal(short.status, 200, JSON.stringify(short.body));

  // Picking a band settles it.
  const saved = await saveTurnoverBand(session, '5_TO_10_CRORE');
  assert.equal(saved.turnover.band, '5_TO_10_CRORE');
  assert.equal(saved.turnover.askAgain, null);
});

test('#236: an answer that is not one of the bands is refused in plain words', async () => {
  const session = await signIn();
  const current = await request('GET', '/api/business-details', {}, session);
  const refused = await request('POST', '/api/business-details', { ...current.body.details, turnoverBand: 'ABOUT_8_CRORE' }, session);
  assert.equal(refused.status, 422);
  assert.match(refused.body.message, /Choose one of the turnover answers/);
});
