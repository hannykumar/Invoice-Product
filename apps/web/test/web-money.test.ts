/**
 * Issue #495 — money received and money paid, and the safety of every review dialog, in a real browser.
 *
 * Replaces the source-text checks on "the picker is a list, not a typed name", "Nothing was saved",
 * "Record once", the busy states and the request routes. Each test drives the real forms and asserts
 * what the person reads and what the page sends.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Page } from 'puppeteer';
import { isShown, startPageHarness, textOf, type PageHarness } from './page-harness.ts';

let harness: PageHarness;
let page: Page;

before(async () => { harness = await startPageHarness(); page = await harness.signedIn('payment'); });
after(async () => { await harness?.close(); });

const open = async (view: string) => {
  await page.evaluate((target) => { location.hash = `#${target}`; }, view);
  await page.waitForFunction((target) => document.querySelector('.view.active')?.id === `view-${target}`, {}, view);
};
const dialogOpen = () => page.waitForFunction(() => (document.querySelector('#review-dialog') as HTMLDialogElement).open);
const sentSince = (from: number) => harness.sent.slice(from).map((request) => `${request.method} ${request.path}`);
const bodyOf = (path: string, from = 0) => JSON.parse(harness.sent.slice(from).findLast((request) => request.path === path)!.body!) as Record<string, string>;
const choices = (form: string) => page.$$eval(`${form} [name="partyId"] option`, (options) => options.map((option) => ({ value: (option as HTMLOptionElement).value, text: option.textContent!.trim() })));

test('money received picks a customer from the list and money paid picks a supplier — there is no box to type a name', async () => {
  await page.waitForFunction(() => document.querySelectorAll('[data-draft="payment"] [name="partyId"] option').length > 1);
  const received = await choices('[data-draft="payment"]');
  assert.equal(received[0]!.value, '', 'nobody is chosen until the shopkeeper chooses');
  assert.match(received[0]!.text, /^Choose the customer who paid/);
  assert.ok(received.some((option) => /ABC Traders/.test(option.text)));
  assert.ok(received.every((option) => !/Shree Ram Steels/.test(option.text)), 'a supplier is never offered as the one who paid us');
  assert.equal(await page.$('[data-draft="payment"] input[name="party"], [data-draft="paid"] input[name="party"]'), null);

  await open('paid');
  const paid = await choices('[data-draft="paid"]');
  assert.match(paid[0]!.text, /^Choose the supplier you paid/);
  assert.ok(paid.some((option) => /Shree Ram Steels/.test(option.text)));
  assert.ok(paid.every((option) => !/ABC Traders/.test(option.text)), 'and a customer is never offered as the one we paid');

  // Every way of paying is sent by its own name, in whatever language the screen speaks.
  for (const form of ['[data-draft="payment"]', '[data-draft="paid"]']) {
    assert.deepEqual((await page.$$eval(`${form} [name="method"] option`, (options) => options.map((option) => (option as HTMLOptionElement).value))).sort(), ['BANK_TRANSFER', 'CASH', 'CHEQUE', 'UPI']);
    for (const name of ['chequeNumber', 'chequeDate']) assert.ok(await page.$(`${form} [name="${name}"]`), `${form} has ${name}`);
  }
  await page.select('#locale', 'hi-IN');
  await page.waitForFunction(() => /[ऀ-ॿ]/.test(document.querySelector('[data-draft="paid"] [name="method"] option')!.textContent!));
  assert.deepEqual((await page.$$eval('[data-draft="paid"] [name="method"] option', (options) => options.map((option) => (option as HTMLOptionElement).value))).sort(), ['BANK_TRANSFER', 'CASH', 'CHEQUE', 'UPI'], 'the values stay English even when the words are Hindi');
  await page.select('#locale', 'en-IN');
});

test('choosing a customer reads their open bills; the review asks first, and nothing is recorded until "Record once"', async () => {
  await open('payment');
  const mark = harness.sent.length;
  await page.select('[data-draft="payment"] [name="partyId"]', 'sampoorna:party:customer');
  await page.waitForFunction(() => document.querySelector('[data-draft="payment"] [data-payment-bills]')!.textContent!.trim() !== '');
  assert.ok(sentSince(mark).includes('POST /api/payments/open-bills'));
  assert.equal(bodyOf('/api/payments/open-bills', mark).partyId, 'sampoorna:party:customer');

  await page.type('[data-draft="payment"] [name="amount"]', '500');
  await page.click('[data-draft="payment"] button[type="submit"]');
  await dialogOpen();
  await page.waitForFunction(() => /check it/.test(document.querySelector('#review-title')!.textContent!));
  assert.equal(await textOf(page, '#review-title'), 'Money received — check it');
  assert.match(await textOf(page, '#review-body'), /₹500\.00 will reduce what ABC Traders owes\./);
  assert.equal(await textOf(page, '#review-confirm'), 'Record once');
  assert.ok(sentSince(mark).includes('POST /api/payments/preview'));
  assert.ok(!sentSince(mark).includes('POST /api/payments/record'), 'a review records nothing');

  await page.click('#review-cancel');
  await page.waitForFunction(() => !(document.querySelector('#review-dialog') as HTMLDialogElement).open);
  assert.ok(!sentSince(mark).includes('POST /api/payments/record'), 'Keep editing records nothing either');
  assert.equal(await page.$eval('[data-draft="payment"] [name="amount"]', (input) => (input as HTMLInputElement).value), '500', 'and what was typed is still there');

  // Record: the very same request key as the review, so pressing it twice is one entry, never two.
  await page.click('[data-draft="payment"] button[type="submit"]');
  await dialogOpen();
  await page.waitForFunction(() => /check it/.test(document.querySelector('#review-title')!.textContent!));
  await page.click('#review-confirm');
  await page.waitForFunction(() => /recorded/.test(document.querySelector('#review-title')!.textContent!));
  const preview = bodyOf('/api/payments/preview', mark);
  const record = bodyOf('/api/payments/record', mark);
  assert.match(record.requestId!, /^[0-9a-f-]{36}$/);
  assert.equal(record.requestId, preview.requestId, 'the key rides from the review to the record');
  assert.deepEqual({ ...record, requestId: '' }, { ...preview, requestId: '' }, 'what is recorded is exactly what was checked');
  assert.equal(record.direction, 'RECEIPT');
  assert.equal(record.partyId, 'sampoorna:party:customer');
  assert.equal(record.amount, '500');
  assert.match(await textOf(page, '#review-body'), /₹500\.00 received from ABC Traders is in your books as RECEIPT\//);
  assert.ok(sentSince(mark).includes('POST /api/payments/voucher'), 'the receipt voucher is asked for');
  assert.ok(await isShown(page, '[data-draft="payment"] ~ [data-voucher-panel] iframe, #view-payment [data-voucher-panel]'), 'and shown under the form');
  await page.click('#review-cancel, #review-dialog [data-close-dialog]').catch(() => page.keyboard.press('Escape'));
  assert.deepEqual(harness.problems, []);
});

test('the same request key is never reused for the next entry', async () => {
  await page.keyboard.press('Escape');
  await open('payment');
  await page.select('[data-draft="payment"] [name="partyId"]', 'sampoorna:party:customer');
  await page.$eval('[data-draft="payment"] [name="amount"]', (input) => { (input as HTMLInputElement).value = ''; });
  await page.type('[data-draft="payment"] [name="amount"]', '100');
  const first = harness.sent.length;
  await page.click('[data-draft="payment"] button[type="submit"]');
  await dialogOpen();
  await page.waitForFunction(() => /check it/.test(document.querySelector('#review-title')!.textContent!));
  const key = bodyOf('/api/payments/preview', first).requestId;
  assert.ok(key);
  await page.click('#review-confirm');
  await page.waitForFunction(() => /recorded/.test(document.querySelector('#review-title')!.textContent!));
  assert.equal(bodyOf('/api/payments/record', first).requestId, key);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !(document.querySelector('#review-dialog') as HTMLDialogElement).open);
  await page.select('[data-draft="payment"] [name="partyId"]', 'sampoorna:party:customer');
  await page.$eval('[data-draft="payment"] [name="amount"]', (input) => { (input as HTMLInputElement).value = ''; });
  await page.type('[data-draft="payment"] [name="amount"]', '110');
  const second = harness.sent.length;
  await page.click('[data-draft="payment"] button[type="submit"]');
  await dialogOpen();
  await page.waitForFunction(() => /check it/.test(document.querySelector('#review-title')!.textContent!));
  assert.notEqual(bodyOf('/api/payments/preview', second).requestId, key, 'a new review is a new entry');
  await page.keyboard.press('Escape');
});

test('while the server is checking, the form says it is busy and the dialog cannot be dismissed into a half state', async () => {
  await page.waitForFunction(() => !(document.querySelector('#review-dialog') as HTMLDialogElement).open);
  await open('payment');
  await page.select('[data-draft="payment"] [name="partyId"]', 'sampoorna:party:customer');
  await page.$eval('[data-draft="payment"] [name="amount"]', (input) => { (input as HTMLInputElement).value = ''; });
  await page.type('[data-draft="payment"] [name="amount"]', '250');
  const release = harness.hold('/api/payments/preview');
  await page.click('[data-draft="payment"] button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('[data-draft="payment"]')!.getAttribute('aria-busy') === 'true');
  assert.equal(await page.$eval('[data-draft="payment"] button[type="submit"]', (button) => (button as HTMLButtonElement).disabled), true, 'the button cannot be pressed twice');
  await dialogOpen();
  assert.equal(await page.$eval('#review-dialog', (dialog) => dialog.getAttribute('aria-busy')), 'true');
  assert.equal(await page.$eval('#review-cancel', (button) => (button as HTMLButtonElement).disabled), true, 'Keep editing waits for the answer');
  assert.equal(await isShown(page, '#review-confirm'), false, 'and Record is not offered until there is something to record');
  release();
  await page.waitForFunction(() => !(document.querySelector('#review-confirm') as HTMLElement).hidden);
  assert.equal(await page.$eval('[data-draft="payment"]', (form) => form.getAttribute('aria-busy')), 'false');
  assert.equal(await page.$eval('#review-dialog', (dialog) => dialog.getAttribute('aria-busy')), 'false');
  assert.equal(await page.$eval('#review-cancel', (button) => (button as HTMLButtonElement).disabled), false);
  assert.match(await textOf(page, '#review-body'), /₹250\.00/);
  await page.keyboard.press('Escape');
});

test('a refusal from the server reads "Nothing was saved", in the reader\'s language, and records nothing', async () => {
  await page.waitForFunction(() => !(document.querySelector('#review-dialog') as HTMLDialogElement).open);
  await open('paid');
  await page.select('[data-draft="paid"] [name="partyId"]', 'sampoorna:party:supplier');
  await page.$eval('[data-draft="paid"] [name="amount"]', (input) => { (input as HTMLInputElement).value = ''; });
  await page.type('[data-draft="paid"] [name="amount"]', '250');
  const mark = harness.sent.length;
  await page.click('[data-draft="paid"] button[type="submit"]');
  await dialogOpen();
  await page.waitForFunction(() => document.querySelector('#review-dialog')!.getAttribute('aria-busy') === 'false');
  assert.equal(await textOf(page, '#review-title'), 'Nothing was saved');
  assert.match(await textOf(page, '#review-body'), /^You have no bill from Shree Ram Steels Private Limited yet\./);
  assert.equal(await isShown(page, '#review-confirm'), false, 'there is nothing to record, so no Record button');
  assert.ok(!sentSince(mark).includes('POST /api/payments/record'));
  await page.keyboard.press('Escape');

  // The same refusal for a Hindi reader: the title is Hindi, and still nothing is saved.
  await page.select('#locale', 'hi-IN');
  await page.click('[data-draft="paid"] button[type="submit"]');
  await dialogOpen();
  await page.waitForFunction(() => document.querySelector('#review-dialog')!.getAttribute('aria-busy') === 'false');
  assert.match(await textOf(page, '#review-title'), /[ऀ-ॿ]/);
  assert.notEqual(await textOf(page, '#review-title'), 'Nothing was saved');
  assert.ok(!sentSince(mark).includes('POST /api/payments/record'));
  await page.keyboard.press('Escape');
  await page.select('#locale', 'en-IN');
});
