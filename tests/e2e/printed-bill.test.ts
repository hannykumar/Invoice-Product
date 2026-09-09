/**
 * Issues #131 and #148 — what the *printed page* says, checked on the page itself.
 *
 * Both of these are defects nobody could catch inside a module. The calculator's totals were right
 * all along; the bill that came out of them was the thing a customer would have refused. So these
 * scenarios sell through the real services, print through the real renderer, and then read the
 * finished HTML back the way a person reads the paper.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isoDate, quantityFromString, rupees } from '@invoice/kernel';
import {
  captureSnapshot, hsnSummary, renderInvoice, RESERVED_SLOTS, templateById, toInvoiceDocument,
  type PageFormat, type TemplateDefinition,
} from '@invoice/invoice-templates';
import { COMPANY_GSTIN, COMPANY_STATE, CUSTOMER, CUSTOMER_GSTIN, CUSTOMER_NAME, makeBusiness, purchase } from './harness.ts';

const seller = {
  name: 'Bengaluru Steel Traders',
  addressLines: ['14, Rajajinagar Industrial Estate'],
  gstin: COMPANY_GSTIN,
  stateCode: COMPANY_STATE,
  stateName: 'Karnataka',
};
const buyer = {
  name: CUSTOMER_NAME,
  addressLines: ['Shop 8, Peenya'],
  gstin: CUSTOMER_GSTIN,
  stateCode: COMPANY_STATE,
  stateName: 'Karnataka',
};

const design = (): TemplateDefinition => {
  const template = templateById('india-standard');
  assert.ok(template !== undefined, 'the one shipped design a wholesaler is offered');
  return template;
};

/** Sells 100 KGS at ₹100 with ₹500 of freight on top, through the real chain, and prints it. */
const printedSaleWithFreight = async (format: PageFormat = 'A4') => {
  const shop = await makeBusiness();
  // Stock first: the sale below goes through the real inventory, so there has to be something in
  // the godown for it to take.
  await shop.posting.post(shop.actor, purchase({ id: 'printed-buy', sourceDocumentId: 'printed-buy-src', invoiceNumber: 'PRINT/BUY/1' }), 'printed:purchase');
  const draft = await shop.sales.createDraft(shop.actor, {
    idempotencyKey: 'printed:freight',
    input: {
      partyId: CUSTOMER,
      customerType: 'B2B',
      supplyKind: 'GOODS',
      documentDate: isoDate('2026-08-29'),
      lines: [{
        lineId: 'steel', itemId: 'TMT12', quantity: quantityFromString('100', 'KGS'),
        unitPrice: rupees(100), priceBasis: 'EXCLUSIVE', warehouseId: 'wh-main',
      }],
      freight: rupees(500),
    },
  });
  const issued = await shop.sales.finalise(shop.actor, { idempotencyKey: 'printed:freight:final', invoiceId: draft.id });
  const document = toInvoiceDocument(issued.invoice, {
    title: 'TAX_INVOICE', seller, buyer, placeOfSupplyStateName: 'Karnataka',
  });
  const snapshot = captureSnapshot(design(), 'en-IN', '2026-08-29');
  return { document, html: renderInvoice(document, snapshot, { format, locale: 'en-IN' }) };
};

/** Reads the money out of a cell the way a person reads it: "₹10,000.00" → 1000000 paise. */
const paise = (cell: string): bigint => {
  const cleaned = cell.replace(/<[^>]*>/g, '').replace(/[₹,\s]|&nbsp;/g, '').trim();
  assert.match(cleaned, /^-?\d+\.\d\d$/, `"${cell}" does not read as an amount`);
  const negative = cleaned.startsWith('-');
  const [whole, fraction] = cleaned.replace('-', '').split('.') as [string, string];
  const value = BigInt(whole) * 100n + BigInt(fraction);
  return negative ? -value : value;
};

const rows = (html: string): string[][] =>
  [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((match) => [...(match[1] ?? '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1] ?? ''));

const text = (cell: string): string => cell.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();

/** The item table, read the way a person reads it: find the headings, then use them. */
const itemTable = (html: string): { columns: Record<string, number>; body: string[][] } => {
  const all = rows(html);
  const headerIndex = all.findIndex((cells) => cells.map(text).includes('Amount'));
  assert.ok(headerIndex >= 0, 'the item table must have a heading row');
  const headings = (all[headerIndex] as string[]).map(text);
  const columns: Record<string, number> = {};
  headings.forEach((h, i) => { columns[h] = i; });
  const body = all.slice(headerIndex + 1).filter((cells) => cells.length === headings.length);
  return { columns, body };
};

test('#131 — on the printed bill, quantity × rate is the amount on every goods line', async () => {
  const { html } = await printedSaleWithFreight();

  const { columns, body } = itemTable(html);
  const goods = body.filter((cells) => /^[\d.]+$/.test(text(cells[columns['Quantity'] as number] ?? '')));
  assert.equal(goods.length, 1, 'the sale has one goods line');

  for (const cells of goods) {
    const quantity = Number(text(cells[columns['Quantity'] as number] ?? ''));
    const rate = paise(cells[columns['Rate'] as number] ?? '');
    const discountCell = text(cells[columns['Discount'] as number] ?? '');
    const discount = discountCell === '' || discountCell === '—' ? 0n : paise(cells[columns['Discount'] as number] ?? '');
    const amount = paise(cells[columns['Amount'] as number] ?? '');
    assert.equal(
      amount,
      BigInt(Math.round(quantity * Number(rate))) - discount,
      `${text(cells[columns['Description of Goods'] as number] ?? '')}: quantity × rate less discount must be the printed amount`,
    );
  }
  assert.ok(html.includes('₹10,000.00'), '100 × ₹100 prints as ₹10,000.00, with no freight folded in');
});

test('#131 — freight is its own line below the goods, and the bill still totals the same', async () => {
  const { document, html } = await printedSaleWithFreight();

  const charges = document.lines.filter((l) => l.kind === 'CHARGE');
  assert.equal(charges.length, 1);
  assert.equal(charges[0]?.description, 'Freight');
  assert.equal(charges[0]?.taxableValue.minor, 50000n, 'the whole ₹500, on a line of its own');

  const goodsIndex = html.indexOf('TMT Steel Bar');
  const freightIndex = html.indexOf('Freight');
  assert.ok(goodsIndex > -1 && freightIndex > goodsIndex, 'freight is printed after the goods it belongs to');
  assert.ok(html.includes('Sub Total'), 'the goods are sub-totalled before the charges');

  // ₹10,000 of goods and ₹500 of freight, both at 18%: ₹10,500 + ₹1,890 = ₹12,390.
  assert.equal(document.totals.taxableValue.minor, 1050000n);
  assert.equal(document.totals.invoiceValue.minor, 1239000n);
});

test('#148 — every reserved slot prints as a bordered box at its final size, with a label', async () => {
  const template = design();
  const snapshot = captureSnapshot(
    { ...template, optionalFields: [...template.optionalFields, 'qr.upi'] },
    'en-IN',
    '2026-08-29',
  );
  const { document } = await printedSaleWithFreight();
  const html = renderInvoice({ ...document, eInvoice: null }, snapshot, { format: 'A4', locale: 'en-IN' });

  for (const spec of RESERVED_SLOTS) {
    const box = new RegExp(`<div class="reserved" data-reserved="${spec.id.replace('.', '\\.')}"[^>]*>(.*?)</div>`).exec(html);
    assert.ok(box !== null, `${spec.id} must have a box waiting for it`);
    assert.ok(
      html.includes(`data-reserved="${spec.id}" style="width:${spec.widthMm}mm;height:${spec.heightMm}mm"`),
      `${spec.id} must be reserved at the size the real thing will take`,
    );
    assert.ok((box[1] ?? '').includes(spec.label['en-IN']), `${spec.id} must say what will appear there`);
  }
  assert.match(html, /\.reserved \{[\s\S]*?border: 1px dashed/, 'a reserved slot is a bordered box, not a gap');
});

test('#148 — a reserved slot is dropped on till-roll paper and never shifts the page when filled', async () => {
  const template = design();
  const snapshot = captureSnapshot(
    { ...template, optionalFields: [...template.optionalFields, 'qr.upi'], formats: ['A4', 'THERMAL_58MM', 'THERMAL_80MM'] },
    'en-IN',
    '2026-08-29',
  );
  const { document } = await printedSaleWithFreight();
  const empty = { ...document, eInvoice: null };

  for (const format of ['THERMAL_58MM', 'THERMAL_80MM'] as const) {
    const html = renderInvoice(empty, snapshot, { format, locale: 'en-IN' });
    assert.ok(!html.includes('data-reserved'), `${format} has no room for a placeholder, so it prints none`);
  }

  // The QR square is 26mm whether it is empty or holding the government's code, so the page below
  // it does not move on the day the provider is connected.
  const filled = renderInvoice(
    { ...document, eInvoice: { irn: 'a'.repeat(64), qrSvg: '<svg role="img"><rect/></svg>' } },
    snapshot,
    { format: 'A4', locale: 'en-IN' },
  );
  const reservedQr = RESERVED_SLOTS.find((s) => s.id === 'einvoice.qr');
  assert.equal(reservedQr?.widthMm, 26);
  assert.match(filled, /\.qr-slot \{[^}]*width: 26mm/);
  assert.ok(!filled.includes('data-reserved="einvoice.qr"'), 'the box holds the real code once there is one');
});

test('#148 — the screen preview and the print show a reserved slot identically', async () => {
  const template = design();
  const snapshot = captureSnapshot(
    { ...template, optionalFields: [...template.optionalFields, 'qr.upi'] },
    'en-IN',
    '2026-08-29',
  );
  const { document } = await printedSaleWithFreight();
  const empty = { ...document, eInvoice: null };
  assert.equal(
    renderInvoice(empty, snapshot, { format: 'A4', locale: 'en-IN', screenPreview: true }),
    renderInvoice(empty, snapshot, { format: 'A4', locale: 'en-IN' }),
    'what a business approves on screen has to be what comes out of the printer',
  );
});


/**
 * Issue #140 — the boxed design, driven through the real services rather than a fixture.
 *
 * The HSN summary's promise is that it agrees with the bill. A fixture can be made to agree with
 * itself; only real calculator output proves the grouping and the rounding survive contact with a
 * bill that has goods, freight and a rate the business declared.
 */
test('#140 — the India-standard bill prints a ruled grid whose HSN summary agrees with the totals', async () => {
  const { document } = await printedSaleWithFreight();
  const template = templateById('india-standard');
  assert.ok(template !== undefined);
  const html = renderInvoice(document, captureSnapshot(template, 'en-IN', '2026-09-08'), {
    format: 'A4',
    locale: 'en-IN',
  });

  assert.ok(html.includes('data-layout="BOXED"'));
  assert.ok(html.includes('HSN / SAC Summary'));

  const summary = hsnSummary(document);
  assert.equal(summary.totals.taxableValue.minor, document.totals.taxableValue.minor, 'taxable value must agree');
  assert.equal(summary.totals.cgst.minor, document.totals.cgst.minor, 'CGST must agree');
  assert.equal(summary.totals.sgst.minor, document.totals.sgst.minor, 'SGST must agree');
  assert.equal(summary.totals.igst.minor, document.totals.igst.minor, 'IGST must agree');
  assert.equal(summary.totals.cess.minor, document.totals.cess.minor, 'cess must agree');

  // The freight line from #131 is grouped in the summary alongside the goods it rides with, so the
  // buyer's accountant sees the same taxable value under the same rate as the goods above.
  assert.ok(summary.rows.length >= 1);
  assert.equal(
    summary.rows.reduce((acc, r) => acc + r.taxableValue.minor, 0n),
    document.totals.taxableValue.minor,
    'every row together is the whole bill; nothing is left out of the summary',
  );

  // And the arithmetic rule from #131 still holds on this design: 100 KGS at Rs 100 is Rs 10,000.
  assert.ok(html.includes('\u20b910,000.00'));
});
