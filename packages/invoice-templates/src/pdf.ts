import puppeteer from 'puppeteer';
import { renderCreditNote, renderEwayBill, renderInvoice, renderInvoiceCopies, type RenderOptions } from './render.ts';
import type { CreditNoteDocument } from './credit-note.ts';
import type { InvoiceDocument, TemplateSnapshot } from './document.ts';
import type { PageFormat } from './template.ts';
import type { Locale } from './document.ts';
import type { EwayBillRecord, Movement } from '@invoice/transport';

/**
 * The browser engine could not make the PDF: a fault on our side, not something the shopkeeper did
 * or can fix. Its own message (paths, versions) is kept as the cause, for the log only (#344).
 */
export class PdfRenderingError extends Error {
  constructor(cause: unknown) {
    super('The PDF could not be produced.', { cause });
    this.name = 'PdfRenderingError';
  }
}

/** The few things a render needs from a browser page; puppeteer's `Page` is one. */
export interface PdfPage {
  setJavaScriptEnabled(enabled: boolean): Promise<void>;
  setRequestInterception(enabled: boolean): Promise<void>;
  on(event: 'request', handler: (request: PdfRequest) => void): unknown;
  setContent(html: string, options: { waitUntil: 'load'; timeout: number }): Promise<void>;
  pdf(options: { preferCSSPageSize: boolean; printBackground: boolean; timeout: number }): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface PdfRequest {
  url(): string;
  continue(): Promise<void>;
  abort(): Promise<void>;
}

/** The few things the pool needs from a browser; puppeteer's `Browser` is one. */
export interface PdfBrowser {
  readonly connected: boolean;
  newPage(): Promise<PdfPage>;
  close(): Promise<void>;
}

export interface PdfRendererOptions {
  /** Starts the browser engine. Called once, then again only after the browser died or was closed for being idle. */
  readonly launch?: () => Promise<PdfBrowser>;
  /** How many pages may render at the same time in the one browser. */
  readonly maxConcurrentPages?: number;
  /** How many more requests may wait for a free page; past that a request is turned away at once. */
  readonly maxWaiting?: number;
  /** How long one render may take, from opening its page to the finished file. */
  readonly renderTimeoutMs?: number;
  /** How long the browser stays up with nothing to print before it is closed. */
  readonly idleCloseMs?: number;
}

// GitHub runners disable Chromium's user-namespace sandbox; the runner itself is isolated.
const launchChromium = async (): Promise<PdfBrowser> =>
  await puppeteer.launch({ headless: true, args: process.env.GITHUB_ACTIONS === 'true' ? ['--no-sandbox'] : [] });

class RenderTimedOut extends Error {
  constructor(milliseconds: number) {
    super(`The render took longer than ${milliseconds} ms.`);
    this.name = 'RenderTimedOut';
  }
}

const within = <T>(work: Promise<T>, milliseconds: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new RenderTimedOut(milliseconds)), milliseconds); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
};

/**
 * Issue #398 — one browser for every PDF, a bounded number of pages in it, a time limit on each.
 *
 * Starting a Chromium per request let a burst of `GET …/pdf` calls run the server out of memory
 * and stop billing for every shop on it. Now the browser is started once and shared; at most
 * `maxConcurrentPages` render together, at most `maxWaiting` more queue, and the rest are turned
 * away at once. JavaScript is off in every page: the templates are plain HTML and CSS, so a
 * slip in escaping can at worst misprint text, never run script on the server. The network stays
 * cut off except for `data:` URLs. Per-user rate limits are #350's.
 */
export class PdfRenderer {
  readonly #launch: () => Promise<PdfBrowser>;
  readonly #maxConcurrentPages: number;
  readonly #maxWaiting: number;
  readonly #renderTimeoutMs: number;
  readonly #idleCloseMs: number;
  #browser: Promise<PdfBrowser> | undefined;
  #rendering = 0;
  readonly #waiting: Array<() => void> = [];
  #idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: PdfRendererOptions = {}) {
    this.#launch = options.launch ?? launchChromium;
    this.#maxConcurrentPages = positive(options.maxConcurrentPages ?? 2, 'maxConcurrentPages');
    this.#maxWaiting = atLeastZero(options.maxWaiting ?? 16, 'maxWaiting');
    this.#renderTimeoutMs = positive(options.renderTimeoutMs ?? 20_000, 'renderTimeoutMs');
    this.#idleCloseMs = atLeastZero(options.idleCloseMs ?? 5_000, 'idleCloseMs');
  }

  /** One page of HTML to PDF bytes. Any failure, a full queue or a timeout is a `PdfRenderingError`. */
  async render(html: string): Promise<Buffer> {
    try { await this.#takePage(); } catch (error) { throw new PdfRenderingError(error); }
    try {
      return await this.#renderOn(html);
    } catch (error) {
      throw new PdfRenderingError(error);
    } finally {
      this.#givePageBack();
    }
  }

  /** Close the shared browser now (shutdown, tests). The next render starts a fresh one. */
  async close(): Promise<void> {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    await this.#discardBrowser();
  }

  async #takePage(): Promise<void> {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    if (this.#rendering < this.#maxConcurrentPages) { this.#rendering += 1; return; }
    if (this.#waiting.length >= this.#maxWaiting) throw new Error('Too many PDFs are already waiting to be made.');
    // The slot is handed over by #givePageBack without being released in between.
    await new Promise<void>((resolve) => { this.#waiting.push(resolve); });
  }

  #givePageBack(): void {
    const next = this.#waiting.shift();
    if (next) { next(); return; }
    this.#rendering -= 1;
    if (this.#rendering === 0 && this.#browser) {
      this.#idleTimer = setTimeout(() => { this.#idleTimer = undefined; void this.#discardBrowser(); }, this.#idleCloseMs);
      this.#idleTimer.unref();
    }
  }

  async #browserNow(): Promise<PdfBrowser> {
    // A browser that crashed or was closed is replaced; renders that find it together share one replacement.
    while (this.#browser) {
      const current = this.#browser;
      const running = await current.catch(() => undefined);
      if (running?.connected) return running;
      if (this.#browser === current) this.#browser = undefined;
    }
    const starting = this.#launch();
    this.#browser = starting;
    // A failed start is not remembered: the next render tries again.
    starting.catch(() => { if (this.#browser === starting) this.#browser = undefined; });
    return starting;
  }

  async #discardBrowser(): Promise<void> {
    const browser = this.#browser;
    this.#browser = undefined;
    const running = await browser?.catch(() => undefined);
    await running?.close().catch(() => undefined);
  }

  async #renderOn(html: string): Promise<Buffer> {
    const timeout = this.#renderTimeoutMs;
    const deadline = Date.now() + timeout;
    const left = () => Math.max(1, deadline - Date.now());
    const browser = await within(this.#browserNow(), left());
    const page = await within(browser.newPage(), left());
    let timedOut = false;
    try {
      return await within((async () => {
        await page.setJavaScriptEnabled(false);
        await page.setRequestInterception(true);
        page.on('request', (request) => {
          if (request.url().startsWith('data:')) void request.continue();
          else void request.abort();
        });
        await page.setContent(html, { waitUntil: 'load', timeout: left() });
        return Buffer.from(await page.pdf({ preferCSSPageSize: true, printBackground: true, timeout: left() }));
      })(), left());
    } catch (error) {
      timedOut = error instanceof RenderTimedOut;
      throw error;
    } finally {
      // A page that cannot even be closed means the browser itself is stuck: start a new one next time.
      const closed = await within(page.close(), timedOut ? 1_000 : timeout).then(() => true, () => false);
      if (!closed && this.#browser) {
        const stuck = this.#browser;
        this.#browser = undefined;
        void stuck.then((running) => running.close()).catch(() => undefined);
      }
    }
  }
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a whole number of at least 1.`);
  return value;
}

function atLeastZero(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a whole number of at least 0.`);
  return value;
}

/** The one renderer every printed document in this process goes through. */
const sharedRenderer = new PdfRenderer();

/**
 * One page through the browser engine, with the network cut off and JavaScript off.
 *
 * Every printed document comes through here, so a bill, a note, a challan and the driver's e-way
 * bill are the same kind of file, and nothing any of them renders can reach out to the network.
 */
async function pdfOf(html: string): Promise<Buffer> {
  return sharedRenderer.render(html);
}

/** Close the shared PDF browser, for a clean shutdown. */
export async function closePdfRenderer(): Promise<void> {
  await sharedRenderer.close();
}

/**
 * Print the exact stored bill HTML with the browser engine used for the preview.
 *
 * Issue #183 — `options.copy` decides which marked copy this is. The customer's file is always the
 * Original: sending them the transporter's or the supplier's copy would hand them a paper that is
 * marked for somebody else.
 */
export async function invoicePdf(document: InvoiceDocument, snapshot: TemplateSnapshot, options: RenderOptions): Promise<Buffer> {
  return pdfOf(renderInvoice(document, snapshot, options));
}

/**
 * Issue #183 — every marked copy of one bill in a single file, each on its own sheet.
 *
 * For the business printing the set on its own printer. What goes to the customer is the Original
 * alone, which is `invoicePdf` above.
 */
export async function invoicePdfCopies(
  document: InvoiceDocument,
  snapshot: TemplateSnapshot,
  options: Omit<RenderOptions, 'copy'>,
): Promise<Buffer> {
  return pdfOf(renderInvoiceCopies(document, snapshot, options));
}

/** Issue #186 — a credit or debit note as a PDF, printed from the same page the screen shows. */
export async function creditNotePdf(
  document: CreditNoteDocument,
  snapshot: TemplateSnapshot,
  options: Omit<RenderOptions, 'copy'>,
): Promise<Buffer> {
  return pdfOf(renderCreditNote(document, snapshot, options));
}

/** Issue #191 — the driver's e-way bill as a PDF, off the same page the screen shows. */
export async function ewayBillPdf(
  record: EwayBillRecord,
  movement: Movement,
  options: { readonly snapshot: TemplateSnapshot; readonly format?: PageFormat; readonly locale?: Locale },
): Promise<Buffer> {
  return pdfOf(renderEwayBill(record, movement, options));
}
