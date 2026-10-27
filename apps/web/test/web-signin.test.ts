/**
 * Issue #495 — the first thing anyone meets: the sign-in. Each case is a visitor who has never been
 * here (their own cookies and storage), and what they see.
 *
 * Replaces the source-text checks on the automatic tester sign-in (the owner's request), the
 * invitation link, the HttpOnly session and "no password box"; and the connection banner (#312).
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { isShown, startPageHarness, textOf, until, type PageHarness } from './page-harness.ts';

let harness: PageHarness;

before(async () => { harness = await startPageHarness(); });
after(async () => { await harness?.close(); });

const dialogIsOpen = (page: import('puppeteer').Page) => page.$eval('#login-dialog', (dialog) => (dialog as HTMLDialogElement).open);

test('a visitor meets the sign-in dialog, which asks for an address and a code — never a password', async () => {
  const page = await harness.newPage({ isolated: true });
  await page.goto(`${harness.base}/`);
  await page.waitForFunction(() => (document.querySelector('#login-dialog') as HTMLDialogElement).open);
  assert.equal(await page.$('input[type="password"]'), null, 'there is no password box anywhere on the page');
  assert.equal(await isShown(page, '#login-form [name="address"]'), true);
  assert.equal(await isShown(page, '#login-form [name="code"]'), false, 'the code is asked for after the address, not before');
  // The help text is tied to the dialog for a screen reader.
  assert.ok(await page.$eval('#login-dialog', (dialog) => dialog.getAttribute('aria-labelledby')));
  assert.equal(await page.$eval('#login-dialog', (dialog) => dialog.getAttribute('aria-describedby')), 'login-help');
  assert.notEqual(await textOf(page, '#login-help'), '');
  // Hindi, before anyone is signed in.
  await page.select('#locale', 'hi-IN');
  assert.match(await textOf(page, '#login-title'), /[ऀ-ॿ]/);
  assert.notEqual(await textOf(page, '#login-title'), 'Sign in');
  await page.select('#locale', 'en-IN');

  // The session is a cookie the page cannot read, set by the server — the page never holds a token.
  const { signInInBrowser } = await import('../../api/test/sign-in-helper.ts');
  await signInInBrowser(page);
  assert.equal(await dialogIsOpen(page), false);
  assert.equal(await page.evaluate(() => document.cookie), '');
  const cookies = await page.cookies();
  const session = cookies.find((cookie) => cookie.name === '__Host-karobar_session');
  assert.ok(session, 'the server set the session cookie');
  assert.equal(session.httpOnly, true, 'which scripts cannot read');
  assert.equal(session.secure, true);
  assert.equal(session.sameSite, 'Lax');
  assert.ok(harness.sent.filter((request) => request.path.startsWith('/api/')).every((request) => request.headers.authorization === undefined));
  await page.browserContext().close();
});

test('on a developer\'s machine the page signs in as the tester by itself — no dialog, no code', async () => {
  const page = await harness.newPage({ isolated: true });
  const mark = harness.sent.length;
  // The server says the tester route is on offer (as it does on a developer's machine); the real server then signs in.
  const restore = harness.respond('/api/auth/tester', { method: 'GET', body: { automatic: true } });
  try {
    await page.goto(`${harness.base}/`);
    await harness.requested('/api/dashboard', mark);
    await page.waitForFunction(() => document.querySelector('#view-dashboard h1')!.textContent!.startsWith('Namaste'));
  } finally { restore(); }
  assert.equal(await dialogIsOpen(page), false, 'nobody met the sign-in dialog');
  const after = harness.sent.slice(mark).map((request) => `${request.method} ${request.path}`);
  assert.ok(after.includes('POST /api/auth/tester'));
  assert.ok(!after.includes('POST /api/auth/code'), 'and nobody was asked for a code');
  await page.browserContext().close();
});

test('where the tester route is not there (a shop\'s real server answers 404), the page asks for the address and shows no tester button', async () => {
  const page = await harness.newPage({ isolated: true });
  const restore = harness.respond('/api/auth/tester', { status: 404, body: { error: 'not found' } });
  try {
    await page.goto(`${harness.base}/`);
    await page.waitForFunction(() => (document.querySelector('#login-dialog') as HTMLDialogElement).open);
    await harness.requested('/api/auth/tester');
    assert.equal(await isShown(page, '#login-tester'), false);
  } finally { restore(); await page.browserContext().close(); }
});

test('an invitation link is taken up by its own sign-in, never by the automatic tester', async () => {
  const page = await harness.newPage({ isolated: true });
  const mark = harness.sent.length;
  // Even where the tester route is on offer, a person who followed an invitation signs in as themselves.
  const restore = harness.respond('/api/auth/tester', { method: 'GET', body: { automatic: true } });
  try {
    await page.goto(`${harness.base}/#join=invite-token-for-a-test`);
    await page.waitForFunction(() => (document.querySelector('#login-dialog') as HTMLDialogElement).open);
    await harness.requested('/api/auth/tester', mark);
  } finally { restore(); }
  assert.equal(harness.sent.slice(mark).filter((request) => request.method === 'POST' && request.path === '/api/auth/tester').length, 0);
  assert.equal(await dialogIsOpen(page), true);
  assert.match(await textOf(page, '#login-help'), /invit/i, 'the dialog says it is for an invitation');
  assert.equal(await page.evaluate(() => location.hash), '#dashboard', 'the invitation token leaves the address bar');
  await page.browserContext().close();
});

test('the connection banner is hidden while the shop answers and appears, in plain words, only when it does not', async () => {
  const page = await harness.signedIn();
  assert.equal(await isShown(page, '#connection-banner'), false);
  const restore = harness.respond('/api/dashboard', { status: 503, body: { error: { code: 'UNAVAILABLE', message: 'down' } } });
  try {
    await page.evaluate(() => { location.hash = '#items'; location.hash = '#dashboard'; });
    await page.reload();
    await page.waitForFunction(() => !(document.querySelector('#connection-banner') as HTMLElement).hidden);
    assert.equal(await textOf(page, '#connection-banner strong'), 'Nothing was saved');
    assert.match(await textOf(page, '#connection-banner'), /That did not work, and nothing was changed\. Please try again\./);
    assert.equal(await page.$eval('#connection-banner', (banner) => banner.getAttribute('role')), 'status');
  } finally { restore(); }
  await page.reload();
  await page.waitForFunction(() => (document.querySelector('#connection-banner') as HTMLElement).hidden);
});
