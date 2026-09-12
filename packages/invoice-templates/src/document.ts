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
import type { TradeMarkChoice } from './marks.ts';

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
  /**
   * Issue #145 — tax collected at source. It is part of what the customer pays and is shown on a
   * line of its own, after the GST and before the total, so it is never read as GST.
   */
  readonly tcs?: Money | null;
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

/**
 * Issue #156 — the order-and-delivery references a buyer quotes back when it queries a bill.
 *
 * Every one of them is a reference to another piece of paper: the delivery note the goods moved on,
 * the transporter's docket, the buyer's own file number. None is required by Rule 46; all of them
 * are on the Tally sample, and a buyer's accounts department matches on them.
 */
export interface RenderableReferences {
  readonly deliveryNoteNumber?: string | null;
  readonly deliveryNoteDate?: IsoDate | null;
  readonly dispatchDocNumber?: string | null;
  readonly referenceNumber?: string | null;
  readonly referenceDate?: IsoDate | null;
  readonly otherReferences?: string | null;
  readonly termsOfDelivery?: string | null;
  /** How and when the buyer pays: "Credit", "30 days", "Against delivery". */
  readonly paymentTerms?: string | null;
}

/**
 * Issue #156 — bank details as named fields rather than free text.
 *
 * Labelling each part is what makes an account number safe to copy: a buyer's clerk reading
 * "A/c No." types an account number, and reading a run-on line types whatever looks longest.
 */
export interface RenderableBank {
  readonly bankName?: string | null;
  readonly accountNumber?: string | null;
  readonly branch?: string | null;
  readonly ifsc?: string | null;
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
  /**
   * Issue #134 — where the goods actually go, when that is not the buyer's own address.
   *
   * `null` means the goods go to the buyer, and the bill says so in one line rather than printing
   * the same address twice. It is built from the same delivery party the e-way bill is built from
   * (see `shipToFromDelivery`), so the two documents cannot disagree about where a load went.
   */
  readonly shipTo: RenderableParty | null;
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
  /**
   * Issue #145 — the sentence that says why tax was collected at source: which customer threshold
   * was crossed, and what this bill's share of it was. Printed whenever a TCS amount is.
   */
  readonly tcsNotice?: string | null;
  readonly logoDataUri: string | null;
  /**
   * Issue #147 — the faint mark of the trade printed behind the items.
   *
   * `null` on every bill until a business goes and chooses one, and a bill without it is complete.
   * It is frozen onto the document like the logo and the design, so a reprint years later carries
   * the picture the customer was given rather than whatever the business picked since.
   *
   * The renderer caps how dark it may be and drops it entirely on till-roll paper. Decoration is
   * never allowed to cost a tax figure its legibility.
   */
  readonly tradeMark?: TradeMarkChoice | null;
  /**
   * Free-text bank lines, kept so a business that entered them this way loses nothing. When `bank`
   * is present it is used instead, because named fields read better and copy more safely.
   */
  readonly bankDetails: readonly string[] | null;
  readonly bank: RenderableBank | null;
  readonly references: RenderableReferences | null;
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
