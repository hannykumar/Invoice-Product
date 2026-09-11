/**
 * Issue #142 — the two papers a wholesaler sends before a sale: the quotation and the proforma invoice.
 *
 * A **quotation** is a price offer. A **proforma invoice** is an advance bill, usually sent so the
 * buyer can pay before the goods move. Neither is a GST document, and that decides this file:
 *
 *  - **What the law says.** GST prescribes no format for either, and neither goes into any return.
 *    Neither is a tax invoice, so neither can be used to claim input tax credit, and neither creates
 *    a tax liability. The tax invoice is issued when the supply happens (CGST section 31), and that
 *    is the only document that posts to the books, moves stock or is reported.
 *  - **What the convention is.** Both look like an invoice: seller and buyer with their GSTINs,
 *    items with HSN, quantity, rate, the GST that will apply, and a total. Both are marked so nobody
 *    mistakes them for a tax invoice. A proforma carries the bank details, because it asks for money.
 *  - **What is the business's own choice.** How long the prices hold, payment terms, any other
 *    terms. These are commitments, so they are fields the business fills in and nothing is defaulted.
 *
 * What each of them leads to:
 *
 *  - A quotation the customer accepts is **turned into a sale**: its lines become a draft invoice,
 *    which then goes through every check a sale goes through. See `PreSaleService.convertToSale`.
 *  - A proforma records **what it was for**, and the tax invoice raised later is **linked back** to it,
 *    so an advance paid against the proforma can be matched to the bill. See `linkInvoice`.
 */
import { compareDates, type BranchId, type CompanyId, type IsoDate, type Money, type PartyId, type UserId } from '@invoice/kernel';
import type { CustomerType, InvoicePricing, SalesInvoiceLineInput } from './model.ts';

export type PreSaleKind = 'QUOTATION' | 'PROFORMA';

/**
 * `ISSUED` — numbered and sent.
 * `CONVERTED` — a quotation whose lines became a draft invoice. Nothing more happens to it.
 * `INVOICED` — a proforma the tax invoice has been linked to. Nothing more happens to it.
 * `CANCELLED` — withdrawn. The number stays used, so the series has no gap.
 *
 * Whether a quotation's validity has run out is not a state: it depends on today's date, so it is
 * worked out when asked (`hasLapsed`), never stored and never allowed to go stale.
 */
export type PreSaleState = 'ISSUED' | 'CONVERTED' | 'INVOICED' | 'CANCELLED';

export interface PreSaleKindRule {
  readonly kind: PreSaleKind;
  readonly label: { readonly 'en-IN': string; readonly 'hi-IN': string };
  /** How the document is closed: a quotation becomes a sale, a proforma is billed by an invoice. */
  readonly closedBy: 'SALE' | 'INVOICE';
  /** A proforma must say what it was issued for; a quotation is a price offer and needs nothing more. */
  readonly needsPurpose: boolean;
}

export const PRESALE_KINDS: readonly PreSaleKindRule[] = [
  { kind: 'QUOTATION', label: { 'en-IN': 'Quotation', 'hi-IN': 'Quotation' }, closedBy: 'SALE', needsPurpose: false },
  { kind: 'PROFORMA', label: { 'en-IN': 'Proforma Invoice', 'hi-IN': 'Proforma invoice' }, closedBy: 'INVOICE', needsPurpose: true },
];

export const preSaleKind = (kind: PreSaleKind): PreSaleKindRule => {
  const found = PRESALE_KINDS.find((k) => k.kind === kind);
  if (found === undefined) throw new Error(`"${kind}" is neither a quotation nor a proforma invoice.`);
  return found;
};

export const isPreSaleKind = (value: string): value is PreSaleKind => PRESALE_KINDS.some((k) => k.kind === value);

/**
 * What the business types. Deliberately the same shape as a draft invoice's input, so that turning
 * a quotation into a sale hands the invoice exactly what was quoted — nothing retyped, nothing lost.
 */
export interface PreSaleInput {
  readonly partyId: PartyId;
  readonly customerType: CustomerType;
  readonly supplyKind: 'GOODS' | 'SERVICES';
  readonly documentDate: IsoDate;
  /** How long the prices hold. The business's own commitment, so there is no default. */
  readonly validUntil?: IsoDate | null;
  readonly deliveryStateCode?: string | null;
  /** Only when a person has confirmed it. Otherwise the rule decides, as it does on an invoice. */
  readonly placeOfSupplyStateCode?: string | null;
  readonly lines: readonly SalesInvoiceLineInput[];
  readonly freight?: Money;
  readonly otherCharges?: Money;
  readonly roundToWholeRupee?: boolean;
  /** The business's own terms, printed as typed. Empty until the business writes some. */
  readonly terms?: string | null;
  /** Kept with the document, never printed. */
  readonly narration?: string | null;
  /** Proforma only, and required there: what this proforma was issued for. Kept, not printed. */
  readonly purpose?: string | null;
  /** Proforma only: the buyer's own order number, which the buyer quotes back when it pays. */
  readonly buyerOrderNumber?: string | null;
  /** Proforma only: how and when the buyer is asked to pay, in the business's own words. */
  readonly paymentTerms?: string | null;
}

/** The draft invoice a quotation became. Its number is known only once that invoice is issued. */
export interface PreSaleSaleLink {
  readonly invoiceId: string;
  readonly convertedBy: UserId;
  readonly convertedAt: string;
}

/** The tax invoice raised after a proforma. */
export interface PreSaleInvoiceLink {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly invoiceDate: IsoDate;
  readonly linkedBy: UserId;
  readonly linkedAt: string;
  /** Anything about the invoice that differs from what the proforma asked for, in plain words. */
  readonly differences: readonly string[];
}

export interface PreSaleDocument {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly branchId: BranchId;
  readonly kind: PreSaleKind;
  readonly state: PreSaleState;
  readonly number: string;
  readonly financialYear: string;
  readonly documentDate: IsoDate;
  readonly validUntil: IsoDate | null;
  readonly partyId: PartyId;
  readonly customerType: CustomerType;
  readonly supplyKind: 'GOODS' | 'SERVICES';
  readonly deliveryStateCode: string | null;
  /** The place of supply a person confirmed, if any. The worked-out one is on `pricing`. */
  readonly placeOfSupplyStateCode: string | null;
  /** The lines as they were given, so a conversion hands the invoice the same input. */
  readonly lines: readonly SalesInvoiceLineInput[];
  readonly freight: Money;
  readonly otherCharges: Money;
  readonly roundToWholeRupee: boolean;
  /**
   * Worked out by the same GST calculator the invoice uses, on the day the document was issued, and
   * never recomputed. It is what the buyer was shown; it is not tax anyone owes.
   */
  readonly pricing: InvoicePricing;
  /** Set when a rate came from the business rather than a checked notification, as on an invoice. */
  readonly declaredRateNotice: { readonly 'en-IN': string; readonly 'hi-IN': string } | null;
  readonly terms: string | null;
  readonly narration: string | null;
  readonly purpose: string | null;
  readonly buyerOrderNumber: string | null;
  readonly paymentTerms: string | null;
  readonly sale: PreSaleSaleLink | null;
  readonly invoice: PreSaleInvoiceLink | null;
  readonly createdBy: UserId;
  readonly createdAt: string;
  readonly cancelledBy: UserId | null;
  readonly cancelledAt: string | null;
  readonly cancelReason: string | null;
  readonly idempotencyKey: string;
  readonly version: number;
}

export const PRESALE_PERMISSIONS = {
  QUOTATION: { issue: 'quotation.issue', cancel: 'quotation.cancel' },
  PROFORMA: { issue: 'proforma.issue', cancel: 'proforma.cancel' },
} as const;

/** True once the date the prices were held until has passed. A document with no such date never lapses. */
export const hasLapsed = (document: Pick<PreSaleDocument, 'validUntil'>, today: IsoDate): boolean =>
  document.validUntil !== null && compareDates(document.validUntil, today) < 0;
