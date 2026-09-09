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
  /** Issue #134 — omit, or pass `null`, when the goods go to the buyer's own address. */
  readonly shipTo?: RenderableParty | null;
  readonly placeOfSupplyStateName: string;
  readonly transport?: RenderableTransport | null;
  readonly eInvoice?: { irn: string; qrSvg: string | null } | null;
  readonly logoDataUri?: string | null;
  readonly bankDetails?: readonly string[] | null;
  readonly terms?: string | null;
  /** The business's own declaration. Never defaulted here; see `InvoiceDocument.declaration`. */
  readonly declaration?: string | null;
  readonly poReference?: string | null;
  readonly amountPaid?: Money | null;
  /** Set when any rate came from the business rather than a checked notification. */
  readonly declaredRateNotice?: string | null;
  readonly batchByLineId?: Readonly<Record<string, string>>;
  readonly noteByLineId?: Readonly<Record<string, string>>;
  /** Issue #138 — how each line was packed for the journey, e.g. "80 Bags". */
  readonly packagesByLineId?: Readonly<Record<string, string>>;
  /** Issue #138 — the business's signature image, supplied the same way as its logo. */
  readonly signatureDataUri?: string | null;
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
    shipTo: context.shipTo ?? null,
    placeOfSupplyStateCode: pricing.placeOfSupplyStateCode,
    placeOfSupplyStateName: context.placeOfSupplyStateName,
    reverseCharge: pricing.lines.some((l) => l.reverseCharge),
    supplyKind: invoice.supplyKind,
    split: pricing.split,
    lines: pricing.lines.map((l: ComputedTaxLine) => ({
      lineId: l.lineId,
      description: l.itemName,
      hsnOrSac: l.hsnOrSac,
      kind: l.kind,
      quantityText: formatQuantity(l.quantity),
      unitPrice: l.unitPrice,
      discount: l.discountAmount.minor === 0n ? null : l.discountAmount,
      taxableValue: l.taxableValue,
      ratePercentTimes100: l.ratePercentTimes100,
      taxAmount: l.totalTax,
      cgst: l.cgst,
      sgst: l.sgst,
      utgst: l.utgst,
      igst: l.igst,
      cess: l.cess,
      reverseCharge: l.reverseCharge,
      batch: context.batchByLineId?.[l.lineId] ?? null,
      packages: context.packagesByLineId?.[l.lineId] ?? null,
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
    taxAmountInWordsText: amountInWords(totals.totalTax),
    declaredRateNotice: context.declaredRateNotice ?? null,
    logoDataUri: context.logoDataUri ?? null,
    bankDetails: context.bankDetails ?? null,
    terms: context.terms ?? null,
    declaration: context.declaration ?? null,
    signatureDataUri: context.signatureDataUri ?? null,
    poReference: context.poReference ?? null,
  };
};

export const todayIso = (): IsoDate => isoDate(new Date().toISOString().slice(0, 10));
export { nil };

/**
 * Issue #134 — the delivery party, as the e-way bill already describes it.
 *
 * This shape is `MovementParty` from `packages/transport` written out structurally, so the printed
 * bill takes **the same object** the e-way bill is built from rather than a second copy typed in by
 * hand. That is the whole point: a bill and an e-way bill that disagree about where a load went is
 * exactly the discrepancy an officer stops a lorry over.
 */
export interface DeliveryParty {
  readonly legalName: string;
  readonly gstin: string;
  readonly address1: string;
  readonly address2?: string;
  readonly place: string;
  readonly pincode: string;
  /** GST state code, "29" for Karnataka. */
  readonly stateCode: string;
}

/** Turns that delivery party into something printable. The state's name is not on the movement. */
export const shipToFromDelivery = (party: DeliveryParty, stateName: string): RenderableParty => ({
  name: party.legalName,
  addressLines: [
    party.address1,
    ...(party.address2 === undefined || party.address2 === '' ? [] : [party.address2]),
    `${party.place} ${party.pincode}`.trim(),
  ],
  gstin: party.gstin === '' ? null : party.gstin,
  stateCode: party.stateCode,
  stateName,
});
