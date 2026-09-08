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
import { renderReservedSlot, reservedSlotStyles } from './reserved.ts';
import { renderBoxed } from './boxed.ts';
import { PAGE, escapeHtml, isZero, money, narrowLine, percent, t } from './parts.ts';

/** Re-exported because this module has been the public home of the escaper since issue #13. */
export { escapeHtml };

export interface RenderOptions {
  readonly format: PageFormat;
  readonly locale: Locale;
  /** Set for the preview shown on screen, which drops the print-only page furniture. */
  readonly screenPreview?: boolean;
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
      width: ${page.widthCss};
      /* On paper this is exactly ${page.widthCss}. On a screen narrower than the page it shrinks
         rather than running off the edge, because a bill nobody can read on a phone is a bill
         nobody checks before sending it. Print media below restores the true width. */
      max-width: ${page.printableMm === null ? '720px' : 'calc(100% - 24px)'};
      margin: 12px auto; background: #fff; padding: ${page.narrow ? '6mm 4mm' : '12mm 10mm'};
      box-shadow: 0 1px 4px rgba(0,0,0,.18);
    }
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
    .boxed .title-cell { text-align: center; }
    .boxed h1 {
      margin: 0; font-size: ${typography.baseSizePt + 3}pt; letter-spacing: .18em;
      text-transform: uppercase; color: ${palette.text}; font-family: ${typography.headingStack};
    }
    .boxed .party-name { display: block; font-weight: 700; font-size: ${typography.baseSizePt + 1}pt; }
    .boxed .meta-cell { padding: 0; }
    /* The item table takes the height that is left, so the page ends at the bottom rule instead of
       stopping halfway down with white space under it, the way a real bill does. */
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
    .boxed .sign-space { height: 16mm; }
    .boxed .sign-line { font-weight: 700; }
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
  if (boxed) {
    return page(doc, snapshot, format, locale, 'boxed', `<div class="sheet-inner">${renderBoxed(doc, snapshot, format, locale)}</div>`);
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
      ${isZero(doc.totals.roundOff) ? '' : `<tr><td>${escapeHtml(t('roundOff', locale))}</td><td class="num">${money(doc.totals.roundOff)}</td></tr>`}
      <tr class="grand"><td>${escapeHtml(t('total', locale))}</td><td class="num">${money(doc.totals.invoiceValue)}</td></tr>
      ${isZero(doc.totals.reverseChargeTax) ? '' : `<tr><td>${escapeHtml(t('rcmTax', locale))}</td><td class="num">${money(doc.totals.reverseChargeTax)}</td></tr>`}
      ${doc.totals.amountPaid != null && shows('totals.amountPaid') ? `<tr><td>${escapeHtml(t('paid', locale))}</td><td class="num">${money(doc.totals.amountPaid)}</td></tr>` : ''}
      ${doc.totals.outstanding != null && shows('totals.outstanding') ? `<tr><td>${escapeHtml(t('outstanding', locale))}</td><td class="num">${money(doc.totals.outstanding)}</td></tr>` : ''}
    </table>`;

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

  const notice =
    doc.declaredRateNotice === null
      ? ''
      : `<div class="notice">${escapeHtml(doc.declaredRateNotice)}</div>`;

  const footerBits = [
    doc.terms !== null && shows('footer.terms') ? `<div>${escapeHtml(doc.terms)}</div>` : '',
    snapshot.footerNote === null ? '' : `<div>${escapeHtml(snapshot.footerNote)}</div>`,
    shows('footer.signature') ? `<div style="margin-top:8mm">${escapeHtml(doc.seller.name)}</div>` : '',
  ].join('');

  const body = `
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
  <div class="parties">${partyBlock(doc.buyer, t('billedTo', locale), locale)}${transport}${bank}</div>
  ${itemsBlock}
  ${totals}
  ${words}
  ${notice}
  ${qr}
  ${upi}
  <footer>${footerBits}</footer>`;

  return page(doc, snapshot, format, locale, '', body);
};

/**
 * The document shell both layouts share: one head, one stylesheet, one sheet.
 *
 * Keeping it in one place is what guarantees that a boxed bill and an airy one are the same kind of
 * file — same escaping, same print rules, same `data-template` stamp identifying exactly which
 * design version produced the page.
 */
const page = (
  doc: InvoiceDocument,
  snapshot: TemplateSnapshot,
  format: PageFormat,
  locale: Locale,
  bodyClass: string,
  body: string,
): string => `<!doctype html>
<html lang="${locale === 'hi-IN' ? 'hi' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`${t(doc.title, locale)} ${doc.number}`)}</title>
<style>${styles(snapshot, format)}</style>
</head>
<body class="${escapeHtml(bodyClass)}">
<div class="sheet" data-format="${escapeHtml(format)}" data-template="${escapeHtml(snapshot.templateId)}@${escapeHtml(snapshot.templateVersion)}" data-layout="${escapeHtml(snapshot.layout ?? 'AIRY')}">
${body}
</div>
</body>
</html>`;
