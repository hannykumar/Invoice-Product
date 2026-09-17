/**
 * Issue #13 / #140 — the pieces both page layouts are built from.
 *
 * This file exists so the airy design and the boxed one cannot drift apart on the two things that
 * must never differ between them: **what a word says** and **how a value is escaped**. There is one
 * wording table and one escaping function in this module, and both layouts import them from here.
 */
import { formatINR, type Money } from '@invoice/kernel';
import type { Locale, RenderableLine } from './document.ts';
import type { PageFormat } from './template.ts';

/** Printable width and the character budget that follows from it. */
export const PAGE: Record<PageFormat, { widthCss: string; printableMm: number | null; narrow: boolean }> = {
  A4: { widthCss: '210mm', printableMm: 190, narrow: false },
  THERMAL_80MM: { widthCss: '80mm', printableMm: 72, narrow: true },
  THERMAL_58MM: { widthCss: '58mm', printableMm: 48, narrow: true },
  MOBILE: { widthCss: '100%', printableMm: null, narrow: true },
};

export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Issue #139, as corrected on 2026-09-09 — **one vocabulary, the one the world uses.**
 *
 * This started as two: a friendly wording for the app's screens and the standard wording for the
 * printed bill. That was wrong. Being easy for a shopkeeper who never studied accounting means the
 * product is easy to *operate* — few steps, obvious buttons — not that the terms everyone else uses
 * get renamed. A customer, a transporter, a CA and a GST officer all say "invoice number", and a
 * user who has only ever seen "Bill number" on their own screen cannot follow the conversation.
 * Renaming standard terms isolates the user rather than helping them.
 *
 * So there is one English word per thing, and it is the real one. Hindi keeps its plain form,
 * because there is no standard Hindi vocabulary on Indian bills to match.
 */
interface Wording {
  readonly en: string;
  readonly hi: string;
}

const w = (en: string, hi: string): Wording => ({ en, hi });
const T = {
  TAX_INVOICE: w('Tax Invoice', 'Tax invoice'),
  BILL_OF_SUPPLY: w('Bill of Supply', 'Bill of supply'),
  CREDIT_NOTE: w('Credit Note', 'Wapsi note'),
  DEBIT_NOTE: w('Debit Note', 'Extra charge note'),
  billedTo: w('Buyer (Bill to)', 'Kiske naam'),
  invoiceNo: w('Invoice No.', 'Bill number'),
  date: w('Invoice Date', 'Taarikh'),
  dueDate: w('Due Date', 'Payment kab tak'),
  placeOfSupply: w('Place of Supply', 'Bikri kis rajya ki'),
  // Issue #183 — the prescribed term stays the prescribed term. A Hindi gloss may follow it in
  // brackets; it never replaces it, because a buyer's accountant and an officer both read the term.
  reverseCharge: w('Reverse Charge', 'Reverse Charge (GST customer khud bharega)'),
  gstin: w('GSTIN', 'GST number'),
  item: w('Description of Goods', 'Item'),
  hsn: w('HSN / SAC', 'HSN / SAC'),
  qty: w('Quantity', 'Kitna'),
  rate: w('Rate', 'Rate'),
  discount: w('Discount', 'Chhoot'),
  batch: w('Batch', 'Batch'),
  note: w('Note', 'Note'),
  taxable: w('Taxable Value', 'Jis par tax laga'),
  subTotal: w('Sub Total', 'Maal ka sub-total'),
  charges: w('Other Charges', 'Bill mein jude charge'),
  gstPercent: w('Tax Rate', 'GST %'),
  gstAmount: w('Tax Amount', 'GST'),
  lineTotal: w('Amount', 'Rakam'),
  totalBeforeGst: w('Total Taxable Value', 'GST se pehle total'),
  roundOff: w('Round Off', 'Round kiya'),
  total: w('Total', 'Kul dena'),
  inWords: w('Amount Chargeable (in words)', 'Shabdon mein'),
  paid: w('Amount Paid', 'Diya'),
  outstanding: w('Balance Due', 'Abhi baaki'),
  rcmTax: w('Tax Payable on Reverse Charge', 'Jo GST aap seedha sarkar ko bharenge'),
  tcs: w('TCS', 'Sarkar ke liye liya gaya tax'),
  transport: w('Dispatched through', 'Transport'),
  vehicle: w('Vehicle No.', 'Gaadi'),
  eWayBill: w('e-Way Bill No.', 'E-way bill'),
  irn: w('IRN', 'Sarkari reference (IRN)'),
  bank: w('Bank Details', 'Yahan bhejein'),
  po: w("Buyer's Order No.", 'Aapka order reference'),
  serial: w('Sl No.', 'Sl'),
  per: w('per', 'per'),
  taxSummary: w('HSN / SAC Summary', 'HSN / SAC ke hisaab se tax'),
  // Issue #183 — the answer to "is tax payable on reverse charge", which every tax invoice gives.
  yes: w('Yes', 'Haan'),
  no: w('No', 'Nahin'),
  taxInWords: w('Tax Amount (in words)', 'Tax ki rakam shabdon mein'),
  declaration: w('Declaration', 'Ghoshna'),
  forSeller: w('for', 'ki taraf se'),
  // Issue #183 — the standard trade words stay the standard trade words (#139), in both languages,
  // with the Hindi gloss in brackets. This is the line a buyer's accountant looks for.
  authorisedSignatory: w('Authorised Signatory', 'Authorised Signatory (adhikrit hastakshar)'),
  // Issue #144 — the caption over the pay-by-scan square, and the line naming where the money goes.
  scanToPay: w('Scan to pay by UPI', 'UPI se scan karke payment'),
  upiId: w('UPI ID', 'UPI ID'),
  digitallySigned: w(
    'Digitally signed by the government against the IRN above. No handwritten signature is needed.',
    'Sarkar ne upar wale IRN par digital hastakshar kiye hain. Haath se hastakshar ki zaroorat nahin.',
  ),
  totalWord: w('Total', 'Kul'),
  pan: w('PAN', 'PAN'),
  packages: w('No. & Kind of Pkgs', 'Packet'),
  lrNumber: w('LR / RR No.', 'LR / RR number'),
  transportDoc: w('Transport Doc No. & Date', 'Transport document'),
  destination: w('Destination', 'Kahan pahunchana hai'),
  eoe: w('E. & O.E.', 'E. & O.E.'),
  shipTo: w('Consignee (Ship to)', 'Maal kahan bhejna hai'),
  deliveryNote: w('Delivery Note', 'Delivery note'),
  deliveryNoteDate: w('Delivery Note Date', 'Delivery note ki taarikh'),
  dispatchDoc: w('Dispatch Doc No.', 'Dispatch doc number'),
  referenceNo: w('Reference No. & Date', 'Reference number aur taarikh'),
  otherReferences: w('Other References', 'Anya reference'),
  termsOfDelivery: w('Terms of Delivery', 'Delivery ki shart'),
  paymentTerms: w('Mode / Terms of Payment', 'Payment kaise aur kab'),
  bankName: w('Bank Name', 'Bank ka naam'),
  accountNumber: w('A/c No.', 'Account number'),
  branchIfsc: w('Branch & IFS Code', 'Branch aur IFSC'),
  sameAsBillTo: w('Same as Buyer (Bill to)', 'Wahi jo upar likha hai'),
  computerGenerated: w(
    'This is a computer generated invoice.',
    'Yeh bill computer se bana hai.',
  ),
  // Issue #137 — the copy markings GST asks a goods invoice to carry.
  //
  // Issue #183 — CGST Rule 48 prescribes these words themselves, so the Hindi bill prints them
  // unchanged and puts the explanation in brackets after. A copy marked `Original, customer ke
  // liye` is not marked with what the rule asks for.
  copyOriginal: w('ORIGINAL FOR RECIPIENT', 'ORIGINAL FOR RECIPIENT (customer ke liye)'),
  copyDuplicateTransporter: w('DUPLICATE FOR TRANSPORTER', 'DUPLICATE FOR TRANSPORTER (transporter ke liye)'),
  copyTriplicate: w('TRIPLICATE FOR SUPPLIER', 'TRIPLICATE FOR SUPPLIER (aapke paas)'),
  copyDuplicateSupplier: w('DUPLICATE FOR SUPPLIER', 'DUPLICATE FOR SUPPLIER (aapke paas)'),
  // Issue #141 — the delivery challan. Its copy markings are the words CGST Rule 55(2) prints, which
  // differ from an invoice's: the goods go to a consignee, who may not be a buyer at all.
  DELIVERY_CHALLAN: w('Delivery Challan', 'Delivery challan'),
  notTaxInvoice: w('Not a tax invoice', 'Yeh tax invoice nahin hai'),
  cancelledMark: w('CANCELLED', 'Radd kiya gaya'),
  challanNo: w('Challan No.', 'Challan number'),
  challanDate: w('Challan Date', 'Challan ki taarikh'),
  consignee: w('Consignee', 'Maal paane wala'),
  deliveryAddress: w('Delivery Address', 'Delivery ka pata'),
  reasonForMovement: w('Reason for Movement', 'Maal kyon ja raha hai'),
  provisional: w('provisional', 'andaaz se'),
  invoiceRef: w('Invoice No. & Date', 'Invoice number aur taarikh'),
  // "CONSIGNER" is CGST Rule 55(2)'s own spelling. It is kept exactly, not corrected.
  copyOriginalConsignee: w('ORIGINAL FOR CONSIGNEE', 'ORIGINAL FOR CONSIGNEE (maal paane wale ke liye)'),
  copyTriplicateConsigner: w('TRIPLICATE FOR CONSIGNER', 'TRIPLICATE FOR CONSIGNER (aapke paas)'),
  // Issue #142 — the quotation and the proforma invoice. Both say "Not a tax invoice" under the title
  // (`notTaxInvoice` above). Where a word already exists for the invoice and means the same thing on
  // these papers — "Buyer's Order No.", "Mode / Terms of Payment" — the same word is used.
  QUOTATION: w('Quotation', 'Quotation'),
  PROFORMA_INVOICE: w('Proforma Invoice', 'Proforma invoice'),
  quotationNo: w('Quotation No.', 'Quotation number'),
  proformaNo: w('Proforma Invoice No.', 'Proforma invoice number'),
  documentDate: w('Date', 'Taarikh'),
  validUntil: w('Valid Until', 'Kab tak valid'),
  // "Chargeable" is the invoice's word: it is what the buyer is being charged. Nothing is charged yet.
  amountInWords: w('Amount (in words)', 'Rakam shabdon mein'),
  termsAndConditions: w('Terms & Conditions', 'Sharten'),
  // The invoice's own line says "invoice", which these papers are not.
  computerGeneratedDocument: w('This is a computer generated document.', 'Yeh document computer se bana hai.'),
} as const;

export type WordingKey = keyof typeof T;

/** The word for a thing. The same one on a screen and on the paper. */
export const t = (key: WordingKey, locale: Locale): string => {
  const entry = T[key] as Wording;
  return locale === 'hi-IN' ? entry.hi : entry.en;
};

/** Every wording key, so a test can walk the whole vocabulary. */
export const WORDING_KEYS = Object.keys(T) as WordingKey[];

export const money = (m: Money): string => escapeHtml(formatINR(m));
export const percent = (rate: bigint | null): string => (rate === null ? '—' : `${Number(rate) / 100}%`);
export const isZero = (m: Money): boolean => m.minor === 0n;

/**
 * Splits "70.5 BOX" into the number and its unit.
 *
 * The quantity is never re-derived at print time — this only separates a string that was already
 * formatted when the bill was raised, so the boxed design can put the unit in its own "per" column
 * the way a real bill does.
 */
export const splitQuantity = (quantityText: string): { amount: string; unit: string } => {
  const at = quantityText.indexOf(' ');
  return at === -1
    ? { amount: quantityText, unit: '' }
    : { amount: quantityText.slice(0, at), unit: quantityText.slice(at + 1) };
};

/**
 * Adds up the quantities on the goods lines, e.g. "2,000.000 KGS".
 *
 * Both real bills total the quantity next to the money, because that is the figure a godown counts
 * the load against. Lines in different units cannot be added — a bill of 80 bags and 12 metres has
 * no single total — so in that case nothing is printed rather than a meaningless number.
 */
export const totalQuantityText = (lines: readonly RenderableLine[]): string => {
  const goods = lines.filter((l) => l.kind !== 'CHARGE').map((l) => splitQuantity(l.quantityText));
  if (goods.length === 0) return '';
  const unit = goods[0]?.unit ?? '';
  if (!goods.every((q) => q.unit === unit)) return '';
  let total = 0;
  for (const q of goods) {
    const value = Number(q.amount.replace(/,/g, ''));
    if (!Number.isFinite(value)) return '';
    total += value;
  }
  const decimals = Math.max(...goods.map((q) => (q.amount.split('.')[1] ?? '').length));
  return `${total.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${unit === '' ? '' : ` ${unit}`}`;
};

/**
 * The narrow shapes get a list, because a nine-column table on 58mm of paper is unreadable.
 *
 * Issue #183 — the HSN or SAC code goes under the description. Rule 46(g) asks every tax invoice
 * for it, and there is no exemption for the paper it is printed on: a phone bill and a till-roll
 * slip are tax invoices like any other. A charge line carries no code of its own (#188), so it
 * simply has none to print.
 */
export const narrowLine = (line: RenderableLine, locale: Locale): string => `
  <div class="tline">
    <div class="tline-name">${escapeHtml(line.description)}${line.reverseCharge ? ' (RCM)' : ''}</div>
    ${line.hsnOrSac === null ? '' : `<div class="tline-hsn">${escapeHtml(t('hsn', locale))} ${escapeHtml(line.hsnOrSac)}</div>`}
    <div class="tline-detail"><span>${line.kind === 'CHARGE' ? '' : `${escapeHtml(line.quantityText)} × ${money(line.unitPrice)}`}</span><span class="num">${money(line.taxableValue)}</span></div>
    ${line.ratePercentTimes100 === null ? '' : `<div class="tline-tax"><span>${escapeHtml(t('gstAmount', locale))} ${escapeHtml(percent(line.ratePercentTimes100))}</span><span class="num">${money(line.taxAmount)}</span></div>`}
  </div>`;
