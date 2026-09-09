/**
 * Issue #13 [E13] — the view model a bill is printed from.
 *
 * It is deliberately separate from the sales invoice. A printed bill must show the facts **as they
 * were when it was raised** — the customer's address, the seller's name, the rate — even if a
 * master record has been edited since. So the document carries flattened values, not references,
 * and is stored alongside the invoice.
 */
import type { IsoDate, Money } from '@invoice/kernel';
import type { PageLayout } from './template.ts';

export type DocumentTitle = 'TAX_INVOICE' | 'BILL_OF_SUPPLY' | 'CREDIT_NOTE' | 'DEBIT_NOTE';
export type TaxSplit = 'CGST_SGST' | 'CGST_UTGST' | 'IGST';
export type Locale = 'en-IN' | 'hi-IN';

export interface RenderableParty {
  readonly name: string;
  readonly addressLines: readonly string[];
  readonly gstin: string | null;
  /**
   * Issue #138 — the income-tax number of the business, which real bills print beside the GSTIN.
   * A buyer's accounts department uses it when it deducts tax at source against the payment.
   */
  readonly pan?: string | null;
  readonly stateCode: string;
  readonly stateName: string;
  readonly phone?: string | null;
  readonly email?: string | null;
}

export interface RenderableLine {
  readonly lineId: string;
  readonly description: string;
  readonly hsnOrSac: string | null;
  /**
   * Issue #131 — `GOODS` is something the customer bought and must satisfy quantity times rate
   * equals the amount. `CHARGE` is freight or another charge, printed on a line of its own below
   * the goods, never folded into one of them.
   */
  readonly kind: 'GOODS' | 'CHARGE';
  /** Already formatted with its unit, e.g. "70 BOX". Quantities are never re-derived when printing. */
  readonly quantityText: string;
  readonly unitPrice: Money;
  readonly discount: Money | null;
  readonly taxableValue: Money;
  readonly ratePercentTimes100: bigint | null;
  readonly taxAmount: Money;
  /**
   * The tax split for this line, carried rather than derived.
   *
   * Issue #135's HSN summary has to show CGST and SGST as separate columns per code, and halving
   * `taxAmount` would not give them: cess is in there too, and each half is rounded on its own. So
   * the calculator's own figures come through untouched and the summary adds up exactly.
   */
  readonly cgst: Money;
  readonly sgst: Money;
  readonly utgst: Money;
  readonly igst: Money;
  readonly cess: Money;
  readonly reverseCharge: boolean;
  readonly batch?: string | null;
  /**
   * Issue #138 — how the goods were made up for the journey, e.g. "80 Bags".
   *
   * It is not the quantity and never stands in for it. A lorry driver, a godown keeper and the
   * person signing for delivery count packages; the bill is priced on the quantity.
   */
  readonly packages?: string | null;
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
  /**
   * Issue #138 — the transporter's own paperwork, which is what a consignment is traced by when a
   * delivery goes missing. The LR (lorry receipt) or RR (railway receipt) number is the reference
   * the transporter answers to; the document number and date are what the buyer quotes back.
   */
  readonly lrNumber?: string | null;
  readonly documentNumber?: string | null;
  readonly documentDate?: IsoDate | null;
  /** Where the goods are actually going, which is often not the address the bill is made out to. */
  readonly destination?: string | null;
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
  /**
   * Issue #137 — goods or services, which decides how many marked copies the bill needs.
   *
   * GST asks for three copies of a goods invoice (the buyer's, the transporter's, and the one the
   * seller keeps) and two of a services invoice, because nothing is carried anywhere.
   */
  readonly supplyKind: 'GOODS' | 'SERVICES';
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
  /**
   * The tax total written out, for the line under the HSN summary that real bills carry.
   *
   * Computed with the total, for the same reason: a reprint years later must read identically.
   */
  readonly taxAmountInWordsText: string;
  /** Present when any rate on the bill came from the business rather than a checked notification. */
  readonly declaredRateNotice: string | null;
  readonly logoDataUri: string | null;
  readonly bankDetails: readonly string[] | null;
  readonly terms: string | null;
  /**
   * The declaration the business makes about the bill, printed in its own box on the boxed design.
   *
   * There is no default and there never will be: a declaration is a statement the business makes,
   * not one this product makes on its behalf. It prints only when the business has set one, and the
   * box does not appear at all until then. Issue #138 wires it to the company record.
   */
  readonly declaration: string | null;
  /**
   * Issue #138 — the signature image, frozen onto the bill the way the logo and the design are.
   *
   * Until a business uploads one the signature block keeps a reserved box at the size the image
   * will take, so the footer does not change shape on the day it arrives (issue #148's rule).
   */
  readonly signatureDataUri: string | null;
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
  /**
   * Optional so that a snapshot captured before issue #140 still reprints exactly as it did. An
   * absent layout means the original airy one, which is what those bills were printed with.
   */
  readonly layout?: PageLayout;
  readonly palette: { accent: string; text: string; muted: string; border: string };
  readonly typography: { bodyStack: string; headingStack: string; baseSizePt: number };
  readonly optionalFields: readonly string[];
  readonly lineColumns: readonly string[];
  readonly logo: { show: boolean; maxHeightPt: number };
  readonly footerNote: string | null;
}
