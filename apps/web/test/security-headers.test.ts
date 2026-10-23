/**
 * Issue #349 — the page under its content policy, in a real browser: every file the page loads
 * carries the security headers, the app signs in and draws a bill with no policy violation, a name
 * typed as `<script>alert(1)</script>` shows as text and runs nothing, and a script slipped into a
 * bill frame is blocked by the policy itself. Issue #399 — the bill frame's sandbox blocks that
 * script too with the policy switched off, and the page can still print the frame.
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
    // Take the #399 sandbox off so this proves the policy on its own.
    frame.removeAttribute('sandbox');
    frame.srcdoc = '<p>bill</p><script>parent.__ran = true</script><img src=x onerror="parent.__ran = true">';
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await page.evaluate(() => (window as unknown as { __ran?: boolean }).__ran), undefined);
  assert.ok(violations.some((text) => /script-src/.test(text)), `a policy violation was reported: ${violations.join(' | ')}`);
});

test('with the policy switched off, the bill frame sandbox still stops a script and the page can still print it', async () => {
  const loose = await browser.newPage();
  try {
    await loose.setBypassCSP(true);
    await loose.setRequestInterception(true);
    loose.on('request', (request) => { if (request.url().startsWith(base) || request.url().startsWith('data:')) void request.continue(); else void request.abort(); });
    loose.on('dialog', (dialog) => { void dialog.dismiss(); });
    await loose.goto(`${base}/`, { waitUntil: 'load' });
    await loose.evaluate(() => { localStorage.setItem('karobar.session', 'stand-in-session'); });

    const hostile = '<p>bill</p><script>parent.__ran = localStorage.getItem("karobar.session") ?? "ran"</script><img src=x onerror="parent.__ran = \'img\'">';
    const ran = async (sandboxed: boolean) => {
      await loose.evaluate((html, keepSandbox) => {
        const page = window as unknown as { __ran?: string };
        delete page.__ran;
        const frame = document.querySelector('#branding-preview') as HTMLIFrameElement;
        if (!keepSandbox) frame.removeAttribute('sandbox');
        frame.srcdoc = html;
      }, hostile, sandboxed);
      await new Promise((resolve) => setTimeout(resolve, 500));
      return loose.evaluate(() => (window as unknown as { __ran?: string }).__ran);
    };

    assert.equal(await loose.evaluate(() => document.querySelector('#branding-preview')?.getAttribute('sandbox')), 'allow-same-origin allow-modals');
    assert.equal(await ran(true), undefined, 'a script inside the sandboxed bill frame ran');

    await loose.evaluate(() => {
      const frame = document.querySelector('#note-frame') as HTMLIFrameElement;
      frame.srcdoc = '<p>Printed note</p>';
    });
    await loose.waitForFunction(() => (document.querySelector('#note-frame') as HTMLIFrameElement).contentDocument?.body?.textContent === 'Printed note');
    // Printing is `contentWindow.print()` from the page: it must reach the frame and not be refused.
    const refused: string[] = [];
    loose.on('console', (message) => { if (/print\(\)/.test(message.text())) refused.push(message.text()); });
    assert.equal(await loose.evaluate(() => {
      try { (document.querySelector('#note-frame') as HTMLIFrameElement).contentWindow!.print(); return 'printed'; } catch (error) { return String(error); }
    }), 'printed', 'the page could not reach the bill frame to print it');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(refused, [], 'the browser refused to print the sandboxed bill frame');

    // The same page with the sandbox taken off does run it, so the check above is not vacuous.
    assert.ok(await ran(false), 'without a sandbox and with the policy off the script should have run');
  } finally {
    await loose.close();
  }
});
