/**
 * Issue #13 [E13] — the view model a bill is printed from.
 *
 * It is deliberately separate from the sales invoice. A printed bill must show the facts **as they
 * were when it was raised** — the customer's address, the seller's name, the rate — even if a
 * master record has been edited since. So the document carries flattened values, not references,
 * and is stored alongside the invoice.
 */
import type { IsoDate, Money } from '@invoice/kernel';

export type DocumentTitle = 'TAX_INVOICE' | 'BILL_OF_SUPPLY' | 'CREDIT_NOTE' | 'DEBIT_NOTE';
export type TaxSplit = 'CGST_SGST' | 'CGST_UTGST' | 'IGST';
export type Locale = 'en-IN' | 'hi-IN';

export interface RenderableParty {
  readonly name: string;
  readonly addressLines: readonly string[];
  readonly gstin: string | null;
  readonly stateCode: string;
  readonly stateName: string;
  readonly phone?: string | null;
  readonly email?: string | null;
}

export interface RenderableLine {
  readonly lineId: string;
  readonly description: string;
  readonly hsnOrSac: string | null;
  /** Already formatted with its unit, e.g. "70 BOX". Quantities are never re-derived when printing. */
  readonly quantityText: string;
  readonly unitPrice: Money;
  readonly discount: Money | null;
  readonly taxableValue: Money;
  readonly ratePercentTimes100: bigint | null;
  readonly taxAmount: Money;
  readonly cess: Money;
  readonly reverseCharge: boolean;
  readonly batch?: string | null;
  readonly note?: string | null;
}

export interface RenderableTotals {
  readonly taxableValue: Money;
  readonly cgst: Money;
  readonly sgst: Money;
  readonly utgst: Money;
  readonly igst: Money;
  readonly cess: Money;
  readonly roundOff: Money;
  readonly invoiceValue: Money;
  readonly reverseChargeTax: Money;
  readonly amountPaid?: Money | null;
  readonly outstanding?: Money | null;
}

export interface RenderableTransport {
  readonly transporter?: string | null;
  readonly vehicleNumber?: string | null;
  readonly eWayBillNumber?: string | null;
}

export interface RenderableEInvoice {
  readonly irn: string;
  /** Produced by issue #26. This module never generates one; it prints what it is given. */
  readonly qrSvg: string | null;
}

export interface InvoiceDocument {
  /**
   * Which document this is. Deciding between a tax invoice and a bill of supply is a compliance
   * question, so it is supplied by the caller rather than guessed here.
   */
  readonly title: DocumentTitle;
  readonly number: string;
  readonly date: IsoDate;
  readonly dueDate: IsoDate | null;
  readonly seller: RenderableParty;
  readonly buyer: RenderableParty;
  readonly placeOfSupplyStateCode: string;
  readonly placeOfSupplyStateName: string;
  readonly reverseCharge: boolean;
  readonly split: TaxSplit;
  readonly lines: readonly RenderableLine[];
  readonly totals: RenderableTotals;
  readonly transport: RenderableTransport | null;
  readonly eInvoice: RenderableEInvoice | null;
  /**
   * The total written out. Computed once when the document is built, not at print time, so a
   * reprint years later shows the same words even if the helper changes.
   */
  readonly amountInWordsText: string;
  /** Present when any rate on the bill came from the business rather than a checked notification. */
  readonly declaredRateNotice: string | null;
  readonly logoDataUri: string | null;
  readonly bankDetails: readonly string[] | null;
  readonly terms: string | null;
  readonly poReference: string | null;
}

/**
 * The template a bill was printed with, stored on the invoice.
 *
 * "Old invoices preserve their original template" is an acceptance criterion. Storing the id alone
 * would not do it — a template can be edited. The snapshot carries everything the renderer needs,
 * so a bill reprinted in three years looks exactly as it did.
 */
export interface TemplateSnapshot {
  readonly templateId: string;
  readonly templateVersion: string;
  readonly capturedOn: string;
  readonly palette: { accent: string; text: string; muted: string; border: string };
  readonly typography: { bodyStack: string; headingStack: string; baseSizePt: number };
  readonly optionalFields: readonly string[];
  readonly lineColumns: readonly string[];
  readonly logo: { show: boolean; maxHeightPt: number };
  readonly footerNote: string | null;
}
