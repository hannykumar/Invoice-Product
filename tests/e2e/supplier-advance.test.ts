/**
 * Issue #261 — paying a supplier before their bill, as a clearly marked advance, run through the app
 * over HTTP exactly as the screens send it. A separate trade from the full trade check (#242): its
 * twelve steps are not touched.
 *
 * Samay's decision (28 Sep 2026): paying a supplier normally comes after their bill, "but that can
 * still happen as advance payment … so the person clicks and gets to know."
 *
 * Every name, GST number and sign-in below is the synthetic demo company's.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { useFixedAppClock } from '../../apps/api/src/app-clock.ts';
import { webServer } from '../../apps/web/server.ts';

// 27 Sep 2026, 10:00 in India.
useFixedAppClock('2026-09-27T04:30:00.000Z');

const TODAY = '2026-09-27';
const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const SHREE_RAM_GSTIN = '27AAECS5678D1Z4';
const SHREE_RAM = 'Shree Ram Steels Private Limited';
const STEEL = 'TMT Steel Bar 12mm';

let base = '';
let session = '';
before(async () => {
  await new Promise<void>((resolve) => webServer.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(webServer.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => webServer.close(() => resolve()));
});

const call = async (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(session === '' ? {} : { authorization: `Bearer ${session}` }) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
};
const ok = async (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => {
  const reply = await call(method, path, body);
  assert.equal(reply.status, 200, `${method} ${path} → ${reply.status}: ${JSON.stringify(reply.body)}`);
  return reply.body;
};
const reports = () => ok('GET', '/api/reports');
const home = () => ok('GET', '/api/dashboard');

const trade = { supplierId: '', itemId: '' };
const advance = () => ({ direction: 'PAYMENT', partyId: trade.supplierId, amount: '10000', date: TODAY, method: 'BANK_TRANSFER', reference: '', bills: '[]', requestId: 'advance-261' });
const purchase = (extra: Record<string, unknown> = {}) => ({
  supplierId: trade.supplierId, reference: 'SRS-101', date: TODAY, amount: '37760',
  lines: JSON.stringify([{ itemId: trade.itemId, quantity: '500', unit: 'KGS', rate: '64', gst: '1800' }]),
  ...extra,
});

test('Sign in to Sampoorna Traders; Shree Ram Steels has no bill yet', async () => {
  const signedIn = await call('POST', '/api/auth/login', { companyId: SAMPOORNA, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  session = signedIn.body.sessionId as string;
  const catalogue = await ok('GET', '/api/catalogue');
  trade.supplierId = catalogue.suppliers.find((row: any) => row.gstin === SHREE_RAM_GSTIN).id;
  trade.itemId = catalogue.items.find((row: any) => row.name === STEEL).id;
  const open = await ok('POST', '/api/payments/open-bills', { direction: 'PAYMENT', partyId: trade.supplierId, date: TODAY });
  assert.deepEqual(open.bills, []);
  assert.equal(open.advancesPaid, 0);
  assert.equal(open.advanceChoice.label, `Record this as an advance to ${SHREE_RAM}`);
  assert.equal(open.advanceChoice.help, `You have no bill from ${SHREE_RAM} yet. This money will be kept as an advance and taken off their next bill.`);
});

test('₹10,000 to Shree Ram with no bill is refused until the advance is chosen', async () => {
  for (const path of ['/api/payments/preview', '/api/payments/record']) {
    for (const choice of [{}, { advance: 'no' }]) {
      const refused = await call('POST', path, { ...advance(), ...choice });
      assert.equal(refused.status, 422, JSON.stringify(refused.body));
      assert.equal(refused.body.message, `You have no bill from ${SHREE_RAM} yet. To pay them before their bill, tick “Record this as an advance to ${SHREE_RAM}”. Nothing was recorded.`);
    }
  }
  assert.equal((await reports()).dues.payables.advancesPaid, 0, 'nothing was recorded');
});

test('Chosen as an advance: the review says so; recorded; Reports and Home show advances ₹10,000 and owe suppliers ₹0', async () => {
  const review = await ok('POST', '/api/payments/preview', { ...advance(), advance: 'yes' });
  assert.equal(review.title, 'Advance to a supplier — check it');
  assert.equal(review.message, `Advance paid to ${SHREE_RAM}: ₹10,000.00. You owe them nothing yet; when their bill is entered, ₹10,000.00 will be taken off it.`);
  assert.ok(review.effects.includes('No GST is entered for this advance, and no GST credit is claimed on it. The credit comes with their bill.'), review.effects.join('\n'));

  const recorded = await ok('POST', '/api/payments/record', { ...advance(), advance: 'yes' });
  assert.equal(recorded.title, 'Advance paid recorded');
  assert.deepEqual(recorded.effects, [`You now owe ${SHREE_RAM} ₹0.00.`, `Advance with ${SHREE_RAM}, to be taken off their next bill: ₹10,000.00.`]);
  const again = await ok('POST', '/api/payments/record', { ...advance(), advance: 'yes' });
  assert.equal(again.paymentId, recorded.paymentId, 'pressed twice, recorded once');

  const voucher = await ok('POST', '/api/payments/voucher', { paymentId: recorded.paymentId });
  assert.ok(voucher.html.includes('No bill yet. Paid as an advance.'));
  assert.ok(voucher.html.includes('Advance, to be taken off their next bill: ₹10,000.00'));

  const books = await reports();
  assert.equal(books.dues.payables.total, 0);
  assert.equal(books.dues.payables.advancesPaid, 10000);
  assert.match(books.dues.payables.sentence['en-IN'], /You still owe suppliers ₹0\.00, .* Separately, you have paid suppliers ₹10,000\.00 in advance, to be taken off their next bills\./);
  assert.deepEqual(books.dues.payables.rows.map((row: any) => [row.party, row.outstanding, row.advancesPaid]), [[SHREE_RAM, 0, 10000]]);
  // Our money with them is not "money with you" on the customers' page.
  assert.equal(books.dues.receivables.rows.some((row: any) => row.party === SHREE_RAM), false);
  assert.equal(books.trialBalance.rows.find((row: any) => row.code === '1460').closing, 10000);
  assert.equal(books.trialBalance.balanced, true);
  const screen = await home();
  assert.equal(screen.supplier.outstanding, 0);
  assert.equal(screen.supplier.advancesPaid, 10000);
});

test('Their ₹37,760 bill takes the advance, ticked: ₹37,760 − ₹10,000 = ₹27,760 owed', async () => {
  const review = await ok('POST', '/api/purchases/preview', purchase());
  assert.deepEqual(review.advance && { available: review.advance.available, use: review.advance.use, used: review.advance.used, owe: review.advance.owe }, { available: 10000, use: true, used: 10000, owe: 27760 });
  assert.ok(review.effects.includes(`Advance already paid to ${SHREE_RAM}: ₹10,000.00. It is taken off this bill:`), review.effects.join('\n'));
  assert.ok(review.effects.includes(`₹37,760.00 − ₹10,000.00 = ₹27,760.00 you will owe ${SHREE_RAM}.`), review.effects.join('\n'));
  assert.equal(review.tax.igst, 5760, 'the GST is the bill\'s own');
  // Unticked, the bill is owed in full and the advance waits.
  const unticked = await ok('POST', '/api/purchases/preview', purchase({ useAdvance: 'no' }));
  assert.equal(unticked.advance.used, 0);
  assert.equal(unticked.advance.owe, 37760);

  const recorded = await ok('POST', '/api/purchases/record', purchase());
  assert.equal(recorded.advanceUsed, 10000);
  assert.equal(recorded.owe, 27760);
  assert.deepEqual(recorded.effects, [`Advance taken off this bill: ₹37,760.00 − ₹10,000.00 = ₹27,760.00 you owe ${SHREE_RAM}.`]);

  const books = await reports();
  assert.equal(books.dues.payables.total, 27760);
  assert.equal(books.dues.payables.advancesPaid, 0);
  assert.equal(books.trialBalance.rows.find((row: any) => row.code === '1460')?.closing ?? 0, 0);
  assert.equal(books.trialBalance.balanced, true);
  const screen = await home();
  assert.equal(screen.supplier.outstanding, 27760);
  assert.equal(screen.supplier.advancesPaid, 0);
  const open = await ok('POST', '/api/payments/open-bills', { direction: 'PAYMENT', partyId: trade.supplierId, date: TODAY });
  assert.deepEqual(open.bills.map((bill: any) => [bill.number, bill.total, bill.paid, bill.outstanding]), [['SRS-101', 37760, 10000, 27760]]);
});

test('September GST credit is ₹5,760 — the bill\'s IGST, with nothing from the advance', async () => {
  // The purchase check, as in the full trade check's step 10: SRS-101 as the portal shows it.
  const workspace = await ok('POST', '/api/itc/typed', {
    period: '2026-09', kind: 'INVOICE', gstin: SHREE_RAM_GSTIN, supplierName: SHREE_RAM, number: 'SRS-101', date: TODAY,
    taxableValue: '32000', cgst: '0', sgst: '0', igst: '5760', invoiceValue: '37760',
  });
  assert.equal(workspace.claimable, 5760, 'safe to claim: the bill\'s GST, nothing for the advance');
  const gst = await ok('POST', '/api/gst-returns', { period: '2026-09' });
  const heads = Object.fromEntries(gst.gstr3b.heads.map((head: any) => [head.head, head]));
  assert.equal(heads.IGST.credit, 5760);
  for (const name of ['CGST', 'SGST', 'CESS']) assert.equal(heads[name].credit, 0, name);
  assert.equal((await reports()).gst.alreadyPaid, 5760);
});
