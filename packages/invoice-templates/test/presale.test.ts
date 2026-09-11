/**
 * Issue #142 — the quotation and the proforma invoice print on the same engine as the invoice, each
 * clearly marked as not a tax invoice, carrying what Indian businesses print on them and nothing
 * that belongs only on a registered tax invoice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PreSaleDocument, PreSaleInput, PreSaleKind } from '@invoice/sales';
import { templateById, type TemplateDefinition } from '../src/template.ts';
import { captureSnapshot } from '../src/snapshot.ts';
import { renderInvoice, renderPreSale } from '../src/render.ts';
import { invoiceReferencesFromPreSale, PRESALE_PRINTED_FIELDS, toPreSalePrint, type PreSalePrintingContext } from '../src/presale.ts';
import { toInvoiceDocument } from '../src/from-sales.ts';
import { ABC, GURUGRAM, inr, on, qty } from '../../sales/test/fixtures.ts';
import { crateOffer, makeSalesCounter } from '../../sales/test/presale-fixtures.ts';

const india = templateById('india-standard') as TemplateDefinition;
const snapshot = captureSnapshot(india, 'en-IN', '2026-09-11');

const SELLER = {
  name: 'Sharma Fruit Traders',
  addressLines: ['12/4, Ajmal Khan Road', 'Karol Bagh, New Delhi 110005'],
  gstin: '07AAAAA0000A1Z4',
  stateCode: '07',
  stateName: 'Delhi',
};
const BUYER = {
  name: 'ABC Traders',
  addressLines: ['Shop 8, Azadpur Mandi', 'New Delhi 110033'],
  gstin: '07DDDDD3333D1ZV',
  stateCode: '07',
  stateName: 'Delhi',
};
const BANK = { bankName: 'State Bank of India', accountNumber: '30001234567', branch: 'Karol Bagh', ifsc: 'SBIN0001234' };

const context = (overrides: Partial<PreSalePrintingContext> = {}): PreSalePrintingContext => ({
  seller: SELLER,
  buyer: BUYER,
  placeOfSupplyStateName: 'Delhi',
  bank: BANK,
  ...overrides,
});

const issue = async (kind: PreSaleKind, input: Partial<PreSaleInput> = {}): Promise<PreSaleDocument> => {
  const counter = await makeSalesCounter();
  return counter.presale.issue(counter.actor, { kind, idempotencyKey: `${kind}-print`, input: crateOffer({ ...(kind === 'PROFORMA' ? { purpose: 'Advance' } : {}), ...input }) });
};

/** The visible text, with tags stripped, so an assertion about a word is about what a person reads. */
const text = (html: string): string =>
  html
    .replace(/<style>[\s\S]*?<\/style>/, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

test('each page says what it is, and that it is not a tax invoice', async () => {
  for (const [kind, title, number] of [['QUOTATION', 'Quotation', 'QTN/26-27/00001'], ['PROFORMA', 'Proforma Invoice', 'PI/26-27/00001']] as const) {
    const html = renderPreSale(toPreSalePrint(await issue(kind), context()), snapshot, { format: 'A4', locale: 'en-IN' });
    const visible = text(html);
    assert.match(visible, new RegExp(` ${title} Not a tax invoice `));
    assert.doesNotMatch(visible, /Tax Invoice/, `the tax invoice title never appears on a ${title}`);
    assert.match(html, new RegExp(`<title>${title} ${number.replace(/\//g, '\\/')}</title>`));
    assert.match(html, /data-template="india-standard@/, 'the same engine and stamp as the invoice');
  }
});

test('the items, totals and HSN summary are the invoice\'s own tables, cell for cell', async () => {
  const counter = await makeSalesCounter();
  const quotation = await counter.presale.issue(counter.actor, { kind: 'QUOTATION', idempotencyKey: 'q', input: crateOffer() });
  const { invoice } = await counter.presale.convertToSale(counter.actor, { quotationId: quotation.id });
  const final = (await counter.till.service.finalise(counter.till.actor, { idempotencyKey: 'f', invoiceId: invoice.id })).invoice;

  const quoted = renderPreSale(toPreSalePrint(quotation, context()), snapshot, { format: 'A4', locale: 'en-IN' });
  const billed = renderInvoice(
    toInvoiceDocument(final, { title: 'TAX_INVOICE', seller: SELLER, buyer: BUYER, placeOfSupplyStateName: 'Delhi' }),
    snapshot,
    { format: 'A4', locale: 'en-IN' },
  );
  const table = (html: string, cls: string): string => (new RegExp(`<table class="grid ${cls}">[\\s\\S]*?</table>`).exec(html) ?? [''])[0];
  for (const cls of ['items', 'summary']) {
    assert.ok(table(quoted, cls) !== '', `the quotation has the ${cls} table`);
    assert.equal(table(quoted, cls), table(billed, cls), `the ${cls} table is identical on the quotation and the invoice made from it`);
  }
});

test('everything Indian businesses print on these papers is there', async () => {
  const visible = text(renderPreSale(toPreSalePrint(await issue('QUOTATION', { validUntil: on('2026-05-25') }), context()), snapshot, { format: 'A4', locale: 'en-IN' }));
  const present: Record<string, boolean> = {
    title: visible.includes('Quotation'),
    notTaxInvoice: visible.includes('Not a tax invoice'),
    number: visible.includes('Quotation No.') && visible.includes('QTN/26-27/00001'),
    date: visible.includes('Date') && visible.includes('10 May 2026'),
    'seller.nameAddressGstin': visible.includes('Sharma Fruit Traders') && visible.includes('Ajmal Khan Road') && visible.includes('07AAAAA0000A1Z4'),
    'buyer.nameAddressGstin': visible.includes('Buyer (Bill to)') && visible.includes('ABC Traders') && visible.includes('Azadpur Mandi') && visible.includes('07DDDDD3333D1ZV'),
    'line.hsnQuantityRateAmount': visible.includes('Plastic crate') && visible.includes('3923') && / 40 /.test(visible) && visible.includes('210.00') && visible.includes('8,400.00'),
    'line.taxRate': visible.includes('Tax Rate') && visible.includes(' 18% '),
    totals: visible.includes('Total Taxable Value') && visible.includes('CGST ₹756.00') && visible.includes('SGST ₹756.00') && visible.includes('Total ₹9,912.00'),
    placeOfSupply: visible.includes('Place of Supply Delhi (07)'),
    signature: visible.includes('Authorised Signatory'),
    validUntil: visible.includes('Valid Until 25 May 2026'),
    // Printed only when typed; checked in the next test.
    terms: true,
    'proforma.bankDetails': true,
    'proforma.buyerOrderNumber': true,
    'proforma.paymentTerms': true,
  };
  for (const field of PRESALE_PRINTED_FIELDS) assert.ok(present[field.id], `${field.id} (${field.basis}) is missing`);
  assert.match(visible, /Amount \(in words\) Rupees nine thousand nine hundred and twelve only/);
  assert.ok(!PRESALE_PRINTED_FIELDS.some((f) => f.basis === 'LAW'), 'GST sets no format for either paper, so nothing is claimed as law');
});

test('nothing that belongs only on a registered tax invoice, or on goods on the road, is printed', async () => {
  for (const kind of ['QUOTATION', 'PROFORMA'] as const) {
    const visible = text(renderPreSale(toPreSalePrint(await issue(kind), context()), snapshot, { format: 'A4', locale: 'en-IN' }));
    for (const invoiceOnly of [
      'Amount Chargeable', 'Balance Due', 'Amount Paid', 'Due Date', 'IRN', 'Government QR', 'Pay by scan', 'ORIGINAL FOR', 'DUPLICATE FOR',
      'Reverse Charge', 'e-Way Bill', 'Dispatched through', 'Vehicle No.', 'Delivery Note', 'computer generated invoice',
    ]) {
      assert.ok(!visible.includes(invoiceOnly), `a ${kind.toLowerCase()} must not carry "${invoiceOnly}"`);
    }
    assert.match(visible, /This is a computer generated document\./, 'the true statement, since this is not an invoice');
  }
});

test('nothing is invented: validity, terms and payment terms print only when the business typed them', async () => {
  const bare = text(renderPreSale(toPreSalePrint(await issue('PROFORMA'), context()), snapshot, { format: 'A4', locale: 'en-IN' }));
  for (const absent of ['Valid Until', 'Terms & Conditions', "Buyer's Order No.", 'Mode / Terms of Payment']) {
    assert.ok(!bare.includes(absent), `"${absent}" appears only once the business has filled it in`);
  }
  assert.ok(!bare.includes('Advance'), 'what the proforma was for is kept on the record, not printed');

  const filled = text(renderPreSale(
    toPreSalePrint(await issue('PROFORMA', { validUntil: on('2026-05-20'), terms: 'Prices ex-godown Karol Bagh.', buyerOrderNumber: 'PO-4471', paymentTerms: '100% advance' }), context()),
    snapshot,
    { format: 'A4', locale: 'en-IN' },
  ));
  assert.match(filled, /Valid Until 20 May 2026/);
  assert.match(filled, /Terms & Conditions Prices ex-godown Karol Bagh\./);
  assert.match(filled, /Buyer's Order No\. PO-4471/);
  assert.match(filled, /Mode \/ Terms of Payment 100% advance/);
});

test('the proforma says where to pay; the quotation does not ask for money', async () => {
  const proforma = text(renderPreSale(toPreSalePrint(await issue('PROFORMA'), context()), snapshot, { format: 'A4', locale: 'en-IN' }));
  assert.match(proforma, /Bank Details Bank Name State Bank of India A\/c No\. 30001234567 Branch & IFS Code Karol Bagh & SBIN0001234/);
  const quotation = text(renderPreSale(toPreSalePrint(await issue('QUOTATION'), context()), snapshot, { format: 'A4', locale: 'en-IN' }));
  assert.ok(!quotation.includes('Bank Details') && !quotation.includes('30001234567'), 'no bank details on a price offer');
});

test('an invoiced proforma shows the invoice it was billed on; a withdrawn one says so', async () => {
  const counter = await makeSalesCounter();
  const proforma = await counter.presale.issue(counter.actor, { kind: 'PROFORMA', idempotencyKey: 'p', input: crateOffer({ purpose: 'Advance' }) });
  const draft = await counter.till.service.createDraft(counter.till.actor, {
    idempotencyKey: 'bill',
    input: { partyId: ABC, customerType: 'B2B', supplyKind: 'GOODS', documentDate: on('2026-05-12'), lines: proforma.lines },
  });
  const final = (await counter.till.service.finalise(counter.till.actor, { idempotencyKey: 'bill-f', invoiceId: draft.id })).invoice;
  const linked = await counter.presale.linkInvoice(counter.actor, { proformaId: proforma.id, invoiceId: final.id });
  assert.match(text(renderPreSale(toPreSalePrint(linked, context()), snapshot, { format: 'A4', locale: 'en-IN' })), /Invoice No\. & Date INV\/KB\/2026-27\/00001, 12 May 2026/);

  const quotation = await counter.presale.issue(counter.actor, { kind: 'QUOTATION', idempotencyKey: 'q', input: crateOffer() });
  const withdrawn = await counter.presale.cancel(counter.actor, { id: quotation.id, reason: 'Customer bought elsewhere' });
  assert.match(text(renderPreSale(toPreSalePrint(withdrawn, context()), snapshot, { format: 'A4', locale: 'en-IN' })), /Not a tax invoice · CANCELLED/);
});

test('the invoice\'s Reference No. & Date box is filled from the quotation or proforma behind it', async () => {
  assert.deepEqual(invoiceReferencesFromPreSale([{ number: 'PI/26-27/00001', documentDate: on('2026-05-10'), state: 'INVOICED' }]), {
    referenceNumber: 'PI/26-27/00001',
    referenceDate: '2026-05-10',
  });
  assert.deepEqual(
    invoiceReferencesFromPreSale([
      { number: 'QTN/26-27/00004', documentDate: on('2026-05-02'), state: 'CONVERTED' },
      { number: 'PI/26-27/00001', documentDate: on('2026-05-10'), state: 'INVOICED' },
      { number: 'PI/26-27/00002', documentDate: on('2026-05-11'), state: 'CANCELLED' },
    ]),
    { referenceNumber: 'QTN/26-27/00004, PI/26-27/00001', referenceDate: null },
  );

  const counter = await makeSalesCounter();
  const quotation = await counter.presale.issue(counter.actor, { kind: 'QUOTATION', idempotencyKey: 'q', input: crateOffer() });
  const { invoice } = await counter.presale.convertToSale(counter.actor, { quotationId: quotation.id });
  const final = (await counter.till.service.finalise(counter.till.actor, { idempotencyKey: 'f', invoiceId: invoice.id })).invoice;
  const references = invoiceReferencesFromPreSale(await counter.presale.forInvoice(counter.actor, final.id));
  const visible = text(renderInvoice(
    toInvoiceDocument(final, { title: 'TAX_INVOICE', seller: SELLER, buyer: BUYER, placeOfSupplyStateName: 'Delhi', references }),
    snapshot,
    { format: 'A4', locale: 'en-IN' },
  ));
  assert.match(visible, /Reference No\. & Date QTN\/26-27\/00001, 10 May 2026/);
});

test('a buyer across a border is shown IGST and its place of supply; a ship-to address gets its own box', async () => {
  const doc = await issue('QUOTATION', { partyId: GURUGRAM });
  const visible = text(renderPreSale(
    toPreSalePrint(doc, context({
      buyer: { ...BUYER, name: 'Gurugram Fresh Mart', gstin: '06BBBBB1111B1ZR', stateCode: '06', stateName: 'Haryana' },
      shipTo: { name: 'Gurugram Fresh Mart godown', addressLines: ['Sector 37'], gstin: '06BBBBB1111B1ZR', stateCode: '06', stateName: 'Haryana' },
      placeOfSupplyStateName: 'Haryana',
    })),
    snapshot,
    { format: 'A4', locale: 'en-IN' },
  ));
  assert.match(visible, /IGST ₹1,512\.00/);
  assert.match(visible, /Place of Supply Haryana \(06\)/);
  assert.match(visible, /Consignee \(Ship to\) Gurugram Fresh Mart godown Sector 37/);
});

test('every shape prints, in Hindi too, and whatever a person typed is escaped', async () => {
  const doc = toPreSalePrint(await issue('PROFORMA', { terms: '<script>alert(1)</script>' }), context({ buyer: { ...BUYER, name: 'A&B <Traders>' } }));
  for (const format of ['A4', 'MOBILE', 'THERMAL_80MM', 'THERMAL_58MM'] as const) {
    const html = renderPreSale(doc, snapshot, { format, locale: 'en-IN' });
    assert.match(text(html), /Proforma Invoice/);
    assert.match(text(html), /Not a tax invoice/);
    assert.ok(!html.includes('<script>'), `${format}: typed text is escaped`);
    assert.match(html, /A&amp;B &lt;Traders&gt;/);
  }
  const hindi = text(renderPreSale(doc, snapshot, { format: 'A4', locale: 'hi-IN' }));
  assert.match(hindi, /Yeh tax invoice nahin hai/);
  assert.match(hindi, /Proforma invoice number/);
});

test('a line with a discount and a freight charge prints as it does on the invoice', async () => {
  const doc = await issue('QUOTATION', {
    freight: inr(500),
    lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: qty('40', 'PCS'), unitPrice: inr(210), priceBasis: 'EXCLUSIVE', discount: { kind: 'PERCENT', percentTimes100: 500n } }],
  });
  const visible = text(renderPreSale(toPreSalePrint(doc, context()), snapshot, { format: 'A4', locale: 'en-IN' }));
  assert.match(visible, /Sub Total/);
  assert.match(visible, /Freight/i);
  assert.match(visible, /7,980\.00/, '40 × ₹210 less 5%');
});
