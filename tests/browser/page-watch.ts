/**
 * Issue #495 — watching what a page sends, and making the server say something particular.
 *
 * "Assert behaviour, not source text": a browser spec asserts what a person sees AND what the page
 * sends to the server. `watchPage` keeps the log of the page's own API calls (method, path, body,
 * headers and the status the server answered) plus every uncaught error and console error;
 * `respondWith` answers a route itself (a figure the page could not have worked out, a 404, a 503);
 * `holdRequests` keeps a route waiting so the busy states can be looked at. All three work on the
 * real page against the real server — nothing is stubbed unless a test says so, by name, for one route.
 */
import { expect, type Page, type Request } from "@playwright/test";

export interface SentRequest { readonly method: string; readonly path: string; readonly headers: Readonly<Record<string, string>>; readonly body: string | null; status?: number }

export interface PageWatch {
  /** Every request the page sent to /api/, in order. */
  readonly sent: SentRequest[];
  /** Uncaught page errors and console errors since the page opened. */
  readonly problems: string[];
  /** How many requests have been sent so far — a mark to ask "since then". */
  mark(): number;
  /** "METHOD /path" of the requests sent since `from`. */
  calls(from?: number): string[];
  /** The body of the last request to `path` since `from`, parsed. */
  bodyOf(path: string, from?: number): Record<string, string>;
  /** Waits until the page has sent `path` (after `from`) and the server has answered it. */
  requested(path: string, from?: number): Promise<SentRequest>;
}

export function watchPage(page: Page): PageWatch {
  const sent: SentRequest[] = [];
  const problems: string[] = [];
  const entries = new WeakMap<Request, SentRequest>();
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (!pathname.startsWith("/api/")) return;
    const entry: SentRequest = { method: request.method(), path: pathname, headers: request.headers(), body: request.postData() };
    entries.set(request, entry);
    sent.push(entry);
  });
  page.on("response", (response) => { const entry = entries.get(response.request()); if (entry) entry.status = response.status(); });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  // (Not a failure of the page: a failed resource is a request the test refused, and the bill frames are
  // sandboxed without scripts on purpose — the browser says so when the test harness looks inside them.)
  page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource|Blocked script execution in 'about:(blank|srcdoc)'/.test(message.text())) problems.push(`console: ${message.text()}`); });
  const calls = (from = 0) => sent.slice(from).map((request) => `${request.method} ${request.path}`);
  return {
    sent, problems,
    mark: () => sent.length,
    calls,
    bodyOf: (path, from = 0) => {
      const found = sent.slice(from).findLast((request) => request.path === path);
      if (!found?.body) throw new Error(`the page sent no body to ${path}; it sent ${calls(from).join(", ") || "nothing"}`);
      return JSON.parse(found.body) as Record<string, string>;
    },
    requested: async (path, from = 0) => {
      let found: SentRequest | undefined;
      await expect.poll(() => { found = sent.slice(from).find((request) => request.path === path && request.status !== undefined); return found !== undefined; }, { message: `the page should send ${path}`, timeout: 15_000 }).toBe(true);
      return found!;
    },
  };
}

/** Answers every call to `path` itself. Returns the function that puts the real server back. */
export async function respondWith(page: Page, path: string, reply: { status?: number; body: unknown; method?: string }): Promise<() => Promise<void>> {
  const pattern = (url: URL) => url.pathname === path;
  await page.route(pattern, (route) => {
    if (reply.method !== undefined && route.request().method() !== reply.method) return route.fallback();
    return route.fulfill({ status: reply.status ?? 200, contentType: "application/json", body: JSON.stringify(reply.body) });
  });
  return () => page.unroute(pattern);
}

/** Keeps every call to `path` waiting until `release()`: a slow network. */
export async function holdRequests(page: Page, path: string): Promise<{ release(): Promise<void> }> {
  const pattern = (url: URL) => url.pathname === path;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  await page.route(pattern, async (route) => { await gate; await route.fallback(); });
  return { release: async () => { open(); } };
}
