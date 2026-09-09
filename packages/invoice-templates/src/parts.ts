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
 * Issue #139 — two vocabularies, kept side by side so they cannot drift apart.
 *
 * `plain` is how the product speaks to a business owner, and it is what the app's own screens use.
 * `printed` is what goes on the paper in English: the standard term a chartered accountant, a GST
 * officer and the buyer's accounts clerk scan for. "Bill number" is the right thing to say on a
 * screen and the wrong thing to print, because nobody checking a bill is looking for it.
 *
 * Hindi keeps the plain wording throughout. There is no standard Hindi vocabulary on Indian bills
 * to match, and inventing one would help nobody.
 */
interface Wording {
  /** What a screen says, and what this product would say out loud. */
  readonly plain: string;
  /** What the printed English document says. Falls back to `plain` where they agree. */
  readonly printed?: string;
  readonly hi: string;
}

const w = (plain: string, hi: string, printed?: string): Wording =>
  printed === undefined ? { plain, hi } : { plain, hi, printed };

const T = {
  TAX_INVOICE: w('Tax invoice', 'Tax invoice', 'Tax Invoice'),
  BILL_OF_SUPPLY: w('Bill of supply', 'Bill of supply', 'Bill of Supply'),
  CREDIT_NOTE: w('Return note', 'Wapsi note', 'Credit Note'),
  DEBIT_NOTE: w('Extra charge note', 'Extra charge note', 'Debit Note'),
  billedTo: w('Billed to', 'Kiske naam', 'Buyer (Bill to)'),
  invoiceNo: w('Bill number', 'Bill number', 'Invoice No.'),
  date: w('Date', 'Taarikh', 'Invoice Date'),
  dueDate: w('Payment due', 'Payment kab tak', 'Due Date'),
  placeOfSupply: w('This sale counts in', 'Bikri kis rajya ki', 'Place of Supply'),
  reverseCharge: w('Customer pays the GST directly', 'GST customer khud bharega', 'Reverse Charge'),
  gstin: w('GST number', 'GST number', 'GSTIN'),
  item: w('Item', 'Item', 'Description of Goods'),
  hsn: w('HSN / SAC', 'HSN / SAC'),
  qty: w('Qty', 'Kitna', 'Quantity'),
  rate: w('Rate', 'Rate'),
  discount: w('Discount', 'Chhoot'),
  batch: w('Batch', 'Batch'),
  note: w('Note', 'Note'),
  taxable: w('Taxable value', 'Jis par tax laga', 'Taxable Value'),
  subTotal: w('Sub-total for goods', 'Maal ka sub-total', 'Sub Total'),
  charges: w('Charges added to this bill', 'Bill mein jude charge', 'Other Charges'),
  gstPercent: w('GST %', 'GST %', 'Tax Rate'),
  gstAmount: w('GST', 'GST', 'Tax Amount'),
  lineTotal: w('Amount', 'Rakam', 'Amount'),
  totalBeforeGst: w('Total before GST', 'GST se pehle total', 'Total Taxable Value'),
  roundOff: w('Rounded', 'Round kiya', 'Round Off'),
  total: w('Total to pay', 'Kul dena', 'Total'),
  inWords: w('In words', 'Shabdon mein', 'Amount Chargeable (in words)'),
  paid: w('Paid', 'Diya', 'Amount Paid'),
  outstanding: w('Still due', 'Abhi baaki', 'Balance Due'),
  rcmTax: w(
    'GST you pay directly to the government',
    'Jo GST aap seedha sarkar ko bharenge',
    'Tax Payable on Reverse Charge',
  ),
  transport: w('Transport', 'Transport', 'Dispatched through'),
  vehicle: w('Vehicle', 'Gaadi', 'Vehicle No.'),
  eWayBill: w('E-way bill', 'E-way bill', 'e-Way Bill No.'),
  irn: w('Government reference (IRN)', 'Sarkari reference (IRN)', 'IRN'),
  bank: w('Pay into', 'Yahan bhejein', 'Bank Details'),
  po: w('Your order reference', 'Aapka order reference', "Buyer's Order No."),
  serial: w('Sl', 'Sl', 'Sl No.'),
  per: w('per', 'per'),
  taxSummary: w('Tax summary by HSN / SAC', 'HSN / SAC ke hisaab se tax', 'HSN / SAC Summary'),
  taxInWords: w('Tax amount in words', 'Tax ki rakam shabdon mein', 'Tax Amount (in words)'),
  declaration: w('Declaration', 'Ghoshna'),
  forSeller: w('for', 'ki taraf se'),
  authorisedSignatory: w('Authorised Signatory', 'Adhikrit hastakshar'),
  totalWord: w('Total', 'Kul'),
  pan: w('PAN', 'PAN'),
  packages: w('Packages', 'Packet', 'No. & Kind of Pkgs'),
  lrNumber: w('LR / RR number', 'LR / RR number', 'LR / RR No.'),
  transportDoc: w('Transport document', 'Transport document', 'Transport Doc No. & Date'),
  destination: w('Destination', 'Kahan pahunchana hai', 'Destination'),
  eoe: w('E. & O.E.', 'E. & O.E.'),
  computerGenerated: w(
    'This is a computer generated invoice.',
    'Yeh bill computer se bana hai.',
  ),
  // Issue #137 — the copy markings GST asks a goods invoice to carry.
  copyOriginal: w('Original, for the customer', 'Original, customer ke liye', 'ORIGINAL FOR RECIPIENT'),
  copyDuplicateTransporter: w('Duplicate, for the transporter', 'Duplicate, transporter ke liye', 'DUPLICATE FOR TRANSPORTER'),
  copyTriplicate: w('Triplicate, kept by you', 'Triplicate, aapke paas', 'TRIPLICATE FOR SUPPLIER'),
  copyDuplicateSupplier: w('Duplicate, kept by you', 'Duplicate, aapke paas', 'DUPLICATE FOR SUPPLIER'),
} as const;

export type WordingKey = keyof typeof T;

/** What the printed document says. This is the one the renderers use. */
export const t = (key: WordingKey, locale: Locale): string => {
  const entry = T[key] as Wording;
  return locale === 'hi-IN' ? entry.hi : (entry.printed ?? entry.plain);
};

/**
 * What a screen says. Kept beside the printed wording precisely so the two cannot drift: a change
 * to one is made in the same object as the other.
 */
export const screenWord = (key: WordingKey, locale: Locale): string => {
  const entry = T[key] as Wording;
  return locale === 'hi-IN' ? entry.hi : entry.plain;
};

/** Every wording key, so a test can walk both vocabularies. */
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

/** The narrow shapes get a list, because a nine-column table on 58mm of paper is unreadable. */
export const narrowLine = (line: RenderableLine, locale: Locale): string => `
  <div class="tline">
    <div class="tline-name">${escapeHtml(line.description)}${line.reverseCharge ? ' (RCM)' : ''}</div>
    <div class="tline-detail"><span>${line.kind === 'CHARGE' ? '' : `${escapeHtml(line.quantityText)} × ${money(line.unitPrice)}`}</span><span class="num">${money(line.taxableValue)}</span></div>
    ${line.ratePercentTimes100 === null ? '' : `<div class="tline-tax"><span>${escapeHtml(t('gstAmount', locale))} ${escapeHtml(percent(line.ratePercentTimes100))}</span><span class="num">${money(line.taxAmount)}</span></div>`}
  </div>`;
