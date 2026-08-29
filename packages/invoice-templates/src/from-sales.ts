/**
 * Issue #13 [E13] — turning a finalised sales invoice (#9) into something printable.
 *
 * This is where the facts are flattened. After this point the bill no longer refers to a customer
 * record or an item record; it carries the name, the address and the rate **as they were on the
 * day it was issued**. That is what makes a reprint in three years honest.
 */
import { formatQuantity, isoDate, subtract, zero, type IsoDate, type Money } from '@invoice/kernel';
import type { SalesInvoice } from '@invoice/sales';
import type { ComputedTaxLine } from '@invoice/gst-calc';
import { amountInWords } from './words.ts';
import type { DocumentTitle, InvoiceDocument, RenderableParty, RenderableTransport } from './document.ts';

export interface PrintingContext {
  readonly title: DocumentTitle;
  readonly seller: RenderableParty;
  readonly buyer: RenderableParty;
  readonly placeOfSupplyStateName: string;
  readonly transport?: RenderableTransport | null;
  readonly eInvoice?: { irn: string; qrSvg: string | null } | null;
  readonly logoDataUri?: string | null;
  readonly bankDetails?: readonly string[] | null;
  readonly terms?: string | null;
  readonly poReference?: string | null;
  readonly amountPaid?: Money | null;
  /** Set when any rate came from the business rather than a checked notification. */
  readonly declaredRateNotice?: string | null;
  readonly batchByLineId?: Readonly<Record<string, string>>;
  readonly noteByLineId?: Readonly<Record<string, string>>;
}

const nil = (): Money => zero('INR');

export const toInvoiceDocument = (invoice: SalesInvoice, context: PrintingContext): InvoiceDocument => {
  if (invoice.pricing === null) {
    throw new Error('A bill without worked-out totals cannot be printed. Price it first.');
  }
  const pricing = invoice.pricing;
  const totals = pricing.totals;
  const paid = context.amountPaid ?? null;

  return {
    title: context.title,
    number: invoice.number ?? '',
    date: invoice.documentDate,
    dueDate: invoice.dueDate,
    seller: context.seller,
    buyer: context.buyer,
    placeOfSupplyStateCode: pricing.placeOfSupplyStateCode,
    placeOfSupplyStateName: context.placeOfSupplyStateName,
    reverseCharge: pricing.lines.some((l) => l.reverseCharge),
    split: pricing.split,
    lines: pricing.lines.map((l: ComputedTaxLine) => ({
      lineId: l.lineId,
      description: l.itemName,
      hsnOrSac: l.hsnOrSac,
      quantityText: formatQuantity(l.quantity),
      unitPrice: l.unitPrice,
      discount: l.discountAmount.minor === 0n ? null : l.discountAmount,
      taxableValue: l.taxableValue,
      ratePercentTimes100: l.ratePercentTimes100,
      taxAmount: l.totalTax,
      cess: l.cess,
      reverseCharge: l.reverseCharge,
      batch: context.batchByLineId?.[l.lineId] ?? null,
      note: context.noteByLineId?.[l.lineId] ?? null,
    })),
    totals: {
      taxableValue: totals.taxableValue,
      cgst: totals.cgst,
      sgst: totals.sgst,
      utgst: totals.utgst,
      igst: totals.igst,
      cess: totals.cess,
      roundOff: totals.roundOff,
      invoiceValue: totals.invoiceValue,
      reverseChargeTax: totals.reverseChargeTax,
      amountPaid: paid,
      outstanding: paid === null ? null : subtract(totals.invoiceValue, paid),
    },
    transport: context.transport ?? null,
    eInvoice: context.eInvoice ?? null,
    amountInWordsText: amountInWords(totals.invoiceValue),
    declaredRateNotice: context.declaredRateNotice ?? null,
    logoDataUri: context.logoDataUri ?? null,
    bankDetails: context.bankDetails ?? null,
    terms: context.terms ?? null,
    poReference: context.poReference ?? null,
  };
};

export const todayIso = (): IsoDate => isoDate(new Date().toISOString().slice(0, 10));
export { nil };
