/**
 * Issue #142 — the quotation and the proforma invoice, printed on the same engine as the invoice.
 *
 * Same page shell, same stylesheet, same escaping, and the same item table, totals and HSN summary
 * the invoice draws (`boxed.ts`), so a buyer holding the quotation, the proforma and the invoice side
 * by side reads the same columns in the same places. What differs, and why:
 *
 *  - **The title** is "Quotation" or "Proforma Invoice", and under it the page says **"Not a tax
 *    invoice"**. GST prescribes no format for either paper, but neither may be mistaken for a tax
 *    invoice: nobody may claim tax credit on it, and it records no sale.
 *  - **"Valid Until"** prints when the business has said how long its prices hold. Nothing is
 *    defaulted — how long a price holds is the business's commitment, not ours.
 *  - **The proforma carries the bank details**, because it is sent to collect payment. The quotation
 *    does not: it is a price offer, and nobody pays against one.
 *  - **The proforma carries the buyer's order number and the payment terms** when the business typed
 *    them, in the boxes the invoice uses for the same facts.
 *
 * What neither ever carries, because each belongs only on a registered tax invoice or on goods on
 * the road: an e-invoice block (IRN, QR, acknowledgement), copy markings, a reverse-charge row, an
 * e-way bill or transport box, a due date, or an amount paid and balance due.
 */
import { formatDate, type IsoDate } from '@invoice/kernel';
import type { PreSaleDocument, PreSaleKind, PreSaleState } from '@invoice/sales';
import type {
  Locale,
  RenderableBank,
  RenderableLine,
  RenderableParty,
  RenderableReferences,
  RenderableTotals,
  TaxSplit,
  TemplateSnapshot,
} from './document.ts';
import type { PageFormat } from './template.ts';
import { cell, itemTable, partyCell, summaryTable, totalsTable } from './boxed.ts';
import { escapeHtml, money, narrowLine, t, type WordingKey } from './parts.ts';
import { renderReservedSlot } from './reserved.ts';
import { renderableLine } from './from-sales.ts';
import { amountInWords } from './words.ts';

/**
 * What these pages carry, and on what basis. Samay decides by this distinction, so it is written
 * down: `LAW` is required by a rule, `CONVENTION` is what Indian businesses and Tally print, and
 * `BUSINESS` is the business's own choice and prints only when the business has filled it in.
 * GST sets no format for either paper, so nothing here is `LAW`.
 */
export const PRESALE_PRINTED_FIELDS: readonly { readonly id: string; readonly basis: 'LAW' | 'CONVENTION' | 'BUSINESS'; readonly why: string }[] = [
  { id: 'title', basis: 'CONVENTION', why: '"Quotation" or "Proforma Invoice", so the paper says what it is.' },
  { id: 'notTaxInvoice', basis: 'CONVENTION', why: 'Issue #142: neither may be mistaken for a tax invoice or used to claim tax credit.' },
  { id: 'number', basis: 'CONVENTION', why: 'Its own series, never the invoice series.' },
  { id: 'date', basis: 'CONVENTION', why: 'The day the offer or request was made.' },
  { id: 'seller.nameAddressGstin', basis: 'CONVENTION', why: 'Who is offering, as on the invoice that follows.' },
  { id: 'buyer.nameAddressGstin', basis: 'CONVENTION', why: 'Who it is for.' },
  { id: 'line.hsnQuantityRateAmount', basis: 'CONVENTION', why: 'What is offered, at what rate — the same table as the invoice.' },
  { id: 'line.taxRate', basis: 'CONVENTION', why: 'The GST that will apply, so the buyer knows the full price.' },
  { id: 'totals', basis: 'CONVENTION', why: 'Value before tax, each tax on its own line, and the total.' },
  { id: 'placeOfSupply', basis: 'CONVENTION', why: 'Decides which GST applies, so it is shown with the tax.' },
  { id: 'signature', basis: 'CONVENTION', why: 'An offer or request signed for the business.' },
  { id: 'validUntil', basis: 'BUSINESS', why: 'How long the prices hold. Never defaulted.' },
  { id: 'terms', basis: 'BUSINESS', why: 'The business\'s own terms, printed as typed. Never defaulted.' },
  { id: 'proforma.bankDetails', basis: 'CONVENTION', why: 'A proforma asks for payment, so it says where to pay.' },
  { id: 'proforma.buyerOrderNumber', basis: 'BUSINESS', why: 'The buyer\'s own reference, when there is one.' },
  { id: 'proforma.paymentTerms', basis: 'BUSINESS', why: 'How and when the buyer is asked to pay. Never defaulted.' },
];

/**
 * What a quotation or proforma is printed from. Flattened, like the invoice's document, so a reprint
 * shows the names, addresses and figures as they were on the day it was sent.
 */
export interface PreSalePrint {
  readonly kind: PreSaleKind;
  readonly number: string;
  readonly date: IsoDate;
  readonly validUntil: IsoDate | null;
  readonly state: PreSaleState;
  readonly seller: RenderableParty;
  readonly buyer: RenderableParty;
  /** Where the goods would go, when that is not the buyer's own address. */
  readonly shipTo: RenderableParty | null;
  readonly placeOfSupplyStateCode: string;
  readonly placeOfSupplyStateName: string;
  readonly split: TaxSplit;
  readonly lines: readonly RenderableLine[];
  readonly totals: RenderableTotals;
  readonly amountInWordsText: string;
  readonly taxAmountInWordsText: string;
  readonly declaredRateNotice: { readonly 'en-IN': string; readonly 'hi-IN': string } | null;
  readonly terms: string | null;
  readonly buyerOrderNumber: string | null;
  readonly paymentTerms: string | null;
  /** Proforma only. */
  readonly bank: RenderableBank | null;
  readonly bankDetails: readonly string[] | null;
  /** The tax invoice a proforma was billed on, once linked. */
  readonly invoice: { readonly number: string; readonly date: IsoDate } | null;
  readonly logoDataUri: string | null;
  readonly signatureDataUri: string | null;
}

export interface PreSalePrintingContext {
  readonly seller: RenderableParty;
  readonly buyer: RenderableParty;
  readonly shipTo?: RenderableParty | null;
  /** The name of the place-of-supply state. The document stores only its code. */
  readonly placeOfSupplyStateName: string;
  /** Printed on a proforma only; ignored on a quotation. */
  readonly bank?: RenderableBank | null;
  readonly bankDetails?: readonly string[] | null;
  readonly logoDataUri?: string | null;
  readonly signatureDataUri?: string | null;
}

export const toPreSalePrint = (document: PreSaleDocument, context: PreSalePrintingContext): PreSalePrint => {
  const proforma = document.kind === 'PROFORMA';
  const totals = document.pricing.totals;
  return {
    kind: document.kind,
    number: document.number,
    date: document.documentDate,
    validUntil: document.validUntil,
    state: document.state,
    seller: context.seller,
    buyer: context.buyer,
    shipTo: context.shipTo ?? null,
    placeOfSupplyStateCode: document.pricing.placeOfSupplyStateCode,
    placeOfSupplyStateName: context.placeOfSupplyStateName,
    split: document.pricing.split,
    lines: document.pricing.lines.map((l) => renderableLine(l)),
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
      amountPaid: null,
      outstanding: null,
    },
    amountInWordsText: amountInWords(totals.invoiceValue),
    taxAmountInWordsText: amountInWords(totals.totalTax),
    declaredRateNotice: document.declaredRateNotice,
    terms: document.terms,
    buyerOrderNumber: document.buyerOrderNumber,
    paymentTerms: document.paymentTerms,
    bank: proforma ? context.bank ?? null : null,
    bankDetails: proforma ? context.bankDetails ?? null : null,
    invoice: document.invoice === null ? null : { number: document.invoice.invoiceNumber, date: document.invoice.invoiceDate },
    logoDataUri: context.logoDataUri ?? null,
    signatureDataUri: context.signatureDataUri ?? null,
  };
};

/**
 * The invoice's "Reference No. & Date" box, filled from the quotation it was made from or the
 * proforma it billed.
 *
 * That is the box Tally prints the seller's own earlier reference in, and it is what a buyer's clerk
 * matches an advance paid against a proforma to. Several references are listed and the single date
 * box is left empty rather than holding one of them, as the Delivery Note box does for challans.
 */
export const invoiceReferencesFromPreSale = (
  documents: readonly Pick<PreSaleDocument, 'number' | 'documentDate' | 'state'>[],
): Pick<RenderableReferences, 'referenceNumber' | 'referenceDate'> => {
  const live = documents.filter((d) => d.state !== 'CANCELLED');
  if (live.length === 0) return { referenceNumber: null, referenceDate: null };
  return {
    referenceNumber: live.map((d) => d.number).join(', '),
    referenceDate: live.length === 1 ? (live[0] as (typeof live)[number]).documentDate : null,
  };
};

const TITLE: Record<PreSaleKind, WordingKey> = { QUOTATION: 'QUOTATION', PROFORMA: 'PROFORMA_INVOICE' };
const NUMBER_LABEL: Record<PreSaleKind, WordingKey> = { QUOTATION: 'quotationNo', PROFORMA: 'proformaNo' };

export const preSaleTitle = (kind: PreSaleKind, locale: Locale): string => t(TITLE[kind], locale);

const placeOfSupply = (doc: PreSalePrint): string =>
  `${escapeHtml(doc.placeOfSupplyStateName)} (${escapeHtml(doc.placeOfSupplyStateCode)})`;

const subtitle = (doc: PreSalePrint, locale: Locale): string =>
  `${escapeHtml(t('notTaxInvoice', locale))}${doc.state === 'CANCELLED' ? ` · <strong>${escapeHtml(t('cancelledMark', locale))}</strong>` : ''}`;

const bankLinesOf = (doc: PreSalePrint, locale: Locale): string[] =>
  doc.bank !== null
    ? ([
        [t('bankName', locale), doc.bank.bankName],
        [t('accountNumber', locale), doc.bank.accountNumber],
        [t('branchIfsc', locale), [doc.bank.branch, doc.bank.ifsc].filter((v) => v != null && v !== '').join(' & ')],
      ] as const)
        .filter(([, v]) => v != null && v !== '')
        .map(([label, v]) => `<div><span class="cap-inline">${escapeHtml(label)}</span> ${escapeHtml(v as string)}</div>`)
    : (doc.bankDetails ?? []).map((l) => `<div>${escapeHtml(l)}</div>`);

/** The whole boxed page, for A4 and the phone screen. */
export const renderPreSaleBoxed = (doc: PreSalePrint, snapshot: TemplateSnapshot, format: PageFormat, locale: Locale): string => {
  const shows = (fieldId: string): boolean => snapshot.optionalFields.includes(fieldId);
  const logo =
    snapshot.logo.show && shows('seller.logo') && doc.logoDataUri !== null
      ? `<img class="logo" src="${escapeHtml(doc.logoDataUri)}" alt="${escapeHtml(doc.seller.name)}">`
      : '';
  const goods = doc.lines.filter((l) => l.kind !== 'CHARGE');
  const charges = doc.lines.filter((l) => l.kind === 'CHARGE');

  const validityRow =
    doc.validUntil === null
      ? `<tr>${cell(t('placeOfSupply', locale), placeOfSupply(doc), 2)}</tr>`
      : `<tr>${cell(t('validUntil', locale), `<strong>${escapeHtml(formatDate(doc.validUntil))}</strong>`)}${cell(t('placeOfSupply', locale), placeOfSupply(doc))}</tr>`;
  // Drawn only when the business typed at least one of them, as the invoice's reference rows are.
  const orderRow =
    doc.buyerOrderNumber === null && doc.paymentTerms === null
      ? ''
      : `<tr>${cell(t('po', locale), escapeHtml(doc.buyerOrderNumber ?? ''))}${cell(t('paymentTerms', locale), escapeHtml(doc.paymentTerms ?? ''))}</tr>`;
  const invoiceRow =
    doc.invoice === null ? '' : `<tr>${cell(t('invoiceRef', locale), escapeHtml(`${doc.invoice.number}, ${formatDate(doc.invoice.date)}`), 2)}</tr>`;

  const buyerRow =
    doc.shipTo === null
      ? `<tr>${partyCell(doc.buyer, t('billedTo', locale), locale, shows, 2)}</tr>`
      : `<tr>${partyCell(doc.buyer, t('billedTo', locale), locale, shows)}${partyCell(doc.shipTo, t('shipTo', locale), locale, shows)}</tr>`;

  const bankLines = bankLinesOf(doc, locale);
  const bank = bankLines.length === 0 || !shows('seller.bankDetails') ? '' : `<td><span class="cap">${escapeHtml(t('bank', locale))}</span>${bankLines.join('')}</td>`;
  const signature = `<td class="sign-cell">
      <span class="cap">${escapeHtml(t('forSeller', locale))} ${escapeHtml(doc.seller.name)}</span>
      <div class="sign-space">${
        doc.signatureDataUri === null
          ? renderReservedSlot('signature', format, locale, escapeHtml)
          : `<img class="sign-image" src="${escapeHtml(doc.signatureDataUri)}" alt="">`
      }</div>
      <div class="sign-line">${escapeHtml(t('authorisedSignatory', locale))}</div>
    </td>`;
  const notations = [
    shows('footer.computerGenerated') ? t('computerGeneratedDocument', locale) : '',
    shows('footer.eoe') ? t('eoe', locale) : '',
  ].filter((n) => n !== '');

  return `
  <table class="grid head">
    <tr><td class="title-cell" colspan="2"><h1>${escapeHtml(preSaleTitle(doc.kind, locale))}</h1><div class="not-invoice">${subtitle(doc, locale)}</div></td></tr>
    <tr>
      ${partyCell(doc.seller, '', locale, shows).replace('<span class="cap"></span>', logo)}
      <td class="meta-cell">
        <table class="grid inner">
          <tr>${cell(t(NUMBER_LABEL[doc.kind], locale), `<strong>${escapeHtml(doc.number)}</strong>`)}${cell(t('documentDate', locale), escapeHtml(formatDate(doc.date)))}</tr>
          ${validityRow}
          ${orderRow}
          ${invoiceRow}
        </table>
      </td>
    </tr>
    ${buyerRow}
  </table>
  ${itemTable(goods, charges, snapshot, locale)}
  <table class="grid words">
    <tr><td><span class="cap">${escapeHtml(t('amountInWords', locale))}</span><strong>${escapeHtml(doc.amountInWordsText)}</strong></td></tr>
  </table>
  ${totalsTable(doc, locale, () => false)}
  <table class="grid section"><tr><td>${escapeHtml(t('taxSummary', locale))}</td></tr></table>
  ${summaryTable(doc, locale)}
  <table class="grid words">
    <tr><td><span class="cap">${escapeHtml(t('taxInWords', locale))}</span>${escapeHtml(doc.taxAmountInWordsText)}</td></tr>
  </table>
  ${doc.declaredRateNotice === null ? '' : `<table class="grid notice"><tr><td>${escapeHtml(doc.declaredRateNotice[locale])}</td></tr></table>`}
  ${doc.terms === null ? '' : `<table class="grid words"><tr><td><span class="cap">${escapeHtml(t('termsAndConditions', locale))}</span>${escapeHtml(doc.terms)}</td></tr></table>`}
  <table class="grid foot"><tr>${bank}${signature}</tr></table>
  ${notations.length === 0 ? '' : `<table class="grid notations"><tr><td>${notations.map((n) => escapeHtml(n)).join(' &nbsp;&nbsp; ')}</td></tr></table>`}`;
};

/**
 * The till-roll shape. A quotation is rarely printed on one, but the engine takes every format and a
 * list is the only thing that fits on 58 millimetres. The signature lines stay: an offer is signed.
 */
export const renderPreSaleNarrow = (doc: PreSalePrint, locale: Locale): string => {
  const kv = (key: WordingKey, value: string): string => `<div><span class="k">${escapeHtml(t(key, locale))}:</span> ${value}</div>`;
  const taxRows = (
    [
      ['CGST', doc.totals.cgst],
      ['SGST', doc.totals.sgst],
      ['UTGST', doc.totals.utgst],
      ['IGST', doc.totals.igst],
      ['Cess', doc.totals.cess],
    ] as const
  )
    .filter(([, amount]) => amount.minor !== 0n)
    .map(([label, amount]) => `<tr><td>${escapeHtml(label)}</td><td class="num">${money(amount)}</td></tr>`)
    .join('');
  const bankLines = bankLinesOf(doc, locale);
  return `
  <h1>${escapeHtml(preSaleTitle(doc.kind, locale))}</h1>
  <div><strong>${subtitle(doc, locale)}</strong></div>
  <div class="party-name">${escapeHtml(doc.seller.name)}</div>
  ${doc.seller.gstin === null ? '' : kv('gstin', escapeHtml(doc.seller.gstin))}
  ${kv(NUMBER_LABEL[doc.kind], `<strong>${escapeHtml(doc.number)}</strong>`)}
  ${kv('documentDate', escapeHtml(formatDate(doc.date)))}
  ${doc.validUntil === null ? '' : kv('validUntil', `<strong>${escapeHtml(formatDate(doc.validUntil))}</strong>`)}
  <div class="ship-line"><span class="k">${escapeHtml(t('billedTo', locale))}:</span> ${escapeHtml(
    [doc.buyer.name, ...doc.buyer.addressLines, doc.buyer.stateName, doc.buyer.gstin ?? ''].filter((v) => v !== '').join(', '),
  )}</div>
  ${kv('placeOfSupply', placeOfSupply(doc))}
  ${doc.buyerOrderNumber === null ? '' : kv('po', escapeHtml(doc.buyerOrderNumber))}
  ${doc.paymentTerms === null ? '' : kv('paymentTerms', escapeHtml(doc.paymentTerms))}
  <div class="items-narrow">${doc.lines.map((l) => narrowLine(l, locale)).join('')}</div>
  <table class="totals">
    <tr><td>${escapeHtml(t('totalBeforeGst', locale))}</td><td class="num">${money(doc.totals.taxableValue)}</td></tr>
    ${taxRows}
    ${doc.totals.roundOff.minor === 0n ? '' : `<tr><td>${escapeHtml(t('roundOff', locale))}</td><td class="num">${money(doc.totals.roundOff)}</td></tr>`}
    <tr class="grand"><td>${escapeHtml(t('total', locale))}</td><td class="num">${money(doc.totals.invoiceValue)}</td></tr>
  </table>
  <div class="words"><span class="k">${escapeHtml(t('amountInWords', locale))}:</span> ${escapeHtml(doc.amountInWordsText)}</div>
  ${doc.declaredRateNotice === null ? '' : `<div class="notice">${escapeHtml(doc.declaredRateNotice[locale])}</div>`}
  ${doc.terms === null ? '' : `<div><span class="k">${escapeHtml(t('termsAndConditions', locale))}:</span> ${escapeHtml(doc.terms)}</div>`}
  ${bankLines.length === 0 ? '' : `<div><span class="k">${escapeHtml(t('bank', locale))}:</span>${bankLines.join('')}</div>`}
  <footer><div style="margin-top:8mm">${escapeHtml(t('forSeller', locale))} ${escapeHtml(doc.seller.name)}</div><div><strong>${escapeHtml(t('authorisedSignatory', locale))}</strong></div></footer>`;
};
