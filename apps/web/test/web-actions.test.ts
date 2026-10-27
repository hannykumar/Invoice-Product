/**
 * Issue #495 — the screens that talk to the government, the bank and the customer, driven in a real
 * browser: the GST return (prepare, approve and export are three separate acts), the quotation and
 * proforma, the bank connection and the page the bank sends the customer back to, reminders,
 * vehicle checks and the service-health screen.
 *
 * Each test clicks the screen's own buttons and asserts what the page sent and what the shopkeeper is
 * then shown. Before, `web.test.ts` only looked for the route strings in `app.js`.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Page } from 'puppeteer';
import { BANK_RETURN_PATH } from '../../../packages/bank-feeds/src/index.ts';
import { isShown, startPageHarness, textOf, type PageHarness } from './page-harness.ts';

let harness: PageHarness;
let page: Page;

before(async () => {
  harness = await startPageHarness();
  // Goods in stock, bought through the Purchase route, so a quotation can become a bill.
  const today = (await harness.api('/api/dashboard')).today;
  const soap = (await harness.api('/api/catalogue')).items.find((item: any) => item.name === 'Herbal Bath Soap 100g').id;
  await harness.api('/api/purchases/record', { supplierId: 'sampoorna:party:supplier', reference: 'SRS-300', date: today, lines: JSON.stringify([{ itemId: soap, quantity: '500', unit: 'PCS', rate: '20', gst: '500' }]) });
  page = await harness.signedIn();
});
after(async () => { await harness?.close(); });

const open = async (view: string) => {
  await page.evaluate((target) => { location.hash = `#${target}`; }, view);
  await page.waitForFunction((target) => document.querySelector('.view.active')?.id === `view-${target}`, {}, view);
};
const calls = (from: number) => harness.sent.slice(from).map((request) => `${request.method} ${request.path}`);
const bodyOf = (path: string, from: number) => JSON.parse(harness.sent.slice(from).findLast((request) => request.path === path)!.body!) as Record<string, string>;
const screenText = (view: string) => page.$eval(`#view-${view}`, (screen) => (screen as HTMLElement).innerText);
const enabled = (selector: string) => page.$eval(selector, (button) => !(button as HTMLButtonElement).disabled);
const dialogOpen = () => page.waitForFunction(() => (document.querySelector('#review-dialog') as HTMLDialogElement).open);
const waitForText = (view: string, pattern: string) => page.waitForFunction((id, source) => new RegExp(source).test((document.querySelector(`#view-${id}`) as HTMLElement).innerText), {}, view, pattern);

test('GST return: preparing only reads the books; approving and exporting are their own buttons, in that order', async () => {
  await open('gst-returns');
  assert.equal(await enabled('#gst-approve'), false, 'nothing to approve before a return is prepared');
  assert.equal(await enabled('#gst-export'), false, 'and nothing to export');
  const mark = harness.sent.length;
  await page.click('#gst-return-form button');
  await waitForText('gst-returns', 'Does it agree with your books\\?');
  assert.deepEqual(calls(mark).filter((call) => /gst-returns/.test(call)), ['POST /api/gst-returns/prepare']);
  assert.match(bodyOf('/api/gst-returns/prepare', mark).period!, /^\d{4}-\d{2}$/, 'the month asked for');
  assert.match(await screenText('gst-returns'), /September 2026|\w+ 20\d\d: \d+ documents? worth/);
  assert.match(await screenText('gst-returns'), /This only reads your books and works out what the return would say\. Nothing is sent to the government here\./);
  assert.equal(await enabled('#gst-approve'), true);
  assert.equal(await enabled('#gst-export'), false, 'a return that is not approved cannot be exported');

  await page.click('#gst-approve');
  await page.waitForFunction(() => !(document.querySelector('#gst-export') as HTMLButtonElement).disabled);
  assert.ok(calls(mark).includes('POST /api/gst-returns/approve'));
  assert.equal(await enabled('#gst-approve'), false, 'approved once, not again');

  await page.click('#gst-export');
  const exported = await harness.requested('/api/gst-returns/export', mark);
  assert.equal(JSON.parse(exported.body!).period, bodyOf('/api/gst-returns/prepare', mark).period, 'the month that was approved is the month exported');
  assert.deepEqual(harness.problems, []);
});

test('a quotation is checked without using a number, issued with one, and then offers print, turn into a sale and cancel', async () => {
  await open('presale');
  const mark = harness.sent.length;
  await page.click('#presale-form button[type="submit"]');
  await page.waitForFunction(() => !(document.querySelector('#presale-issue') as HTMLElement).hidden);
  const checked = bodyOf('/api/presale/preview', mark);
  assert.equal(checked.kind, 'QUOTATION');
  assert.equal(checked.customerId, 'sampoorna:party:customer');
  assert.ok(!calls(mark).includes('POST /api/presale/issue'), 'checking issues nothing');
  assert.match(await screenText('presale'), /Checking saves nothing and uses no number\. The number is given only when you issue it\./);

  await page.click('#presale-issue');
  await harness.requested('/api/presale/issue', mark);
  await dialogOpen();
  assert.match(await textOf(page, '#review-body'), /QTN\/26-27\/\d{5}/, 'the number given is told to the shopkeeper');
  await page.keyboard.press('Escape');
  await waitForText('presale', 'QTN/26-27/\\d{5} · Quotation: ₹[\\d,.]+\\nWaiting for the customer');
  assert.ok((await screenText('presale')).includes('Quotation'));
  // From the one that is open: print it, turn it into a sale, or cancel it.
  const buttons = await page.$$eval('#view-presale button', (all) => all.filter((button) => (button as HTMLElement).getClientRects().length > 0).map((button) => (button as HTMLElement).innerText));
  for (const wanted of ['Print', 'Turn into a sale', 'Cancel it']) assert.ok(buttons.includes(wanted), `${wanted} is offered — saw ${buttons.join(' | ')}`);
  await harness.requested('/api/presale/print', mark); // the bill it opens on is read before it can be turned into a sale
  await page.click('#presale-convert-button');
  await harness.requested('/api/presale/convert', mark);
  assert.ok(!calls(mark).includes('POST /api/presale/issue-sale'), 'turning it into a sale shows the bill first, it does not issue it');
  await page.waitForFunction(() => !(document.querySelector('#presale-sale') as HTMLElement).hidden);
  assert.match(await textOf(page, '#presale-sale-detail'), /The bill comes to: ₹2,625\.00/);
  assert.deepEqual(harness.problems, []);
});

test('Money against a proforma has its own receipt and refund forms, which appear only for a proforma', async () => {
  await page.goto(`${harness.base}/#presale`);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.view.active')?.id === 'view-presale');
  assert.equal(await isShown(page, '#presale-advance-form'), false, 'no advance form until a proforma is open');
  assert.equal(await isShown(page, '#presale-refund-form'), false);
  await page.select('#presale-form [name="kind"]', 'PROFORMA');
  await page.type('#presale-form [name="purpose"]', 'Advance for soap before dispatch');
  await page.click('#presale-form button[type="submit"]');
  await page.waitForFunction(() => !(document.querySelector('#presale-issue') as HTMLElement).hidden);
  await page.click('#presale-issue');
  await dialogOpen();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => (document.querySelector('#presale-advance-form') as HTMLElement).getClientRects().length > 0);
  assert.equal(await isShown(page, '#presale-advance-form'), true);
});
