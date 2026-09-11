/**
 * Issue #141 — the delivery challan, printed on the same engine as the invoice.
 *
 * Same page shell, same stylesheet, same escaping, same ruled grid and signature box. What differs
 * is decided by CGST Rule 55, not by taste:
 *
 *  - The title is "Delivery Challan" and the page says it is **not a tax invoice**, so nobody pays
 *    against it or claims tax credit on it.
 *  - Every line carries its **taxable value** (Rule 55(1)(vi)). The **tax rate and tax amount**
 *    print only when the goods are moving as a sale to the consignee (Rule 55(1)(vii)). A job-work
 *    challan shows the value of the goods and no tax.
 *  - **Place of supply** prints on a sale challan, and on any challan whose goods cross a state
 *    border (Rule 55(1)(viii)).
 *  - A quantity that was not known at dispatch is marked **provisional** (Rule 55(1)(v)).
 *  - The copies are marked for the consignee, the transporter and the consigner (Rule 55(2)).
 *  - It carries the **signature** (Rule 55(1)(ix)).
 *
 * And what it never carries, because none of it belongs on a paper that is not a demand for
 * payment: an amount payable, the amount in words, a due date, bank details, a pay-by-scan square,
 * or an e-invoice block (only an invoice can be registered for an IRN).
 */
import { formatDate, formatQuantity, sum, type IsoDate, type Money } from '@invoice/kernel';
import { challanReason, type ChallanState, type DeliveryChallan } from '@invoice/sales';
import type { Locale, RenderableParty, RenderableReferences, RenderableTransport, TaxSplit, TemplateSnapshot } from './document.ts';
import type { PageFormat } from './template.ts';
import { cell, partyCell } from './boxed.ts';
import { escapeHtml, isZero, money, percent, splitQuantity, t } from './parts.ts';
import { renderReservedSlot } from './reserved.ts';

/** Rule 55(1)(i) to (ix), as the fields this page is checked for. None of them is optional. */
export const CHALLAN_MANDATORY_FIELDS: readonly { readonly id: string; readonly clause: string; readonly conditional: boolean }[] = [
  { id: 'challan.number', clause: 'Rule 55(1)(i)', conditional: false },
  { id: 'challan.date', clause: 'Rule 55(1)(i)', conditional: false },
  { id: 'consigner.nameAddressGstin', clause: 'Rule 55(1)(ii)', conditional: false },
  { id: 'consignee.nameAddressGstin', clause: 'Rule 55(1)(iii)', conditional: false },
  { id: 'line.hsnAndDescription', clause: 'Rule 55(1)(iv)', conditional: false },
  { id: 'line.quantity', clause: 'Rule 55(1)(v)', conditional: false },
  { id: 'line.taxableValue', clause: 'Rule 55(1)(vi)', conditional: false },
  { id: 'line.taxRateAndAmount', clause: 'Rule 55(1)(vii) — when the goods move as a sale', conditional: true },
  { id: 'placeOfSupply', clause: 'Rule 55(1)(viii) — when the goods cross a state border', conditional: true },
  { id: 'signature', clause: 'Rule 55(1)(ix)', conditional: false },
];

export interface ChallanDocumentLine {
  readonly lineId: string;
  readonly description: string;
  readonly hsnOrSac: string;
  /** Already formatted with its unit, e.g. "250 KGS". */
  readonly quantityText: string;
  readonly quantityProvisional: boolean;
  readonly unitPrice: Money;
  readonly taxableValue: Money;
  readonly ratePercentTimes100: bigint | null;
  readonly taxAmount: Money;
}

/**
 * What a challan is printed from. Flattened, like the invoice's document, so a reprint shows the
 * names and addresses as they were on the day the goods left.
 */
export interface ChallanDocument {
  readonly number: string;
  readonly date: IsoDate;
  readonly state: ChallanState;
  readonly consigner: RenderableParty;
  readonly consignee: RenderableParty;
  /** Where the goods are delivered, when that is not the consignee's own address. */
  readonly deliveryAddress: RenderableParty | null;
  readonly reason: { readonly 'en-IN': string; readonly 'hi-IN': string };
  readonly legalBasis: string;
  readonly reasonNote: string | null;
  readonly placeOfSupplyStateCode: string | null;
  readonly placeOfSupplyStateName: string | null;
  readonly showsTax: boolean;
  readonly split: TaxSplit | null;
  readonly lines: readonly ChallanDocumentLine[];
  readonly totals: {
    readonly taxableValue: Money;
    readonly cgst: Money;
    readonly sgst: Money;
    readonly utgst: Money;
    readonly igst: Money;
    readonly cess: Money;
    readonly totalTax: Money;
  };
  readonly transport: RenderableTransport | null;
  /** The tax invoice raised after delivery, once it has been linked (Rule 55(4)). */
  readonly invoice: { readonly number: string; readonly date: IsoDate } | null;
  readonly declaredRateNotice: { readonly 'en-IN': string; readonly 'hi-IN': string } | null;
  readonly logoDataUri: string | null;
  readonly signatureDataUri: string | null;
}

export interface ChallanPrintingContext {
  readonly consigner: RenderableParty;
  readonly consignee: RenderableParty;
  readonly deliveryAddress?: RenderableParty | null;
  /** The name of the place-of-supply state. The challan stores only its code. */
  readonly placeOfSupplyStateName?: string | null;
  /** Transporter details not already on the challan's e-way bill. The challan's own values win. */
  readonly transport?: RenderableTransport | null;
  readonly logoDataUri?: string | null;
  readonly signatureDataUri?: string | null;
}

export const toChallanDocument = (challan: DeliveryChallan, context: ChallanPrintingContext): ChallanDocument => {
  const rule = challanReason(challan.reason);
  const eway = challan.ewayBill;
  const given = context.transport ?? null;
  const transport: RenderableTransport | null =
    eway === null && given === null
      ? null
      : {
          ...(given ?? {}),
          transporter: eway?.transporter ?? given?.transporter ?? null,
          vehicleNumber: eway?.vehicleNumber ?? given?.vehicleNumber ?? null,
          eWayBillNumber: eway?.number ?? given?.eWayBillNumber ?? null,
        };
  return {
    number: challan.number,
    date: challan.documentDate,
    state: challan.state,
    consigner: context.consigner,
    consignee: context.consignee,
    deliveryAddress: context.deliveryAddress ?? null,
    reason: rule.label,
    legalBasis: rule.legalBasis,
    reasonNote: challan.reasonNote,
    placeOfSupplyStateCode: challan.placeOfSupplyStateCode,
    placeOfSupplyStateName: challan.placeOfSupplyStateCode === null ? null : context.placeOfSupplyStateName ?? null,
    showsTax: challan.showsTax,
    split: challan.split,
    lines: challan.lines.map((l) => ({
      lineId: l.lineId,
      description: l.itemName,
      hsnOrSac: l.hsnOrSac,
      quantityText: formatQuantity(l.quantity),
      quantityProvisional: l.quantityProvisional,
      unitPrice: l.unitPrice,
      taxableValue: l.taxableValue,
      ratePercentTimes100: challan.showsTax ? l.ratePercentTimes100 : null,
      taxAmount: sum([l.cgst, l.sgst, l.utgst, l.igst, l.cess]),
    })),
    totals: challan.totals,
    transport,
    invoice: challan.invoice === null ? null : { number: challan.invoice.invoiceNumber, date: challan.invoice.invoiceDate },
    declaredRateNotice: challan.declaredRateNotice,
    logoDataUri: context.logoDataUri ?? null,
    signatureDataUri: context.signatureDataUri ?? null,
  };
};

/**
 * The invoice's "Delivery Note" box, filled from the challans it was linked to.
 *
 * Tally prints the delivery challan's number and date in exactly this box, and it is the reference
 * a buyer's clerk matches the goods received against. With several challans billed on one invoice
 * the numbers are listed and the single date box is left empty rather than holding one of them.
 */
export const deliveryNoteFromChallans = (
  challans: readonly Pick<DeliveryChallan, 'number' | 'documentDate' | 'state'>[],
): Pick<RenderableReferences, 'deliveryNoteNumber' | 'deliveryNoteDate'> => {
  const live = challans.filter((c) => c.state !== 'CANCELLED');
  if (live.length === 0) return { deliveryNoteNumber: null, deliveryNoteDate: null };
  return {
    deliveryNoteNumber: live.map((c) => c.number).join(', '),
    deliveryNoteDate: live.length === 1 ? (live[0] as (typeof live)[number]).documentDate : null,
  };
};

const placeOfSupply = (doc: ChallanDocument): string =>
  doc.placeOfSupplyStateCode === null
    ? ''
    : `${escapeHtml(doc.placeOfSupplyStateName ?? '')} (${escapeHtml(doc.placeOfSupplyStateCode)})`.trim();

const reasonText = (doc: ChallanDocument, locale: Locale): string =>
  `${escapeHtml(doc.reason[locale])}${doc.reasonNote === null ? '' : ` — ${escapeHtml(doc.reasonNote)}`} <span class="cap-inline">(${escapeHtml(doc.legalBasis)})</span>`;

const quantityCell = (line: ChallanDocumentLine, locale: Locale): string => {
  const q = splitQuantity(line.quantityText);
  return `${escapeHtml(q.amount)}${line.quantityProvisional ? ` <span class="cap-inline">(${escapeHtml(t('provisional', locale))})</span>` : ''}`;
};

/** The tax heads this challan carries, never a column of zeroes. */
const taxRows = (doc: ChallanDocument): [string, Money][] =>
  !doc.showsTax
    ? []
    : ([
        ['CGST', doc.totals.cgst],
        ['SGST', doc.totals.sgst],
        ['UTGST', doc.totals.utgst],
        ['IGST', doc.totals.igst],
        ['Cess', doc.totals.cess],
      ] as [string, Money][]).filter(([, amount]) => !isZero(amount));

const signatureCell = (doc: ChallanDocument, format: PageFormat, locale: Locale): string => `
  <td class="sign-cell">
    <span class="cap">${escapeHtml(t('forSeller', locale))} ${escapeHtml(doc.consigner.name)}</span>
    <div class="sign-space">${
      doc.signatureDataUri === null
        ? renderReservedSlot('signature', format, locale, escapeHtml)
        : `<img class="sign-image" src="${escapeHtml(doc.signatureDataUri)}" alt="">`
    }</div>
    <div class="sign-line">${escapeHtml(t('authorisedSignatory', locale))}</div>
  </td>`;

/** The whole boxed challan page, for A4 and the phone screen. */
export const renderChallanBoxed = (
  doc: ChallanDocument,
  snapshot: TemplateSnapshot,
  format: PageFormat,
  locale: Locale,
  copyMark: string | null,
): string => {
  const shows = (fieldId: string): boolean => snapshot.optionalFields.includes(fieldId);
  const logo =
    snapshot.logo.show && shows('seller.logo') && doc.logoDataUri !== null
      ? `<img class="logo" src="${escapeHtml(doc.logoDataUri)}" alt="${escapeHtml(doc.consigner.name)}">`
      : '';
  const transport = doc.transport;

  const headings: { label: string; share: number; num?: boolean }[] = [
    { label: t('serial', locale), share: 5, num: true },
    { label: t('item', locale), share: 26 },
    { label: t('hsn', locale), share: 9 },
    { label: t('qty', locale), share: 12, num: true },
    { label: t('per', locale), share: 5 },
    { label: t('rate', locale), share: 10, num: true },
    ...(doc.showsTax
      ? [
          { label: t('gstPercent', locale), share: 7, num: true },
          { label: t('gstAmount', locale), share: 10, num: true },
        ]
      : []),
    { label: t('taxable', locale), share: 12, num: true },
  ];
  const totalShare = headings.reduce((a, h) => a + h.share, 0);

  const rows = doc.lines
    .map((line, i) => {
      const q = splitQuantity(line.quantityText);
      return `<tr>
        <td class="num sl">${i + 1}</td>
        <td>${escapeHtml(line.description)}</td>
        <td>${escapeHtml(line.hsnOrSac)}</td>
        <td class="num">${quantityCell(line, locale)}</td>
        <td>${escapeHtml(q.unit)}</td>
        <td class="num">${money(line.unitPrice)}</td>
        ${doc.showsTax ? `<td class="num">${escapeHtml(percent(line.ratePercentTimes100))}</td><td class="num">${money(line.taxAmount)}</td>` : ''}
        <td class="num">${money(line.taxableValue)}</td>
      </tr>`;
    })
    .join('');

  const totals = `<table class="grid totals">
    <tr><td>${escapeHtml(t('totalBeforeGst', locale))}</td><td class="num">${money(doc.totals.taxableValue)}</td></tr>
    ${taxRows(doc).map(([label, amount]) => `<tr><td>${escapeHtml(label)}</td><td class="num">${money(amount)}</td></tr>`).join('')}
  </table>`;

  const notice = doc.declaredRateNotice === null ? '' : `<table class="grid notice"><tr><td>${escapeHtml(doc.declaredRateNotice[locale])}</td></tr></table>`;
  const consigneeRow = doc.deliveryAddress === null
    ? `<tr>${partyCell(doc.consignee, t('consignee', locale), locale, shows, 2)}</tr>`
    : `<tr>${partyCell(doc.consignee, t('consignee', locale), locale, shows)}${partyCell(doc.deliveryAddress, t('deliveryAddress', locale), locale, shows)}</tr>`;

  return `
  <table class="grid head">
    <tr><td class="title-cell" colspan="2"><h1>${escapeHtml(t('DELIVERY_CHALLAN', locale))}</h1><div class="not-invoice">${escapeHtml(t('notTaxInvoice', locale))}${
      doc.state === 'CANCELLED' ? ` · <strong>${escapeHtml(t('cancelledMark', locale))}</strong>` : ''
    }</div>${copyMark === null ? '' : `<span class="copy-mark-inline">${escapeHtml(copyMark)}</span>`}</td></tr>
    <tr>
      ${partyCell(doc.consigner, '', locale, shows).replace('<span class="cap"></span>', logo)}
      <td class="meta-cell">
        <table class="grid inner">
          <tr>${cell(t('challanNo', locale), `<strong>${escapeHtml(doc.number)}</strong>`)}${cell(t('challanDate', locale), escapeHtml(formatDate(doc.date)))}</tr>
          <tr>${cell(t('reasonForMovement', locale), reasonText(doc, locale), 2)}</tr>
          <tr>
            ${cell(t('transport', locale), escapeHtml(transport?.transporter ?? ''))}
            ${cell(t('vehicle', locale), escapeHtml(transport?.vehicleNumber ?? ''))}
          </tr>
          <tr>
            ${cell(t('eWayBill', locale), escapeHtml(transport?.eWayBillNumber ?? ''))}
            ${cell(t('placeOfSupply', locale), placeOfSupply(doc))}
          </tr>
          ${doc.invoice === null ? '' : `<tr>${cell(t('invoiceRef', locale), escapeHtml(`${doc.invoice.number}, ${formatDate(doc.invoice.date)}`), 2)}</tr>`}
        </table>
      </td>
    </tr>
    ${consigneeRow}
  </table>
  <table class="grid items">
    <thead><tr>${headings
      .map((h) => `<th${h.num === true ? ' class="num"' : ''} style="width:${((h.share / totalShare) * 100).toFixed(2)}%">${escapeHtml(h.label)}</th>`)
      .join('')}</tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${totals}
  ${notice}
  <table class="grid foot"><tr>${signatureCell(doc, format, locale)}</tr></table>`;
};

/**
 * The till-roll shape. A challan is rarely printed on one, but the engine takes every format, and a
 * list is the only thing that fits on 58 millimetres. The signature lines stay: Rule 55 asks for a
 * signature on every challan, and unlike a counter slip, a challan is a paper that gets signed.
 */
export const renderChallanNarrow = (doc: ChallanDocument, locale: Locale, copyMark: string | null): string => `
  ${copyMark === null ? '' : `<div class="copy-mark">${escapeHtml(copyMark)}</div>`}
  <h1>${escapeHtml(t('DELIVERY_CHALLAN', locale))}</h1>
  <div><strong>${escapeHtml(t('notTaxInvoice', locale))}</strong>${doc.state === 'CANCELLED' ? ` · <strong>${escapeHtml(t('cancelledMark', locale))}</strong>` : ''}</div>
  <div class="party-name">${escapeHtml(doc.consigner.name)}</div>
  ${doc.consigner.gstin === null ? '' : `<div><span class="k">${escapeHtml(t('gstin', locale))}:</span> ${escapeHtml(doc.consigner.gstin)}</div>`}
  <div><span class="k">${escapeHtml(t('challanNo', locale))}:</span> <strong>${escapeHtml(doc.number)}</strong></div>
  <div><span class="k">${escapeHtml(t('challanDate', locale))}:</span> ${escapeHtml(formatDate(doc.date))}</div>
  <div><span class="k">${escapeHtml(t('reasonForMovement', locale))}:</span> ${reasonText(doc, locale)}</div>
  <div class="ship-line"><span class="k">${escapeHtml(t('consignee', locale))}:</span> ${escapeHtml(
    [doc.consignee.name, ...doc.consignee.addressLines, doc.consignee.stateName, doc.consignee.gstin ?? ''].filter((v) => v !== '').join(', '),
  )}</div>
  ${doc.placeOfSupplyStateCode === null ? '' : `<div><span class="k">${escapeHtml(t('placeOfSupply', locale))}:</span> ${placeOfSupply(doc)}</div>`}
  ${doc.transport?.eWayBillNumber == null ? '' : `<div><span class="k">${escapeHtml(t('eWayBill', locale))}:</span> ${escapeHtml(doc.transport.eWayBillNumber)}</div>`}
  <div class="items-narrow">${doc.lines
    .map(
      (l) => `<div class="tline">
        <div class="tline-name">${escapeHtml(l.description)} <span class="k">${escapeHtml(l.hsnOrSac)}</span></div>
        <div class="tline-detail"><span>${quantityCell(l, locale)} ${escapeHtml(splitQuantity(l.quantityText).unit)} × ${money(l.unitPrice)}</span><span class="num">${money(l.taxableValue)}</span></div>
        ${doc.showsTax ? `<div class="tline-tax"><span>${escapeHtml(t('gstAmount', locale))} ${escapeHtml(percent(l.ratePercentTimes100))}</span><span class="num">${money(l.taxAmount)}</span></div>` : ''}
      </div>`,
    )
    .join('')}</div>
  <table class="totals">
    <tr><td>${escapeHtml(t('totalBeforeGst', locale))}</td><td class="num">${money(doc.totals.taxableValue)}</td></tr>
    ${taxRows(doc).map(([label, amount]) => `<tr><td>${escapeHtml(label)}</td><td class="num">${money(amount)}</td></tr>`).join('')}
  </table>
  ${doc.declaredRateNotice === null ? '' : `<div class="notice">${escapeHtml(doc.declaredRateNotice[locale])}</div>`}
  <footer><div style="margin-top:8mm">${escapeHtml(t('forSeller', locale))} ${escapeHtml(doc.consigner.name)}</div><div><strong>${escapeHtml(t('authorisedSignatory', locale))}</strong></div></footer>`;
