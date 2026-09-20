import puppeteer from 'puppeteer';
import { renderCreditNote, renderEwayBill, renderInvoice, renderInvoiceCopies, type RenderOptions } from './render.ts';
import type { CreditNoteDocument } from './credit-note.ts';
import type { InvoiceDocument, TemplateSnapshot } from './document.ts';
import type { PageFormat } from './template.ts';
import type { Locale } from './document.ts';
import type { EwayBillRecord, Movement } from '@invoice/transport';

/**
 * One page through the browser engine, with the network cut off.
 *
 * Every printed document comes through here, so a bill, a note, a challan and the driver's e-way
 * bill are the same kind of file, and nothing any of them renders can reach out to the network.
 */
async function pdfOf(html: string): Promise<Buffer> {
  // GitHub runners disable Chromium's user-namespace sandbox; the runner itself is isolated.
  const browser = await puppeteer.launch({ headless: true, args: process.env.GITHUB_ACTIONS === 'true' ? ['--no-sandbox'] : [] });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (request.url().startsWith('data:')) void request.continue();
      else void request.abort();
    });
    await page.setContent(html, { waitUntil: 'load' });
    return Buffer.from(await page.pdf({ preferCSSPageSize: true, printBackground: true }));
  } finally {
    await browser.close();
  }
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
