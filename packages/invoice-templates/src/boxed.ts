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
import { formatDate, sum, type IsoDate, type Money } from '@invoice/kernel';
import type { InvoiceDocument, RenderableLine, RenderableParty, TemplateSnapshot } from './document.ts';
import type { PageFormat } from './template.ts';
import { hsnSummary, hsnSummaryColumns, type HsnSummaryRow } from './hsn-summary.ts';
import { escapeHtml, isZero, money, percent, splitQuantity, t, totalQuantityText } from './parts.ts';
import type { Locale } from './document.ts';
import { renderReservedSlot } from './reserved.ts';

/** A cell in the header grid: a small grey caption with the value under it. */
export const cell = (caption: string, value: string, span = 1): string =>
  `<td colspan="${span}"><span class="cap">${escapeHtml(caption)}</span><span class="val">${value}</span></td>`;

/** A party's box: name, address, state, GSTIN, and whatever optional contact lines the design shows. */
export const partyCell = (
  party: RenderableParty,
  heading: string,
  locale: Locale,
  shows: (f: string) => boolean,
  span = 1,
): string => `
  <td class="party-cell" colspan="${span}">
    <span class="cap">${escapeHtml(heading)}</span>
    <span class="party-name">${escapeHtml(party.name)}</span>
    ${party.addressLines.map((l) => `<div>${escapeHtml(l)}</div>`).join('')}
    <div>${escapeHtml(party.stateName)} (${escapeHtml(party.stateCode)})</div>
    ${party.gstin === null ? '' : `<div><span class="cap-inline">${escapeHtml(t('gstin', locale))}</span> ${escapeHtml(party.gstin)}</div>`}
    ${party.pan == null || !shows('seller.pan') ? '' : `<div><span class="cap-inline">${escapeHtml(t('pan', locale))}</span> ${escapeHtml(party.pan)}</div>`}
    ${party.phone != null && shows('seller.phone') ? `<div>${escapeHtml(party.phone)}</div>` : ''}
    ${party.email != null && shows('seller.email') ? `<div>${escapeHtml(party.email)}</div>` : ''}
  </td>`;

/**
 * The item table.
 *
 * A serial number down the left and the unit in its own "per" column are what make this read as a
 * bill rather than a spreadsheet. The amount column is the line's own amount — quantity times rate,
 * less its discount — which since issue #131 is exactly what it says.
 *
 * Exported for issue #142: a quotation and a proforma print their items with this same table, so the
 * three papers a buyer compares side by side cannot drift apart column by column.
 */
export const itemTable = (
  goods: readonly RenderableLine[],
  charges: readonly RenderableLine[],
  snapshot: TemplateSnapshot,
  locale: Locale,
): string => {
  const showDiscount = snapshot.lineColumns.includes('line.discount');
  const showBatch = snapshot.lineColumns.includes('line.batch');
  const showPackages = snapshot.lineColumns.includes('line.packages');

  /**
   * Columns, each with the share of the width it needs.
   *
   * The description gets the most, because it is the only column whose content is a sentence and
   * the one a customer reads first. Everything else is a number or a short code. The shares are
   * normalised below, so adding or dropping a column keeps the rest in proportion.
   */
  const headings: { label: string; share: number }[] = [
    { label: t('serial', locale), share: 5 },
    { label: t('item', locale), share: 22 },
    { label: t('hsn', locale), share: 8 },
    ...(showBatch ? [{ label: t('batch', locale), share: 8 }] : []),
    ...(showPackages ? [{ label: t('packages', locale), share: 8 }] : []),
    { label: t('qty', locale), share: 9 },
    { label: t('rate', locale), share: 9 },
    { label: t('per', locale), share: 5 },
    ...(showDiscount ? [{ label: t('discount', locale), share: 8 }] : []),
    { label: t('gstPercent', locale), share: 6 },
    { label: t('lineTotal', locale), share: 11 },
  ];
  const totalShare = headings.reduce((a, h) => a + h.share, 0);

  const row = (line: RenderableLine, index: number | null): string => {
    const charge = line.kind === 'CHARGE';
    const q = splitQuantity(line.quantityText);
    return `<tr${charge ? ' class="charge"' : ''}>
      <td class="num sl">${index === null ? '' : index}</td>
      <td>${escapeHtml(line.description)}${line.reverseCharge ? ' <span class="tag">RCM</span>' : ''}</td>
      <td>${charge ? '' : escapeHtml(line.hsnOrSac ?? '—')}</td>
      ${showBatch ? `<td>${charge ? '' : escapeHtml(line.batch ?? '')}</td>` : ''}
      ${showPackages ? `<td>${charge ? '' : escapeHtml(line.packages ?? '')}</td>` : ''}
      <td class="num">${charge ? '' : escapeHtml(q.amount)}</td>
      <td class="num">${charge ? '' : money(line.unitPrice)}</td>
      <td>${charge ? '' : escapeHtml(q.unit)}</td>
      ${showDiscount ? `<td class="num">${charge || line.discount === null ? '' : money(line.discount)}</td>` : ''}
      <td class="num">${escapeHtml(percent(line.ratePercentTimes100))}</td>
      <td class="num">${money(line.taxableValue)}</td>
    </tr>`;
  };

  const goodsTotal = sum(goods.map((l) => l.taxableValue));
  // Both real bills total the quantity as well as the money: 2,000.000 KGS on Blessing Export,
  // 1400 on KK Polyplast. It is what a godown checks the load against.
  const quantityTotal = totalQuantityText(goods);
  const quantityAt = headings.findIndex((h) => h.label === t('qty', locale));

  return `<table class="grid items">
    <thead><tr>${headings
      .map((h) => `<th style="width:${((h.share / totalShare) * 100).toFixed(2)}%">${escapeHtml(h.label)}</th>`)
      .join('')}</tr></thead>
    <tbody>${goods.map((l, i) => row(l, i + 1)).join('')}</tbody>
    ${
      charges.length === 0
        ? ''
        : `<tbody class="charges">
            <tr class="subtotal">${headings
              .map((h, i) =>
                i === 0
                  ? `<td class="num" colspan="${quantityAt}">${escapeHtml(t('subTotal', locale))}</td>`
                  : i < quantityAt
                    ? ''
                    : i === quantityAt
                      ? `<td class="num">${escapeHtml(quantityTotal)}</td>`
                      : i === headings.length - 1
                        ? `<td class="num">${money(goodsTotal)}</td>`
                        : '<td></td>',
              )
              .join('')}</tr>
            ${charges.map((l) => row(l, null)).join('')}
          </tbody>`
    }
  </table>`;
};

export const totalsTable = (doc: Pick<InvoiceDocument, 'totals'>, locale: Locale, shows: (f: string) => boolean): string => {
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
export const summaryTable = (doc: Pick<InvoiceDocument, 'lines' | 'split'>, locale: Locale): string => {
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
  /** Issue #137 — "ORIGINAL FOR RECIPIENT" and the rest. `null` prints an unmarked bill. */
  copyMark: string | null = null,
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

  /**
   * Issue #158 — the signature is part of the compliance section, not something a design chooses.
   *
   * CGST Rule 46 lists a signature or digital signature among the mandatory particulars of a tax
   * invoice, so this is assembled from the document and there is no field with which to remove it.
   *
   * The one exemption is real: an invoice registered with the government carries an IRN and is
   * digitally signed, and needs no handwritten one. The page says so rather than leaving a rule
   * nobody will sign. Until a business uploads its signature image, issue #148's reserved box holds
   * the space at the size the image will take (#138).
   */
  const signedByGovernment = doc.eInvoice !== null && doc.eInvoice.irn !== '';
  const signature = `<td class="sign-cell">
      <span class="cap">${escapeHtml(t('forSeller', locale))} ${escapeHtml(doc.seller.name)}</span>
      ${
        signedByGovernment
          ? `<div class="sign-digital">${escapeHtml(t('digitallySigned', locale))}</div>`
          : `<div class="sign-space">${
              doc.signatureDataUri === null
                ? reserved('signature')
                : `<img class="sign-image" src="${escapeHtml(doc.signatureDataUri)}" alt="">`
            }</div>
            <div class="sign-line">${escapeHtml(t('authorisedSignatory', locale))}</div>`
      }
    </td>`;

  // No declaration is invented. The box exists only once the business has written one.
  const declaration =
    doc.declaration === null || !shows('footer.declaration')
      ? ''
      : `<td><span class="cap">${escapeHtml(t('declaration', locale))}</span>${escapeHtml(doc.declaration)}</td>`;

  /**
   * Issue #156 — named bank fields where a business has them, its own lines where it does not.
   *
   * Nothing already entered is lost: a business that only ever typed free text keeps printing it.
   */
  const bankLines =
    doc.bank !== null
      ? ([
          [t('bankName', locale), doc.bank.bankName],
          [t('accountNumber', locale), doc.bank.accountNumber],
          [t('branchIfsc', locale), [doc.bank.branch, doc.bank.ifsc].filter((v) => v != null && v !== '').join(' & ')],
        ] as const)
          .filter(([, v]) => v != null && v !== '')
          .map(([label, v]) => `<div><span class="cap-inline">${escapeHtml(label)}</span> ${escapeHtml(v as string)}</div>`)
      : (doc.bankDetails ?? []).map((l) => `<div>${escapeHtml(l)}</div>`);

  const bank =
    bankLines.length === 0 || !shows('seller.bankDetails')
      ? ''
      : `<td><span class="cap">${escapeHtml(t('bank', locale))}</span>${bankLines.join('')}</td>`;

  // The pay-by-scan square sits beside the bank details, which is where a customer looks for a way
  // to pay. Issue #144 supplies the business's UPI id; issue #148's reserved box holds the space.
  const upi = !shows('qr.upi') ? '' : `<td class="upi-cell">${reserved('upi.qr')}</td>`;

  const footerCells = [declaration, bank, upi, signature].filter((c) => c !== '');

  /**
   * The two standard notations from issue #138.
   *
   * "This is a computer generated invoice" is a fact about the document, which this product
   * produced, so the shipped design states it. "E. & O.E." — errors and omissions excepted — is a
   * reservation the *business* makes to its customer, so it is off unless a business turns it on.
   * We do not make commitments on a business's behalf.
   */
  const notations = [
    shows('footer.computerGenerated') ? t('computerGenerated', locale) : '',
    shows('footer.eoe') ? t('eoe', locale) : '',
  ].filter((n) => n !== '');

  // Issue #156 — the order-and-delivery references, two to a row. Tally prints these labels even
  // with nothing in them; we draw a row only when at least one of its cells has a value, because
  // eight empty labels make a header that is mostly blank paper. Inside a row that is drawn, an
  // empty cell keeps its label, as Tally does.
  const references = doc.references ?? {};
  const dated = (number: string | null | undefined, date: IsoDate | null | undefined): string =>
    [number, date == null ? null : formatDate(date)].filter((v): v is string => v != null && v !== '').join(', ');

  // The label prints whether or not there is anything in it, which is what Tally does: Blessing
  // Export's own bill carries an empty Delivery Note and an empty Dispatch Doc No. A buyer reading
  // a familiar form finds the same box in the same place on every bill, and an empty one tells them
  // the seller had nothing to put there rather than leaving them to wonder where it went.
  const referenceRow = (
    fieldId: string,
    left: readonly [string, string],
    right: readonly [string, string],
  ): string =>
    !shows(fieldId)
      ? ''
      : `<tr>${cell(left[0], escapeHtml(left[1]))}${cell(right[0], escapeHtml(right[1]))}</tr>`;

  const referenceRows = [
          referenceRow(
            'document.deliveryNote',
            [t('deliveryNote', locale), references.deliveryNoteNumber ?? ''],
            [
              t('deliveryNoteDate', locale),
              references.deliveryNoteDate == null ? '' : formatDate(references.deliveryNoteDate),
            ],
          ),
          referenceRow(
            'document.dispatchDoc',
            [t('dispatchDoc', locale), references.dispatchDocNumber ?? ''],
            [t('termsOfDelivery', locale), shows('document.termsOfDelivery') ? references.termsOfDelivery ?? '' : ''],
          ),
          referenceRow(
            'document.references',
            [t('referenceNo', locale), dated(references.referenceNumber, references.referenceDate)],
            [t('otherReferences', locale), references.otherReferences ?? ''],
          ),
          referenceRow(
            'document.paymentTerms',
            [t('paymentTerms', locale), references.paymentTerms ?? ''],
            ['', ''],
          ),
  ].join('');

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
    <tr><td class="title-cell" colspan="${showEInvoice ? 3 : 2}"><h1>${escapeHtml(t(doc.title, locale))}</h1>${
      copyMark === null ? '' : `<span class="copy-mark-inline">${escapeHtml(copyMark)}</span>`
    }</td></tr>
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
          <tr>
            ${cell(t('reverseCharge', locale), doc.reverseCharge ? 'Yes' : 'No', 2)}
          </tr>
          ${
            // Issue #138 — the transporter's own paperwork. A whole row is only worth its space when
            // the design carries at least one of these, so a bill without them prints cleanly.
            !showTransport || !(shows('transport.lrNumber') || shows('transport.document') || shows('transport.destination'))
              ? ''
              : `<tr>
                  ${cell(t('lrNumber', locale), shows('transport.lrNumber') ? escapeHtml(transport.lrNumber ?? '') : '')}
                  ${cell(
                    t('transportDoc', locale),
                    !shows('transport.document')
                      ? ''
                      : escapeHtml(
                          [transport.documentNumber, transport.documentDate === null || transport.documentDate === undefined ? null : formatDate(transport.documentDate)]
                            .filter((v): v is string => v != null && v !== '')
                            .join(', '),
                        ),
                  )}
                </tr>
                <tr>
                  ${cell(t('destination', locale), shows('transport.destination') ? escapeHtml(transport.destination ?? '') : '', 2)}
                </tr>`
          }
          ${referenceRows}
          ${irnRow}
        </table>
      </td>
      ${qrCell}
    </tr>
    <tr>
      ${partyCell(doc.buyer, t('billedTo', locale), locale, shows)}
      ${
        // Issue #134 — the consignee box, beside the buyer, as both real bills print it.
        //
        // When the goods go to the buyer's own address the box **repeats it in full** rather than
        // saying "same as above". That is what the samples do: Blessing Export prints the buyer's
        // name, address, GSTIN and state again under Consignee (Ship to), identical to the box
        // beside it, and KK Polyplast prints the delivery address on its own. Neither ever
        // cross-references. Anyone handling the goods reads one box and needs the whole address in
        // it, so a bill that makes them look somewhere else is the worse bill.
        partyCell(doc.shipTo ?? doc.buyer, t('shipTo', locale), locale, shows, showEInvoice ? 2 : 1)
      }
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
  ${footerCells.length === 0 ? '' : `<table class="grid foot"><tr>${footerCells.join('')}</tr></table>`}
  ${
    notations.length === 0
      ? ''
      : `<table class="grid notations"><tr><td>${notations.map((n) => escapeHtml(n)).join(' &nbsp;&nbsp; ')}</td></tr></table>`
  }`;
};
