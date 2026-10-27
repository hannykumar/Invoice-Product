/**
 * Issue #495 — one way to open the real page in a real browser against the real web server, for
 * every test that must prove what a person sees and what the page sends (never what app.js says).
 *
 * The server is the real `webServer` on an ephemeral port with the demo company (in-memory books,
 * as `npm test` has no database). Requests to anywhere but that server are refused, so nothing
 * leaves this machine; the web fonts have system fallbacks. Sign-in goes through the real dialog.
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import puppeteer, { type Browser, type HTTPRequest, type Page } from 'puppeteer';
import { webServer } from '../server.ts';
import { signInInBrowser, signInOverHttp } from '../../api/test/sign-in-helper.ts';

export interface SentRequest { readonly method: string; readonly path: string; readonly headers: Readonly<Record<string, string>>; readonly body: string | undefined; status?: number; }

export interface PageHarness {
  readonly base: string;
  readonly browser: Browser;
  /** Every request the page itself sent to the server, in order (page navigations and files excluded). */
  readonly sent: SentRequest[];
  /** Uncaught page errors and console errors since the page was opened. */
  readonly problems: string[];
  /** Opens a new signed-out page with the request log wired up. */
  newPage(options?: { width?: number; height?: number }): Promise<Page>;
  /** A fresh page signed in through the real dialog (the demo owner), on `#hash`. */
  signedIn(hash?: string, options?: { width?: number; height?: number }): Promise<Page>;
  /** Resolves when the page has sent a request to `path` (after the first `from` requests) and the server has answered it; rejects after `timeoutMs`. */
  requested(path: string, from?: number, timeoutMs?: number): Promise<SentRequest>;
  /**
   * Holds every request to `path` (a pathname) until the returned function is called: a slow
   * network, so a test can look at the page while it waits for an answer.
   */
  hold(path: string): () => void;
  /** Server calls made as the demo owner, to arrange records a screen then shows. */
  api(path: string, body?: Record<string, unknown>): Promise<Record<string, any>>;
  close(): Promise<void>;
}

export async function startPageHarness(): Promise<PageHarness> {
  await new Promise<void>((resolve) => webServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(webServer.address() as AddressInfo).port}`;
  const cookie = await signInOverHttp(base);
  const browser = await puppeteer.launch({ headless: true, args: process.env.GITHUB_ACTIONS === 'true' ? ['--no-sandbox'] : [] });
  const sent: SentRequest[] = [];
  const problems: string[] = [];
  const entries = new WeakMap<HTTPRequest, SentRequest>();
  const holds = new Map<string, Promise<void>>();

  const newPage = async (options: { width?: number; height?: number } = {}) => {
    const page = await browser.newPage();
    await page.setViewport({ width: options.width ?? 1280, height: options.height ?? 900 });
    await page.setRequestInterception(true);
    page.on('request', async (request: HTTPRequest) => {
      const url = request.url();
      if (!url.startsWith(base) && !url.startsWith('data:') && !url.startsWith('about:')) return void request.abort();
      const { pathname } = new URL(url);
      if (pathname.startsWith('/api/')) {
        const entry: SentRequest = { method: request.method(), path: pathname, headers: request.headers(), body: request.postData() };
        entries.set(request, entry);
        sent.push(entry);
      }
      await holds.get(pathname);
      void request.continue().catch(() => undefined);
    });
    page.on('response', (response) => { const entry = entries.get(response.request()); if (entry) entry.status = response.status(); });
    page.on('pageerror', (error) => problems.push(`pageerror: ${error instanceof Error ? error.message : String(error)}`));
    page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) problems.push(`console: ${message.text()}`); });
    return page;
  };

  const signedIn = async (hash = '', options: { width?: number; height?: number } = {}) => {
    const page = await newPage(options);
    await page.goto(`${base}/${hash === '' ? '' : `#${hash}`}`, { waitUntil: 'load' });
    await signInInBrowser(page);
    await page.waitForFunction(() => document.querySelector('#view-dashboard') !== null && !(document.querySelector('#login-dialog') as HTMLDialogElement).open);
    return page;
  };

  const api = async (path: string, body?: Record<string, unknown>) => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: base },
      body: body === undefined ? null : JSON.stringify(body),
    });
    const reply = await response.json() as Record<string, any>;
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(reply)}`);
    return reply;
  };

  return {
    base, browser, sent, problems, newPage, signedIn, api,
    requested: (path, from = 0, timeoutMs = 15_000) => new Promise<SentRequest>((resolve, reject) => {
      const started = Date.now();
      const look = () => {
        const found = sent.slice(from).find((request) => request.path === path && request.status !== undefined);
        if (found) resolve(found);
        else if (Date.now() - started > timeoutMs) reject(new Error(`the page never sent ${path}; it sent ${sent.slice(from).map((request) => request.path).join(', ')}`));
        else setTimeout(look, 25);
      };
      look();
    }),
    hold: (path) => {
      let release = () => {};
      holds.set(path, new Promise<void>((resolve) => { release = () => { holds.delete(path); resolve(); }; }));
      return release;
    },
    close: async () => { await browser.close(); await new Promise<void>((resolve) => webServer.close(() => resolve())); },
  };
}

/** Text a person reads in an element. */
export const textOf = (page: Page, selector: string) => page.$eval(selector, (element) => (element as HTMLElement).innerText.trim());
/** True when an element exists and is not hidden or inside a closed dialog. */
export const isShown = (page: Page, selector: string) => page.$eval(selector, (element) => { const box = element as HTMLElement; return !box.hidden && box.getClientRects().length > 0; }).catch(() => false);
