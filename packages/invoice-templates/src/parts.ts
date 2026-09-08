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

const T = {
  TAX_INVOICE: { 'en-IN': 'Tax invoice', 'hi-IN': 'Tax invoice' },
  BILL_OF_SUPPLY: { 'en-IN': 'Bill of supply', 'hi-IN': 'Bill of supply' },
  CREDIT_NOTE: { 'en-IN': 'Return note', 'hi-IN': 'Wapsi note' },
  DEBIT_NOTE: { 'en-IN': 'Extra charge note', 'hi-IN': 'Extra charge note' },
  billedTo: { 'en-IN': 'Billed to', 'hi-IN': 'Kiske naam' },
  invoiceNo: { 'en-IN': 'Bill number', 'hi-IN': 'Bill number' },
  date: { 'en-IN': 'Date', 'hi-IN': 'Taarikh' },
  dueDate: { 'en-IN': 'Payment due', 'hi-IN': 'Payment kab tak' },
  placeOfSupply: { 'en-IN': 'This sale counts in', 'hi-IN': 'Bikri kis rajya ki' },
  reverseCharge: { 'en-IN': 'Customer pays the GST directly', 'hi-IN': 'GST customer khud bharega' },
  gstin: { 'en-IN': 'GST number', 'hi-IN': 'GST number' },
  item: { 'en-IN': 'Item', 'hi-IN': 'Item' },
  hsn: { 'en-IN': 'HSN / SAC', 'hi-IN': 'HSN / SAC' },
  qty: { 'en-IN': 'Qty', 'hi-IN': 'Kitna' },
  rate: { 'en-IN': 'Rate', 'hi-IN': 'Rate' },
  discount: { 'en-IN': 'Discount', 'hi-IN': 'Chhoot' },
  batch: { 'en-IN': 'Batch', 'hi-IN': 'Batch' },
  note: { 'en-IN': 'Note', 'hi-IN': 'Note' },
  taxable: { 'en-IN': 'Taxable value', 'hi-IN': 'Jis par tax laga' },
  subTotal: { 'en-IN': 'Sub-total for goods', 'hi-IN': 'Maal ka sub-total' },
  charges: { 'en-IN': 'Charges added to this bill', 'hi-IN': 'Bill mein jude charge' },
  gstPercent: { 'en-IN': 'GST %', 'hi-IN': 'GST %' },
  gstAmount: { 'en-IN': 'GST', 'hi-IN': 'GST' },
  lineTotal: { 'en-IN': 'Amount', 'hi-IN': 'Rakam' },
  totalBeforeGst: { 'en-IN': 'Total before GST', 'hi-IN': 'GST se pehle total' },
  roundOff: { 'en-IN': 'Rounded', 'hi-IN': 'Round kiya' },
  total: { 'en-IN': 'Total to pay', 'hi-IN': 'Kul dena' },
  inWords: { 'en-IN': 'In words', 'hi-IN': 'Shabdon mein' },
  paid: { 'en-IN': 'Paid', 'hi-IN': 'Diya' },
  outstanding: { 'en-IN': 'Still due', 'hi-IN': 'Abhi baaki' },
  rcmTax: { 'en-IN': 'GST you pay directly to the government', 'hi-IN': 'Jo GST aap seedha sarkar ko bharenge' },
  transport: { 'en-IN': 'Transport', 'hi-IN': 'Transport' },
  vehicle: { 'en-IN': 'Vehicle', 'hi-IN': 'Gaadi' },
  eWayBill: { 'en-IN': 'E-way bill', 'hi-IN': 'E-way bill' },
  irn: { 'en-IN': 'Government reference (IRN)', 'hi-IN': 'Sarkari reference (IRN)' },
  bank: { 'en-IN': 'Pay into', 'hi-IN': 'Yahan bhejein' },
  po: { 'en-IN': 'Your order reference', 'hi-IN': 'Aapka order reference' },
  // Issue #140 — wording the boxed design needs.
  serial: { 'en-IN': 'Sl', 'hi-IN': 'Sl' },
  per: { 'en-IN': 'per', 'hi-IN': 'per' },
  taxSummary: { 'en-IN': 'Tax summary by HSN / SAC', 'hi-IN': 'HSN / SAC ke hisaab se tax' },
  taxInWords: { 'en-IN': 'Tax amount in words', 'hi-IN': 'Tax ki rakam shabdon mein' },
  declaration: { 'en-IN': 'Declaration', 'hi-IN': 'Ghoshna' },
  forSeller: { 'en-IN': 'for', 'hi-IN': 'ki taraf se' },
  authorisedSignatory: { 'en-IN': 'Authorised Signatory', 'hi-IN': 'Adhikrit hastakshar' },
  totalWord: { 'en-IN': 'Total', 'hi-IN': 'Kul' },
} as const;

export type Wording = keyof typeof T;
export const t = (key: Wording, locale: Locale): string => T[key][locale];

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
