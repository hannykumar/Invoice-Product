/**
 * Issue #238 — the permanent full trade check (#242), run through the app on every pull request.
 *
 * `docs/checks/full-trade-check.md` is the written check: twelve steps of one whole trade, from
 * buying 500 kg of steel to filing September's GST, with every figure the screens must show. This
 * file runs the same trade, in the same order, with the same inputs, against the web server started
 * here in this process and reached over HTTP — the requests are the ones the screens send, field for
 * field — and after each step asserts the document's figures to the paisa.
 *
 * Rules (from #238 and #242):
 *
 * - The document is the reference. When the two disagree, both are fixed in the same pull request;
 *   an expected figure is never loosened to match the app.
 * - A step that fails because an open issue is not fixed yet is marked `{ todo: '#NNN' }`. It still
 *   runs; the fix for that issue removes its own `todo`. No step is skipped or deleted.
 * - The clock is fixed at 27 Sep 2026, 10:00 in India, so the dates below do not move with the day
 *   the test is run. The running app reads the real clock (#234); only this process is pinned.
 *
 * Every name, GST number, address and sign-in below is the synthetic demo company's.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { useFixedAppClock } from '../../apps/api/src/app-clock.ts';
import { webServer } from '../../apps/web/server.ts';

// 27 Sep 2026, 10:00 in India is 04:30 UTC.
useFixedAppClock('2026-09-27T04:30:00.000Z');

const TODAY = '2026-09-27';
const MONTH = '2026-09';
const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const SHREE_RAM_GSTIN = '27AAECS5678D1Z4';
const MEHTA = 'Mehta Construction Supplies';
const ABC = 'ABC Traders';
const STEEL = 'TMT Steel Bar 12mm';

// ---------------------------------------------------------------------------------------------
// Money, to the paisa. The app answers in rupees as JSON numbers; every figure here is compared as
// a whole number of paise, and a figure carrying a fraction of a paisa fails on its own.

const paise = (amount: unknown): number => {
  assert.equal(typeof amount, 'number', `expected an amount, got ${JSON.stringify(amount)}`);
  const value = Number(amount) * 100;
  const whole = Math.round(value);
  assert.ok(Math.abs(value - whole) < 1e-6, `${String(amount)} is not a whole number of paise`);
  return whole;
};
/** "₹5,760.00" as written in the check document, in paise. */
const rs = (written: string): number => Math.round(Number(written.replace(/[₹,]/g, '')) * 100);
/** For the printed step lines: ₹50,150.00. */
const inr = (amount: number): string => `₹${amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const assertRupees = (actual: unknown, written: string, what: string) =>
  assert.equal(paise(actual), rs(written), `${what}: expected ${written}, got ${String(actual)}`);

// ---------------------------------------------------------------------------------------------
// The app, over HTTP.

let base = '';
let session = '';

before(async () => {
  await new Promise<void>((resolve) => webServer.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(webServer.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => webServer.close(() => resolve()));
});

interface Reply { readonly status: number; readonly body: Record<string, any>; }

const call = async (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<Reply> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(session === '' ? {} : { authorization: `Bearer ${session}` }) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
};

/** A request the step needs to succeed; anything else fails the step with the app's own words. */
const ok = async (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<Record<string, any>> => {
  const reply = await call(method, path, body);
  assert.equal(reply.status, 200, `${method} ${path} → ${reply.status}: ${JSON.stringify(reply.body)}`);
  return reply.body;
};

const reports = () => ok('GET', '/api/reports');
const home = () => ok('GET', '/api/dashboard');
const steelRows = async () => (await reports()).stock.rows.filter((row: any) => row.item === STEEL);
const receivable = async (party: string) => (await reports()).dues.receivables.rows.find((row: any) => row.party === party);

/** The printed page as text, so a check reads like the paper does. */
const pageText = (html: string): string => html
  .replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<svg[\s\S]*?<\/svg>/g, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ');

/** What the trade has made so far, carried from one step to the next. */
const trade: {
  supplierId: string; itemId: string; purchaseId: string;
  mehtaId: string; invoiceId: string; invoiceNumber: string; salesBefore: number;
  ewayBillNumber: string; noteId: string; noteNumber: string;
} = {
  supplierId: '', itemId: '', purchaseId: '', mehtaId: '', invoiceId: '', invoiceNumber: '', salesBefore: 0,
  ewayBillNumber: '', noteId: '', noteNumber: '',
};

// ---------------------------------------------------------------------------------------------

test('Before the trade: Sampoorna Traders, three old bills to ABC Traders (₹1,838 owed) and no steel', async (t) => {
  const signedIn = await call('POST', '/api/auth/login', { companyId: SAMPOORNA, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  session = signedIn.body.sessionId as string;
  assert.equal(signedIn.body.company.name, 'Sampoorna Traders');

  const business = await ok('GET', '/api/business-details');
  assert.match(JSON.stringify(business), /29AAAAA0000A1ZY/);

  const books = await reports();
  const abc = books.dues.receivables.rows.find((row: any) => row.party === ABC);
  // ₹1,050 + ₹525 + ₹263 = ₹1,838
  assertRupees(abc.outstanding, '₹1,838.00', 'ABC Traders owes');
  assertRupees(books.dues.receivables.total, '₹1,838.00', 'customers owe');
  assert.deepEqual((await home()).customer.documents.map((bill: any) => paise(bill.outstanding)), [rs('₹1,050'), rs('₹525'), rs('₹263')]);
  // No steel in the godown: Reports has no line for it yet, and Home shows 0.
  assert.deepEqual((books.stock.rows as any[]).filter((row) => row.item === STEEL && row.closing !== '0.000'), []);
  assert.equal((await home()).stockItems.find((item: any) => item.name === STEEL).quantity, 0);
  trade.salesBefore = books.sales.rows?.length ?? 0;

  const catalogue = await ok('GET', '/api/catalogue');
  const supplier = catalogue.suppliers.find((row: any) => row.gstin === SHREE_RAM_GSTIN);
  const item = catalogue.items.find((row: any) => row.name === STEEL);
  assert.ok(supplier, 'Shree Ram Steels is in the supplier list');
  assert.ok(item, 'the steel is in the item list');
  trade.supplierId = supplier.id;
  trade.itemId = item.id;
  t.diagnostic(`ABC Traders owes ${inr(abc.outstanding)}; steel in stock 0`);
});

test('Step 1. Buy 500 KGS at ₹64 from Shree Ram Steels (Maharashtra): IGST ₹5,760, total ₹37,760, stock 500 KGS', async (t) => {
  // What the Purchase screen sends: the supplier from the list, their bill, and the lines. No state.
  const purchase = {
    supplierId: trade.supplierId, reference: 'SRS-101', date: TODAY, amount: '37760',
    lines: JSON.stringify([{ itemId: trade.itemId, quantity: '500', unit: 'KGS', rate: '64', gst: '1800' }]),
  };
  const preview = await ok('POST', '/api/purchases/preview', purchase);
  assert.equal(preview.taxType, 'IGST', 'the two GST numbers say another state, so IGST');
  assert.ok(preview.effects.includes('The supplier is in Maharashtra (27) and your godown is in Karnataka (29), so the bill carries IGST.'), preview.effects.join('\n'));
  // 500 × ₹64 = ₹32,000; 18% of ₹32,000 = ₹5,760
  assert.ok(preview.effects.includes(`${STEEL}: 500.000 KGS × ₹64.00 = ₹32,000.00, IGST 18% = ₹5,760.00`), preview.effects.join('\n'));
  assertRupees(preview.tax.igst, '₹5,760.00', 'IGST');
  assertRupees(preview.tax.cgst, '₹0.00', 'CGST');
  assertRupees(preview.tax.sgst, '₹0.00', 'SGST');
  assertRupees(preview.amount, '₹37,760.00', 'bill total');

  const recorded = await ok('POST', '/api/purchases/record', purchase);
  trade.purchaseId = recorded.bill.id;
  assert.equal(recorded.bill.supplier, 'Shree Ram Steels Private Limited');
  assertRupees(recorded.bill.taxable, '₹32,000.00', 'goods');
  assertRupees(recorded.bill.igst, '₹5,760.00', 'IGST');
  // ₹32,000 + ₹5,760 = ₹37,760, which matches the bill
  assertRupees(recorded.bill.total, '₹37,760.00', 'total');

  assert.deepEqual((await steelRows()).map((row: any) => row.closing), ['500.000']);
  const payables = (await reports()).dues.payables;
  assertRupees(payables.total, '₹37,760.00', 'owed to suppliers');
  t.diagnostic(`purchase SRS-101: goods ${inr(recorded.bill.taxable)}, IGST ${inr(recorded.bill.igst)}, total ${inr(recorded.bill.total)}; stock 500 KGS; owed to supplier ${inr(payables.total)}`);
});

test('Step 2. Add Mehta Construction Supplies: the state is Maharashtra (27), from the GST number', async (t) => {
  const added = await ok('POST', '/api/customers', {
    legalName: MEHTA, registration: 'regular', gstin: '27AAACM1234K1ZN',
    line1: 'Plot 22, MIDC Bhosari', city: 'Pune', pincode: '411026',
  });
  trade.mehtaId = added.customer.id;
  assert.equal(added.customer.stateCode, '27');
  assert.equal(added.customer.stateName, 'Maharashtra');
  t.diagnostic(`Mehta added: ${added.customer.stateName} (${added.customer.stateCode})`);
});

/** The Sale screen's request: the customer, the lines as typed, the freight and the vehicle. */
const saleInput = (quantity: string, requestId: string) => ({
  party: trade.mehtaId, date: TODAY, terms: '30',
  lines: JSON.stringify([{ itemId: trade.itemId, quantity, unit: 'KGS', rate: '90' }]),
  freight: '2000', otherCharges: '', shipTo: 'same', vehicleNumber: 'KA01AB1234', requestId,
});

test('Step 3. Sell 450 KGS at ₹90 with ₹2,000 freight: ₹42,500 + IGST ₹7,650 = ₹50,150; stock 50 KGS; Home ₹51,988', async (t) => {
  const sale = saleInput('450', 'full-trade-238-sale');
  const review = await ok('POST', '/api/sales/preview', sale);
  // 450 × ₹90 = ₹40,500; plus freight ₹2,000 = ₹42,500; 18% = ₹7,650; total ₹50,150
  assert.equal(review.message, 'This sale counts in Maharashtra (27), so one combined GST applies. GST of ₹7,650.00 has been added to ₹42,500.00, and the bill comes to ₹50,150.00.');
  assertRupees(review.amount, '₹50,150.00', 'bill total');
  assert.deepEqual(review.chargeLines.map((line: any) => [line.kind, paise(line.taxableValue), paise(line.gst)]), [['FREIGHT', rs('₹2,000'), rs('₹360')]]);
  // Needs an e-way bill: across a state border and over ₹50,000.
  assert.equal(review.ewayBill.outcome, 'REQUIRED');
  assert.equal(review.ewayBill.ruleId, 'EWB.THRESHOLD.INTER_STATE');
  // No credit-limit warning: nobody set a limit for Mehta (#235).
  assert.equal(review.terms.credit.outcome, 'ALLOW');
  assert.equal(review.terms.credit.limit, null);

  const recorded = await ok('POST', '/api/sales/record', sale);
  trade.invoiceId = recorded.invoice.id;
  trade.invoiceNumber = recorded.invoice.number;
  assertRupees(recorded.invoice.amount, '₹50,150.00', 'bill total');
  assert.ok(trade.invoiceNumber.length <= 16, `${trade.invoiceNumber} is ${trade.invoiceNumber.length} characters; the government allows 16`);
  assert.match(trade.invoiceNumber, /^INV\/26-27\/\d{6}$/);
  // The "Sale recorded" dialog knows these goods need an e-way bill, and offers it (#240).
  assert.equal(recorded.ewayBill.outcome, 'REQUIRED');

  // Stock: 500 − 450 = 50 KGS (#229)
  assert.deepEqual((await steelRows()).map((row: any) => row.closing), ['50.000']);

  // Home: the bill under Mehta's name; customers owe ₹1,838 + ₹50,150 = ₹51,988 (#237)
  const screen = await home();
  assert.ok(screen.activity.some((row: any) => row.id === trade.invoiceId && row.title === `${trade.invoiceNumber} · ${MEHTA}`));
  assertRupees(screen.metrics.customersOwe, '₹51,988.00', 'Home: money customers owe you');
  assertRupees((await reports()).dues.receivables.total, '₹51,988.00', 'Reports: customers owe');

  // The sale form is emptied by the page itself after Record once (#233): the bundle this server
  // hands the browser resets the form as soon as a bill comes back.
  const bundle = await (await fetch(`${base}/app.js`)).text();
  assert.match(bundle, /if \(form\.dataset\.draft === "sale" && result\.invoice\) resetSaleForm\(form\);/);
  t.diagnostic(`bill ${trade.invoiceNumber} (${trade.invoiceNumber.length} characters): ${inr(recorded.invoice.amount)}; stock 50 KGS; Home owed ${inr(screen.metrics.customersOwe)}`);
});

test('Step 3 (e-invoice line). The sale review says whether this bill needs an e-invoice', async (t) => {
  // Sampoorna has not answered the turnover question in Business details, so the app cannot tell
  // and says so, pointing to Business details — it never guesses (#239).
  const review = await ok('POST', '/api/sales/preview', saleInput('1', 'full-trade-238-einvoice-question'));
  assert.equal(review.eInvoice.needed, 'UNKNOWN');
  assert.equal(review.eInvoice.askTurnover, true, 'with a button to Business details');
  assert.equal(review.eInvoice.message, "We don't know yet whether you need e-invoices: Business details does not say whether your turnover has been over ₹5 crore. Answer once in Business details. This bill can still be issued now.");
  t.diagnostic(`e-invoice line: "${review.eInvoice.message}"`);
});

test('Step 4. Selling 600 KGS with 50 KGS in stock is refused, and no bill number is used up', async (t) => {
  for (const path of ['/api/sales/preview', '/api/sales/record']) {
    const refused = await call('POST', path, saleInput('600', 'full-trade-238-too-much'));
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'SALES_STOCK_NOT_ENOUGH');
    assert.equal(refused.body.message, `You have 50 KGS of ${STEEL} in Bengaluru · Peenya godown. This bill asks for 600 KGS.`);
  }
  assert.deepEqual((await steelRows()).map((row: any) => row.closing), ['50.000']);
  // Only one new bill is in the books; step 11 also shows September's numbers run from and to the one bill.
  const numbers = ((await reports()).sales.rows ?? []).map((row: any) => row.number);
  assert.equal(numbers.length, trade.salesBefore + 1, numbers.join(', '));
  t.diagnostic('600 KGS refused: "You have 50 KGS … This bill asks for 600 KGS."');
});

test('Step 4 (nothing left behind). The refused review leaves no "bill waiting" in Reports', async () => {
  const findings = (await reports()).exceptions.items.map((item: any) => item.code);
  assert.equal(findings.includes('BILL_STUCK_BEFORE_ISSUE'), false, findings.join(', '));
});

test('Step 5. The printed A4 bill carries every field the document lists', async (t) => {
  const printed = await ok('POST', '/api/sales/print', { invoice: trade.invoiceId, format: 'A4', locale: 'en-IN' });
  const paper = pageText(printed.html);
  const wanted = [
    'Tax Invoice', 'ORIGINAL FOR RECIPIENT',
    // Our name, full address with PIN, GST number, PAN, phone and email
    'Sampoorna Traders', 'Bengaluru 560058', 'Karnataka (29)', '29AAAAA0000A1ZY', 'AAAAA0000A', '080 4000 1234', 'billing@sampoorna.example.invalid',
    // Bill number, date, due date (27 Sep + 30 days), vehicle, place of supply, reverse charge
    trade.invoiceNumber, 'Invoice Date 27 September 2026', 'Due Date 27 October 2026', 'Vehicle No. KA01AB1234',
    'Place of Supply Maharashtra (27)', 'Reverse Charge No',
    // Buyer and ship-to
    'Buyer (Bill to) Mehta Construction Supplies Plot 22, MIDC Bhosari Pune 411026 Maharashtra (27) GSTIN 27AAACM1234K1ZN',
    'Consignee (Ship to) Mehta Construction Supplies Plot 22, MIDC Bhosari Pune 411026 Maharashtra (27) GSTIN 27AAACM1234K1ZN',
    // The line, then the freight
    'TMT Steel Bar 12mm 72142090 450 ₹90.00 KGS 18% ₹40,500.00', 'Freight 18% ₹2,000.00',
    // Taxable, IGST, total and the total in words
    'Total Taxable Value ₹42,500.00', 'IGST ₹7,650.00', 'Total ₹50,150.00', 'Rupees fifty thousand one hundred and fifty only',
    // HSN summary
    'HSN / SAC Summary', '72142090 ₹42,500.00 18% ₹7,650.00',
    'for Sampoorna Traders', 'Authorised Signatory',
  ];
  const missing = wanted.filter((text) => !paper.includes(text));
  assert.deepEqual(missing, [], `missing from the printed bill:\n${missing.join('\n')}`);
  t.diagnostic(`A4 bill ${trade.invoiceNumber}: all ${wanted.length} listed fields present, due 27 October 2026, vehicle KA01AB1234`);
});

test('Step 6 (filled from the bill, #240). Choosing the bill fills the parties, Pune 411026, the goods and KA01AB1234; the distance is left to the portal', async (t) => {
  // The "Sale recorded" dialog offers the e-way bill in one press, because these goods need one.
  const bills = await ok('GET', '/api/eway/bills');
  const first = bills.invoices[0];
  assert.equal(first.id, trade.invoiceId, 'a bill that needs an e-way bill and has none is listed first');
  assert.deepEqual([first.number, first.customer, paise(first.amount), first.label], [trade.invoiceNumber, MEHTA, rs('₹50,150'), 'needs one']);

  // Only the bill is chosen: nothing is typed.
  const opened = await ok('POST', '/api/eway/for-bill', { invoice: trade.invoiceId });
  assert.equal(opened.raised, null);
  assert.deepEqual(opened.form, {
    invoice: trade.invoiceId, reason: 'SUPPLY', shipToState: '27', shipToAddress: 'Plot 22, MIDC Bhosari',
    shipToPlace: 'Pune', shipToPincode: '411026', distanceKm: '', vehicle: 'KA01AB1234',
  });
  const check = opened.check;
  assert.deepEqual(check.problems, [], 'no complaint about freight or anything else (#231)');
  assert.equal(check.outcome, 'REQUIRED');
  assert.equal(check.ready, true);
  assert.equal(check.vehicleReady, true, 'KA01AB1234 comes from the bill');
  assertRupees(check.consignmentValue, '₹50,150.00', 'consignment value');
  const filled = check.filled;
  assert.deepEqual([filled.from.gstin, filled.from.pincode, filled.from.stateCode], ['29AAAAA0000A1ZY', '560058', '29']);
  assert.deepEqual([filled.to.name, filled.to.gstin, filled.to.address, filled.to.pincode, filled.to.state], [MEHTA, '27AAACM1234K1ZN', 'Plot 22, MIDC Bhosari', '411026', 'Maharashtra']);
  assert.deepEqual([filled.document.number, filled.document.date], [trade.invoiceNumber, TODAY]);
  assert.deepEqual(filled.lines.map((line: any) => [line.description, line.hsn, line.quantity, line.unit]).slice(0, 1), [[STEEL, '72142090', '450', 'KGS']]);
  assertRupees(filled.taxable, '₹42,500.00', 'taxable value on the e-way bill');
  assertRupees(filled.igst, '₹7,650.00', 'IGST on the e-way bill');
  assert.deepEqual([filled.transportMode, filled.vehicle], ['Road', 'KA01AB1234']);
  // The distance is not typed: 0 goes to the portal, which works it out from 560058 and 411026.
  // Nothing has ever been sent between these two PIN codes, so no distance is made up here.
  assert.equal(check.distance.sentKm, 0);
  assert.deepEqual([check.distance.fromPincode, check.distance.toPincode], ['560058', '411026']);
  assert.equal(check.distance.knownKm, undefined);
  assert.equal(check.validityDays, null, 'validity is shown once the portal has answered');
  t.diagnostic(`filled from ${trade.invoiceNumber}: ${filled.to.address}, ${filled.to.place} ${filled.to.pincode}, vehicle ${filled.vehicle}; distance sent 0`);
});

test('Step 6. Raise: the portal works out 840 km from the PIN codes, so valid 5 days (840 ÷ 200 = 4.2, part of a day is a day), until 2 Oct 2026', async (t) => {
  // What the E-way bill screen sends: the form exactly as it was filled from the bill.
  const opened = await ok('POST', '/api/eway/for-bill', { invoice: trade.invoiceId });
  const raised = await ok('POST', '/api/eway/generate', opened.form);
  trade.ewayBillNumber = raised.ewayBillNumber;
  assert.equal(raised.status, 'ACTIVE');
  assert.match(raised.ewayBillNumber, /^\d{12}$/, 'a 12-digit e-way bill number');
  assert.equal(raised.raw.distanceKm, 0, 'the distance sent was 0');
  assert.equal(raised.raw.acknowledgement.portalDistanceKm, 840);
  assert.match(raised.message, /The portal worked out 840 km from PIN 560058 to PIN 411026: 840 ÷ 200 = 4\.2, and part of a day counts as a whole day, so 5 days\./);
  // Raised 27 Sep: five days, each ending at midnight, to the end of 27 + 5 = 2 Oct (#234).
  assert.equal(raised.validUntilLabel, '02/10/2026 23:59:59 (Indian time)');
  assert.equal(raised.validUntil, '2026-10-02T18:30:00.000Z');
  assert.ok(new Date(raised.validUntil) > new Date(`${TODAY}T04:30:00.000Z`), 'valid until is after today, not in the past');

  // Print for the driver.
  const copy = await ok('POST', '/api/eway/print', { invoice: trade.invoiceId });
  assert.match(pageText(String(copy.html ?? '')), new RegExp(raised.ewayBillNumber.replace(/(\d{4})(?=\d)/g, '$1\\s?')));

  // The same two PIN codes again: the portal's 840 km is now known, so the check says 5 days in
  // advance, and a typed distance is held to 10% more: 840 + 84 = 924 km.
  const known = await ok('POST', '/api/eway/preview', { invoice: trade.invoiceId });
  assert.deepEqual([known.distance.knownKm, known.distance.longestAllowedKm, known.validityDays], [840, 924, 5]);
  assert.deepEqual((await ok('POST', '/api/eway/preview', { invoice: trade.invoiceId, distanceKm: '924' })).problems, []);
  const tooFar = await ok('POST', '/api/eway/preview', { invoice: trade.invoiceId, distanceKm: '925' });
  assert.equal(tooFar.ready, false);
  assert.deepEqual(tooFar.problems.map((problem: any) => problem.field), ['transDistance']);
  assert.match(tooFar.problems[0].message, /^You typed 925 km, but the portal counts 840 km from PIN 560058 to PIN 411026\. It accepts at most 10% more: 840 \+ 84 = 924 km\./);
  t.diagnostic(`e-way bill ${raised.ewayBillNumber}: distance sent 0, portal said 840 km, valid 5 days, until ${raised.validUntilLabel}; 925 km refused`);
});

test('Step 7. ₹30,000 received from Mehta by bank transfer: ₹50,150 − ₹30,000 = ₹20,150 still due; ABC Traders unchanged at ₹1,838', async (t) => {
  const open = await ok('POST', '/api/payments/open-bills', { direction: 'RECEIPT', partyId: trade.mehtaId, date: TODAY });
  assert.equal(open.party.name, MEHTA);
  assert.deepEqual(open.bills.map((bill: any) => [bill.number, paise(bill.outstanding)]), [[trade.invoiceNumber, rs('₹50,150')]], 'only Mehta\'s bills are offered');

  const received = { direction: 'RECEIPT', partyId: trade.mehtaId, amount: '30000', date: TODAY, method: 'BANK_TRANSFER', reference: '', bills: JSON.stringify([trade.invoiceId]), requestId: 'full-trade-238-receipt' };
  const review = await ok('POST', '/api/payments/preview', received);
  assert.equal(review.message, `₹30,000.00 will reduce what ${MEHTA} owes.`);
  assert.doesNotMatch(JSON.stringify(review), /ABC Traders/);
  assert.ok(review.effects.includes(`${trade.invoiceNumber}: ₹50,150.00 − ₹30,000.00 = ₹20,150.00 still due on this bill`), review.effects.join('\n'));

  const recorded = await ok('POST', '/api/payments/record', received);
  assert.equal(recorded.party.name, MEHTA);
  assert.equal(recorded.mode, 'BANK_TRANSFER');
  assertRupees(recorded.outstanding, '₹20,150.00', 'still owed on the bill');
  assertRupees((await receivable(MEHTA)).outstanding, '₹20,150.00', 'Mehta owes');
  assertRupees((await receivable(ABC)).outstanding, '₹1,838.00', 'ABC Traders owes');
  t.diagnostic(`receipt ${recorded.voucherNumber}: Mehta still owes ${inr(recorded.outstanding)}; ABC Traders ₹1,838`);
});

test('Step 8. ₹37,760 paid to Shree Ram Steels by bank transfer against SRS-101: owed to suppliers ₹0', async (t) => {
  const open = await ok('POST', '/api/payments/open-bills', { direction: 'PAYMENT', partyId: trade.supplierId, date: TODAY });
  assert.deepEqual(open.bills.map((bill: any) => [bill.number, paise(bill.outstanding)]), [['SRS-101', rs('₹37,760')]]);
  const paid = { direction: 'PAYMENT', partyId: trade.supplierId, amount: '37760', date: TODAY, method: 'BANK_TRANSFER', reference: '', bills: JSON.stringify([trade.purchaseId]), requestId: 'full-trade-238-payment' };
  const review = await ok('POST', '/api/payments/preview', paid);
  assert.equal(review.message, '₹37,760.00 will reduce what you owe Shree Ram Steels Private Limited.');
  const recorded = await ok('POST', '/api/payments/record', paid);
  assert.equal(recorded.mode, 'BANK_TRANSFER');
  assertRupees(recorded.outstanding, '₹0.00', 'still owed on SRS-101');
  const payables = (await reports()).dues.payables;
  assertRupees(payables.total, '₹0.00', 'owed to suppliers');
  assertRupees((await home()).supplier.outstanding, '₹0.00', 'Home: owed to suppliers');
  t.diagnostic(`payment ${recorded.voucherNumber}: owed to suppliers ${inr(payables.total)}`);
});

test('Step 9. 50 KGS come back, usable: credit note ₹4,500 + IGST ₹810 = ₹5,310 under Maharashtra (27); Mehta owes ₹14,840; stock 100 KGS on one line', async (t) => {
  const documents = (await ok('GET', '/api/returns/documents')).documents;
  const original = documents.find((document: any) => document.id === trade.invoiceId);
  assert.ok(original, 'the bill from step 3 can be returned against');
  const back = {
    kind: original.kind, documentId: original.id, lineId: original.lines[0].id, unit: original.lines[0].unit,
    quantity: '50', disposition: 'ACCEPTED', date: TODAY, reference: 'full-trade-238-return', reason: 'Bent bars',
  };
  assert.equal(back.kind, 'SALES_RETURN');
  const review = await ok('POST', '/api/returns/preview', back);
  assertRupees(review.amount, '₹5,310.00', 'credit note total');
  const recorded = await ok('POST', '/api/returns/record', back);
  trade.noteId = recorded.note.id;
  trade.noteNumber = recorded.note.number;
  assert.ok(trade.noteNumber.length <= 16, `${trade.noteNumber} is ${trade.noteNumber.length} characters; the government allows 16`);
  assert.equal(recorded.message, `${trade.noteNumber} credits ₹5,310.00 against ${trade.invoiceNumber}.`);
  assertRupees(recorded.note.amount, '₹5,310.00', 'credit note total');

  // The note on paper: 50 × ₹90 = ₹4,500; 18% = ₹810; ₹4,500 + ₹810 = ₹5,310; naming the bill it corrects.
  const note = pageText((await ok('POST', '/api/returns/print', { note: trade.noteId, format: 'A4', locale: 'en-IN' })).html);
  const wanted = [trade.noteNumber, trade.invoiceNumber, '₹4,500.00', '₹810.00', '₹5,310.00', 'Maharashtra (27)'];
  assert.deepEqual(wanted.filter((text) => !note.includes(text)), [], 'missing from the printed credit note');

  // Mehta: ₹20,150 − ₹5,310 = ₹14,840
  assertRupees((await receivable(MEHTA)).outstanding, '₹14,840.00', 'Mehta owes');
  // Stock: 50 + 50 = 100 KGS, on one line (#229)
  assert.deepEqual((await steelRows()).map((row: any) => row.closing), ['100.000']);
  t.diagnostic(`credit note ${trade.noteNumber} (${trade.noteNumber.length} characters): ₹5,310 against ${trade.invoiceNumber}; Mehta owes ₹14,840; stock 100 KGS on one line`);
});

test('Step 10. The purchase check: SRS-101 agrees with the portal, and ₹5,760 is safe to claim this month', async (t) => {
  // The row typed as the government's portal shows it (the Purchase check screen's typed form).
  const workspace = await ok('POST', '/api/itc/typed', {
    period: MONTH, kind: 'INVOICE', gstin: SHREE_RAM_GSTIN, supplierName: 'Shree Ram Steels Private Limited', number: 'SRS-101', date: TODAY,
    taxableValue: '32000', cgst: '0', sgst: '0', igst: '5760', invoiceValue: '37760',
  });
  const line = workspace.lines.find((row: any) => row.number === 'SRS-101');
  assert.equal(line.status, 'EXACT');
  assert.equal(line.statusLabel, 'Agrees with the portal');
  assert.equal(line.outcome, 'CLAIM_NOW');
  assertRupees(line.claimable, '₹5,760.00', 'SRS-101 safe to claim');
  assertRupees(workspace.claimable, '₹5,760.00', 'safe to claim this month');
  assertRupees(workspace.heldBack, '₹0.00', 'held back');
  t.diagnostic(`purchase check: SRS-101 ${line.statusLabel}; ${inr(workspace.claimable)} safe to claim`);
});

test('Step 11. September GST: on sales ₹7,650 − ₹810 = ₹6,840 IGST; credit ₹5,760; cash ₹6,840 − ₹5,760 = ₹1,080; no blocking question', async (t) => {
  const gst = await ok('POST', '/api/gst-returns', { period: MONTH });
  const heads = Object.fromEntries(gst.gstr3b.heads.map((head: any) => [head.head, head]));
  assertRupees(heads.IGST.liability, '₹6,840.00', 'IGST on sales');
  assertRupees(heads.IGST.credit, '₹5,760.00', 'IGST paid on purchases, set against it');
  assertRupees(heads.IGST.difference, '₹1,080.00', 'left to pay in cash');
  for (const name of ['CGST', 'SGST', 'CESS']) {
    assertRupees(heads[name].liability, '₹0.00', `${name} on sales`);
    assertRupees(heads[name].credit, '₹0.00', `${name} credit`);
  }

  const sections = Object.fromEntries(gst.sections.map((section: any) => [section.id, section]));
  assertRupees(sections.B2B.tax, '₹7,650.00', 'GST on the bill');
  assertRupees(sections.CDNR.tax, '-₹810.00', 'GST on the credit note');
  // The credit note is listed under Maharashtra (#232).
  assert.deepEqual(sections.CDNR.rows.map((row: any) => [row.label, row.placeOfSupply]), [[trade.noteNumber, 'Maharashtra (27)']]);
  // The freight is in the code-wise table under the goods code (#231): ₹42,500 − ₹4,500 = ₹38,000.
  const hsn = gst.hsn.find((row: any) => row.hsn === '72142090');
  assertRupees(hsn.taxableValue, '₹38,000.00', 'HSN 72142090 taxable');
  assertRupees(hsn.igst, '₹6,840.00', 'HSN 72142090 IGST');
  // One bill number and one note number used this month, none cancelled (and none eaten by step 4).
  assert.deepEqual(gst.documentsIssued.map((row: any) => [row.kind, row.from, row.to, row.total, row.cancelled]).sort(), [
    ['CREDIT_NOTE', trade.noteNumber, trade.noteNumber, 1, 0],
    ['INVOICE', trade.invoiceNumber, trade.invoiceNumber, 1, 0],
  ]);

  // No blocking question: no line with no goods code, no "inside your own state but carries IGST".
  assert.equal(gst.counts.BLOCKING, 0, JSON.stringify(gst.findings));
  assert.deepEqual(gst.exceptions, []);
  assert.deepEqual(gst.findings.filter((finding: any) => finding.severity !== 'INFORMATION'), []);
  assert.equal(gst.mayApprove, true);
  // The return agrees with the books on both sides.
  assert.equal(gst.reconciliation.agrees, true);
  assert.equal(gst.purchaseReconciliation.agrees, true);
  t.diagnostic(`September 3B: IGST on sales ${inr(heads.IGST.liability)}, credit ${inr(heads.IGST.credit)}, cash ${inr(heads.IGST.difference)}; credit note under ${sections.CDNR.rows[0].placeOfSupply}`);
});

test('Step 12. The books: stock 100 KGS on one line; customers owe ₹1,838 + ₹14,840 = ₹16,678 on Reports and Home; suppliers ₹0; Mehta 0 days late', async (t) => {
  const books = await reports();
  const screen = await home();
  assert.deepEqual((books.stock.rows as any[]).filter((row) => row.item === STEEL).map((row) => row.closing), ['100.000']);
  assert.equal(screen.stockItems.find((item: any) => item.name === STEEL).quantity, 100);

  assertRupees((await receivable(ABC)).outstanding, '₹1,838.00', 'ABC Traders owes');
  assertRupees((await receivable(MEHTA)).outstanding, '₹14,840.00', 'Mehta owes');
  assertRupees(books.dues.receivables.total, '₹16,678.00', 'Reports: customers owe');
  assertRupees(screen.metrics.customersOwe, '₹16,678.00', 'Home: customers owe');
  assertRupees(books.dues.payables.total, '₹0.00', 'suppliers owed');

  // Days late counted to today, not to 31 March (#234): Mehta's bill is due 27 Oct, so not yet due.
  assert.equal(books.period.lateCountedTo, TODAY);
  assert.equal((await receivable(MEHTA)).oldestDaysOverdue, 0);

  // No "stock value not in the books" warning (#229), and the books hold together.
  assert.equal(books.exceptions.items.some((item: any) => item.code === 'STOCK_VALUE_NOT_IN_BOOKS'), false);
  assert.equal(books.trialBalance.balanced, true);
  t.diagnostic(`books: stock 100 KGS; owed ${inr(books.dues.receivables.total)} (Home ${inr(screen.metrics.customersOwe)}); suppliers ${inr(books.dues.payables.total)}; Mehta ${(await receivable(MEHTA)).oldestDaysOverdue} days late`);
});
