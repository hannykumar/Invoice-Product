import puppeteer from 'puppeteer';
import { renderInvoice, renderInvoiceCopies, type RenderOptions } from './render.ts';
import type { InvoiceDocument, TemplateSnapshot } from './document.ts';

/**
 * Print the exact stored bill HTML with the browser engine used for the preview.
 *
 * Issue #183 — `options.copy` decides which marked copy this is. The customer's file is always the
 * Original: sending them the transporter's or the supplier's copy would hand them a paper that is
 * marked for somebody else.
 */
export async function invoicePdf(document: InvoiceDocument, snapshot: TemplateSnapshot, options: RenderOptions): Promise<Buffer> {
  // GitHub runners disable Chromium's user-namespace sandbox; the runner itself is isolated.
  const browser = await puppeteer.launch({ headless: true, args: process.env.GITHUB_ACTIONS === 'true' ? ['--no-sandbox'] : [] });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (request.url().startsWith('data:')) void request.continue();
      else void request.abort();
    });
    await page.setContent(renderInvoice(document, snapshot, options), { waitUntil: 'load' });
    return Buffer.from(await page.pdf({ preferCSSPageSize: true, printBackground: true }));
  } finally {
    await browser.close();
  }
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
  const browser = await puppeteer.launch({ headless: true, args: process.env.GITHUB_ACTIONS === 'true' ? ['--no-sandbox'] : [] });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (request.url().startsWith('data:')) void request.continue();
      else void request.abort();
    });
    await page.setContent(renderInvoiceCopies(document, snapshot, options), { waitUntil: 'load' });
    return Buffer.from(await page.pdf({ preferCSSPageSize: true, printBackground: true }));
  } finally {
    await browser.close();
  }
}
