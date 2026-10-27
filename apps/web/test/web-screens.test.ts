/**
 * Issue #495 — the page's screens, navigation, languages and layout, driven in a real browser.
 *
 * These replace what `web.test.ts` used to check by reading `app.js` and `index.html` as text. A
 * regular expression over the source proves a string exists, not that a button opens its screen.
 * Every check here loads the real page from the real web server, clicks and types like a person,
 * and asserts what the person sees (text, focus, what is shown or hidden, computed layout) and what
 * the page sends to the server. See docs/testing-the-web-app.md.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Page } from 'puppeteer';
import { isShown, startPageHarness, textOf, type PageHarness } from './page-harness.ts';

let harness: PageHarness;
let page: Page;

before(async () => {
  harness = await startPageHarness();
  page = await harness.signedIn();
});
after(async () => { await harness?.close(); });

/** The screen on show, by its id without the `view-` prefix. */
const screenNow = () => page.$eval('.view.active', (view) => view.id.replace(/^view-/, ''));
/** Opens a screen the way an old bookmark does: by its address. */
async function openByAddress(view: string) {
  await page.evaluate((target) => { location.hash = `#${target}`; }, view);
  await page.waitForFunction((target) => document.querySelector('.view.active')?.id === `view-${target}`, {}, view);
}
const tab = (view: string) => `.app-tabbar [data-view="${view}"]`;

test('the page opens signed in with no error, and Home is the first screen', async () => {
  assert.equal(await screenNow(), 'dashboard');
  assert.match(await textOf(page, '#view-dashboard h1'), /^Namaste, /);
  assert.deepEqual(harness.problems, []);
  assert.equal(await isShown(page, '#login-dialog'), false);
});

test('every screen opens from its address, shows exactly one screen, and puts the cursor on its heading', async () => {
  const screens = await page.$$eval('section.view', (sections) => sections.map((section) => section.id.replace(/^view-/, '')));
  assert.ok(screens.length >= 28, `the check must cover the real screens, found ${screens.length}`);
  for (const screen of screens) {
    await openByAddress(screen);
    assert.equal(await page.$$eval('.view.active', (views) => views.length), 1, `${screen}: one screen on show`);
    const heading = await page.$eval(`#view-${screen}`, (view) => {
      const named = document.getElementById(view.getAttribute('aria-labelledby') ?? '');
      return { text: named?.textContent?.trim() ?? '', focused: document.activeElement === view.querySelector('h1'), isH1: named?.tagName === 'H1' };
    });
    assert.ok(heading.isH1 && heading.text !== '', `${screen}: a visible heading names the screen`);
    assert.ok(heading.focused, `${screen}: the heading takes the focus so a screen reader starts there`);
    assert.equal(await page.evaluate(() => location.hash), `#${screen}`);
  }
  // An address nobody knows lands on Home, never on a blank page.
  await page.evaluate(() => { location.hash = '#no-such-screen'; });
  await page.waitForFunction(() => document.querySelector('.view.active')?.id === 'view-dashboard');
  assert.deepEqual(harness.problems, []);
});

test('five tabs — Home, Khata, + Bill, Items, More — are the whole menu, and More reaches every other screen', async () => {
  assert.deepEqual(await page.$$eval('.app-tabbar small', (labels) => labels.map((label) => (label as HTMLElement).innerText)), ['Home', 'Khata', 'Bill', 'Items', 'More']);
  assert.equal(await page.$('.sidebar, .bottom-nav, #menu-button'), null, 'the old 22-item menu is gone');

  await page.click(tab('items'));
  assert.equal(await screenNow(), 'items');
  assert.equal(await page.$eval(tab('items'), (button) => button.getAttribute('aria-current')), 'page', 'the tab for the screen on show is marked');
  assert.equal(await page.$eval(tab('dashboard'), (button) => button.getAttribute('aria-current')), null);

  // Khata is who owes what: it opens Reports on the dues.
  await page.click(tab('reports'));
  assert.equal(await screenNow(), 'reports');
  await page.waitForSelector('#report-dues');

  await page.click(tab('more'));
  assert.equal(await screenNow(), 'more');
  assert.deepEqual(await page.$$eval('#view-more h2', (headings) => headings.map((heading) => (heading as HTMLElement).innerText)), ['GST', 'Stock', 'People', 'Business settings', 'Reports']);

  // No screen was dropped: each is one tap on a tab, a choice on + Bill, or a line on More (the design page has its own address).
  const reachable = await page.$$eval('[data-view]', (links) => [...new Set(links.map((link) => (link as HTMLElement).dataset.view))]);
  const screens = await page.$$eval('section.view', (sections) => sections.map((section) => section.id.replace(/^view-/, '')));
  assert.deepEqual(screens.filter((screen) => !reachable.includes(screen) && screen !== 'design'), []);
  // Every line on More actually opens the screen it names.
  for (const link of await page.$$eval('#view-more [data-view]', (links) => links.map((entry) => (entry as HTMLElement).dataset.view!))) {
    await openByAddress('more');
    await page.evaluate((view) => (document.querySelector(`#view-more [data-view="${view}"]`) as HTMLElement).click(), link);
    assert.equal(await screenNow(), link, `More → ${link}`);
  }
  // The tab for a screen that is not a tab is More.
  assert.equal(await page.$eval('#more-tab', (button) => button.getAttribute('aria-current')), 'page');
});

test('+ Bill, F2 and Alt+N open a new sale from any screen; "Other bills" lists the rest and closes when one is chosen', async () => {
  await openByAddress('dashboard');
  await page.click('#bill-button');
  assert.equal(await screenNow(), 'sale');
  assert.equal(await page.$eval('#bill-button', (button) => button.getAttribute('aria-current')), 'page');

  await openByAddress('items');
  await page.keyboard.press('F2');
  assert.equal(await screenNow(), 'sale');
  await openByAddress('paid');
  await page.keyboard.down('Alt'); await page.keyboard.press('KeyN'); await page.keyboard.up('Alt');
  assert.equal(await screenNow(), 'sale');

  await page.click('#other-bills');
  await page.waitForFunction(() => (document.querySelector('#bill-sheet') as HTMLDialogElement).open);
  const choices = await page.$$eval('#bill-sheet [data-view]', (buttons) => buttons.map((button) => ({ view: (button as HTMLElement).dataset.view, label: (button as HTMLElement).innerText.replace(/^\S+\s+/, ''), disabled: (button as HTMLButtonElement).disabled })));
  assert.deepEqual(choices, [
    { view: 'sale', label: 'Sale', disabled: false }, { view: 'purchase', label: 'Purchase', disabled: false },
    { view: 'payment', label: 'Money received', disabled: false }, { view: 'paid', label: 'Money paid', disabled: false },
    { view: 'presale', label: 'Quotation', disabled: false }, { view: 'returns', label: 'Return', disabled: false },
    { view: 'books', label: 'Expense', disabled: false },
  ]);
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.view), 'sale', 'Sale is the one the cursor starts on');
  for (const choice of choices.slice(1)) {
    await page.click('#other-bills');
    await page.waitForFunction(() => (document.querySelector('#bill-sheet') as HTMLDialogElement).open);
    await page.click(`#bill-sheet [data-view="${choice.view}"]`);
    assert.equal(await screenNow(), choice.view, `Other bills → ${choice.label}`);
    assert.equal(await isShown(page, '#bill-sheet'), false, 'choosing closes the sheet');
    await openByAddress('sale');
  }
});

test('Hindi: every screen and every label speaks Hindi when chosen, and switching back restores English', async () => {
  const labels = () => page.evaluate(() => [...document.querySelectorAll('[data-i18n], [data-i18n-aria], [data-i18n-placeholder]')].map((element) => {
    const box = element as HTMLElement;
    return { key: box.dataset.i18n ?? box.dataset.i18nAria ?? box.dataset.i18nPlaceholder!, text: box.dataset.i18n ? box.textContent!.trim() : box.getAttribute(box.dataset.i18nAria ? 'aria-label' : 'placeholder') ?? '' };
  }));
  await openByAddress('dashboard');
  const english = await labels();
  assert.ok(english.length > 70, `${english.length} translated labels on the page`);
  assert.deepEqual(english.filter((label) => label.text === ''), [], 'every label has English words');

  await page.select('#locale', 'hi-IN');
  await page.waitForFunction(() => /नमस्ते/.test(document.querySelector('#view-dashboard h1')!.textContent!));
  const hindi = await labels();
  assert.deepEqual(hindi.filter((label) => label.text === ''), [], 'every label has Hindi words');
  const byKey = new Map(english.map((label) => [label.key, label.text]));
  // A label that is the same in both languages is a key that fell back to English (a brand or a unit may legitimately match).
  const fellBack = hindi.filter((label) => label.text === byKey.get(label.key) && /[A-Za-z]{4,}/.test(label.text));
  assert.ok(fellBack.length < hindi.length * 0.1, `too many labels still in English: ${[...new Set(fellBack.map((label) => label.key))].join(', ')}`);
  for (const key of ['signOut', 'tabHome', 'tabKhata', 'tabItems', 'tabMore', 'itemsTitle', 'language']) {
    const shown = hindi.find((label) => label.key === key);
    if (shown) assert.match(shown.text, /[ऀ-ॿ]/, `${key} is in Devanagari`);
  }
  assert.match(await page.$eval('#sign-out', (button) => (button as HTMLElement).innerText), /[ऀ-ॿ]/);
  assert.equal(await page.$eval('html', (root) => root.lang), 'hi-IN');
  assert.equal(await page.evaluate(() => localStorage.getItem('karobar.locale')), 'hi-IN', 'the choice is remembered');

  await page.select('#locale', 'en-IN');
  await page.waitForFunction(() => /^Namaste/.test(document.querySelector('#view-dashboard h1')!.textContent!));
  assert.equal(await textOf(page, '#sign-out'), 'Sign out');
});

test('Home is one money card, the tasks that need the owner, and recent bills with a status chip — no old tiles', async () => {
  await openByAddress('dashboard');
  assert.equal(await page.$('.metric-card, .attention-panel'), null);
  await page.waitForFunction(() => document.querySelectorAll('#home-tasks li').length > 0 || !(document.querySelector('#home-all-clear') as HTMLElement).hidden);
  assert.match(await textOf(page, '#home-money-main'), /Sales today/);
  const tasks = await page.$$eval('#home-tasks li', (rows) => rows.map((row) => ({ text: (row as HTMLElement).innerText, button: row.querySelector('button') !== null })));
  assert.ok(tasks.length > 0, 'the demo books have things that need the owner');
  assert.equal(await isShown(page, '#home-all-clear'), false, 'not "all clear" while something is waiting');
  assert.ok(tasks.every((task) => task.button), 'each task offers its one button');
  const bills = await page.$$eval('#home-bills li', (rows) => rows.map((row) => ({ text: (row as HTMLElement).innerText, chip: row.querySelector('.chip')?.className ?? '' })));
  assert.ok(bills.length > 0);
  assert.ok(bills.every((bill) => /\bchip (paid|late|due)\b/.test(bill.chip)), `every bill has a status chip: ${JSON.stringify(bills)}`);
  assert.ok(bills.some((bill) => /late/.test(bill.chip) && /days late/.test(bill.text)), 'an overdue bill says how late it is');
});

test('Home is read again every time it is opened, so a task done elsewhere is gone', async () => {
  await openByAddress('items');
  const mark = harness.sent.length;
  await page.click(tab('dashboard'));
  await harness.requested('/api/dashboard', mark);
  await page.click(tab('items'));
  const again = harness.sent.length;
  await page.click(tab('dashboard'));
  await harness.requested('/api/dashboard', again);
});

test('the Items tab lists every item with what is left, adds one and changes one', async () => {
  await page.click(tab('items'));
  await page.waitForFunction(() => document.querySelectorAll('#items-list li').length >= 2);
  const rows = await page.$$eval('#items-list li', (items) => items.map((item) => (item as HTMLElement).innerText));
  assert.ok(rows.some((row) => /TMT Steel Bar 12mm/.test(row) && /HSN 72142090/.test(row) && /GST 18%/.test(row)), rows.join(' / '));
  assert.ok(rows.every((row) => /left|None left/i.test(row)), 'each item says what is left');

  await page.click('#items-add');
  await page.waitForFunction(() => (document.querySelector('#item-dialog') as HTMLDialogElement).open);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !(document.querySelector('#item-dialog') as HTMLDialogElement).open);

  await page.evaluate(() => (document.querySelector('#items-list li button') as HTMLElement).click());
  await page.waitForFunction(() => (document.querySelector('#item-edit-dialog') as HTMLDialogElement).open);
  assert.ok(await isShown(page, '#item-edit-dialog'));
  await page.keyboard.press('Escape');
});

test('the session is a cookie the page never holds: no token in storage, none sent, and signing out closes the books', async () => {
  const stored = await page.evaluate(() => [...Object.entries(localStorage), ...Object.entries(sessionStorage)]);
  assert.deepEqual(stored.filter(([key, value]) => /session|token|bearer/i.test(key) || /^[A-Za-z0-9_-]{32,}$/.test(value)), [], 'nothing in this browser is a session token');
  assert.equal(await page.evaluate(() => document.cookie), '', 'the session cookie is HttpOnly, so the page cannot read it');
  assert.ok(harness.sent.length > 5);
  assert.ok(harness.sent.every((request) => request.headers.authorization === undefined), 'no request carries a bearer token');
  assert.ok(harness.sent.some((request) => request.path === '/api/auth/sign-in'), 'sign-in went through the real route');

  const before = harness.sent.length;
  await page.click('#sign-out');
  await page.waitForFunction(() => (document.querySelector('#login-dialog') as HTMLDialogElement).open);
  assert.ok(harness.sent.slice(before).some((request) => request.method === 'POST' && request.path === '/api/auth/sign-out'));
  assert.equal(await page.evaluate(() => localStorage.getItem('karobar.signedIn')), null);
  const afterSignOut = await page.evaluate(() => fetch('/api/session', { credentials: 'same-origin' }).then((reply) => reply.status));
  assert.equal(afterSignOut, 401, 'the server no longer knows this browser');
});

test('on a phone the five tabs are a bar at the bottom of the screen; on a desktop they are a rail down the left', async () => {
  const measure = (view: Page) => view.evaluate(() => {
    const bar = document.querySelector('.app-tabbar') as HTMLElement;
    const box = bar.getBoundingClientRect();
    const tabs = [...bar.querySelectorAll('button')].map((button) => button.getBoundingClientRect());
    const bill = getComputedStyle(document.querySelector('.tabbar .tab-main > span')!).backgroundColor;
    const avatar = getComputedStyle(document.querySelector('.topbar-actions .user-avatar')!).display;
    return { top: box.top, bottom: box.bottom, left: box.left, width: box.width, height: box.height, tabSpread: Math.max(...tabs.map((tabBox) => tabBox.top)) - Math.min(...tabs.map((tabBox) => tabBox.top)), viewport: { w: innerWidth, h: innerHeight }, position: getComputedStyle(bar).position, bill, avatar, overflowX: document.documentElement.scrollWidth > innerWidth };
  });
  const phone = await harness.signedIn('', { width: 390, height: 780 });
  const small = await measure(phone);
  assert.equal(small.position, 'fixed');
  assert.ok(Math.abs(small.bottom - small.viewport.h) <= 1, `the bar sits on the bottom edge (${small.bottom} of ${small.viewport.h})`);
  assert.ok(small.width >= small.viewport.w - 1, 'and spans the width');
  assert.ok(small.tabSpread < 24, `all five tabs on one row (the raised + Bill aside), spread ${small.tabSpread}`);
  assert.equal(small.avatar, 'none', 'the avatar makes room on a phone');
  assert.equal(small.overflowX, false, 'the page never scrolls sideways on a phone');
  assert.notEqual(small.bill, 'rgba(0, 0, 0, 0)', '+ Bill is the raised coloured button');
  await phone.close();

  const wide = await measure(page);
  assert.ok(wide.left <= 1 && wide.width < wide.viewport.w / 3, 'a narrow rail at the left edge');
  assert.ok(wide.height > wide.width, 'standing, not lying');
  assert.ok(wide.tabSpread > 150, `five tabs one above the other, spread ${wide.tabSpread}`);
});

test('keyboard focus is always visible, and a person who asked for less motion gets none', async () => {
  await openByAddress('dashboard');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const ring = await page.evaluate(() => { const style = getComputedStyle(document.activeElement!); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth), tag: document.activeElement!.tagName }; });
  assert.ok(ring.style !== 'none' && ring.width > 0, `a focused ${ring.tag} shows an outline`);

  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const motion = await page.evaluate(() => { const style = getComputedStyle(document.querySelector('.action-button, button')!); return { animation: parseFloat(style.animationDuration), transition: parseFloat(style.transitionDuration) }; });
  assert.ok(motion.animation <= 0.001 && motion.transition <= 0.001, `reduced motion: ${JSON.stringify(motion)}`);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);

  await openByAddress('sale');
  assert.ok(await isShown(page, '#sale-save-state, #view-sale .save-state'), 'the "saved on this device" note is never hidden');
});
