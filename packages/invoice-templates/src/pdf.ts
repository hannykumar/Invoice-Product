import puppeteer from 'puppeteer';
import { renderInvoice, type RenderOptions } from './render.ts';
import type { InvoiceDocument, TemplateSnapshot } from './document.ts';

/** Print the exact stored bill HTML with the browser engine used for the preview. */
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
