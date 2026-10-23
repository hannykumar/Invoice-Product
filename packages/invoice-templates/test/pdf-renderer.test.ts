/**
 * Issue #398 — one shared browser for every PDF, a bounded number of pages, a time limit on each,
 * and JavaScript off in the page.
 *
 * The pool is driven through a fake browser so concurrency, queueing, timeouts and crashes can be
 * forced; the last tests use the real Chromium to show a script in a template never runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PdfRenderer, PdfRenderingError, type PdfBrowser, type PdfPage, type PdfRequest } from '../src/pdf.ts';

const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\nfake');

type FakePage = PdfPage & { readonly calls: string[]; closed: boolean; requestHandler?: (request: PdfRequest) => void };

interface FakeOptions {
  /** Held open until released, to keep renders in flight. */
  readonly hold?: () => Promise<void>;
  readonly setContent?: () => Promise<void>;
  readonly closePage?: () => Promise<void>;
}

function fakeEngine(options: FakeOptions = {}) {
  const state = { launches: 0, rendering: 0, mostAtOnce: 0, pages: [] as FakePage[], browsers: [] as Array<PdfBrowser & { connected: boolean; closed: boolean }> };
  const launch = async (): Promise<PdfBrowser> => {
    state.launches += 1;
    const browser = {
      connected: true,
      closed: false,
      async newPage(): Promise<PdfPage> {
        const page: FakePage = {
          calls: [],
          closed: false,
          async setJavaScriptEnabled(enabled) { page.calls.push(`javascript:${enabled}`); },
          async setRequestInterception(enabled) { page.calls.push(`intercept:${enabled}`); },
          on(_event, handler) { page.requestHandler = handler; return page; },
          async setContent() {
            page.calls.push('content');
            state.rendering += 1;
            state.mostAtOnce = Math.max(state.mostAtOnce, state.rendering);
            try {
              await options.hold?.();
              await options.setContent?.();
            } finally { state.rendering -= 1; }
          },
          async pdf() { page.calls.push('pdf'); return PDF_BYTES; },
          async close() { await options.closePage?.(); page.closed = true; },
        };
        state.pages.push(page);
        return page;
      },
      async close() { browser.connected = false; browser.closed = true; },
    };
    state.browsers.push(browser);
    return browser;
  };
  return { state, launch };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, wait: () => opened };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('#398: many PDFs at once share one browser and never exceed the page limit', async () => {
  const release = gate();
  const engine = fakeEngine({ hold: release.wait });
  const renderer = new PdfRenderer({ launch: engine.launch, maxConcurrentPages: 3, maxWaiting: 20, idleCloseMs: 0 });
  const renders = Array.from({ length: 12 }, (_unused, index) => renderer.render(`<p>bill ${index}</p>`));
  for (let i = 0; i < 5; i += 1) await settle();
  assert.equal(engine.state.rendering, 3, 'only three pages render together; the rest wait');
  release.open();
  const files = await Promise.all(renders);
  assert.equal(files.length, 12);
  for (const file of files) assert.equal(file.subarray(0, 5).toString(), '%PDF-');
  assert.equal(engine.state.launches, 1, 'one browser for all twelve, not twelve browsers');
  assert.equal(engine.state.mostAtOnce, 3);
  assert.equal(engine.state.pages.length, 12);
  assert.ok(engine.state.pages.every((page) => page.closed), 'every page is closed after its render');
  await renderer.close();
});

test('#398: JavaScript is switched off before the bill is loaded into the page', async () => {
  const engine = fakeEngine();
  const renderer = new PdfRenderer({ launch: engine.launch, idleCloseMs: 0 });
  await renderer.render('<p>bill</p>');
  const [page] = engine.state.pages;
  assert.deepEqual(page!.calls, ['javascript:false', 'intercept:true', 'content', 'pdf']);
  await renderer.close();
});

test('#398: the network stays cut off apart from data: URLs', async () => {
  const engine = fakeEngine();
  const renderer = new PdfRenderer({ launch: engine.launch, idleCloseMs: 0 });
  await renderer.render('<p>bill</p>');
  const handler = engine.state.pages[0]!.requestHandler!;
  const answered: string[] = [];
  const request = (url: string): PdfRequest => ({ url: () => url, continue: async () => { answered.push(`continue ${url}`); }, abort: async () => { answered.push(`abort ${url}`); } });
  handler(request('data:image/png;base64,AAAA'));
  handler(request('https://attacker.example.invalid/steal'));
  handler(request('file:///etc/passwd'));
  assert.deepEqual(answered, ['continue data:image/png;base64,AAAA', 'abort https://attacker.example.invalid/steal', 'abort file:///etc/passwd']);
  await renderer.close();
});

test('#398: past the waiting limit a request is turned away at once, and the ones already in line still finish', async () => {
  const release = gate();
  const engine = fakeEngine({ hold: release.wait });
  const renderer = new PdfRenderer({ launch: engine.launch, maxConcurrentPages: 2, maxWaiting: 3, idleCloseMs: 0 });
  const accepted = Array.from({ length: 5 }, () => renderer.render('<p>bill</p>'));
  await assert.rejects(renderer.render('<p>one too many</p>'), (error: unknown) => {
    assert.ok(error instanceof PdfRenderingError);
    assert.equal(error.message, 'The PDF could not be produced.');
    assert.match(String((error.cause as Error).message), /Too many PDFs/);
    return true;
  });
  release.open();
  assert.equal((await Promise.all(accepted)).length, 5);
  assert.equal(engine.state.launches, 1);
  await renderer.close();
});

test('#398: a render that hangs is stopped at the time limit, its page is closed and the slot is freed', async () => {
  let hang = true;
  const engine = fakeEngine({ setContent: () => hang ? new Promise<void>(() => {}) : Promise.resolve() });
  const renderer = new PdfRenderer({ launch: engine.launch, maxConcurrentPages: 1, maxWaiting: 1, renderTimeoutMs: 50, idleCloseMs: 0 });
  const started = Date.now();
  await assert.rejects(renderer.render('<p>stuck</p>'), PdfRenderingError);
  assert.ok(Date.now() - started < 2_000, 'the caller is not kept waiting past the limit');
  assert.equal(engine.state.pages[0]!.closed, true);
  hang = false;
  const file = await renderer.render('<p>next</p>');
  assert.equal(file.subarray(0, 5).toString(), '%PDF-');
  assert.equal(engine.state.launches, 1, 'one slow bill does not cost the browser');
  await renderer.close();
});

test('#398: a browser that cannot even close a page is replaced on the next render', async () => {
  let stuck = true;
  const engine = fakeEngine({
    setContent: () => stuck ? new Promise<void>(() => {}) : Promise.resolve(),
    closePage: () => stuck ? new Promise<void>(() => {}) : Promise.resolve(),
  });
  const renderer = new PdfRenderer({ launch: engine.launch, renderTimeoutMs: 30, idleCloseMs: 0 });
  await assert.rejects(renderer.render('<p>stuck</p>'), PdfRenderingError);
  stuck = false;
  await renderer.render('<p>next</p>');
  assert.equal(engine.state.launches, 2);
  assert.equal(engine.state.browsers[0]!.closed, true, 'the stuck browser is shut down');
  await renderer.close();
});

test('#398: a browser that failed to start is tried again on the next request, not remembered as broken', async () => {
  const engine = fakeEngine();
  let failNext = true;
  const renderer = new PdfRenderer({
    launch: async () => {
      if (failNext) { failNext = false; throw new Error('Could not find Chrome (cache path /root/.cache/puppeteer)'); }
      return engine.launch();
    },
    idleCloseMs: 0,
  });
  await assert.rejects(renderer.render('<p>bill</p>'), (error: unknown) => error instanceof PdfRenderingError && error.message === 'The PDF could not be produced.');
  const file = await renderer.render('<p>bill</p>');
  assert.equal(file.subarray(0, 5).toString(), '%PDF-');
  assert.equal(engine.state.launches, 1);
  await renderer.close();
});

test('#398: a browser that crashed is replaced once, even when several renders find it dead together', async () => {
  const engine = fakeEngine();
  const renderer = new PdfRenderer({ launch: engine.launch, maxConcurrentPages: 4, idleCloseMs: 60_000 });
  await renderer.render('<p>first</p>');
  engine.state.browsers[0]!.connected = false;
  await Promise.all([renderer.render('<p>a</p>'), renderer.render('<p>b</p>'), renderer.render('<p>c</p>')]);
  assert.equal(engine.state.launches, 2);
  await renderer.close();
});

test('#398: an idle browser is closed after a while and a fresh one starts for the next bill', async () => {
  const engine = fakeEngine();
  const renderer = new PdfRenderer({ launch: engine.launch, idleCloseMs: 20 });
  await renderer.render('<p>bill</p>');
  await Promise.all([renderer.render('<p>b</p>'), renderer.render('<p>c</p>')]);
  assert.equal(engine.state.launches, 1, 'back-to-back bills reuse the browser');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(engine.state.browsers[0]!.closed, true);
  await renderer.render('<p>later</p>');
  assert.equal(engine.state.launches, 2);
  await renderer.close();
  assert.equal(engine.state.browsers[1]!.closed, true);
});

test('#398: limits that make no sense are refused when the renderer is built', () => {
  assert.throws(() => new PdfRenderer({ maxConcurrentPages: 0 }), RangeError);
  assert.throws(() => new PdfRenderer({ maxWaiting: -1 }), RangeError);
  assert.throws(() => new PdfRenderer({ renderTimeoutMs: 1.5 }), RangeError);
});

/** A PDF's page count: each page object is `/Type /Page`, the page tree is `/Type /Pages`. */
const pageCount = (file: Buffer): number => (file.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;

const SCRIPT_THAT_ADDS_PAGES = `<!doctype html><html><head><style>@page { size: A4; margin: 10mm } .sheet { break-after: page }</style></head>
<body><p>Bill INV/26-27/000398</p>
<script>for (let i = 0; i < 9; i += 1) { const sheet = document.createElement('div'); sheet.className = 'sheet'; sheet.textContent = 'added by script ' + i; document.body.appendChild(sheet); }</script>
<img src="x" onerror="document.body.appendChild(Object.assign(document.createElement('div'), { className: 'sheet', textContent: 'onerror ran' }))">
</body></html>`;

test('#398: in the real browser a script slipped into a template does not run', async (context) => {
  const renderer = new PdfRenderer({ idleCloseMs: 0 });
  context.after(() => renderer.close());
  const file = await renderer.render(SCRIPT_THAT_ADDS_PAGES);
  assert.equal(file.subarray(0, 5).toString(), '%PDF-');
  assert.equal(pageCount(file), 1, 'the script would have added nine more pages');
});

test('#398: in the real browser parallel bills come out of one browser, each a whole PDF', async (context) => {
  const renderer = new PdfRenderer({ maxConcurrentPages: 2, maxWaiting: 8, idleCloseMs: 0 });
  context.after(() => renderer.close());
  const files = await Promise.all(Array.from({ length: 6 }, (_unused, index) => renderer.render(`<!doctype html><p>Bill ${index}</p>`)));
  for (const file of files) {
    assert.equal(file.subarray(0, 5).toString(), '%PDF-');
    assert.equal(pageCount(file), 1);
  }
});
