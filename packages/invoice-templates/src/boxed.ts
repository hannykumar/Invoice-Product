/**
 * Issue #140 — the India-standard boxed layout.
 *
 * A real Indian tax invoice is one ruled grid. Every fact sits in a closed cell, the item table is
 * ruled on all four sides, and the page ends with an HSN-wise tax summary and a footer split into
 * the business's declaration, its bank details and a signature block. Businesses judge a billing
 * product on whether its output looks like the bills they already send, and the airy design does
 * not pass that test.
 *
 * Two things this file will not do:
 *
 *  - It will not invent a declaration, a payment term or a footer slogan. Those are commitments the
 *    business makes to its customer; a box appears only when the business has filled it in.
 *  - It will not decide what a tax invoice must contain. Like the airy layout, the compliance
 *    section is assembled from the document, and the template has no field with which to remove it.
 */
import { formatDate, sum, type Money } from '@invoice/kernel';
import type { InvoiceDocument, RenderableLine, RenderableParty, TemplateSnapshot } from './document.ts';
import type { PageFormat } from './template.ts';
import { hsnSummary, hsnSummaryColumns, type HsnSummaryRow } from './hsn-summary.ts';
import { escapeHtml, isZero, money, percent, splitQuantity, t } from './parts.ts';
import type { Locale } from './document.ts';
import { renderReservedSlot } from './reserved.ts';

/** A cell in the header grid: a small grey caption with the value under it. */
const cell = (caption: string, value: string, span = 1): string =>
  `<td colspan="${span}"><span class="cap">${escapeHtml(caption)}</span><span class="val">${value}</span></td>`;

const partyCell = (party: RenderableParty, heading: string, locale: Locale, shows: (f: string) => boolean): string => `
  <td class="party-cell">
    <span class="cap">${escapeHtml(heading)}</span>
    <span class="party-name">${escapeHtml(party.name)}</span>
    ${party.addressLines.map((l) => `<div>${escapeHtml(l)}</div>`).join('')}
    <div>${escapeHtml(party.stateName)} (${escapeHtml(party.stateCode)})</div>
    ${party.gstin === null ? '' : `<div><span class="cap-inline">${escapeHtml(t('gstin', locale))}</span> ${escapeHtml(party.gstin)}</div>`}
    ${party.phone != null && shows('seller.phone') ? `<div>${escapeHtml(party.phone)}</div>` : ''}
    ${party.email != null && shows('seller.email') ? `<div>${escapeHtml(party.email)}</div>` : ''}
  </td>`;

/**
 * The item table.
 *
 * A serial number down the left and the unit in its own "per" column are what make this read as a
 * bill rather than a spreadsheet. The amount column is the line's own amount — quantity times rate,
 * less its discount — which since issue #131 is exactly what it says.
 */
const itemTable = (
  goods: readonly RenderableLine[],
  charges: readonly RenderableLine[],
  snapshot: TemplateSnapshot,
  locale: Locale,
): string => {
  const showDiscount = snapshot.lineColumns.includes('line.discount');
  const showBatch = snapshot.lineColumns.includes('line.batch');

  const headings = [
    t('serial', locale), t('item', locale), t('hsn', locale),
    ...(showBatch ? [t('batch', locale)] : []),
    t('qty', locale), t('rate', locale), t('per', locale),
    ...(showDiscount ? [t('discount', locale)] : []),
    t('gstPercent', locale), t('lineTotal', locale),
  ];

  const row = (line: RenderableLine, index: number | null): string => {
    const charge = line.kind === 'CHARGE';
    const q = splitQuantity(line.quantityText);
    return `<tr${charge ? ' class="charge"' : ''}>
      <td class="num sl">${index === null ? '' : index}</td>
      <td>${escapeHtml(line.description)}${line.reverseCharge ? ' <span class="tag">RCM</span>' : ''}</td>
      <td>${charge ? '' : escapeHtml(line.hsnOrSac ?? '—')}</td>
      ${showBatch ? `<td>${charge ? '' : escapeHtml(line.batch ?? '')}</td>` : ''}
      <td class="num">${charge ? '' : escapeHtml(q.amount)}</td>
      <td class="num">${charge ? '' : money(line.unitPrice)}</td>
      <td>${charge ? '' : escapeHtml(q.unit)}</td>
      ${showDiscount ? `<td class="num">${charge || line.discount === null ? '' : money(line.discount)}</td>` : ''}
      <td class="num">${escapeHtml(percent(line.ratePercentTimes100))}</td>
      <td class="num">${money(line.taxableValue)}</td>
    </tr>`;
  };

  const goodsTotal = sum(goods.map((l) => l.taxableValue));
  const span = headings.length - 1;

  return `<table class="grid items">
    <thead><tr>${headings.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
    <tbody>${goods.map((l, i) => row(l, i + 1)).join('')}</tbody>
    ${
      charges.length === 0
        ? ''
        : `<tbody class="charges">
            <tr class="subtotal"><td class="num" colspan="${span}">${escapeHtml(t('subTotal', locale))}</td><td class="num">${money(goodsTotal)}</td></tr>
            ${charges.map((l) => row(l, null)).join('')}
          </tbody>`
    }
  </table>`;
};

const totalsTable = (doc: InvoiceDocument, locale: Locale, shows: (f: string) => boolean): string => {
  const rows: [string, Money][] = [
    [t('totalBeforeGst', locale), doc.totals.taxableValue],
    ['CGST', doc.totals.cgst],
    ['SGST', doc.totals.sgst],
    ['UTGST', doc.totals.utgst],
    ['IGST', doc.totals.igst],
    ['Cess', doc.totals.cess],
  ];
  const optional: [string, Money | null | undefined][] = [
    [t('roundOff', locale), isZero(doc.totals.roundOff) ? null : doc.totals.roundOff],
    [t('rcmTax', locale), isZero(doc.totals.reverseChargeTax) ? null : doc.totals.reverseChargeTax],
    [t('paid', locale), shows('totals.amountPaid') ? doc.totals.amountPaid : null],
    [t('outstanding', locale), shows('totals.outstanding') ? doc.totals.outstanding : null],
  ];
  const line = (label: string, amount: Money, cls = ''): string =>
    `<tr${cls}><td>${escapeHtml(label)}</td><td class="num">${money(amount)}</td></tr>`;

  return `<table class="grid totals">
    ${rows.filter(([label, a]) => label === t('totalBeforeGst', locale) || !isZero(a)).map(([l, a]) => line(l, a)).join('')}
    ${optional.filter(([, a]) => a != null).map(([l, a]) => line(l, a as Money)).join('')}
    ${line(t('total', locale), doc.totals.invoiceValue, ' class="grand"')}
  </table>`;
};

/**
 * The HSN summary — the table the buyer's accountant reconciles against.
 *
 * Its totals row is the invoice's own totals, so the two can never disagree. Only the taxes this
 * bill actually carries get a column; a column of zeroes is noise on a page that is already dense.
 */
const summaryTable = (doc: InvoiceDocument, locale: Locale): string => {
  const summary = hsnSummary(doc);
  const columns = hsnSummaryColumns(summary);
  const amountOf = (row: HsnSummaryRow, column: (typeof columns)[number]): Money =>
    column === 'CGST' ? row.cgst : column === 'SGST' ? row.sgst : column === 'UTGST' ? row.utgst : column === 'IGST' ? row.igst : row.cess;

  // IGST carries the whole rate; CGST and SGST carry half each, which is how they are notified and
  // how the buyer's accountant expects to read them. Cess has no percentage of its own here.
  const rateOf = (row: HsnSummaryRow, column: (typeof columns)[number]): bigint | null =>
    row.ratePercentTimes100 === null || column === 'CESS'
      ? null
      : column === 'IGST'
        ? row.ratePercentTimes100
        : row.ratePercentTimes100 / 2n;

  const body = (row: HsnSummaryRow, label: string, cls: string): string => `
    <tr${cls}>
      <td>${label}</td>
      <td class="num">${money(row.taxableValue)}</td>
      ${columns
        .map((c) => {
          const rate = rateOf(row, c);
          return `<td class="num">${rate === null ? '' : escapeHtml(percent(rate))}</td><td class="num">${money(amountOf(row, c))}</td>`;
        })
        .join('')}
      <td class="num">${money(row.totalTax)}</td>
    </tr>`;

  return `<table class="grid summary">
    <thead>
      <tr>
        <th rowspan="2">${escapeHtml(t('hsn', locale))}</th>
        <th rowspan="2" class="num">${escapeHtml(t('taxable', locale))}</th>
        ${columns.map((c) => `<th colspan="2">${escapeHtml(c === 'CESS' ? 'Cess' : c)}</th>`).join('')}
        <th rowspan="2" class="num">${escapeHtml(t('gstAmount', locale))}</th>
      </tr>
      <tr>${columns.map(() => `<th class="num">%</th><th class="num">${escapeHtml(t('gstAmount', locale))}</th>`).join('')}</tr>
    </thead>
    <tbody>
      ${summary.rows.map((r) => body(r, escapeHtml(r.code ?? '—'), '')).join('')}
      ${body(summary.totals, escapeHtml(t('totalWord', locale)), ' class="grand"')}
    </tbody>
  </table>`;
};

/** The whole boxed page. */
export const renderBoxed = (
  doc: InvoiceDocument,
  snapshot: TemplateSnapshot,
  format: PageFormat,
  locale: Locale,
): string => {
  const shows = (fieldId: string): boolean => snapshot.optionalFields.includes(fieldId);
  const reserved = (id: Parameters<typeof renderReservedSlot>[0]): string =>
    renderReservedSlot(id, format, locale, escapeHtml);

  const goods = doc.lines.filter((l) => l.kind !== 'CHARGE');
  const charges = doc.lines.filter((l) => l.kind === 'CHARGE');

  const logo =
    snapshot.logo.show && shows('seller.logo') && doc.logoDataUri !== null
      ? `<img class="logo" src="${escapeHtml(doc.logoDataUri)}" alt="${escapeHtml(doc.seller.name)}">`
      : '';

  const transport = doc.transport;
  const showTransport = transport !== null && shows('transport.vehicleNumber');

  const signature = !shows('footer.signature')
    ? ''
    : `<td class="sign-cell">
        <span class="cap">${escapeHtml(t('forSeller', locale))} ${escapeHtml(doc.seller.name)}</span>
        <div class="sign-space"></div>
        <div class="sign-line">${escapeHtml(t('authorisedSignatory', locale))}</div>
      </td>`;

  // No declaration is invented. The box exists only once the business has written one.
  const declaration =
    doc.declaration === null || !shows('footer.declaration')
      ? ''
      : `<td><span class="cap">${escapeHtml(t('declaration', locale))}</span>${escapeHtml(doc.declaration)}</td>`;

  const bank =
    doc.bankDetails === null || !shows('seller.bankDetails')
      ? ''
      : `<td><span class="cap">${escapeHtml(t('bank', locale))}</span>${doc.bankDetails.map((l) => `<div>${escapeHtml(l)}</div>`).join('')}</td>`;

  const footerCells = [declaration, bank, signature].filter((c) => c !== '');

  // The government block belongs at the top of the page, which is where a registered e-invoice
  // carries it and where anyone checking the bill looks first. Putting it here also means the QR
  // square shares the header's height instead of leaving a band of white paper at the foot.
  const showEInvoice = shows('qr.eInvoice') && renderReservedSlot('einvoice.qr', format, locale, escapeHtml) !== '';
  // The QR sits beside the seller block rather than spanning down into the buyer block. Spanning
  // made the buyer row as tall as the QR square and left a band of blank paper across the page,
  // which is exactly the dead space this design exists to remove.
  const qrCell = !showEInvoice
    ? ''
    : `<td class="qr-cell">
        ${doc.eInvoice?.qrSvg == null ? reserved('einvoice.qr') : `<div class="qr-slot">${doc.eInvoice.qrSvg}</div>`}
        <div class="qr-acks">${reserved('einvoice.ackNumber')}${reserved('einvoice.ackDate')}</div>
      </td>`;
  const irnRow = !showEInvoice
    ? ''
    : `<tr><td colspan="2" class="irn-cell">${
        doc.eInvoice === null
          ? reserved('einvoice.irn')
          : `<span class="cap">${escapeHtml(t('irn', locale))}</span><code>${escapeHtml(doc.eInvoice.irn)}</code>`
      }</td></tr>`;

  // The header's column widths are set on the cells, in CSS, keyed off this class. A fixed table
  // layout takes its widths from the first row, and the first row here is the title spanning the
  // whole width — so without them the seller's name is squeezed into a one-character column.
  return `
  <table class="grid head${showEInvoice ? ' with-qr' : ''}">
    <tr><td class="title-cell" colspan="${showEInvoice ? 3 : 2}"><h1>${escapeHtml(t(doc.title, locale))}</h1></td></tr>
    <tr>
      ${partyCell(doc.seller, '', locale, shows).replace('<span class="cap"></span>', logo)}
      <td class="meta-cell">
        <table class="grid inner">
          <tr>${cell(t('invoiceNo', locale), `<strong>${escapeHtml(doc.number)}</strong>`)}${cell(t('date', locale), escapeHtml(formatDate(doc.date)))}</tr>
          <tr>
            ${cell(t('po', locale), doc.poReference !== null && shows('document.poReference') ? escapeHtml(doc.poReference) : '')}
            ${cell(t('dueDate', locale), doc.dueDate !== null && shows('document.dueDate') ? escapeHtml(formatDate(doc.dueDate)) : '')}
          </tr>
          <tr>
            ${cell(t('transport', locale), showTransport ? escapeHtml(transport.transporter ?? '') : '')}
            ${cell(t('vehicle', locale), showTransport ? escapeHtml(transport.vehicleNumber ?? '') : '')}
          </tr>
          <tr>
            ${cell(t('eWayBill', locale), showTransport ? escapeHtml(transport.eWayBillNumber ?? '') : '')}
            ${cell(t('placeOfSupply', locale), `${escapeHtml(doc.placeOfSupplyStateName)} (${escapeHtml(doc.placeOfSupplyStateCode)})`)}
          </tr>
          ${irnRow}
        </table>
      </td>
      ${qrCell}
    </tr>
    <tr>
      ${partyCell(doc.buyer, t('billedTo', locale), locale, shows)}
      ${cell(t('reverseCharge', locale), doc.reverseCharge ? 'Yes' : 'No', showEInvoice ? 2 : 1)}
    </tr>
  </table>
  ${itemTable(goods, charges, snapshot, locale)}
  <table class="grid words">
    <tr><td><span class="cap">${escapeHtml(t('inWords', locale))}</span><strong>${escapeHtml(doc.amountInWordsText)}</strong></td></tr>
  </table>
  ${totalsTable(doc, locale, shows)}
  <table class="grid section"><tr><td>${escapeHtml(t('taxSummary', locale))}</td></tr></table>
  ${summaryTable(doc, locale)}
  <table class="grid words">
    <tr><td><span class="cap">${escapeHtml(t('taxInWords', locale))}</span>${escapeHtml(doc.taxAmountInWordsText)}</td></tr>
  </table>
  ${doc.declaredRateNotice === null ? '' : `<table class="grid notice"><tr><td>${escapeHtml(doc.declaredRateNotice)}</td></tr></table>`}
  ${doc.terms !== null && shows('footer.terms') ? `<table class="grid words"><tr><td>${escapeHtml(doc.terms)}</td></tr></table>` : ''}
  ${footerCells.length === 0 ? '' : `<table class="grid foot"><tr>${footerCells.join('')}</tr></table>`}`;
};
