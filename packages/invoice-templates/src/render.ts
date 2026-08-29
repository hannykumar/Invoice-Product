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
import { formatDate, formatINR, toDecimalString, type Money } from '@invoice/kernel';
import type {
  InvoiceDocument,
  Locale,
  RenderableLine,
  RenderableParty,
  TemplateSnapshot,
} from './document.ts';
import type { PageFormat } from './template.ts';

export interface RenderOptions {
  readonly format: PageFormat;
  readonly locale: Locale;
  /** Set for the preview shown on screen, which drops the print-only page furniture. */
  readonly screenPreview?: boolean;
}

/** Printable width and the character budget that follows from it. */
const PAGE: Record<PageFormat, { widthCss: string; printableMm: number | null; narrow: boolean }> = {
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
  qrPending: { 'en-IN': 'QR code not received yet', 'hi-IN': 'QR code abhi nahin mila' },
  bank: { 'en-IN': 'Pay into', 'hi-IN': 'Yahan bhejein' },
  po: { 'en-IN': 'Your order reference', 'hi-IN': 'Aapka order reference' },
} as const;

const t = (key: keyof typeof T, locale: Locale): string => T[key][locale];

const money = (m: Money): string => escapeHtml(formatINR(m));
const percent = (rate: bigint | null): string => (rate === null ? '—' : `${Number(rate) / 100}%`);
const isZero = (m: Money): boolean => m.minor === 0n;

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
  const cells = [
    `<td>${escapeHtml(line.description)}${line.reverseCharge ? ' <span class="tag">RCM</span>' : ''}</td>`,
    `<td>${escapeHtml(line.hsnOrSac ?? '—')}</td>`,
    `<td class="num">${escapeHtml(line.quantityText)}</td>`,
    `<td class="num">${money(line.unitPrice)}</td>`,
  ];
  if (snapshot.lineColumns.includes('line.discount')) {
    cells.push(`<td class="num">${line.discount === null ? '—' : money(line.discount)}</td>`);
  }
  if (snapshot.lineColumns.includes('line.batch')) cells.push(`<td>${escapeHtml(line.batch ?? '—')}</td>`);
  if (snapshot.lineColumns.includes('line.note')) cells.push(`<td>${escapeHtml(line.note ?? '')}</td>`);
  cells.push(
    `<td class="num">${money(line.taxableValue)}</td>`,
    `<td class="num">${escapeHtml(percent(line.ratePercentTimes100))}</td>`,
    `<td class="num">${money(line.taxAmount)}</td>`,
  );
  return `<tr>${cells.join('')}</tr>`;
};

/** The narrow shapes get a list, because a nine-column table on 58mm of paper is unreadable. */
const narrowLine = (line: RenderableLine, locale: Locale): string => `
  <div class="tline">
    <div class="tline-name">${escapeHtml(line.description)}${line.reverseCharge ? ' (RCM)' : ''}</div>
    <div class="tline-detail"><span>${escapeHtml(line.quantityText)} × ${money(line.unitPrice)}</span><span class="num">${money(line.taxableValue)}</span></div>
    ${line.ratePercentTimes100 === null ? '' : `<div class="tline-tax"><span>${escapeHtml(t('gstAmount', locale))} ${escapeHtml(percent(line.ratePercentTimes100))}</span><span class="num">${money(line.taxAmount)}</span></div>`}
  </div>`;

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
    .tline { border-bottom: 1px dotted ${palette.border}; padding: 1.2mm 0; break-inside: avoid; }
    .tline-name { font-weight: 700; }
    .tline-detail, .tline-tax { display: flex; justify-content: space-between; }
    .qr { margin-top: 3mm; display: flex; gap: 3mm; align-items: center; }
    .qr-slot { width: 26mm; height: 26mm; border: 1px solid ${palette.border}; padding: 2mm; display: flex; align-items: center; justify-content: center; text-align: center; font-size: ${typography.baseSizePt - 2}pt; color: ${palette.muted}; background: #fff; }
    .qr-slot svg { width: 100%; height: 100%; }
    footer { margin-top: 4mm; border-top: 1px solid ${palette.border}; padding-top: 2mm; color: ${palette.muted}; }
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

  const itemsBlock = narrow
    ? `<div class="items-narrow">${doc.lines.map((l) => narrowLine(l, locale)).join('')}</div>`
    : `<table class="items">
        <thead><tr>${complianceLineColumns(locale, snapshot).map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
        <tbody>${doc.lines.map((l) => lineRow(l, snapshot)).join('')}</tbody>
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

  const qr =
    doc.eInvoice === null || !shows('qr.eInvoice')
      ? ''
      : `<div class="qr">
          <div class="qr-slot">${doc.eInvoice.qrSvg ?? escapeHtml(t('qrPending', locale))}</div>
          <div><span class="k">${escapeHtml(t('irn', locale))}:</span><br><code>${escapeHtml(doc.eInvoice.irn)}</code></div>
        </div>`;

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

  return `<!doctype html>
<html lang="${locale === 'hi-IN' ? 'hi' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`${title} ${doc.number}`)}</title>
<style>${styles(snapshot, format)}</style>
</head>
<body>
<div class="sheet" data-format="${escapeHtml(format)}" data-template="${escapeHtml(snapshot.templateId)}@${escapeHtml(snapshot.templateVersion)}">
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
  <footer>${footerBits}</footer>
</div>
</body>
</html>`;
};
