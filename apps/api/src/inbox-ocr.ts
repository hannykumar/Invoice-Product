/**
 * Issue #489 — who reads a supplier's bill off the page for the purchase inbox.
 *
 * The inbox asks an `OcrAdapter` (connector-v1, kind `ocr`) and never knows which vendor answers.
 * No OCR vendor is contracted yet, so:
 *
 *  - on a developer's machine and in tests, `DevelopmentOcr` answers. A file it has been told about
 *    returns the pages it was told; a PDF made by `sampleBillPdf` below carries its own text lines
 *    in a comment, which it reads back; any other file is "too blurred to read", which the inbox
 *    holds with a sentence a shopkeeper can act on. It never invents a bill.
 *  - everywhere else, `OcrNotContracted` answers "the reading service is not available", which the
 *    inbox keeps as a failed, retryable document. The e-invoice JSON path needs no OCR at all and
 *    works regardless.
 *
 * Every name and GST number in a sample bill is synthetic.
 */
import { ConnectorError, isLocalEnvironment } from '../../../packages/platform/src/connectors.ts';
import { pageFromLines, type OcrAdapter, type OcrPage, type OcrRequest, type OcrResult } from '../../../packages/purchasing/src/ocr.ts';
import { objectStore } from './files-application.ts';

const MARKER = 'KAROBAR-SAMPLE-BILL';

/**
 * A small, valid one-page PDF whose text lines `DevelopmentOcr` can read back. Real PDFs from a shop
 * have no such comment and are for the contracted vendor to read. `tag` makes two samples differ.
 */
export const sampleBillPdf = (lines: readonly string[], tag = ''): Uint8Array => {
  const body = [`% ${MARKER} ${tag}`, ...lines.map((line) => `% ${line}`)].join('\n');
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj',
    `4 0 obj << /Length ${body.length} >> stream\n${body}\nendstream endobj`,
  ];
  let pdf = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (const object of objects) { offsets.push(pdf.length); pdf += `${object}\n`; }
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
};

/** The lines of a sample bill, laid out the way the reader expects an Indian tax invoice. */
export const sampleBillLines = (bill: {
  readonly supplierName: string; readonly supplierGstin: string; readonly buyerGstin: string; readonly number: string; readonly date: string;
  readonly item: string; readonly hsn: string; readonly quantity: string; readonly unit: string; readonly rate: string;
  readonly taxable: string; readonly igst: string; readonly total: string;
}): readonly string[] => [
  bill.supplierName.toUpperCase(), `GSTIN: ${bill.supplierGstin}`, 'TAX INVOICE', `Invoice No: ${bill.number}`, `Invoice Date: ${bill.date}`,
  `GSTIN: ${bill.buyerGstin}`, `${bill.item}   HSN ${bill.hsn}   ${bill.quantity} ${bill.unit}   ${bill.rate}`,
  `Taxable Value: ${bill.taxable}`, `IGST 18%: ${bill.igst}`, `Grand Total: ${bill.total}`,
];

export class DevelopmentOcr implements OcrAdapter {
  readonly #told = new Map<string, readonly OcrPage[]>();

  /** Tells the reader what a stored file says. */
  set(storageKey: string, pages: readonly OcrPage[]): void { this.#told.set(storageKey, pages); }

  async read(request: OcrRequest): Promise<OcrResult> {
    const providerRequestId = `development-${request.correlationId}`;
    const told = this.#told.get(request.storageKey);
    if (told !== undefined) return { provider: 'development', providerRequestId, pages: told };
    const stored = await objectStore().read(request.storageKey, 25 * 1024 * 1024).catch(() => null);
    if (stored === null) throw new ConnectorError('INVALID_REQUEST', false, providerRequestId);
    const text = Buffer.from(stored.bytes).toString('latin1');
    const at = text.indexOf(`% ${MARKER}`);
    if (at < 0) return { provider: 'development', providerRequestId, pages: [pageFromLines(1, [], { readable: false })] };
    const lines = text.slice(at).split('\n').slice(1).map((line) => line.match(/^% (.+)$/)?.[1]).filter((line): line is string => line !== undefined);
    return { provider: 'development', providerRequestId, pages: [pageFromLines(1, lines)] };
  }
}

/** No OCR vendor is contracted: every read is a retryable "not available", never a made-up bill. */
export class OcrNotContracted implements OcrAdapter {
  async read(request: OcrRequest): Promise<OcrResult> { throw new ConnectorError('OUTAGE', true, `no-ocr-vendor-${request.correlationId}`); }
}

export const inboxOcr = (env: NodeJS.ProcessEnv = process.env): OcrAdapter => (isLocalEnvironment(env.NODE_ENV) ? new DevelopmentOcr() : new OcrNotContracted());
