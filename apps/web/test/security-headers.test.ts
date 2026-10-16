/**
 * Issue #349 — the page under its content policy, in a real browser: every file the page loads
 * carries the security headers, the app signs in and draws a bill with no policy violation, a name
 * typed as `<script>alert(1)</script>` shows as text and runs nothing, and a script slipped into a
 * bill frame is blocked by the policy itself.
 *
 * Nothing leaves this machine: requests to anywhere but the local server are refused (the web
 * fonts have system fallbacks).
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { webServer } from '../server.ts';
import { HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS, SECURITY_HEADERS } from '../../api/src/http-hardening.ts';
import { signInInBrowser, signInOverHttp } from '../../api/test/sign-in-helper.ts';

const HOSTILE = '<script>alert(1)</script><img src=x onerror=alert(2)>';

let base = '';
let browser: Browser;
let page: Page;
const dialogs: string[] = [];
const violations: string[] = [];

before(async () => {
  await new Promise<void>((resolve) => webServer.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(webServer.address() as AddressInfo).port}`;
  browser = await puppeteer.launch({ headless: true, args: process.env.GITHUB_ACTIONS === 'true' ? ['--no-sandbox'] : [] });
  page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (request) => { if (request.url().startsWith(base) || request.url().startsWith('data:')) void request.continue(); else void request.abort(); });
  page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  page.on('console', (message) => { if (/Content Security Policy/i.test(message.text())) violations.push(message.text()); });
  await page.evaluateOnNewDocument(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as unknown as { __violations: string[] }).__violations ??= [];
      (window as unknown as { __violations: string[] }).__violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
});

after(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => webServer.close(() => resolve()));
});

test('the page, its scripts and styles, and the API all carry every security header', async () => {
  for (const path of ['/', '/app.js', '/styles.css', '/sale-slides.js', '/api/status', '/no-such-page']) {
    const response = await fetch(`${base}${path}`, { method: 'HEAD' });
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(response.headers.get(name), value, `${name} on ${path}`);
  }
  assert.equal(webServer.requestTimeout, REQUEST_TIMEOUT_MS);
  assert.equal(webServer.headersTimeout, HEADERS_TIMEOUT_MS);
});

test('the app signs in and draws a bill under the policy, and a hostile name stays text', async () => {
  const cookie = await signInOverHttp(base);
  const added = await fetch(`${base}/api/customers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: base },
    body: JSON.stringify({ legalName: HOSTILE, registration: 'unregistered', line1: HOSTILE, city: 'Pune', pincode: '411026' }),
  });
  assert.equal(added.status, 200, await added.text());

  await page.goto(`${base}/#sale`, { waitUntil: 'load' });
  await signInInBrowser(page);
  // The customer list now holds the hostile name: it must be an option's text, not markup.
  await page.waitForFunction((name) => [...document.querySelectorAll('option')].some((option) => option.textContent === name), {}, HOSTILE);

  // The bill design screen draws a whole printed bill in an `srcdoc` frame, inline styles and all.
  await page.evaluate(() => { location.hash = 'branding'; });
  await page.waitForFunction(() => ((document.querySelector('#branding-preview') as HTMLIFrameElement | null)?.srcdoc ?? '').length > 1000);
  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.deepEqual(dialogs, [], 'nothing typed into a field ran as script');
  assert.deepEqual(await page.evaluate(() => (window as unknown as { __violations?: string[] }).__violations ?? []), []);
  assert.deepEqual(violations, []);
});

test('a script slipped into a bill frame is stopped by the policy, not just by escaping', async () => {
  await page.evaluate(() => {
    const frame = document.querySelector('#branding-preview') as HTMLIFrameElement;
    frame.srcdoc = '<p>bill</p><script>parent.__ran = true</script><img src=x onerror="parent.__ran = true">';
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await page.evaluate(() => (window as unknown as { __ran?: boolean }).__ran), undefined);
  assert.ok(violations.some((text) => /script-src/.test(text)), `a policy violation was reported: ${violations.join(' | ')}`);
});
