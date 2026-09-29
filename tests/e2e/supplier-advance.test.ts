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
const advanceVoucher = { id: '', before: '' };
const advance = () => ({
  direction: 'PAYMENT', partyId: trade.supplierId, amount: '10000', date: TODAY, method: 'BANK_TRANSFER', reference: 'UTR 000123', bills: '[]', requestId: 'advance-261',
  // Issue #274 — what the advance is against, and the supplier's receipt voucher for it.
  purchaseOrderNumber: 'PO-17', purchaseOrderDate: '2026-09-25', supplierReceiptNumber: 'RV-55', supplierReceiptDate: TODAY,
});
/** The printed page as a person reads it: tags gone, one line per row. */
const printedText = (html: string) => html
  .replace(/<style[\s\S]*?<\/style>/g, '').replace(/<title>[\s\S]*?<\/title>/g, '')
  .replace(/<\/(tr|p|h1|table)>|<br>/g, '\n').replace(/<\/t[hd]>/g, ' | ').replace(/<[^>]+>/g, '')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .split('\n').map((line) => line.trim().replace(/\s*\|\s*$/, '')).filter((line) => line !== '').join('\n');
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

  // Issue #274 — the standard fields and narration of an advance payment; no invented sentence.
  const voucher = await ok('POST', '/api/payments/voucher', { paymentId: recorded.paymentId });
  const printed = printedText(voucher.html);
  assert.match(printed, /^PAYMENT VOUCHER$/m);
  assert.match(printed, /^Against \| Purchase order no\. PO-17 dated 25 September 2026$/m);
  assert.match(printed, /^Supplier's receipt voucher \| No\. RV-55 dated 27 September 2026$/m);
  assert.match(printed, /^Mode of payment \| Bank transfer$/m);
  assert.match(printed, /^Reference \| UTR 000123$/m);
  assert.match(printed, new RegExp(`^Narration: Being advance paid to ${SHREE_RAM} against purchase order no\\. PO-17 dated 25 September 2026, by bank transfer, ref\\. UTR 000123\\.$`, 'm'));
  for (const invented of ['No bill yet', 'to be taken off', 'Adjusted against', 'Not put against any bill', 'Rule 52']) {
    assert.equal(printed.includes(invented), false, `${invented} is not on the voucher:\n${printed}`);
  }
  advanceVoucher.id = recorded.paymentId;
  advanceVoucher.before = printed;

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
  assert.match(recorded.message, new RegExp(`^₹37,760\\.00 − ₹10,000\\.00 = ₹27,760\\.00 is now owed to ${SHREE_RAM} for bill SRS-101,`));
  assert.equal(recorded.effects.length, 2, recorded.effects.join('\n'));
  assert.match(recorded.effects[0], /^Advance adjusted against bill no\. SRS-101: payment voucher \S+ dated 27 September 2026, ₹10,000\.00\.$/);
  assert.equal(recorded.effects[1], `Advance taken off this bill: ₹37,760.00 − ₹10,000.00 = ₹27,760.00 you owe ${SHREE_RAM}.`);
  assert.deepEqual(recorded.advanceAdjustments.map((a: any) => [a.paymentId, a.amount]), [[advanceVoucher.id, 10000]]);

  // Issue #274 — the advance's voucher, printed again, now records the bill it was adjusted against.
  const after = printedText((await ok('POST', '/api/payments/voucher', { paymentId: advanceVoucher.id })).html);
  assert.match(after, /^Adjusted against bill \| Bill date \| Bill amount \| Amount adjusted\nSRS-101 \| 27 September 2026 \| ₹37,760\.00 \| ₹10,000\.00$/m);
  assert.match(after, /^Unadjusted advance: ₹0\.00$/m);
  assert.equal(after.includes('Settled by this payment'), false, 'the advance did not pay SRS-101 when it was made');

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

test('#274 An advance\'s purchase order and receipt voucher are both-or-neither, with dates that can be true', async () => {
  const refusals: [Record<string, unknown>, string][] = [
    [{ purchaseOrderDate: '' }, 'Enter both the purchase order number and its date, or leave both blank.'],
    [{ purchaseOrderNumber: '' }, 'Enter both the purchase order number and its date, or leave both blank.'],
    [{ purchaseOrderDate: '2026-09-28' }, 'The purchase order is dated 28 September 2026, after this payment on 27 September 2026. An advance against it is paid on or after the order\'s date. Check both dates.'],
    [{ supplierReceiptDate: '' }, 'Enter both the supplier\'s receipt voucher number and its date, or leave both blank.'],
    [{ supplierReceiptDate: '2026-09-26' }, 'The supplier\'s receipt voucher is dated 26 September 2026, before this payment on 27 September 2026. They issue it when they receive the money, so it cannot be earlier. Check both dates.'],
  ];
  for (const [change, message] of refusals) {
    const refused = await call('POST', '/api/payments/preview', { ...advance(), ...change, advance: 'yes', requestId: 'advance-274-refused' });
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(refused.body.message, message);
  }
});

test('#274 Paying SRS-101 and more, with no purchase order: the rest is an advance against goods to be supplied', async () => {
  const bill = (await ok('POST', '/api/payments/open-bills', { direction: 'PAYMENT', partyId: trade.supplierId, date: TODAY })).bills[0];
  const input = {
    direction: 'PAYMENT', partyId: trade.supplierId, amount: '30000', date: TODAY, method: 'UPI', reference: '', bills: JSON.stringify([bill.id]),
    requestId: 'advance-274-mixed', advance: 'yes',
  };
  const review = await ok('POST', '/api/payments/preview', input);
  assert.ok(review.effects.includes('Against: goods to be supplied.'), review.effects.join('\n'));
  const recorded = await ok('POST', '/api/payments/record', input);
  const printed = printedText((await ok('POST', '/api/payments/voucher', { paymentId: recorded.paymentId })).html);
  assert.match(printed, /^Amount \| ₹30,000\.00$/m);
  assert.match(printed, /^Advance \| ₹2,240\.00$/m);
  assert.match(printed, /^Against \| Goods to be supplied$/m);
  assert.equal(printed.includes("Supplier's receipt voucher"), false, 'printed only when entered');
  assert.match(printed, /^SRS-101 \| 27 September 2026 \| ₹37,760\.00 \| ₹27,760\.00$/m);
  assert.match(printed, new RegExp(`^Narration: Being payment made to ${SHREE_RAM} against bill no\\. SRS-101, and advance paid against goods to be supplied, by UPI\\.$`, 'm'));
  assert.equal(printed.includes('Adjusted against'), false);
});
