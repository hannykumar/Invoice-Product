/**
 * Issue #305 / #311 — the sale in slides, driven in a real browser against the real app.
 *
 * The full-trade check (#242, tests/e2e/full-trade.test.ts) drives the trade over HTTP. This file
 * drives the same step 3 through the slides themselves, by keyboard only: Items → Customer →
 * Payment → Transport → Make bill, and asserts the bill the owner sees: ₹42,500 + IGST ₹7,650 =
 * ₹50,150, and the e-way bill raised by itself with no visit to the E-way bill screen. Then a
 * walk-in cash sale of three items, counting the taps after the items (the issue asks for five at
 * most; it is three), and the 600 KGS sale that is refused with the purchase hand-off.
 *
 * Every name, GST number and sign-in is the demo company's own, and nothing leaves this machine:
 * requests to anywhere but the local server are refused (the web fonts have system fallbacks).
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { webServer } from '../server.ts';

let base = '';
let session = '';
let browser: Browser;
let page: Page;

const call = async (path: string, body?: Record<string, unknown>) => {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(session === '' ? {} : { authorization: `Bearer ${session}` }) },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const reply = await response.json() as Record<string, any>;
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(reply)}`);
  return reply;
};

/** Text of an element, once it exists. */
const textOf = (selector: string) => page.$eval(selector, (element) => (element as HTMLElement).innerText.trim());
/** The slide on screen. */
const slideNow = () => page.$eval('#sale-frame', (frame) => (frame.querySelector('[data-slide]:not([hidden])') as HTMLElement).dataset.slide);
/** Waits until the live total (or the review) has settled on what is typed. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 700));

before(async () => {
  await new Promise<void>((resolve) => webServer.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(webServer.address() as AddressInfo).port}`;
  session = (await call('/api/auth/login', { companyId: '00000000-0000-4000-8000-000000000001', email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' })).sessionId;
  // Full trade, steps 1 and 2 (the same requests the Purchase screen and the customer box send).
  const catalogue = await call('/api/catalogue');
  const steel = catalogue.items.find((item: any) => item.name === 'TMT Steel Bar 12mm').id;
  await call('/api/purchases/record', { supplierId: 'sampoorna:party:supplier', reference: 'SRS-101', date: (await call('/api/dashboard')).today, amount: '37760', lines: JSON.stringify([{ itemId: steel, quantity: '500', unit: 'KGS', rate: '64', gst: '1800' }]) });
  await call('/api/customers', { legalName: 'Mehta Construction Supplies', registration: 'regular', gstin: '27AAACM1234K1ZN', line1: 'Plot 22, MIDC Bhosari', city: 'Pune', pincode: '411026' });
  // Three counter goods with a usual price, so a walk-in bill needs no typing.
  const today = (await call('/api/dashboard')).today;
  for (const [name, price] of [['Neem Soap 75g', '30'], ['Rose Soap 75g', '35']]) {
    await call('/api/items', { name, kind: 'goods', hsnSac: '34011190', unit: 'PCS', taxKind: 'taxable', ratePercentTimes100: '500', basis: 'Same rate as our other soap', price });
  }
  await call('/api/items/edit', { itemId: 'sampoorna:item:SOAP', hsnSac: '34011190', barcode: '', price: '40', otherName: '' });
  const items = (await call('/api/catalogue')).items as Array<{ id: string; name: string }>;
  await call('/api/purchases/record', { supplierId: 'sampoorna:party:supplier', reference: 'SRS-102', date: today, lines: JSON.stringify(
    items.filter((item) => /Soap/.test(item.name)).map((item) => ({ itemId: item.id, quantity: '100', unit: 'PCS', rate: '20', gst: '500' })),
  ) });

  browser = await puppeteer.launch({ headless: true, args: process.env.GITHUB_ACTIONS === 'true' ? ['--no-sandbox'] : [] });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', (request) => { if (request.url().startsWith(base)) void request.continue(); else void request.abort(); });
  await page.goto(`${base}/#sale`, { waitUntil: 'load' });
  // Sign in with the details already filled in, as the owner does.
  await page.waitForSelector('#login-form button[type="submit"]', { visible: true });
  await page.click('#login-form button[type="submit"]');
  await page.waitForFunction(() => !(document.querySelector('#login-dialog') as HTMLDialogElement).open);
  await page.waitForFunction(() => document.querySelectorAll('#sale-lines [data-item-search]').length > 0 && (document.querySelector('[data-draft="sale"] [name="party"]') as HTMLSelectElement).value !== '');
});

after(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => webServer.close(() => resolve()));
});

/** Focuses a box, selects what is in it, and types over it: the keyboard's way of "tap the number". */
async function typeInto(selector: string, value: string) {
  await page.focus(selector);
  await page.$eval(selector, (input) => { (input as HTMLInputElement).select(); });
  await page.keyboard.type(value);
}

/** Types into the item search on the last line and takes the first match with Enter. */
async function pickItem(query: string) {
  const boxes = await page.$$('#sale-lines [data-item-search]');
  await boxes.at(-1)!.focus();
  await page.keyboard.type(query, { delay: 30 });
  // The list shows the matches first; Enter then takes the top one, as a person sees it.
  await page.waitForFunction(() => [...document.querySelectorAll('.item-picker-list')].some((list) => !(list as HTMLElement).hidden && list.children.length > 0));
  await page.keyboard.press('Enter');
}

test('#305: full-trade step 3 through the slides, by keyboard: ₹50,150 and the e-way bill raised by itself (#311)', async () => {
  assert.equal(await slideNow(), 'items');
  assert.equal(await textOf('#sale-next'), 'Next');
  await pickItem('TMT');
  // Tap the number to type it: 450 KGS at ₹90.
  await typeInto('#sale-lines [data-line-field="quantity"]', '450');
  await typeInto('#sale-lines [data-line-field="rate"]', '90');
  // Freight: the box opens from the keyboard.
  await page.focus('#sale-charges summary');
  await page.keyboard.press('Enter');
  await page.focus('[name="freight"]');
  await page.keyboard.type('2000');
  await settle();
  // ← → move between slides; each slide's heading takes the focus.
  await page.focus('#sale-slide-items');
  await page.keyboard.press('ArrowRight');
  assert.equal(await slideNow(), 'customer');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'sale-slide-customer');
  assert.match(await textOf('#sale-step'), /^Step 2 of \d: Who is buying\?$/);
  // Walk-in is chosen until somebody else is: Mehta, from the keyboard.
  assert.equal(await page.$eval('#sale-customer-choices [aria-pressed="true"]', (button) => (button as HTMLElement).innerText), 'Walk-in / cash customer');
  const mehta = await page.evaluateHandle(() => [...document.querySelectorAll('#sale-customer-choices button')].find((button) => (button as HTMLElement).innerText.startsWith('Mehta')));
  await (mehta as any).focus();
  await page.keyboard.press('Enter');
  await settle();
  const checks = await page.$$eval('#sale-customer-checks li', (rows) => rows.map((row) => (row as HTMLElement).innerText));
  assert.deepEqual(checks.slice(0, 2), ['Maharashtra sale · IGST', 'e-way bill needed — raised after you make the bill']);
  assert.equal(await textOf('#sale-bill-bar [data-calculated="total"]'), '₹50,150.00', 'the total is in the bar on every slide');

  await page.keyboard.press('ArrowRight');
  assert.equal(await slideNow(), 'payment');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'sale-slide-payment');
  // Udhaar, 30 days: the tile from the keyboard; thirty days comes pressed.
  await page.focus('[data-pay="UDHAAR"]');
  await page.keyboard.press('Enter');
  await settle();
  assert.equal(await page.$eval('#sale-udhaar-days [aria-pressed="true"]', (chip) => (chip as HTMLElement).dataset.days), '30');
  await page.waitForFunction(() => !(document.querySelector('#sale-review-ok') as HTMLElement).hidden);
  assert.equal(await textOf('#sale-review-ok [data-line-text]'), 'e-way bill needed — raised after you make the bill');
  // The one warning: the turnover question (full trade, step 3), with its button.
  assert.match(await textOf('#sale-review-warning [data-line-text]'), /^We don't know yet whether you need e-invoices/);
  assert.equal(await page.$eval('#sale-review-turnover', (button) => (button as HTMLElement).hidden), false);
  assert.deepEqual(await page.$$eval('.bill-summary strong', (cells) => cells.filter((cell) => (cell.parentElement as HTMLElement).hidden === false).map((cell) => (cell as HTMLElement).innerText)), ['₹40,500.00', '₹2,000.00', '₹7,650.00', '₹50,150.00']);
  assert.equal(await textOf('#sale-next'), 'Next', 'goods that need an e-way bill get the Transport slide before Make bill');

  // Transport: the vehicle, and its check (#29) as one line.
  await page.focus('#sale-slide-payment');
  await page.keyboard.press('ArrowRight');
  assert.equal(await slideNow(), 'transport');
  await page.focus('[name="vehicleNumber"]');
  await page.keyboard.type('KA01AB1234');
  await page.waitForFunction(() => !(document.querySelector('#sale-vehicle-check') as HTMLElement).hidden);
  assert.match(await textOf('#sale-vehicle-check'), /KA01AB1234 is on the transport department's record/);
  assert.equal(await textOf('#sale-next'), 'Make bill');
  // Arrow keys never make a bill: → on the last slide stays there.
  await page.focus('#sale-slide-transport');
  await page.keyboard.press('ArrowRight');
  assert.equal(await slideNow(), 'transport');

  await page.focus('#sale-next');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (document.querySelector('[data-slide="done"]') as HTMLElement).hidden === false, { timeout: 15_000 });
  const done = await textOf('[data-slide="done"]');
  assert.match(done, /Bill made/);
  assert.match(done, /INV\/26-27\/\d{6}/);
  assert.match(done, /₹50,150\.00/);
  const raised = done.match(/E-way bill (\d{12}) raised by itself · valid until (.+)/);
  assert.ok(raised, done);
  // The same e-way bill the E-way bill screen shows for this bill — it was never opened.
  const number = done.match(/INV\/26-27\/\d{6}/)![0];
  const bill = (await call('/api/eway/bills')).invoices.find((row: any) => row.number === number);
  assert.equal(bill.label, `e-way bill ${raised[1]}`);
  assert.equal(bill.customer, 'Mehta Construction Supplies');
  assert.equal(await page.evaluate(() => (document.querySelector('#sale-bill-bar') as HTMLElement).hidden), true);
});

test('#305: a walk-in cash sale of three items is three taps after the items, with no typing', async () => {
  // New bill, from the done slide.
  await page.evaluate(() => ([...document.querySelectorAll('[data-slide="done"] button')].find((button) => (button as HTMLElement).innerText === 'New bill') as HTMLElement).click());
  assert.equal(await slideNow(), 'items');
  for (const [index, query] of ['herbal', 'neem', 'rose'].entries()) {
    if (index > 0) { await page.focus('#sale-add-line'); await page.keyboard.press('Enter'); }
    await pickItem(query);
  }
  await settle();
  assert.deepEqual(await page.$$eval('#sale-lines [data-line-field="rate"]', (inputs) => inputs.map((input) => (input as HTMLInputElement).value)), ['40', '30', '35'], 'each at its usual price');
  let taps = 0;
  const tap = async () => { taps += 1; await page.click('#sale-next'); await settle(); };
  await tap();
  assert.equal(await slideNow(), 'customer');
  await tap();
  assert.equal(await slideNow(), 'payment');
  assert.equal(await page.$eval('[data-pay="CASH"]', (tile) => tile.getAttribute('aria-pressed')), 'true', 'cash is already chosen');
  await page.waitForFunction(() => /Paid now by Cash/.test((document.querySelector('#sale-review-ok') as HTMLElement).innerText));
  assert.equal(await textOf('#sale-next'), 'Make bill');
  await tap();
  await page.waitForFunction(() => (document.querySelector('[data-slide="done"]') as HTMLElement).hidden === false, { timeout: 15_000 });
  assert.equal(taps, 3);
  assert.match(await textOf('[data-slide="done"]'), /Cash received from Walk-in\. Stock updated\./);
});

test('#305: 600 KGS with 50 in stock is refused on the Payment slide, with "Enter the purchase bill", and no bill is made', async () => {
  const before = (await call('/api/reports')).sales.rows.length;
  await page.evaluate(() => ([...document.querySelectorAll('[data-slide="done"] button')].find((button) => (button as HTMLElement).innerText === 'New bill') as HTMLElement).click());
  await pickItem('TMT');
  await typeInto('#sale-lines [data-line-field="quantity"]', '600');
  await page.click('#sale-next');
  await page.evaluate(() => ([...document.querySelectorAll('#sale-customer-choices button')].find((button) => (button as HTMLElement).innerText.startsWith('Mehta')) as HTMLElement).click());
  await settle();
  // Mehta was last charged ₹90: the price the app filled in follows the customer chosen after the items.
  assert.equal(await page.$eval('#sale-lines [data-line-field="rate"]', (input) => (input as HTMLInputElement).value), '90');
  await page.click('#sale-next');
  await page.waitForFunction(() => (document.querySelector('#review-dialog') as HTMLDialogElement).open && !(document.querySelector('#review-purchase') as HTMLElement).hidden, { timeout: 15_000 });
  assert.match(await textOf('#review-body'), /^You have 50 KGS of TMT Steel Bar 12mm in Bengaluru · Peenya godown\. This bill asks for 600 KGS\./);
  assert.equal(await textOf('#review-purchase'), 'Enter the purchase bill');
  assert.equal((await call('/api/reports')).sales.rows.length, before, 'no bill number used up');
});
