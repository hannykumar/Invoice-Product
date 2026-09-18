/**
 * Issue #186 — the credit note and the debit note, printed on the same engine as the invoice.
 *
 * When goods come back, the customer needs a paper: without it they cannot reverse the GST credit
 * they claimed on the bill, and the business holds nothing that shows the reduction it is making.
 * CGST Rule 53(1A) lists what that paper carries, and this page carries all of it:
 *
 *  - (a) the supplier's name, address and GSTIN — the business's own particulars, frozen when the
 *    note is issued (#180);
 *  - (b) what the document is: "Credit Note";
 *  - (c) its number, unique for the financial year (#185), and (d) its date;
 *  - (e) the recipient's name, address and GSTIN, and (f) for an unregistered recipient the delivery
 *    address with its state — copied from the original bill as it was printed, never re-read;
 *  - (g) the number and date of the invoice it is issued against — a list, because the rule allows
 *    one note against several invoices;
 *  - (h) the taxable value, the tax rate and the tax credited, per line and in total;
 *  - (i) the signature.
 *
 * The tax is the original bill's tax, reversed at that bill's rates and on that bill's split. Nothing
 * is recalculated from today's rates.
 *
 * A purchase return prints as a "Debit Note" addressed to the supplier, against the supplier's
 * invoice. Under GST it is the supplier who issues the credit note for goods sent back; the buyer's
 * debit note is the business's own commercial document, so the page does not call it anything more.
 *
 * No copy markings: CGST Rule 48 prescribes copies for tax invoices, not for credit notes.
 */
import { formatDate, formatQuantity, sum, type IsoDate, type Money } from '@invoice/kernel';
import type { ReturnNote } from '@invoice/returns';
import type { InvoiceDocument, Locale, RenderableParty, TemplateSnapshot } from './document.ts';
import type { PageFormat } from './template.ts';
import { cell, partyCell } from './boxed.ts';
import { escapeHtml, isZero, money, percent, splitQuantity, t } from './parts.ts';
import { renderReservedSlot } from './reserved.ts';
import { amountInWords } from './words.ts';

/** Rule 53(1A)(a) to (i), as the fields this page is checked for. */
export const CREDIT_NOTE_MANDATORY_FIELDS: readonly { readonly id: string; readonly clause: string }[] = [
  { id: 'supplier.nameAddressGstin', clause: 'Rule 53(1A)(a)' },
  { id: 'document.nature', clause: 'Rule 53(1A)(b)' },
  { id: 'note.number', clause: 'Rule 53(1A)(c)' },
  { id: 'note.date', clause: 'Rule 53(1A)(d)' },
  { id: 'recipient.nameAddressGstin', clause: 'Rule 53(1A)(e) and (f)' },
  { id: 'against.invoiceNumberAndDate', clause: 'Rule 53(1A)(g)' },
  { id: 'line.taxableValue', clause: 'Rule 53(1A)(h)' },
  { id: 'line.taxRate', clause: 'Rule 53(1A)(h)' },
  { id: 'line.taxAmount', clause: 'Rule 53(1A)(h)' },
  { id: 'signature', clause: 'Rule 53(1A)(i)' },
];

export interface CreditNoteLine {
  readonly lineId: string;
  readonly description: string;
  readonly hsnOrSac: string | null;
  /** Already formatted with its unit, e.g. "5 PCS". */
  readonly quantityText: string;
  readonly unitPrice: Money | null;
  readonly taxableValue: Money;
  readonly ratePercentTimes100: bigint | null;
  readonly taxAmount: Money;
}

/** What a credit or debit note is printed from. Flattened and frozen, like the invoice's document. */
export interface CreditNoteDocument {
  readonly title: 'CREDIT_NOTE' | 'DEBIT_NOTE';
  readonly number: string;
  readonly date: IsoDate;
  /** The business issuing the note. */
  readonly issuer: RenderableParty;
  /** The customer (credit note) or the supplier (debit note), as on the original bill. */
  readonly counterparty: RenderableParty;
  /** Rule 53(1A)(f) — where the goods went, for an unregistered recipient. */
  readonly deliveryAddress: RenderableParty | null;
  /** Rule 53(1A)(g) — one or more invoices. Never empty. */
  readonly against: readonly { readonly number: string; readonly date: IsoDate }[];
  readonly placeOfSupplyStateCode: string | null;
  readonly placeOfSupplyStateName: string | null;
  readonly reason: string;
  readonly lines: readonly CreditNoteLine[];
  readonly totals: {
    readonly taxableValue: Money;
    readonly cgst: Money;
    readonly sgst: Money;
    readonly utgst: Money;
    readonly igst: Money;
    readonly cess: Money;
    readonly totalTax: Money;
    readonly total: Money;
  };
  readonly amountInWordsText: string;
  readonly logoDataUri: string | null;
  readonly signatureDataUri: string | null;
}

/** The facts the note takes from the original bill as it was printed. */
export interface NoteOriginal {
  readonly counterparty: RenderableParty;
  readonly deliveryAddress?: RenderableParty | null;
  readonly placeOfSupplyStateCode: string | null;
  readonly placeOfSupplyStateName: string | null;
}

/** The business issuing the note, from its saved particulars on the day it is issued (#180). */
export interface NoteIssuer {
  readonly seller: RenderableParty;
  readonly logoDataUri?: string | null;
  readonly signatureDataUri?: string | null;
}

/**
 * The customer, the delivery address and the place of supply, as the original invoice printed them.
 * A registered buyer's GSTIN is enough; for an unregistered one the delivery address is carried too.
 */
export const noteOriginalFromInvoice = (invoice: InvoiceDocument): NoteOriginal => ({
  counterparty: invoice.buyer,
  deliveryAddress: invoice.buyer.gstin === null ? invoice.shipTo ?? null : null,
  placeOfSupplyStateCode: invoice.placeOfSupplyStateCode,
  placeOfSupplyStateName: invoice.placeOfSupplyStateName,
});

export const toCreditNoteDocument = (note: ReturnNote, original: NoteOriginal, issuer: NoteIssuer): CreditNoteDocument => {
  const totalTax = sum([note.totals.cgst, note.totals.sgst, note.totals.utgst, note.totals.igst, note.totals.cess]);
  return {
    title: note.kind === 'SALES_RETURN' ? 'CREDIT_NOTE' : 'DEBIT_NOTE',
    number: note.number,
    date: note.documentDate,
    issuer: issuer.seller,
    counterparty: original.counterparty,
    deliveryAddress: original.deliveryAddress ?? null,
    against: [{ number: note.originalDocument.number, date: note.originalDocument.date }],
    placeOfSupplyStateCode: original.placeOfSupplyStateCode,
    placeOfSupplyStateName: original.placeOfSupplyStateName,
    reason: note.reason,
    lines: note.lines.map((line) => ({
      lineId: line.originalLineId,
      description: line.description,
      hsnOrSac: line.hsnOrSac,
      quantityText: formatQuantity(line.quantity),
      unitPrice: line.unitPrice,
      taxableValue: line.amounts.taxableValue,
      ratePercentTimes100: line.ratePercentTimes100,
      taxAmount: sum([line.amounts.cgst, line.amounts.sgst, line.amounts.utgst, line.amounts.igst, line.amounts.cess]),
    })),
    totals: {
      taxableValue: note.totals.taxableValue,
      cgst: note.totals.cgst,
      sgst: note.totals.sgst,
      utgst: note.totals.utgst,
      igst: note.totals.igst,
      cess: note.totals.cess,
      totalTax,
      total: note.totals.total,
    },
    amountInWordsText: amountInWords(note.totals.total),
    logoDataUri: issuer.logoDataUri ?? null,
    signatureDataUri: issuer.signatureDataUri ?? null,
  };
};

const isCredit = (doc: CreditNoteDocument): boolean => doc.title === 'CREDIT_NOTE';

/** "INV/26-27/000004 dated 15 Sep 2026", one per invoice, joined. */
const againstText = (doc: CreditNoteDocument, locale: Locale): string =>
  doc.against.map((a) => `${escapeHtml(a.number)} ${escapeHtml(t('dated', locale))} ${escapeHtml(formatDate(a.date))}`).join('; ');

const againstLabel = (doc: CreditNoteDocument, locale: Locale): string =>
  t(isCredit(doc) ? 'againstInvoice' : 'againstSupplierInvoice', locale);

const placeOfSupply = (doc: CreditNoteDocument): string =>
  doc.placeOfSupplyStateCode === null ? '' : `${escapeHtml(doc.placeOfSupplyStateName ?? '')} (${escapeHtml(doc.placeOfSupplyStateCode)})`;

/** The tax heads this note carries, never a row of zeroes. */
const taxRows = (doc: CreditNoteDocument): [string, Money][] =>
  ([
    ['CGST', doc.totals.cgst],
    ['SGST', doc.totals.sgst],
    ['UTGST', doc.totals.utgst],
    ['IGST', doc.totals.igst],
    ['Cess', doc.totals.cess],
  ] as [string, Money][]).filter(([, amount]) => !isZero(amount));

const totalLabel = (doc: CreditNoteDocument, locale: Locale): string => t(isCredit(doc) ? 'totalCredited' : 'totalDebited', locale);

const signatureCell = (doc: CreditNoteDocument, format: PageFormat, locale: Locale): string => `
  <td class="sign-cell">
    <span class="cap">${escapeHtml(t('forSeller', locale))} ${escapeHtml(doc.issuer.name)}</span>
    <div class="sign-space">${
      doc.signatureDataUri === null
        ? renderReservedSlot('signature', format, locale, escapeHtml)
        : `<img class="sign-image" src="${escapeHtml(doc.signatureDataUri)}" alt="">`
    }</div>
    <div class="sign-line">${escapeHtml(t('authorisedSignatory', locale))}</div>
  </td>`;

/** The whole boxed note, for A4 and the phone screen. */
export const renderCreditNoteBoxed = (
  doc: CreditNoteDocument,
  snapshot: TemplateSnapshot,
  format: PageFormat,
  locale: Locale,
): string => {
  const shows = (fieldId: string): boolean => snapshot.optionalFields.includes(fieldId);
  const logo =
    snapshot.logo.show && shows('seller.logo') && doc.logoDataUri !== null
      ? `<img class="logo" src="${escapeHtml(doc.logoDataUri)}" alt="${escapeHtml(doc.issuer.name)}">`
      : '';

  const headings: { label: string; share: number; num?: boolean }[] = [
    { label: t('serial', locale), share: 6, num: true },
    { label: t('item', locale), share: 21 },
    { label: t('hsn', locale), share: 12 },
    { label: t('qty', locale), share: 9, num: true },
    { label: t('per', locale), share: 6 },
    { label: t('rate', locale), share: 11, num: true },
    { label: t('taxable', locale), share: 13, num: true },
    { label: t('gstPercent', locale), share: 9, num: true },
    { label: t('gstAmount', locale), share: 13, num: true },
  ];
  const totalShare = headings.reduce((a, h) => a + h.share, 0);

  const rows = doc.lines
    .map((line, i) => {
      const q = splitQuantity(line.quantityText);
      return `<tr>
        <td class="num sl">${i + 1}</td>
        <td>${escapeHtml(line.description)}</td>
        <td>${escapeHtml(line.hsnOrSac ?? '')}</td>
        <td class="num">${escapeHtml(q.amount)}</td>
        <td>${escapeHtml(q.unit)}</td>
        <td class="num">${line.unitPrice === null ? '' : money(line.unitPrice)}</td>
        <td class="num">${money(line.taxableValue)}</td>
        <td class="num">${escapeHtml(percent(line.ratePercentTimes100))}</td>
        <td class="num">${money(line.taxAmount)}</td>
      </tr>`;
    })
    .join('');

  const counterpartyHeading = t(isCredit(doc) ? 'recipient' : 'supplierParty', locale);
  const partiesRow = doc.deliveryAddress === null
    ? `<tr>${partyCell(doc.counterparty, counterpartyHeading, locale, shows, 2)}</tr>`
    : `<tr>${partyCell(doc.counterparty, counterpartyHeading, locale, shows)}${partyCell(doc.deliveryAddress, t('shipTo', locale), locale, shows)}</tr>`;

  return `
  <table class="grid head">
    <tr><td class="title-cell" colspan="2"><h1>${escapeHtml(t(doc.title, locale))}</h1></td></tr>
    <tr>
      ${partyCell(doc.issuer, '', locale, shows).replace('<span class="cap"></span>', logo)}
      <td class="meta-cell">
        <table class="grid inner">
          <tr>${cell(t(isCredit(doc) ? 'creditNoteNo' : 'debitNoteNo', locale), `<strong>${escapeHtml(doc.number)}</strong>`)}${cell(t('noteDate', locale), escapeHtml(formatDate(doc.date)))}</tr>
          <tr>${cell(againstLabel(doc, locale), `<strong>${againstText(doc, locale)}</strong>`, 2)}</tr>
          <tr>${cell(t('placeOfSupply', locale), placeOfSupply(doc))}${cell(t('noteReason', locale), escapeHtml(doc.reason))}</tr>
        </table>
      </td>
    </tr>
    ${partiesRow}
  </table>
  <table class="grid items">
    <thead><tr>${headings
      .map((h) => `<th${h.num === true ? ' class="num"' : ''} style="width:${((h.share / totalShare) * 100).toFixed(2)}%">${escapeHtml(h.label)}</th>`)
      .join('')}</tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <table class="grid totals">
    <tr><td>${escapeHtml(t('totalBeforeGst', locale))}</td><td class="num">${money(doc.totals.taxableValue)}</td></tr>
    ${taxRows(doc).map(([label, amount]) => `<tr><td>${escapeHtml(label)}</td><td class="num">${money(amount)}</td></tr>`).join('')}
    <tr class="grand"><td>${escapeHtml(totalLabel(doc, locale))}</td><td class="num">${money(doc.totals.total)}</td></tr>
  </table>
  <table class="grid words">
    <tr><td><span class="cap">${escapeHtml(t('noteInWords', locale))}</span>${escapeHtml(doc.amountInWordsText)}</td></tr>
  </table>
  <table class="grid foot"><tr>${signatureCell(doc, format, locale)}</tr></table>`;
};

/**
 * The till-roll shape. Every Rule 53(1A) particular is still on it — a narrow roll is no reason to
 * leave off the invoice the note is against, or the signature.
 */
export const renderCreditNoteNarrow = (doc: CreditNoteDocument, locale: Locale): string => `
  <h1>${escapeHtml(t(doc.title, locale))}</h1>
  <div class="party-name">${escapeHtml(doc.issuer.name)}</div>
  ${doc.issuer.addressLines.map((l) => `<div>${escapeHtml(l)}</div>`).join('')}
  <div>${escapeHtml(doc.issuer.stateName)} (${escapeHtml(doc.issuer.stateCode)})</div>
  ${doc.issuer.gstin === null ? '' : `<div><span class="k">${escapeHtml(t('gstin', locale))}:</span> ${escapeHtml(doc.issuer.gstin)}</div>`}
  <div><span class="k">${escapeHtml(t(isCredit(doc) ? 'creditNoteNo' : 'debitNoteNo', locale))}:</span> <strong>${escapeHtml(doc.number)}</strong></div>
  <div><span class="k">${escapeHtml(t('noteDate', locale))}:</span> ${escapeHtml(formatDate(doc.date))}</div>
  <div><span class="k">${escapeHtml(againstLabel(doc, locale))}:</span> <strong>${againstText(doc, locale)}</strong></div>
  <div class="ship-line"><span class="k">${escapeHtml(t(isCredit(doc) ? 'recipient' : 'supplierParty', locale))}:</span> ${escapeHtml(
    [doc.counterparty.name, ...doc.counterparty.addressLines, doc.counterparty.stateCode === '' ? '' : `${doc.counterparty.stateName} (${doc.counterparty.stateCode})`, doc.counterparty.gstin ?? ''].filter((v) => v !== '').join(', '),
  )}</div>
  ${doc.deliveryAddress === null ? '' : `<div class="ship-line"><span class="k">${escapeHtml(t('shipTo', locale))}:</span> ${escapeHtml(
    [...doc.deliveryAddress.addressLines, `${doc.deliveryAddress.stateName} (${doc.deliveryAddress.stateCode})`].join(', '),
  )}</div>`}
  ${doc.placeOfSupplyStateCode === null ? '' : `<div><span class="k">${escapeHtml(t('placeOfSupply', locale))}:</span> ${placeOfSupply(doc)}</div>`}
  <div><span class="k">${escapeHtml(t('noteReason', locale))}:</span> ${escapeHtml(doc.reason)}</div>
  <div class="items-narrow">${doc.lines
    .map(
      (l) => `<div class="tline">
        <div class="tline-name">${escapeHtml(l.description)} <span class="k">${escapeHtml(l.hsnOrSac ?? '')}</span></div>
        <div class="tline-detail"><span>${escapeHtml(l.quantityText)}${l.unitPrice === null ? '' : ` × ${money(l.unitPrice)}`}</span><span class="num">${money(l.taxableValue)}</span></div>
        <div class="tline-tax"><span>${escapeHtml(t('gstAmount', locale))} ${escapeHtml(percent(l.ratePercentTimes100))}</span><span class="num">${money(l.taxAmount)}</span></div>
      </div>`,
    )
    .join('')}</div>
  <table class="totals">
    <tr><td>${escapeHtml(t('totalBeforeGst', locale))}</td><td class="num">${money(doc.totals.taxableValue)}</td></tr>
    ${taxRows(doc).map(([label, amount]) => `<tr><td>${escapeHtml(label)}</td><td class="num">${money(amount)}</td></tr>`).join('')}
    <tr class="grand"><td>${escapeHtml(totalLabel(doc, locale))}</td><td class="num">${money(doc.totals.total)}</td></tr>
  </table>
  <div>${escapeHtml(t('noteInWords', locale))}: ${escapeHtml(doc.amountInWordsText)}</div>
  <footer><div style="margin-top:8mm">${escapeHtml(t('forSeller', locale))} ${escapeHtml(doc.issuer.name)}</div><div><strong>${escapeHtml(t('authorisedSignatory', locale))}</strong></div></footer>`;
