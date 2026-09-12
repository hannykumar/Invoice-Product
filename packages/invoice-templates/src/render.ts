/**
 * Issue #13 [E13] — the rendering engine.
 *
 * One document, four shapes: A4, 80mm thermal, 58mm thermal, and a phone screen. Each is a real
 * constraint. Fifty-eight millimetres of paper is about thirty-two characters wide, so a bill
 * printed there is a list, not a table, and pretending otherwise produces something nobody can
 * read at a counter.
 *
 * Two rules hold in every shape:
 *
 *  1. **The compliance section is assembled from the document**, never from the template. A
 *     template has no way to remove a legally required field, because it has no field for it.
 *  2. **Everything is escaped.** An item called `<script>` is a thing a shopkeeper can type.
 */
import { formatDate, sum, type Money } from '@invoice/kernel';
import type {
  InvoiceDocument,
  Locale,
  RenderableLine,
  RenderableParty,
  TemplateSnapshot,
} from './document.ts';
import type { PageFormat } from './template.ts';
import { printsReservedSlots, renderReservedSlot, reservedSlotStyles } from './reserved.ts';
import { renderBoxed } from './boxed.ts';
import { PAGE, escapeHtml, isZero, money, narrowLine, percent, t } from './parts.ts';
import { CHALLAN_COPIES, challanCopyMarking, copiesFor, copyMarking, type InvoiceCopy } from './copies.ts';
import { renderChallanBoxed, renderChallanNarrow, type ChallanDocument } from './challan.ts';
import { preSaleTitle, renderPreSaleBoxed, renderPreSaleNarrow, type PreSalePrint } from './presale.ts';
import { MAX_TRADE_MARK_OPACITY_PERCENT } from './marks.ts';

/** Re-exported because this module has been the public home of the escaper since issue #13. */
export { escapeHtml };

export interface RenderOptions {
  readonly format: PageFormat;
  readonly locale: Locale;
  /** Set for the preview shown on screen, which drops the print-only page furniture. */
  readonly screenPreview?: boolean;
  /**
   * Issue #137 — which marked copy this is. Omitted prints an unmarked bill, which is what a
   * preview and a phone screen want.
   */
  readonly copy?: InvoiceCopy;
}

const partyBlock = (party: RenderableParty, heading: string, locale: Locale): string => {
  const lines = [
    `<div class="party-name">${escapeHtml(party.name)}</div>`,
    ...party.addressLines.map((l) => `<div>${escapeHtml(l)}</div>`),
    `<div>${escapeHtml(party.stateName)} (${escapeHtml(party.stateCode)})</div>`,
    party.gstin === null ? '' : `<div><span class="k">${escapeHtml(t('gstin', locale))}:</span> ${escapeHtml(party.gstin)}</div>`,
    party.phone == null ? '' : `<div>${escapeHtml(party.phone)}</div>`,
    party.email == null ? '' : `<div>${escapeHtml(party.email)}</div>`,
  ];
  return `<section class="party"><h2>${escapeHtml(heading)}</h2>${lines.join('')}</section>`;
};

const taxRows = (doc: InvoiceDocument, locale: Locale): string => {
  // Each tax is shown on its own line. Lumping them together is exactly what a GST officer,
  // and a customer claiming credit, cannot work with.
  const rows: [string, Money][] = [
    ['CGST', doc.totals.cgst],
    ['SGST', doc.totals.sgst],
    ['UTGST', doc.totals.utgst],
    ['IGST', doc.totals.igst],
    ['Cess', doc.totals.cess],
  ];
  return rows
    .filter(([, amount]) => !isZero(amount))
    .map(([label, amount]) => `<tr><td>${escapeHtml(label)}</td><td class="num">${money(amount)}</td></tr>`)
    .join('');
};

const complianceLineColumns = (locale: Locale, snapshot: TemplateSnapshot): string[] => {
  const columns = [t('item', locale), t('hsn', locale), t('qty', locale), t('rate', locale)];
  if (snapshot.lineColumns.includes('line.discount')) columns.push(t('discount', locale));
  if (snapshot.lineColumns.includes('line.batch')) columns.push(t('batch', locale));
  if (snapshot.lineColumns.includes('line.note')) columns.push(t('note', locale));
  columns.push(t('taxable', locale), t('gstPercent', locale), t('gstAmount', locale));
  return columns;
};

const lineRow = (line: RenderableLine, snapshot: TemplateSnapshot): string => {
  // A charge has no quantity and no rate a customer would recognise, so both are left blank rather
  // than filled with a made-up "1". Only a goods line invites the quantity-times-rate check.
  const charge = line.kind === 'CHARGE';
  // Cells a charge has no answer for are left blank rather than filled with a dash. A row of five
  // dashes reads as missing data; a blank cell reads as "does not apply", which is the truth.
  const cells = [
    `<td>${escapeHtml(line.description)}${line.reverseCharge ? ' <span class="tag">RCM</span>' : ''}</td>`,
    `<td>${charge ? '' : escapeHtml(line.hsnOrSac ?? '—')}</td>`,
    `<td class="num">${charge ? '' : escapeHtml(line.quantityText)}</td>`,
    `<td class="num">${charge ? '' : money(line.unitPrice)}</td>`,
  ];
  if (snapshot.lineColumns.includes('line.discount')) {
    cells.push(`<td class="num">${charge ? '' : line.discount === null ? '—' : money(line.discount)}</td>`);
  }
  if (snapshot.lineColumns.includes('line.batch')) cells.push(`<td>${charge ? '' : escapeHtml(line.batch ?? '—')}</td>`);
  if (snapshot.lineColumns.includes('line.note')) cells.push(`<td>${charge ? '' : escapeHtml(line.note ?? '')}</td>`);
  cells.push(
    `<td class="num">${money(line.taxableValue)}</td>`,
    `<td class="num">${escapeHtml(percent(line.ratePercentTimes100))}</td>`,
    `<td class="num">${money(line.taxAmount)}</td>`,
  );
  return `<tr${charge ? ' class="charge"' : ''}>${cells.join('')}</tr>`;
};

/**
 * Issue #147 — the faint mark of the trade, if the business has chosen one.
 *
 * Three rules live here rather than in a template, because a template must not be able to decide
 * any of them:
 *
 *  - It prints only when a business has picked a picture. There is no default and no guess from
 *    the kind of business; a bill with no mark is a complete bill.
 *  - It is never darker than `MAX_TRADE_MARK_OPACITY_PERCENT`, whatever is stored against the
 *    business, because the figures on top of it are the tax on the bill.
 *  - It does not print on till roll at all. A thermal printer has one ink and no grey, so a
 *    watermark there comes out as a smudge across the amounts.
 */
const watermark = (doc: InvoiceDocument, format: PageFormat): string => {
  const mark = doc.tradeMark;
  if (mark == null) return '';
  if (format === 'THERMAL_58MM' || format === 'THERMAL_80MM') return '';
  const percent = Math.min(mark.opacityPercent, MAX_TRADE_MARK_OPACITY_PERCENT);
  if (!(percent > 0)) return '';
  return `<div class="watermark" aria-hidden="true"><img src="${escapeHtml(mark.imageDataUri)}" alt="" style="opacity:${(percent / 100).toFixed(3)}"></div>`;
};

const styles = (snapshot: TemplateSnapshot, format: PageFormat): string => {
  const page = PAGE[format];
  const { palette, typography } = snapshot;
  return `
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 0; background: #f4f4f4;
      font-family: ${typography.bodyStack};
      font-size: ${typography.baseSizePt}pt; color: ${palette.text}; line-height: 1.4;
    }
    .sheet {
      position: relative;
      width: ${page.widthCss};
      /* On paper this is exactly ${page.widthCss}. On a screen narrower than the page it shrinks
         rather than running off the edge, because a bill nobody can read on a phone is a bill
         nobody checks before sending it. Print media below restores the true width. */
      max-width: ${page.printableMm === null ? '720px' : 'calc(100% - 24px)'};
      margin: 12px auto; background: #fff; padding: ${page.narrow ? '6mm 4mm' : '12mm 10mm'};
      box-shadow: 0 1px 4px rgba(0,0,0,.18);
    }
    /* Issue #147 — the mark of the trade, behind everything and touching nothing.
       It is drawn once per sheet, sized against the page rather than the content, so it does not
       move when a bill has four lines instead of forty. Every other block on the sheet is lifted
       above it, so no figure is ever printed through a picture rather than over it. */
    .watermark {
      position: absolute; inset: 0; z-index: 0;
      display: flex; align-items: center; justify-content: center;
      pointer-events: none;
    }
    .watermark img { width: 55%; max-width: 110mm; max-height: 45%; }
    .sheet > *:not(.watermark) { position: relative; z-index: 1; }
    table.items { table-layout: fixed; }
    table.items td, table.items th { overflow-wrap: anywhere; }
    h1 { font-family: ${typography.headingStack}; font-size: ${typography.baseSizePt + 4}pt; margin: 0 0 2mm; color: ${palette.accent}; letter-spacing: .04em; }
    h2 { font-family: ${typography.headingStack}; font-size: ${typography.baseSizePt}pt; margin: 0 0 1mm; color: ${palette.accent}; text-transform: uppercase; letter-spacing: .06em; }
    .k { color: ${palette.muted}; }
    .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .head { display: flex; justify-content: space-between; gap: 6mm; align-items: flex-start; border-bottom: 2px solid ${palette.accent}; padding-bottom: 3mm; margin-bottom: 3mm; }
    .logo { max-height: ${snapshot.logo.maxHeightPt}pt; max-width: 40%; }
    .meta div { margin-bottom: .6mm; }
    .parties { display: ${page.narrow ? 'block' : 'flex'}; gap: 6mm; margin-bottom: 3mm; }
    .party { flex: 1; border: 1px solid ${palette.border}; padding: 2mm; margin-bottom: ${page.narrow ? '2mm' : '0'}; }
    .party-name { font-weight: 700; }
    table.items { width: 100%; border-collapse: collapse; margin-top: 2mm; }
    table.items th { background: ${palette.accent}; color: #fff; text-align: left; padding: 1.4mm 1.6mm; font-weight: 600; }
    table.items td { border-bottom: 1px solid ${palette.border}; padding: 1.4mm 1.6mm; vertical-align: top; }
    table.items tbody tr { break-inside: avoid; page-break-inside: avoid; }
    .totals { margin-top: 3mm; margin-left: auto; width: ${page.narrow ? '100%' : '78mm'}; border-collapse: collapse; }
    .totals td { padding: 1mm 1.6mm; }
    .totals tr.grand td { border-top: 2px solid ${palette.accent}; font-weight: 700; font-size: ${typography.baseSizePt + 2}pt; }
    .words { margin-top: 2mm; border: 1px dashed ${palette.border}; padding: 2mm; }
    .ship-line { margin: 1.5mm 0; }
    .notice { margin-top: 3mm; border-left: 3px solid ${palette.accent}; background: #fffbe6; padding: 2mm; }
    .tag { font-size: ${typography.baseSizePt - 1}pt; border: 1px solid ${palette.border}; padding: 0 .8mm; }
    table.items tbody.charges tr:first-child td { border-top: 1px solid ${palette.accent}; }
    table.items tr.charge td { background: #fafafa; }
    table.items tr.subtotal td { font-weight: 600; border-top: 1px solid ${palette.accent}; }
    .tline { border-bottom: 1px dotted ${palette.border}; padding: 1.2mm 0; break-inside: avoid; }
    .tline-name { font-weight: 700; }
    .tcharges { border-top: 1px solid ${palette.border}; margin-top: 1.5mm; padding-top: 1mm; }
    .tline-detail, .tline-tax { display: flex; justify-content: space-between; }
    .qr { margin-top: 3mm; display: flex; gap: 3mm; align-items: center; }
    .qr-slot { width: 26mm; height: 26mm; border: 1px solid ${palette.border}; padding: 2mm; display: flex; align-items: center; justify-content: center; text-align: center; font-size: ${typography.baseSizePt - 2}pt; color: ${palette.muted}; background: #fff; }
    .qr-slot svg { width: 100%; height: 100%; }
    .qr-pair { display: flex; gap: 3mm; align-items: flex-start; flex-wrap: wrap; }
    .qr-lines { display: flex; flex-direction: column; gap: 1.5mm; }
    ${reservedSlotStyles(palette.border, palette.muted, Math.max(6, typography.baseSizePt - 2))}
    footer { margin-top: 4mm; border-top: 1px solid ${palette.border}; padding-top: 2mm; color: ${palette.muted}; }
    /* Issue #137 — the copy marking, in the place Indian bills put it: top right, above the frame. */
    .copy-mark {
      text-align: right; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
      font-size: ${Math.max(6, typography.baseSizePt - 1)}pt; color: ${palette.text}; margin-bottom: 1.5mm;
    }
    /* Each copy starts on a fresh sheet, so one press of Print produces the whole set. */
    .sheet + .sheet { page-break-before: always; break-before: page; }

    /* Issue #140 — the boxed India-standard grid. Every table below shares one outer rule, so the
       page reads as a single frame rather than a stack of separate tables. */
    .boxed .sheet-inner { border: 1px solid ${palette.border}; border-bottom: 0; }
    .boxed table.grid { width: 100%; border-collapse: collapse; table-layout: fixed; }
    .boxed table.grid > tbody > tr > td, .boxed table.grid > tr > td, .boxed table.grid th {
      border: 1px solid ${palette.border}; border-top: 0; border-left: 0;
      padding: 1.2mm 1.4mm; vertical-align: top; overflow-wrap: anywhere;
    }
    .boxed table.grid > tbody > tr > td:last-child, .boxed table.grid > tr > td:last-child,
    .boxed table.grid th:last-child { border-right: 0; }
    /* Colour and background are both restated: the airy design paints its headings white on the
       accent colour, and without both the boxed grid inherits white text on a pale grey band. */
    .boxed table.grid th { background: #f0f0f0; color: ${palette.text}; font-weight: 700; text-align: left; }
    .boxed table.grid th.num, .boxed table.grid td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .boxed table.inner { border: 0; }
    /* The airy design draws the amount-in-words panel and the rate notice as loose dashed and
       left-barred blocks. Inside a ruled grid those read as damage, so they are squared off. */
    .boxed table.words, .boxed table.notice, .boxed table.section { margin: 0; border: 0; background: none; }
    .boxed table.words td { border-left: 0; }
    .boxed table.inner > tbody > tr > td:last-child, .boxed table.inner > tr > td:last-child { border-right: 0; }
    .boxed .cap {
      display: block; font-size: ${Math.max(6, typography.baseSizePt - 2)}pt; color: ${palette.muted};
      text-transform: uppercase; letter-spacing: .04em; line-height: 1.3;
    }
    .boxed .cap-inline { color: ${palette.muted}; }
    .boxed .val { display: block; min-height: ${typography.baseSizePt + 2}pt; }
    .boxed .title-cell { text-align: center; position: relative; }
    /* Issue #141 — a challan says under its title that it is not a tax invoice. */
    .boxed .not-invoice { font-size: ${Math.max(6, typography.baseSizePt - 1)}pt; letter-spacing: .06em; margin-top: .6mm; }
    .boxed .copy-mark-inline {
      position: absolute; right: 1.4mm; top: 50%; transform: translateY(-50%);
      font-size: ${Math.max(6, typography.baseSizePt - 2)}pt; font-weight: 700; letter-spacing: .06em;
    }
    .boxed h1 {
      margin: 0; font-size: ${typography.baseSizePt + 3}pt; letter-spacing: .18em;
      text-transform: uppercase; color: ${palette.text}; font-family: ${typography.headingStack};
    }
    .boxed .party-name { display: block; font-weight: 700; font-size: ${typography.baseSizePt + 1}pt; }
    .boxed .meta-cell { padding: 0; }
    /* The item table takes the height that is left, so the page ends at the bottom rule instead of
       stopping halfway down with white space under it, the way a real bill does. */
    /* The airy layout's header, item table and totals share these class names, and its spacing — a
       padded, rule-underlined header and gaps above the items and the totals — opened bands of blank
       paper inside the frame. In the ruled grid every table sits flush against the next. */
    .boxed table.head { padding: 0; margin: 0; border-bottom: 0; }
    .boxed table.items, .boxed table.totals { margin-top: 0; }
    .boxed table.items { table-layout: fixed; }
    .boxed table.items td.sl { width: 7mm; }
    .boxed table.items tbody tr { break-inside: avoid; page-break-inside: avoid; }
    .boxed table.items tr.charge td { background: #fafafa; }
    .boxed table.items tr.subtotal td { font-weight: 700; }
    .boxed table.totals td:first-child { text-align: right; }
    .boxed table.totals tr.grand td { font-weight: 700; font-size: ${typography.baseSizePt + 1}pt; }
    .boxed table.summary tr.grand td { font-weight: 700; }
    .boxed table.section td { background: #f0f0f0; font-weight: 700; text-align: center; letter-spacing: .06em; }
    .boxed table.notice td { background: #fffbe6; }
    .boxed table.foot td.upi-cell { width: 32mm; text-align: center; }
    .boxed .sign-cell { text-align: right; }
    .boxed .sign-space { min-height: 16mm; display: flex; align-items: center; justify-content: flex-end; }
    .boxed .sign-image { max-height: 16mm; max-width: 48mm; }
    .boxed table.notations td { text-align: center; color: ${palette.muted}; }
    .boxed .sign-line { font-weight: 700; }
    .boxed .sign-digital { margin-top: 2mm; color: ${palette.muted}; text-align: left; }
    .boxed table.head td.party-cell { width: 50%; }
    .boxed table.head.with-qr td.party-cell { width: 34%; }
    .boxed table.head.with-qr td.meta-cell { width: 48%; }
    .boxed .qr-cell { width: 18%; text-align: center; vertical-align: top; }
    /* A bill number is read as one token; only a 64-character IRN may be split mid-character. */
    .boxed table.head td { overflow-wrap: break-word; }
    .boxed table.head td .val { overflow-wrap: normal; }
    /* An address wraps between words; only a long unbroken code may be split mid-character. */
    .boxed table.head td { overflow-wrap: break-word; }
    .boxed .irn-cell code, .boxed table.grid td.break { overflow-wrap: anywhere; }
    .boxed .irn-cell code { word-break: break-all; }
    .boxed .qr-acks { display: flex; flex-direction: column; gap: 1.5mm; margin-top: 1.5mm; align-items: center; }
    .boxed .tag { font-size: ${typography.baseSizePt - 1}pt; border: 1px solid ${palette.border}; padding: 0 .8mm; }
    @media print {
      body { background: #fff; }
      /* Drawn as a picture rather than as a background, because a browser printing a page throws
         backgrounds away by default and a business that switched its mark on would get nothing. */
      .watermark img { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
      .sheet { margin: 0; box-shadow: none; width: auto; max-width: none; }
      table.items thead { display: table-header-group; }
      table.items tfoot { display: table-footer-group; }
      @page { size: ${format === 'A4' ? 'A4' : `${page.widthCss} auto`}; margin: ${format === 'A4' ? '10mm' : '3mm'}; }
    }
  `;
};

/**
 * Renders one bill.
 *
 * The output is a complete HTML document, so it can be opened, printed, or saved as PDF from the
 * browser's own print dialogue. Generating PDF bytes here would mean shipping a rendering engine;
 * the browser already has one, and it is the one that renders the preview the user approved.
 */
export const renderInvoice = (
  doc: InvoiceDocument,
  snapshot: TemplateSnapshot,
  options: RenderOptions,
): string => {
  const { locale, format } = options;
  const narrow = PAGE[format].narrow;
  const shows = (fieldId: string): boolean => snapshot.optionalFields.includes(fieldId);

  // Issue #140 — the boxed grid is for the shapes that have room for a grid. Fifty-eight
  // millimetres of till roll cannot hold a ten-column ruled table under any design, so a boxed
  // template still prints the list there, and the compliance section survives either way. A
  // snapshot taken before #140 has no layout at all, which correctly means the original airy page.
  const boxed = snapshot.layout === 'BOXED' && !narrow;
  const marking = options.copy === undefined ? null : copyMarking(doc, options.copy, locale);
  if (boxed) {
    return page(
      `${t(doc.title, locale)} ${doc.number}`,
      snapshot,
      format,
      locale,
      'boxed',
      `${watermark(doc, format)}<div class="sheet-inner">${renderBoxed(doc, snapshot, format, locale, marking)}</div>`,
      options.copy,
    );
  }

  const title = t(doc.title, locale);
  const logo =
    snapshot.logo.show && shows('seller.logo') && doc.logoDataUri !== null
      ? `<img class="logo" src="${escapeHtml(doc.logoDataUri)}" alt="${escapeHtml(doc.seller.name)}">`
      : '';

  const meta = [
    `<div><span class="k">${escapeHtml(t('invoiceNo', locale))}:</span> <strong>${escapeHtml(doc.number)}</strong></div>`,
    `<div><span class="k">${escapeHtml(t('date', locale))}:</span> ${escapeHtml(formatDate(doc.date))}</div>`,
    doc.dueDate !== null && shows('document.dueDate')
      ? `<div><span class="k">${escapeHtml(t('dueDate', locale))}:</span> ${escapeHtml(formatDate(doc.dueDate))}</div>`
      : '',
    doc.poReference !== null && shows('document.poReference')
      ? `<div><span class="k">${escapeHtml(t('po', locale))}:</span> ${escapeHtml(doc.poReference)}</div>`
      : '',
    `<div><span class="k">${escapeHtml(t('placeOfSupply', locale))}:</span> ${escapeHtml(doc.placeOfSupplyStateName)} (${escapeHtml(doc.placeOfSupplyStateCode)})</div>`,
    doc.reverseCharge ? `<div><strong>${escapeHtml(t('reverseCharge', locale))}</strong></div>` : '',
  ].join('');

  // Issue #131 — goods first, then charges on lines of their own. A goods line on the printed bill
  // is exactly quantity × rate less its shown discount, so the first check anyone makes succeeds.
  const goodsLines = doc.lines.filter((l) => l.kind !== 'CHARGE');
  const chargeLines = doc.lines.filter((l) => l.kind === 'CHARGE');
  const columnCount = narrow ? 0 : complianceLineColumns(locale, snapshot).length;
  const goodsSubTotal = sum(goodsLines.map((l) => l.taxableValue));

  const chargeBody =
    chargeLines.length === 0
      ? ''
      : `<tbody class="charges">
          <tr class="subtotal"><td colspan="${columnCount - 3}">${escapeHtml(t('subTotal', locale))}</td><td class="num">${money(goodsSubTotal)}</td><td></td><td></td></tr>
          ${chargeLines.map((l) => lineRow(l, snapshot)).join('')}
        </tbody>`;

  const itemsBlock = narrow
    ? `<div class="items-narrow">${goodsLines.map((l) => narrowLine(l, locale)).join('')}${
        chargeLines.length === 0
          ? ''
          : `<div class="tcharges"><div class="tline-name">${escapeHtml(t('charges', locale))}</div>${chargeLines.map((l) => narrowLine(l, locale)).join('')}</div>`
      }</div>`
    : `<table class="items">
        <thead><tr>${complianceLineColumns(locale, snapshot).map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
        <tbody>${goodsLines.map((l) => lineRow(l, snapshot)).join('')}</tbody>
        ${chargeBody}
      </table>`;

  const totals = `
    <table class="totals">
      <tr><td>${escapeHtml(t('totalBeforeGst', locale))}</td><td class="num">${money(doc.totals.taxableValue)}</td></tr>
      ${taxRows(doc, locale)}
      ${doc.totals.tcs == null || isZero(doc.totals.tcs) ? '' : `<tr><td>${escapeHtml(t('tcs', locale))}</td><td class="num">${money(doc.totals.tcs)}</td></tr>`}
      ${isZero(doc.totals.roundOff) ? '' : `<tr><td>${escapeHtml(t('roundOff', locale))}</td><td class="num">${money(doc.totals.roundOff)}</td></tr>`}
      <tr class="grand"><td>${escapeHtml(t('total', locale))}</td><td class="num">${money(doc.totals.invoiceValue)}</td></tr>
      ${isZero(doc.totals.reverseChargeTax) ? '' : `<tr><td>${escapeHtml(t('rcmTax', locale))}</td><td class="num">${money(doc.totals.reverseChargeTax)}</td></tr>`}
      ${doc.totals.amountPaid != null && shows('totals.amountPaid') ? `<tr><td>${escapeHtml(t('paid', locale))}</td><td class="num">${money(doc.totals.amountPaid)}</td></tr>` : ''}
      ${doc.totals.outstanding != null && shows('totals.outstanding') ? `<tr><td>${escapeHtml(t('outstanding', locale))}</td><td class="num">${money(doc.totals.outstanding)}</td></tr>` : ''}
    </table>`;

  // Issue #134 — on till roll the consignee is one line, not a box. There is no room for a second
  // address block, and a counter slip that only says where the goods went is still useful.
  const shipToLine =
    doc.shipTo === null
      ? ''
      : `<div class="ship-line"><span class="k">${escapeHtml(t('shipTo', locale))}:</span> ${escapeHtml(
          [doc.shipTo.name, ...doc.shipTo.addressLines, doc.shipTo.stateName].join(', '),
        )}</div>`;

  const words = `<div class="words"><span class="k">${escapeHtml(t('inWords', locale))}:</span> ${escapeHtml(doc.amountInWordsText)}</div>`;

  const transport =
    doc.transport === null || !shows('transport.vehicleNumber')
      ? ''
      : `<section class="party"><h2>${escapeHtml(t('transport', locale))}</h2>
          ${doc.transport.transporter == null ? '' : `<div>${escapeHtml(doc.transport.transporter)}</div>`}
          ${doc.transport.vehicleNumber == null ? '' : `<div><span class="k">${escapeHtml(t('vehicle', locale))}:</span> ${escapeHtml(doc.transport.vehicleNumber)}</div>`}
          ${doc.transport.eWayBillNumber == null ? '' : `<div><span class="k">${escapeHtml(t('eWayBill', locale))}:</span> ${escapeHtml(doc.transport.eWayBillNumber)}</div>`}
        </section>`;

  // Issue #148 — the e-invoice block is drawn whenever the design carries it, whether or not the
  // government reply has arrived. What has not arrived is a reserved box at its final size, so the
  // page a business approves today is the page that prints once the provider is connected.
  const reserved = (id: Parameters<typeof renderReservedSlot>[0]): string =>
    renderReservedSlot(id, format, locale, escapeHtml);

  const qr = !shows('qr.eInvoice')
    ? ''
    : `<div class="qr qr-pair">
        ${doc.eInvoice?.qrSvg == null ? reserved('einvoice.qr') : `<div class="qr-slot">${doc.eInvoice.qrSvg}</div>`}
        <div class="qr-lines">
          ${
            doc.eInvoice === null
              ? reserved('einvoice.irn')
              : `<div><span class="k">${escapeHtml(t('irn', locale))}:</span><br><code>${escapeHtml(doc.eInvoice.irn)}</code></div>`
          }
          <div class="qr-pair">${reserved('einvoice.ackNumber')}${reserved('einvoice.ackDate')}</div>
        </div>
      </div>`;

  // The pay-by-scan square. No shipped design carries it yet; issue #144 turns it on and supplies
  // the business's UPI id, and finds the space already waiting for it here.
  const upi = !shows('qr.upi') ? '' : `<div class="qr qr-pair">${reserved('upi.qr')}</div>`;

  const bank =
    doc.bankDetails === null || !shows('seller.bankDetails')
      ? ''
      : `<section class="party"><h2>${escapeHtml(t('bank', locale))}</h2>${doc.bankDetails.map((l) => `<div>${escapeHtml(l)}</div>`).join('')}</section>`;

  const notice = [
    // Issue #145 — the customer is entitled to see why an extra amount appeared on their bill.
    doc.tcsNotice == null ? '' : `<div class="notice">${escapeHtml(doc.tcsNotice)}</div>`,
    doc.declaredRateNotice === null ? '' : `<div class="notice">${escapeHtml(doc.declaredRateNotice)}</div>`,
  ].join('');

  const footerBits = [
    doc.terms !== null && shows('footer.terms') ? `<div>${escapeHtml(doc.terms)}</div>` : '',
    snapshot.footerNote === null ? '' : `<div>${escapeHtml(snapshot.footerNote)}</div>`,
    // Required by Rule 46, so it is printed whatever the design says (#158) — except on till roll,
    // where a counter slip is not the copy anyone signs and there is no room for a rule to sign on.
    printsReservedSlots(format)
      ? `<div style="margin-top:8mm">${escapeHtml(t('forSeller', locale))} ${escapeHtml(doc.seller.name)}</div><div><strong>${escapeHtml(t('authorisedSignatory', locale))}</strong></div>`
      : '',
  ].join('');

  const body = `
  ${watermark(doc, format)}
  ${marking === null ? '' : `<div class="copy-mark">${escapeHtml(marking)}</div>`}
  <div class="head">
    <div>
      ${logo}
      <h1>${escapeHtml(title)}</h1>
      <div class="party-name">${escapeHtml(doc.seller.name)}</div>
      ${doc.seller.addressLines.map((l) => `<div>${escapeHtml(l)}</div>`).join('')}
      <div>${escapeHtml(doc.seller.stateName)} (${escapeHtml(doc.seller.stateCode)})</div>
      ${doc.seller.gstin === null ? '' : `<div><span class="k">${escapeHtml(t('gstin', locale))}:</span> ${escapeHtml(doc.seller.gstin)}</div>`}
      ${doc.seller.phone != null && shows('seller.phone') ? `<div>${escapeHtml(doc.seller.phone)}</div>` : ''}
      ${doc.seller.email != null && shows('seller.email') ? `<div>${escapeHtml(doc.seller.email)}</div>` : ''}
    </div>
    <div class="meta">${meta}</div>
  </div>
  <div class="parties">${partyBlock(doc.buyer, t('billedTo', locale), locale)}${shipToLine}${transport}${bank}</div>
  ${itemsBlock}
  ${totals}
  ${words}
  ${notice}
  ${qr}
  ${upi}
  <footer>${footerBits}</footer>`;

  return page(`${t(doc.title, locale)} ${doc.number}`, snapshot, format, locale, '', body, options.copy);
};

/**
 * Each marked copy as its own document.
 *
 * The two ways of getting the copies are not alternatives, they answer different needs. A business
 * printing on its own printer wants one press of Print for the set — that is `renderInvoiceCopies`
 * below. A business **sending** them wants three separate files, because the transporter's copy goes
 * to the transporter and the buyer's to the buyer, and asking someone to split a three-page PDF
 * before they can send it is work we have handed them rather than done.
 */
export const renderInvoiceCopySet = (
  doc: InvoiceDocument,
  snapshot: TemplateSnapshot,
  options: Omit<RenderOptions, 'copy'>,
): readonly { readonly copy: InvoiceCopy; readonly marking: string; readonly html: string }[] =>
  copiesFor(doc).map((copy) => ({
    copy,
    marking: copyMarking(doc, copy, options.locale) ?? '',
    html: renderInvoice(doc, snapshot, { ...options, copy }),
  }));

/**
 * Every marked copy of a bill, in one printable document.
 *
 * For the business printing the set on its own printer: the copies are pages of a single document,
 * each starting on a fresh sheet, so one press of Print produces all of them. Use
 * `renderInvoiceCopySet` when the copies are going to different people.
 */
export const renderInvoiceCopies = (
  doc: InvoiceDocument,
  snapshot: TemplateSnapshot,
  options: Omit<RenderOptions, 'copy'>,
): string => {
  return combineCopies(copiesFor(doc).map((copy) => renderInvoice(doc, snapshot, { ...options, copy })));
};

/**
 * Several rendered copies as one document: the first copy's head, then every copy's sheet.
 *
 * Each copy is rendered whole and then taken apart, rather than assembled from pieces, so a copy in
 * the combined file is byte for byte the copy that would have been printed on its own.
 */
const combineCopies = (rendered: readonly string[]): string => {
  const sheets = rendered
    .map((html) => {
      const body = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>'));
      return body.slice(body.indexOf('>') + 1);
    })
    .join('');
  const first = rendered[0] as string;
  const head = first.slice(0, first.indexOf('<body'));
  const bodyOpen = first.slice(first.indexOf('<body'), first.indexOf('>', first.indexOf('<body')) + 1);
  return `${head}${bodyOpen}${sheets}</body>\n</html>`;
};

/**
 * Issue #141 — one delivery challan, on the same engine and stylesheet as the invoice.
 *
 * The boxed grid on A4 and the phone screen, whatever the template's layout: a challan has no page
 * from before #140 to reprint as it was, so there is no reason to draw it any other way. On till
 * roll it is a list, for the same reason an invoice is.
 */
export const renderChallan = (doc: ChallanDocument, snapshot: TemplateSnapshot, options: RenderOptions): string => {
  const { locale, format } = options;
  const marking = options.copy === undefined ? null : challanCopyMarking(options.copy, locale);
  const heading = `${t('DELIVERY_CHALLAN', locale)} ${doc.number}`;
  return PAGE[format].narrow
    ? page(heading, snapshot, format, locale, '', renderChallanNarrow(doc, locale, marking), options.copy)
    : page(heading, snapshot, format, locale, 'boxed', `<div class="sheet-inner">${renderChallanBoxed(doc, snapshot, format, locale, marking)}</div>`, options.copy);
};

/** The three marked copies of a challan as separate files, for sending to three different people. */
export const renderChallanCopySet = (
  doc: ChallanDocument,
  snapshot: TemplateSnapshot,
  options: Omit<RenderOptions, 'copy'>,
): readonly { readonly copy: InvoiceCopy; readonly marking: string; readonly html: string }[] =>
  CHALLAN_COPIES.map((copy) => ({
    copy,
    marking: challanCopyMarking(copy, options.locale),
    html: renderChallan(doc, snapshot, { ...options, copy }),
  }));

/** The three marked copies of a challan in one document, so one press of Print produces the set. */
export const renderChallanCopies = (
  doc: ChallanDocument,
  snapshot: TemplateSnapshot,
  options: Omit<RenderOptions, 'copy'>,
): string => combineCopies(CHALLAN_COPIES.map((copy) => renderChallan(doc, snapshot, { ...options, copy })));

/**
 * Issue #142 — a quotation or a proforma invoice, on the same engine and stylesheet as the invoice.
 *
 * One copy, unmarked: the marked copies are what GST asks of a tax invoice and a challan, for goods
 * that travel. A price offer and a request for payment travel with nothing, so a "copy" option is
 * ignored rather than printing a marking that would claim otherwise.
 */
export const renderPreSale = (doc: PreSalePrint, snapshot: TemplateSnapshot, options: Omit<RenderOptions, 'copy'>): string => {
  const { locale, format } = options;
  const heading = `${preSaleTitle(doc.kind, locale)} ${doc.number}`;
  return PAGE[format].narrow
    ? page(heading, snapshot, format, locale, '', renderPreSaleNarrow(doc, locale))
    : page(heading, snapshot, format, locale, 'boxed', `<div class="sheet-inner">${renderPreSaleBoxed(doc, snapshot, format, locale)}</div>`);
};

/**
 * The document shell both layouts share: one head, one stylesheet, one sheet.
 *
 * Keeping it in one place is what guarantees that a boxed bill and an airy one are the same kind of
 * file — same escaping, same print rules, same `data-template` stamp identifying exactly which
 * design version produced the page.
 */
const page = (
  /** What the browser tab and a saved PDF are called, e.g. "Tax Invoice INV/26-27/000001". */
  heading: string,
  snapshot: TemplateSnapshot,
  format: PageFormat,
  locale: Locale,
  bodyClass: string,
  body: string,
  copy?: InvoiceCopy,
): string => `<!doctype html>
<html lang="${locale === 'hi-IN' ? 'hi' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)}</title>
<style>${styles(snapshot, format)}</style>
</head>
<body class="${escapeHtml(bodyClass)}">
<div class="sheet" data-format="${escapeHtml(format)}" data-template="${escapeHtml(snapshot.templateId)}@${escapeHtml(snapshot.templateVersion)}" data-layout="${escapeHtml(snapshot.layout ?? 'AIRY')}"${copy === undefined ? '' : ` data-copy="${escapeHtml(copy)}"`}>
${body}
</div>
</body>
</html>`;
