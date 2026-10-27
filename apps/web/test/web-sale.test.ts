/**
 * Issue #495 — what happens around a sale, driven in a real browser: the stock refusal and its way
 * through Purchase and back (#262), the form after a bill is recorded (#233/#288), the done screen
 * and its WhatsApp message (#307), and the choices the sale form offers (#288/#293).
 *
 * `sale-slides.test.ts` already walks the four slides end to end; these cover the rest of what
 * `web.test.ts` used to check by reading `app.js` as text.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Page } from 'puppeteer';
import { isShown, startPageHarness, textOf, type PageHarness } from './page-harness.ts';

let harness: PageHarness;
let page: Page;
let today = '';

before(async () => {
  harness = await startPageHarness();
  today = (await harness.api('/api/dashboard')).today;
  // Some steel in stock, bought on the Purchase screen's own route, so a small sale goes through and a big one does not.
  const steel = (await harness.api('/api/catalogue')).items.find((item: any) => item.name === 'TMT Steel Bar 12mm').id;
  await harness.api('/api/purchases/record', { supplierId: 'sampoorna:party:supplier', reference: 'SRS-100', date: today, lines: JSON.stringify([{ itemId: steel, quantity: '500', unit: 'KGS', rate: '64', gst: '1800' }]) });
  page = await harness.signedIn('sale');
  await page.waitForFunction(() => document.querySelectorAll('#sale-lines [data-item-search]').length > 0 && (document.querySelector('[data-draft="sale"] [name="party"]') as HTMLSelectElement).value !== '');
});
after(async () => { await harness?.close(); });

const open = async (view: string) => {
  await page.evaluate((target) => { location.hash = `#${target}`; }, view);
  await page.waitForFunction((target) => document.querySelector('.view.active')?.id === `view-${target}`, {}, view);
};
const slideNow = () => page.$eval('#sale-frame', (frame) => (frame.querySelector('[data-slide]:not([hidden])') as HTMLElement).dataset.slide);
const dialogOpen = () => page.waitForFunction(() => (document.querySelector('#review-dialog') as HTMLDialogElement).open);
const settled = () => page.waitForFunction(() => document.querySelector('#review-dialog')!.getAttribute('aria-busy') !== 'true' && document.querySelector('[data-draft="sale"]')!.getAttribute('aria-busy') !== 'true');

async function typeInto(selector: string, value: string) {
  await page.focus(selector);
  await page.$eval(selector, (input) => { (input as HTMLInputElement).select(); });
  await page.keyboard.type(value);
}
/** Types into the last line's item search and takes the first match, as a person does. */
async function pickItem(query: string) {
  const boxes = await page.$$('#sale-lines [data-item-search]');
  await boxes.at(-1)!.focus();
  await page.keyboard.type(query, { delay: 20 });
  await page.waitForFunction(() => [...document.querySelectorAll('.item-picker-list')].some((list) => !(list as HTMLElement).hidden && list.children.length > 0));
  await page.keyboard.press('Enter');
}
/** Walks the slides with the arrow keys until `slide` is on screen. */
async function goToSlide(slide: string) {
  const order = ['items', 'customer', 'payment', 'transport'];
  for (let step = 0; step < 4; step += 1) {
    const now = (await slideNow())!;
    if (now === slide) return;
    await page.focus(`#sale-slide-${now}`);
    await page.keyboard.press(order.indexOf(now) < order.indexOf(slide) ? 'ArrowRight' : 'ArrowLeft');
    await page.waitForFunction((from) => (document.querySelector('#sale-frame [data-slide]:not([hidden])') as HTMLElement).dataset.slide !== from, {}, now);
  }
  assert.equal(await slideNow(), slide);
}
const nextSlide = async (expected: string) => { await page.click('#sale-next'); await page.waitForFunction((slide) => (document.querySelector('#sale-frame [data-slide]:not([hidden])') as HTMLElement).dataset.slide === slide, {}, expected); };

test('a sale for more than is in stock is refused with the way to fix it: the purchase bill, which comes back to the sale', async () => {
  await pickItem('TMT');
  await typeInto('#sale-lines [data-line-field="quantity"]', '600');
  await typeInto('#sale-lines [data-line-field="rate"]', '90');
  await nextSlide('customer');
  // A walk-in customer cannot be billed this much: the refusal arrives with one button to name the customer.
  await nextSlide('payment');
  await dialogOpen(); await settled();
  assert.equal(await textOf(page, '#review-title'), 'Nothing was saved');
  assert.equal(await isShown(page, '#review-add-customer'), true);
  assert.equal(await textOf(page, '#review-add-customer'), "Add the customer's name and address");
  assert.equal(await isShown(page, '#review-purchase'), false, 'this refusal is not about stock');
  await page.click('#review-cancel');
  await page.waitForFunction(() => !(document.querySelector('#review-dialog') as HTMLDialogElement).open);
  await page.evaluate(() => (document.querySelector('#sale-frame') as HTMLElement).scrollIntoView());
  await goToSlide('customer');
  await page.evaluate(() => ([...document.querySelectorAll('#sale-customer-choices button')].find((button) => (button as HTMLElement).innerText.startsWith('ABC')) as HTMLElement).click());
  await nextSlide('payment');
  await dialogOpen();
  await page.waitForFunction(() => !(document.querySelector('#review-purchase') as HTMLElement).hidden, { timeout: 15_000 });
  const refusal = await textOf(page, '#review-body');
  const stock = /^You have (\d+) KGS of TMT Steel Bar 12mm in (.+?)\. This bill asks for 600 KGS\./.exec(refusal);
  assert.ok(stock, refusal);
  const [, available, godown] = stock;
  assert.equal(await textOf(page, '#review-title'), 'Nothing was saved');
  // The only ways out are to keep editing or to enter the purchase: nothing lets the short sale through.
  const offered = await page.$$eval('#review-dialog .dialog-actions button', (buttons) => buttons.filter((button) => (button as HTMLElement).getClientRects().length > 0).map((button) => (button as HTMLElement).innerText));
  assert.deepEqual(offered, ['Close', 'Enter the purchase bill']);
  assert.ok(!harness.sent.some((request) => request.path === '/api/sales/record'), 'no bill was made');

  // The server's own sentence reaches a Hindi reader, not "could not complete".
  await page.click('#review-cancel');
  await page.waitForFunction(() => !(document.querySelector('#review-dialog') as HTMLDialogElement).open);
  await page.select('#locale', 'hi-IN');
  // Changing the language asks the server again, so the same refusal comes back in Hindi.
  await dialogOpen(); await settled();
  assert.match(await textOf(page, '#review-body'), /[ऀ-ॿ]/, 'the server\'s Hindi sentence, not "could not complete"');
  assert.notEqual(await textOf(page, '#review-body'), refusal);
  await page.click('#review-cancel');
  await page.waitForFunction(() => !(document.querySelector('#review-dialog') as HTMLDialogElement).open);
  // And back in English.
  await page.select('#locale', 'en-IN');
  await dialogOpen(); await settled();

  await page.click('#review-purchase');
  await page.waitForFunction(() => document.querySelector('.view.active')?.id === 'view-purchase');
  assert.equal(await isShown(page, '#review-dialog'), false, 'the dialog closes');
  // Purchase opens with the short item chosen, the quantity left for the supplier's bill to say.
  assert.match(await page.$eval('#purchase-lines [data-item-search]', (input) => (input as HTMLInputElement).value), /TMT Steel Bar 12mm/);
  assert.equal(await page.$$eval('#purchase-lines [data-line-field="item"]', (lines) => lines.length), 1, 'the untouched line is used, not a second one added');
  assert.equal(await page.$eval('#purchase-lines [data-line-field="quantity"]', (input) => (input as HTMLInputElement).value), '', 'the quantity is never guessed');
  assert.equal(await textOf(page, '#purchase-for-sale-note [data-note-text]'), `For the sale you were making: it asks for 600 KGS of TMT Steel Bar 12mm, and ${godown} has ${available} KGS. Type the quantity printed on the supplier's bill. The goods go into ${godown}.`);
  assert.equal(await textOf(page, '#purchase-back-to-sale'), 'Back to the sale');
  // The sale as typed is still on the device, untouched.
  const sale = await page.evaluate(() => JSON.parse(localStorage.getItem('karobar.draft.sale')!));
  assert.deepEqual(sale.__lines.map((line: any) => [line.quantity, line.rate]), [['600', '90']]);

  // Enter the supplier's bill: the review ends with the way back to the sale.
  await page.select('[data-draft="purchase"] [name="supplierId"]', 'sampoorna:party:supplier');
  await page.type('[data-draft="purchase"] [name="reference"]', 'SRS-901');
  await typeInto('#purchase-lines [data-line-field="quantity"]', '600');
  await typeInto('#purchase-lines [data-line-field="rate"]', '64');
  await page.click('[data-draft="purchase"] button[type="submit"]');
  await dialogOpen(); await settled();
  await page.waitForFunction(() => !(document.querySelector('#review-confirm') as HTMLElement).hidden);
  await page.click('#review-confirm');
  await page.waitForFunction(() => !(document.querySelector('#review-back-to-sale') as HTMLElement).hidden, { timeout: 15_000 });
  assert.match(await textOf(page, '#review-effects'), /The goods are in stock now\. Go back to the sale: everything you typed is still there\. Review it again to issue the bill\./);
  await page.click('#review-back-to-sale');
  await page.waitForFunction(() => document.querySelector('.view.active')?.id === 'view-sale');
  assert.equal(await isShown(page, '#review-dialog'), false);
  assert.equal(await isShown(page, '#purchase-for-sale-note'), false, 'the purchase screen no longer speaks of the sale');
  assert.equal(await page.$eval('#sale-lines [data-line-field="quantity"]', (input) => (input as HTMLInputElement).value), '600', 'everything typed on the sale is still there');
  // A recorded supplier bill leaves a fresh Purchase form, so the next one never opens on its figures.
  await open('purchase');
  assert.equal(await page.$eval('[data-draft="purchase"] [name="reference"]', (input) => (input as HTMLInputElement).value), '');
  assert.equal(await page.$$eval('#purchase-lines [data-line-field="item"]', (lines) => lines.length), 1);
  assert.equal(await page.$eval('#purchase-lines [data-line-field="quantity"]', (input) => (input as HTMLInputElement).value), '1', 'a new line, with the form\'s own starting quantity — not the 600 just bought');
  assert.deepEqual(harness.problems, []);
});

/** Starts a new bill from wherever the sale is (the done slide's own "New bill" button, or a fresh screen). */
async function newBill() {
  await open('sale');
  if (await slideNow() === 'done') await page.evaluate(() => ([...document.querySelectorAll('[data-slide="done"] button')].find((button) => (button as HTMLElement).innerText === 'New bill') as HTMLElement).click());
  await page.waitForFunction(() => (document.querySelector('#sale-frame [data-slide]:not([hidden])') as HTMLElement).dataset.slide === 'items');
}

/** A sale screen with no draft behind it, as on the first visit of the day. */
async function freshSale() {
  // Leave the page first, so no timer of its own writes the draft again; then clear it and come back.
  await page.goto(`${harness.base}/robots.txt`);
  await page.evaluate(() => { localStorage.removeItem('karobar.draft.sale'); });
  await page.goto(`${harness.base}/#sale`);
  await page.waitForFunction(() => document.querySelectorAll('#sale-lines [data-item-search]').length > 0 && (document.querySelector('[data-draft="sale"] [name="party"]') as HTMLSelectElement).value !== '');
}
/** Waits until the Payment slide's own check has settled on what is typed. */
const settledReview = () => page.waitForFunction(() => !(document.querySelector('#sale-review-ok') as HTMLElement).hidden);
const sendsOf = (path: string, from: number) => harness.sent.slice(from).filter((request) => request.path === path).map((request) => JSON.parse(request.body!) as Record<string, string>);

test('the payment slide offers six ways to pay: part paid asks for an amount, udhaar for the days, and a cheque is sent to its own screen', async () => {
  const customer = await harness.api('/api/customers', { legalName: 'Kavita Stores', registration: 'unregistered', line1: '4 Market Road', city: 'Pune', pincode: '411001', phone: '98765 43210' });
  assert.equal(customer.customer.name, 'Kavita Stores');
  await freshSale();
  await newBill();
  await pickItem('TMT');
  await typeInto('#sale-lines [data-line-field="quantity"]', '10');
  await typeInto('#sale-lines [data-line-field="rate"]', '90');
  await nextSlide('customer');
  assert.equal(await page.$eval('#sale-customer-choices [aria-pressed="true"]', (button) => (button as HTMLElement).innerText), 'Walk-in / cash customer', 'a new sale starts with the walk-in customer chosen');
  await page.evaluate(() => ([...document.querySelectorAll('#sale-customer-choices button')].find((button) => (button as HTMLElement).innerText.startsWith('Kavita')) as HTMLElement).click());
  await nextSlide('payment');

  const tiles = () => page.$$eval('#sale-frame [data-pay]', (all) => all.map((tile) => ({ way: (tile as HTMLElement).dataset.pay, label: (tile as HTMLElement).innerText, pressed: tile.getAttribute('aria-pressed'), disabled: (tile as HTMLButtonElement).disabled })));
  assert.deepEqual(await tiles(), [
    { way: 'CASH', label: 'Cash', pressed: 'true', disabled: false }, { way: 'UPI', label: 'UPI', pressed: 'false', disabled: false },
    { way: 'CARD', label: 'Card', pressed: 'false', disabled: false }, { way: 'UDHAAR', label: 'Udhaar', pressed: 'false', disabled: false },
    { way: 'PART', label: 'Part paid', pressed: 'false', disabled: false }, { way: 'CHEQUE', label: 'Cheque', pressed: 'false', disabled: true },
  ]);
  assert.equal(await isShown(page, '#sale-cheque-note'), true, 'the cheque tile is off, and the slide says where a cheque is entered');
  assert.match(await textOf(page, '#sale-cheque-note'), /heque/);

  // Cash, UPI and card: the money is received now, by that mode, and the amount box is off.
  const paid = () => page.evaluate(() => { const box = (name: string) => document.querySelector(`[data-draft="sale"] [name="${name}"]`) as HTMLInputElement; return { terms: box('terms').value, paidBy: box('paidBy').value, paidByOff: box('paidBy').disabled, amountOff: box('paidAmount').disabled }; });
  await page.click('[data-pay="UPI"]');
  assert.deepEqual(await paid(), { terms: 'now', paidBy: 'UPI', paidByOff: false, amountOff: true });
  await page.click('[data-pay="CARD"]');
  assert.equal((await paid()).paidBy, 'CARD');
  // Udhaar: nothing is received — no mode and no amount go to the server — and the days to pay within appear.
  await page.click('[data-pay="UDHAAR"]');
  const udhaar = await paid();
  assert.deepEqual([udhaar.paidByOff, udhaar.amountOff], [true, true]);
  assert.equal(await isShown(page, '#sale-udhaar-days'), true);
  assert.deepEqual(await page.$$eval('#sale-udhaar-days [data-days]', (chips) => chips.map((chip) => (chip as HTMLElement).dataset.days)), ['0', '7', '15', '30']);
  assert.equal(await page.$eval('#sale-udhaar-days [aria-pressed="true"]', (chip) => (chip as HTMLElement).dataset.days), '30');
  await page.click('#sale-udhaar-days [data-days="7"]');
  assert.equal(await page.$eval('[data-draft="sale"] [name="terms"]', (select) => (select as HTMLSelectElement).value), '7');
  // Part paid: the amount box opens, and only now.
  await page.click('[data-pay="PART"]');
  assert.equal(await isShown(page, '#sale-part-paid'), true);
  assert.equal((await paid()).amountOff, false);
  assert.equal(await isShown(page, '#sale-udhaar-days'), false);
  await page.click('[data-pay="CASH"]');
  assert.equal(await isShown(page, '#sale-part-paid'), false);
  assert.equal(await page.$eval('[data-draft="sale"] [name="paidAmount"]', (box) => (box as HTMLInputElement).disabled), true);
});

test('a part-paid sale is recorded as typed; the done screen says where the money went, offers the customer a WhatsApp message with the amount still due, and the form is left fresh', async () => {
  await freshSale();
  await pickItem('TMT');
  await typeInto('#sale-lines [data-line-field="quantity"]', '10');
  await typeInto('#sale-lines [data-line-field="rate"]', '90');
  await nextSlide('customer');
  await page.evaluate(() => ([...document.querySelectorAll('#sale-customer-choices button')].find((button) => (button as HTMLElement).innerText.startsWith('Kavita')) as HTMLElement).click());
  await nextSlide('payment');
  await page.click('[data-pay="PART"]');
  await page.focus('[data-draft="sale"] [name="paidAmount"]');
  await page.keyboard.type('500');
  await page.select('[data-draft="sale"] [name="paidBy"]', 'UPI');
  await page.waitForFunction(() => (document.querySelector('#sale-next') as HTMLElement).innerText === 'Make bill');
  const mark = harness.sent.length;
  await settledReview();
  await page.click('#sale-next');
  await page.waitForFunction(() => (document.querySelector('[data-slide="done"]') as HTMLElement).hidden === false, { timeout: 15_000 });

  const record = sendsOf('/api/sales/record', mark).at(-1)!;
  assert.equal(record.paidAmount, '500');
  assert.equal(record.paidBy, 'UPI');
  assert.equal(record.terms, 'now');
  assert.match(record.requestId ?? '', /^[0-9a-f-]{36}$/, 'every sale carries its own key, so pressing twice is one bill');
  const lines = JSON.parse(record.lines!) as Array<Record<string, string>>;
  assert.deepEqual(lines.map((line) => [line.quantity, line.rate]), [['10', '90']]);

  const done = await textOf(page, '[data-slide="done"]');
  assert.match(done, /Bill made/);
  assert.match(done, /UPI payment of ₹500\.00 received; ₹562\.00 added to Kavita Stores’ khata\. Stock updated\./);
  // The message the customer gets: the amount still to pay, never the whole bill, and the bill's number.
  const chat = await page.$eval('[data-slide="done"] a[href^="https://wa.me/"]', (link) => (link as HTMLAnchorElement).href);
  const link = new URL(chat);
  assert.equal(`${link.origin}${link.pathname}`, 'https://wa.me/919876543210', "the customer's own number, as WhatsApp wants it");
  const message = link.searchParams.get('text')!;
  assert.match(message, /^Hello Kavita Stores, thank you for shopping at Sampoorna Traders\. Bill INV\/26-27\/\d{6}: ₹1,062\.00\.\nStill to pay: ₹562\.00\./);

  // The form after a recorded sale: walk-in chosen, one fresh line, today's date, and no draft to bring the old sale back.
  await page.evaluate(() => ([...document.querySelectorAll('[data-slide="done"] button')].find((button) => (button as HTMLElement).innerText === 'New bill') as HTMLElement).click());
  await page.waitForFunction(() => (document.querySelector('#sale-frame [data-slide]:not([hidden])') as HTMLElement).dataset.slide === 'items');
  assert.equal(await page.$$eval('#sale-lines [data-line-field="item"]', (rows) => rows.length), 1);
  assert.equal(await page.$eval('#sale-lines [data-line-field="item"]', (input) => (input as HTMLInputElement).value), '', 'no item left on the line');
  assert.equal(await page.$eval('[data-draft="sale"] [name="party"]', (select) => (select as HTMLSelectElement).selectedOptions[0]!.textContent), 'Walk-in / cash customer');
  assert.equal(await page.$eval('[data-draft="sale"] [name="date"]', (input) => (input as HTMLInputElement).value), today);
  assert.equal(await isShown(page, '#sale-draft-date-note'), false);
  const left = await page.evaluate(() => JSON.parse(localStorage.getItem('karobar.draft.sale') ?? 'null'));
  assert.ok(left === null || (left.__lines ?? []).every((line: any) => line.quantity !== '10'), 'the saved draft no longer holds the sale just made');
  await page.reload();
  await page.waitForFunction(() => (document.querySelector('[data-draft="sale"] [name="party"]') as HTMLSelectElement).value !== '');
  assert.equal(await page.$eval('[data-draft="sale"] [name="party"]', (select) => (select as HTMLSelectElement).selectedOptions[0]!.textContent), 'Walk-in / cash customer', 'a reload does not bring the old customer back');
  assert.notEqual(await page.$eval('#sale-lines [data-line-field="quantity"]', (input) => (input as HTMLInputElement).value), '10', 'nor the old line');
});
