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
import { after, before, beforeEach, test } from 'node:test';
import type { Page } from 'puppeteer';
import { BANK_RETURN_PATH } from '../../../packages/bank-feeds/src/index.ts';
import { isShown, startPageHarness, textOf, until, type PageHarness } from './page-harness.ts';

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

// Each test starts on a screen of its own: whatever dialog the last one left on show is closed.
beforeEach(async () => { await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach((dialog) => (dialog as HTMLDialogElement).close())); });

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

test('the bank sends the customer back to the app, which finishes the request there — and refuses a reply it did not ask for', async () => {
  // The page the bank returns to is the app itself, served like any other.
  const served = await fetch(`${harness.base}${BANK_RETURN_PATH}?code=bank-code&state=bank-state`);
  assert.equal(served.status, 200);
  assert.match(served.headers.get('content-type') ?? '', /^text\/html/);

  await page.goto(`${harness.base}/#bank-feeds`);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.view.active')?.id === 'view-bank-feeds');
  const mark = harness.sent.length;
  await page.click('#bank-feed-connect');
  await dialogOpen();
  assert.equal(await textOf(page, '#review-title'), 'Start bank permission');
  assert.ok(!calls(mark).includes('POST /api/bank-feeds/consent/complete'), 'asking for permission connects nothing yet');
  await page.click('#review-confirm');
  await harness.requested('/api/bank-feeds/consent', mark);
  await page.waitForFunction(() => sessionStorage.getItem('karobar.bankConsent') !== null);
  const consent = await page.evaluate(() => JSON.parse(sessionStorage.getItem('karobar.bankConsent')!)) as { connectionId: string; consentState: string };
  assert.ok(consent.connectionId && consent.consentState, 'this tab remembers which request it made, and under which state');
  await page.keyboard.press('Escape');

  // A reply carrying a state this tab never handed out is not sent on, the code leaves the address bar,
  // and the remembered request is dropped. (The reply is shown in a dialog; see the note in the PR about its wording.)
  const refused = harness.sent.length;
  await page.goto(`${harness.base}${BANK_RETURN_PATH}?code=forged-code&state=not-the-one-we-gave`);
  await page.waitForFunction(() => document.querySelector('.view.active')?.id === 'view-bank-feeds' && (document.querySelector('#review-dialog') as HTMLDialogElement).open);
  assert.equal(await page.evaluate(() => location.search), '', 'the code is gone from the address bar');
  assert.equal(await page.evaluate(() => location.hash), '#bank-feeds');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('karobar.bankConsent')), null);
  assert.ok(!calls(refused).includes('POST /api/bank-feeds/consent/complete'), 'a forged return completes nothing');
});

test('a return with the right state and a code completes the connection exactly once, and the spent code is not left behind', async () => {
  await page.goto(`${harness.base}/#bank-feeds`);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.view.active')?.id === 'view-bank-feeds');
  const mark = harness.sent.length;
  await page.click('#bank-feed-connect');
  await dialogOpen();
  await page.click('#review-confirm');
  await harness.requested('/api/bank-feeds/consent', mark);
  await page.waitForFunction(() => sessionStorage.getItem('karobar.bankConsent') !== null);
  const consent = await page.evaluate(() => JSON.parse(sessionStorage.getItem('karobar.bankConsent')!)) as { connectionId: string; consentState: string };
  await page.keyboard.press('Escape');

  // The same tab goes to the bank's page and comes back with the code.
  const returned = harness.sent.length;
  await page.goto(`${harness.base}${BANK_RETURN_PATH}?code=sandbox-approved&state=${encodeURIComponent(consent.consentState)}`);
  const complete = await harness.requested('/api/bank-feeds/consent/complete', returned);
  const sentBody = JSON.parse(complete.body!) as Record<string, string>;
  assert.deepEqual([sentBody.connectionId, sentBody.authorizationCode, sentBody.consentState], [consent.connectionId, 'sandbox-approved', consent.consentState]);
  assert.equal(calls(returned).filter((call) => call === 'POST /api/bank-feeds/consent/complete').length, 1);
  assert.equal(await page.evaluate(() => location.search), '', 'the spent code is not left in the address bar or the history');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('karobar.bankConsent')), null);
});

test('Returns: a whole-bill credit note and a price correction are different choices, and a price correction must say why', async () => {
  await open('returns');
  await page.waitForFunction(() => document.querySelectorAll('#return-document option').length > 0);
  const options = await page.$$eval('#return-line option', (all) => all.map((option) => (option as HTMLOptionElement).value));
  assert.ok(options.includes('__whole__'), 'the whole bill can be credited in one go');
  assert.equal(await isShown(page, '#return-price'), false, 'the price-correction questions are not asked of a goods return');
  assert.equal(await page.$eval('#return-price', (box) => (box as HTMLFieldSetElement).disabled), true, 'and are not sent');

  await page.select('#return-form [name="mode"]', 'PRICE');
  await page.waitForFunction(() => !(document.querySelector('#return-price') as HTMLElement).hidden);
  assert.equal(await page.$eval('#return-price', (box) => (box as HTMLFieldSetElement).disabled), false);
  // Nothing is chosen for the shopkeeper: a wrong bill and a discount given afterwards are different things in law.
  const causes = await page.$$eval('#return-form [name="cause"] option', (all) => all.map((option) => (option as HTMLOptionElement).value));
  assert.deepEqual(causes, ['', 'INVOICE_ERROR', 'DISCOUNT_AFTER_SALE']);
  assert.equal(await page.$eval('#return-form [name="cause"]', (select) => (select as HTMLSelectElement).value), '');
  assert.equal(await page.$eval('#return-form [name="cause"]', (select) => (select as HTMLSelectElement).required), true);
  const mark = harness.sent.length;
  await page.type('#return-form [name="reason"]', 'Priced wrongly');
  await page.click('#return-form button[type="submit"]');
  assert.ok(!calls(mark).includes('POST /api/returns/preview'), 'without a cause the form is not sent');

  // Back to a goods return: the questions go away again and the whole bill can be previewed.
  await page.select('#return-form [name="mode"]', '');
  await page.waitForFunction(() => (document.querySelector('#return-price') as HTMLElement).hidden);
  assert.equal(await page.$eval('#return-price', (box) => (box as HTMLFieldSetElement).disabled), true);
  await page.select('#return-line', '__whole__');
  await page.type('#return-form [name="reference"]', 'CN-REF-1');
  await page.$eval('#return-form [name="reason"]', (box) => { (box as HTMLTextAreaElement).value = ''; });
  await page.type('#return-form [name="reason"]', 'Customer returned the whole bill');
  await page.click('#return-form button[type="submit"]');
  const preview = await harness.requested('/api/returns/preview', mark);
  assert.equal(JSON.parse(preview.body!).lineId, '__whole__');
  await dialogOpen();
  await page.waitForFunction(() => document.querySelector('#review-dialog')!.getAttribute('aria-busy') === 'false');
  assert.ok(!calls(mark).includes('POST /api/returns/record'), 'a preview records nothing');
  await page.keyboard.press('Escape');
});

test('Reminders: "send all" says what it sent, or why it left every bill alone', async () => {
  await open('reminders');
  const mark = harness.sent.length;
  await page.click('#reminders-send-all');
  await harness.requested('/api/reminders/send-all', mark);
  await dialogOpen();
  await page.waitForFunction(() => document.querySelector('#review-dialog')!.getAttribute('aria-busy') === 'false');
  assert.equal(await textOf(page, '#review-title'), 'Nothing needed sending');
  assert.equal(await textOf(page, '#review-body'), 'Every open bill was deliberately left alone today. The reasons are on this screen.');
  await page.keyboard.press('Escape');
});

test('Service health shows the checks, the recurring jobs and the safe retry, and a retry goes to its own route', async () => {
  const mark = harness.sent.length;
  await open('operations');
  await harness.requested('/api/operations', mark);
  await waitForText('operations', 'All checks are working');
  const recurring = await page.$$eval('#operations-recurring li, #operations-recurring .activity-row', (rows) => rows.map((row) => (row as HTMLElement).innerText));
  assert.ok(recurring.length >= 4, `recurring work is listed: ${recurring.join(' / ')}`);
  assert.match(recurring.join('\n'), /Daily collection reminders/);
  assert.match(await screenText('operations'), /Customer data stays private\./);
  const retry = await page.$$eval('#view-operations button', (buttons) => buttons.map((button) => (button as HTMLElement).innerText));
  assert.ok(retry.includes('Retry safely'), retry.join(' | '));
  const before = harness.sent.length;
  await page.evaluate(() => ([...document.querySelectorAll('#view-operations button')].find((button) => (button as HTMLElement).innerText === 'Retry safely') as HTMLElement).click());
  await until(() => harness.sent.slice(before).some((request) => request.method === 'POST'), 'the retry to be sent');
  assert.ok(calls(before).some((call) => /^POST \/api\/operations/.test(call)), calls(before).join(', '));
});

test('Vehicle check: the vehicle number and the bill go to the server, and the answer is in plain words', async () => {
  await open('vehicle');
  const mark = harness.sent.length;
  await page.click('#vehicle-form button[type="submit"]');
  const checked = await harness.requested('/api/vehicles/check', mark);
  const sentBody = JSON.parse(checked.body!) as Record<string, string>;
  assert.match(sentBody.vehicle!, /^[A-Z]{2}\d{2}[A-Z]{1,3}\d{4}$/);
  assert.ok(sentBody.invoice);
  await page.waitForFunction(() => /cannot carry this consignment/.test((document.querySelector('#vehicle-held') as HTMLElement).innerText));
  const held = await textOf(page, '#vehicle-held');
  assert.match(held, /KA05MN9012 · block: This consignment on KA05MN9012 cannot go out as it stands: a two-wheeler cannot carry this consignment\./);
  // A finding that can be answered may be overridden on the owner's authority, with a reason; one that cannot, is not even listed.
  assert.equal(await isShown(page, '#vehicle-override-form'), true);
  const codes = await page.$$eval('#vehicle-override-codes option', (all) => all.map((option) => option.textContent!.trim()));
  assert.deepEqual(codes, ['Nobody has said what this weighs'], 'a two-wheeler that cannot carry the load is not offered');
  assert.match(await screenText('vehicle'), /A vehicle that physically cannot carry the load is not one of them\./);
  assert.match(await screenText('vehicle'), /It changes no weight, no capacity and no government record\./);
  assert.deepEqual(harness.problems, []);
});

test('Purchase check: comparing a month sends the month; a typed row needs the supplier\'s GST number, bill number and value', async () => {
  await open('itc');
  const mark = harness.sent.length;
  await page.click('#itc-form button[type="submit"]');
  const checked = await harness.requested('/api/itc', mark);
  assert.match(JSON.parse(checked.body!).period, /^\d{4}-\d{2}$/);
  await waitForText('itc', 'nothing is claimed, sent or filed|Nothing is claimed, sent or filed');
  assert.match(await screenText('itc'), /This only compares\. Nothing is claimed, sent or filed from this screen\./);
  // The typed row cannot be sent half filled in.
  const beforeTyped = harness.sent.length;
  await page.click('#itc-typed-form button[type="submit"]');
  assert.ok(!calls(beforeTyped).includes('POST /api/itc/typed'));
  const missing = await page.$$eval('#itc-typed-form :invalid', (fields) => fields.map((field) => (field as HTMLInputElement).name));
  for (const name of ['gstin', 'number', 'taxableValue']) assert.ok(missing.includes(name), `${name} is required (missing: ${missing.join(', ')})`);
});

test('Challan: checked first, then issued with a number, then it appears among the challans issued', async () => {
  await open('challan');
  const mark = harness.sent.length;
  await page.click('#challan-form button[type="submit"]');
  const checked = await harness.requested('/api/challans/preview', mark);
  assert.equal(JSON.parse(checked.body!).reason, 'SUPPLY_INVOICE_TO_FOLLOW');
  await page.waitForFunction(() => (document.querySelector('#challan-issue') as HTMLElement | null)?.getClientRects().length);
  assert.match(await screenText('challan'), /Checking saves nothing and uses no number\. The number is given only when you issue it\./);
  assert.match(await screenText('challan'), /Challan checked/);
  assert.ok(!calls(mark).includes('POST /api/challans/issue'), 'checking issues nothing');
  assert.match(await screenText('challan'), /No challan has been issued yet\./);
  await page.click('#challan-issue');
  await harness.requested('/api/challans/issue', mark);
  await waitForText('challan', '[A-Z]+/26-27/\\d+');
  assert.doesNotMatch(await screenText('challan'), /No challan has been issued yet\./);
});

test('a new customer\'s state is filled in from the PIN code, and can still be chosen by hand', async () => {
  await open('payment');
  await page.waitForFunction(() => document.querySelectorAll('[data-draft="payment"] [name="partyId"] option').length > 1);
  await page.select('[data-draft="payment"] [name="partyId"]', '__add__');
  await page.waitForFunction(() => (document.querySelector('#customer-dialog') as HTMLDialogElement).open);
  const mark = harness.sent.length;
  await page.type('#customer-form [name="pincode"]', '411026');
  const asked = await harness.requested('/api/pincode/state', mark);
  assert.equal(JSON.parse(asked.body!).pincode, '411026');
  await page.waitForFunction(() => (document.querySelector('#customer-states') as HTMLSelectElement).value === '27');
  // A PIN code that is not six digits is not even asked about.
  const before = harness.sent.length;
  await page.$eval('#customer-form [name="pincode"]', (input) => { (input as HTMLInputElement).value = ''; });
  await page.type('#customer-form [name="pincode"]', '4110');
  assert.ok(!calls(before).includes('POST /api/pincode/state'));
  await page.keyboard.press('Escape');
});

test('dates fill in as today, except the one that is the business\'s own promise: how long a quotation\'s price holds', async () => {
  await open('presale');
  const today = (await harness.api('/api/dashboard')).today as string;
  assert.equal(await page.$eval('#presale-form [name="date"]', (input) => (input as HTMLInputElement).value), today);
  assert.equal(await page.$eval('#presale-form [name="validUntil"]', (input) => (input as HTMLInputElement).value), '', 'left empty: no promise is made for the shopkeeper');
});

test('Ask: the answer names its source, and it is still on screen — in Hindi — when the language is switched', async () => {
  await open('ask');
  const mark = harness.sent.length;
  await page.type('#ask-question', 'Who owes me money?');
  await page.click('#ask-send');
  const asked = await harness.requested('/api/assistant/ask', mark);
  assert.equal(JSON.parse(asked.body!).question, 'Who owes me money?');
  await waitForText('ask', 'Your customers owe you ₹[\\d,.]+ across 1 customer\\.');
  assert.match(await screenText('ask'), /Where these figures come from/);
  assert.match(await screenText('ask'), /3 records behind it/);
  await page.select('#locale', 'hi-IN');
  await page.waitForFunction(() => /पूछिए/.test((document.querySelector('#view-ask') as HTMLElement).innerText));
  assert.match(await screenText('ask'), /Who owes me money\?/, 'the question asked is still shown');
  assert.match(await screenText('ask'), /मुझे किससे पैसा लेना है\?/, 'the example questions are Hindi');
  await page.select('#locale', 'en-IN');
});

test('Setting up a business reads the full list of states from the server, not twelve typed into the page', async () => {
  await open('setup');
  await page.waitForFunction(() => document.querySelectorAll('#setup-states option').length > 30);
  const names = await page.$$eval('#setup-states option', (all) => all.map((option) => option.textContent!));
  assert.ok(names.some((name) => /Maharashtra/.test(name)) && names.some((name) => /Ladakh/.test(name)) && names.some((name) => /Karnataka/.test(name)));
  assert.ok(harness.sent.some((request) => request.path === '/api/states'));
});
