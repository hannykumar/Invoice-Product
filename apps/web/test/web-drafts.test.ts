/**
 * Issue #495 (replaces #266's and its follow-up's source-slicing harnesses) — a form left half done
 * on this device comes back correctly on another day, and when its lists arrive late.
 *
 * Each test seeds the draft the way the page itself keeps it (localStorage), reloads the real page and
 * reads what the person sees. The late-lists case holds the server's answer on the wire, types while
 * it waits, then lets it through — the situation the old test could only imitate with fake boxes.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Page } from 'puppeteer';
import { isShown, startPageHarness, textOf, type PageHarness } from './page-harness.ts';

let harness: PageHarness;
let page: Page;
let today = '';
let steel = '';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (iso: string) => `${Number(iso.slice(8))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const daysBefore = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

before(async () => {
  harness = await startPageHarness();
  today = (await harness.api('/api/dashboard')).today;
  steel = (await harness.api('/api/catalogue')).items.find((item: any) => item.name === 'TMT Steel Bar 12mm').id;
  page = await harness.signedIn();
});
after(async () => { await harness?.close(); });

/** Leaves a draft on the device, then opens the screen afresh, as a person returning the next day does. */
async function returnTo(flow: string, saved: Record<string, unknown>, hold?: string) {
  await page.evaluate((key, value) => { localStorage.setItem(key, value); }, `karobar.draft.${flow}`, JSON.stringify(saved));
  const release = hold === undefined ? undefined : harness.hold(hold);
  await page.evaluate((target) => { location.hash = `#${target}`; location.reload(); }, flow);
  await page.waitForFunction((target) => document.querySelector('.view.active')?.id === `view-${target}`, {}, flow);
  return release;
}
const form = (flow: string) => `[data-draft="${flow}"]`;
const field = (flow: string, name: string) => `${form(flow)} [name="${name}"]`;
const valueOf = (selector: string) => page.$eval(selector, (box) => (box as HTMLInputElement).value);
const loaded = (flow: string) => page.waitForFunction((selector) => document.querySelectorAll(`${selector} option`).length > 1, {}, field(flow, flow === 'purchase' ? 'supplierId' : flow === 'sale' ? 'party' : 'partyId'));
const note = (flow: string) => page.evaluate((id) => { const box = document.querySelector(id) as HTMLElement; return box.hidden ? null : box.querySelector('[data-note-text]')!.textContent; }, `#${flow}-draft-date-note`);
const stored = (flow: string) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), `karobar.draft.${flow}`);

test('a sale started on an earlier day comes back dated today, with one line saying so', async () => {
  const started = daysBefore(today, 1);
  await returnTo('sale', { party: 'sampoorna:party:customer', date: started, __startedOn: started, __savedOn: started });
  await loaded('sale');
  assert.equal(await valueOf(field('sale', 'date')), today);
  assert.equal(await note('sale'), `This sale was started on ${longDate(started)}. Its date is now today, ${longDate(today)}. Change it only if the goods really left on another day.`);
});

test('a sale dated yesterday on purpose today is left alone when the page is reloaded the same day', async () => {
  const yesterday = daysBefore(today, 1);
  await returnTo('sale', { party: 'sampoorna:party:customer', date: yesterday, __startedOn: today, __savedOn: today });
  await loaded('sale');
  assert.equal(await valueOf(field('sale', 'date')), yesterday);
  assert.equal(await note('sale'), null);
});

test('a supplier bill keeps the supplier\'s own date, and money entries keep the day the money moved — each says so', async () => {
  const started = daysBefore(today, 1);
  const billDate = daysBefore(today, 2);
  await returnTo('purchase', { supplierId: 'sampoorna:party:supplier', reference: 'SRS-101', date: billDate, __startedOn: started, __savedOn: started });
  await loaded('purchase');
  assert.equal(await valueOf(field('purchase', 'date')), billDate, 'the supplier\'s bill date is never changed');
  assert.equal(await note('purchase'), `This supplier bill was started on ${longDate(started)}. Its bill date is kept as ${longDate(billDate)}, because it is the supplier's date. Check it against their bill.`);

  for (const flow of ['payment', 'paid']) {
    await returnTo(flow, { amount: '500', date: started, __startedOn: started, __savedOn: started });
    await loaded(flow);
    assert.equal(await valueOf(field(flow, 'date')), started, `${flow}: the day the money moved is kept`);
    assert.equal(await note(flow), `This entry was started on ${longDate(started)}. Its date is kept as ${longDate(started)}. Change it if the money moved on another day.`);
  }
});

test('the date line is said in Hindi to a Hindi reader, and a cleared form loses it', async () => {
  const started = daysBefore(today, 1);
  await page.select('#locale', 'hi-IN');
  await returnTo('sale', { party: 'sampoorna:party:customer', date: started, __startedOn: started, __savedOn: started });
  await loaded('sale');
  const hindi = await note('sale');
  assert.match(hindi ?? '', /[ऀ-ॿ]/);
  assert.doesNotMatch(hindi ?? '', /was started on/);
  await page.select('#locale', 'en-IN');
  // The form's own "clear" empties the draft and the line with it.
  const clear = await page.$(`${form('sale')} [data-clear-draft], ${form('sale')} button[type="reset"]`);
  if (clear) { await clear.click(); assert.equal(await note('sale'), null); }
});

test('a sale\'s customer and item lines come back even when the lists arrive after the draft is put back', async () => {
  const saved = { party: 'sampoorna:party:customer', reference: 'PO-7', date: today, __lines: [{ item: steel, quantity: '450', rate: '90' }], __startedOn: today, __savedOn: today };
  const release = await returnTo('sale', saved, '/api/catalogue');
  try {
    await page.waitForSelector(field('sale', 'reference'));
    assert.equal(await valueOf(field('sale', 'party')), '', 'the customer list is not here yet, so the box cannot show the customer');
    // Something is typed while the lists are still on their way: the saved customer and lines survive it.
    // (The reference box sits on a later slide, so it is edited as the page's own input event would.)
    await page.$eval(field('sale', 'reference'), (input) => { (input as HTMLInputElement).value = 'PO-7A'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('karobar.draft.sale')!).reference === 'PO-7A');
    const waiting = await stored('sale');
    assert.equal(waiting.party, 'sampoorna:party:customer', 'the customer is kept while waiting');
    assert.deepEqual(waiting.__lines, saved.__lines, 'and so are the lines');
    assert.equal(waiting.reference, 'PO-7A');
  } finally { release!(); }
  await loaded('sale');
  await page.waitForFunction((selector, id) => (document.querySelector(selector) as HTMLSelectElement).value === id, {}, field('sale', 'party'), 'sampoorna:party:customer');
  await page.waitForFunction(() => document.querySelectorAll('#sale-lines [data-line-field="quantity"]').length === 1 && (document.querySelector('#sale-lines [data-line-field="quantity"]') as HTMLInputElement).value === '450');
  assert.equal(await valueOf('#sale-lines [data-line-field="rate"]'), '90');
  assert.match(await valueOf('#sale-lines [data-item-search]'), /TMT Steel Bar 12mm/, 'the item box shows the item by its name');
  const after = await stored('sale');
  assert.equal(after.party, 'sampoorna:party:customer');
  assert.deepEqual(after.__lines.map((line: any) => [line.item, line.quantity, line.rate]), [[steel, '450', '90']], 'the lines on screen are what is saved now');
});

test('a supplier bill gets its supplier, line and GST rate back; money entries get their party; a removed party is let go', async () => {
  await returnTo('purchase', { supplierId: 'sampoorna:party:supplier', reference: 'SRS-101', date: today, __lines: [{ item: steel, quantity: '500', rate: '64', gst: '1800' }], __startedOn: today, __savedOn: today });
  await loaded('purchase');
  await page.waitForFunction(() => (document.querySelector('#purchase-lines [data-line-field="gst"]') as HTMLSelectElement | null)?.value === '1800');
  assert.equal(await valueOf(field('purchase', 'supplierId')), 'sampoorna:party:supplier');
  assert.equal(await valueOf('#purchase-lines [data-line-field="quantity"]'), '500');
  assert.equal(await valueOf('#purchase-lines [data-line-field="rate"]'), '64');

  for (const [flow, party] of [['payment', 'sampoorna:party:customer'], ['paid', 'sampoorna:party:supplier']] as const) {
    await returnTo(flow, { partyId: party, amount: '500', date: today, __startedOn: today, __savedOn: today });
    await loaded(flow);
    assert.equal(await valueOf(field(flow, 'partyId')), party, flow);
  }

  // The list has loaded and the saved customer is no longer on it: it is let go, not kept for ever.
  await returnTo('payment', { partyId: 'removed-long-ago', amount: '500', date: today, __startedOn: today, __savedOn: today });
  await loaded('payment');
  assert.equal(await valueOf(field('payment', 'partyId')), '');
  await page.$eval(field('payment', 'amount'), (input) => { (input as HTMLInputElement).value = ''; });
  await page.type(field('payment', 'amount'), '600');
  assert.equal((await stored('payment')).partyId, '');
  assert.deepEqual(harness.problems, []);
});
