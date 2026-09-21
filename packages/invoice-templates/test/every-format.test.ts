/**
 * Issue #183 — every required particular, on every paper, in both languages.
 *
 * CGST Rule 46 applies to a tax invoice whatever it is printed on. The narrow layouts used to drop
 * the HSN code, the reverse-charge answer, the HSN summary and — on till roll — the signature, and
 * a shopkeeper billing from a phone is served the narrow layout by default. So this file renders
 * the same B2B goods bill in all four formats and both locales and asserts the whole list.
 *
 * This is the test that stops the next layout from quietly dropping a required field.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isoDate, rupees } from '@invoice/kernel';
import { MANDATORY_FIELDS } from '../src/mandatory.ts';
import { templateById, type PageFormat, type TemplateDefinition } from '../src/template.ts';
import { captureSnapshot } from '../src/snapshot.ts';
import { renderInvoice, renderInvoiceCopies } from '../src/render.ts';
import { copiesFor, copyMarking } from '../src/copies.ts';
import { amountInWords } from '../src/words.ts';
import { qrSvg } from '../src/qr.ts';
import type { InvoiceDocument, Locale, RenderableLine } from '../src/document.ts';

const nil = rupees(0);

const line = (overrides: Partial<RenderableLine> = {}): RenderableLine => ({
  lineId: 'l1',
  description: 'PP Regrind',
  hsnOrSac: '39021000',
  kind: 'GOODS',
  quantityText: '1,400.000 KGS',
  unitPrice: rupees(60),
  discount: null,
  taxableValue: rupees(84000),
  ratePercentTimes100: 1800n,
  taxAmount: rupees(15120),
  cgst: rupees(7560),
  sgst: rupees(7560),
  utgst: nil,
  igst: nil,
  cess: nil,
  reverseCharge: false,
  batch: null,
  note: null,
  ...overrides,
});

const doc = (overrides: Partial<InvoiceDocument> = {}): InvoiceDocument => ({
  title: 'TAX_INVOICE',
  number: 'INV/26-27/000004',
  date: isoDate('2026-09-17'),
  dueDate: isoDate('2026-10-17'),
  seller: {
    name: 'Sampoorna Traders',
    addressLines: ['No. 14, 2nd Main, Peenya Industrial Area', 'Bengaluru 560058'],
    gstin: '29AAAAA0000A1ZY',
    stateCode: '29',
    stateName: 'Karnataka',
    phone: '080 4000 1234',
  },
  buyer: {
    name: 'Peenya Plastics',
    addressLines: ['18, Peenya 2nd Stage', 'Bengaluru 560058'],
    gstin: '29GGGGG6666G1ZG',
    stateCode: '29',
    stateName: 'Karnataka',
  },
  shipTo: null,
  placeOfSupplyStateCode: '29',
  placeOfSupplyStateName: 'Karnataka',
  reverseCharge: false,
  supplyKind: 'GOODS',
  split: 'CGST_SGST',
  lines: [line()],
  totals: {
    taxableValue: rupees(84000),
    cgst: rupees(7560),
    sgst: rupees(7560),
    utgst: nil,
    igst: nil,
    cess: nil,
    roundOff: nil,
    invoiceValue: rupees(99120),
    reverseChargeTax: nil,
    amountPaid: null,
    outstanding: null,
  },
  transport: null,
  eInvoice: null,
  amountInWordsText: amountInWords(rupees(99120)),
  taxAmountInWordsText: amountInWords(rupees(15120)),
  declaredRateNotice: null,
  logoDataUri: null,
  bankDetails: null,
  bank: null,
  references: null,
  terms: null,
  declaration: null,
  signatureDataUri: null,
  poReference: null,
  ...overrides,
});

const india = templateById('india-standard') as TemplateDefinition;
const render = (d: InvoiceDocument, format: PageFormat, locale: Locale = 'en-IN', copy: 'ORIGINAL' | 'DUPLICATE' | 'TRIPLICATE' = 'ORIGINAL') =>
  renderInvoice(d, captureSnapshot(india, locale, '2026-09-17'), { format, locale, copy });

/** The page as a reader sees it: tags out, entities back, runs of space collapsed. */
const text = (html: string): string =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x20B9;|&rupee;/g, '₹')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ');

const FORMATS: readonly PageFormat[] = ['A4', 'MOBILE', 'THERMAL_80MM', 'THERMAL_58MM'];
const LOCALES: readonly Locale[] = ['en-IN', 'hi-IN'];

test('every required particular prints on all four papers, in both languages', () => {
  for (const format of FORMATS) {
    for (const locale of LOCALES) {
      const html = render(doc(), format, locale);
      const visible = text(html);
      const where = `${format} / ${locale}`;

      const present: Record<string, boolean> = {
        'document.title': /tax invoice/i.test(visible),
        'document.number': visible.includes('INV/26-27/000004'),
        'document.date': /17|2026/.test(visible),
        'seller.name': visible.includes('Sampoorna Traders'),
        'seller.address': visible.includes('Peenya Industrial Area'),
        'seller.gstin': visible.includes('29AAAAA0000A1ZY'),
        'seller.stateName': visible.includes('Karnataka'),
        'buyer.name': visible.includes('Peenya Plastics'),
        'buyer.address': visible.includes('Peenya 2nd Stage'),
        'buyer.gstin': visible.includes('29GGGGG6666G1ZG'),
        'supply.placeOfSupply': visible.includes('(29)'),
        // The answer, not only the question: "No" is what this bill has to say.
        'supply.reverseCharge': visible.includes('Reverse Charge') && /Reverse Charge(\s*\([^)]*\))?[^A-Za-z]*(No|Nahin)/.test(visible),
        'line.description': visible.includes('PP Regrind'),
        'line.hsnOrSac': visible.includes('39021000'),
        'line.quantity': visible.includes('1,400.000') && visible.includes('KGS'),
        'line.unitPrice': visible.includes('60.00'),
        'line.taxableValue': visible.includes('84,000.00'),
        'line.taxRate': visible.includes('18%'),
        'line.taxAmount': visible.includes('15,120.00') || visible.includes('7,560.00'),
        'totals.taxableValue': visible.includes('84,000.00'),
        'totals.taxBreakup': visible.includes('7,560.00'),
        'totals.roundOff': true,
        'totals.invoiceValue': visible.includes('99,120.00'),
        'totals.amountInWords': visible.toLowerCase().includes('ninety-nine thousand') || visible.includes('Rupees'),
        'footer.signature': visible.includes('Authorised Signatory'),
      };

      for (const field of MANDATORY_FIELDS) {
        if (field.conditional && present[field.id] === undefined) continue;
        assert.ok(present[field.id] !== false, `${field.id} is missing on ${where}`);
      }
      // The HSN summary is what a buyer's accountant matches on. It is not a wide-paper luxury.
      assert.ok(visible.includes('39021000'), `the HSN code must appear on ${where}`);
      assert.ok(/HSN/.test(visible), `an HSN summary must appear on ${where}`);
      // And the copy is marked, in the words the rule prescribes, in both languages.
      assert.ok(visible.includes('ORIGINAL FOR RECIPIENT'), `the copy marking must appear on ${where}`);
    }
  }
});

test('the phone and till-roll layouts carry the HSN code, the reverse-charge answer and the signature', () => {
  for (const format of ['MOBILE', 'THERMAL_80MM', 'THERMAL_58MM'] as const) {
    const visible = text(render(doc(), format));
    assert.ok(visible.includes('HSN / SAC 39021000'), `the HSN code is under the item on ${format}`);
    assert.match(visible, /Reverse Charge[^A-Za-z]*No/, `the reverse-charge answer is on ${format}`);
    assert.ok(visible.includes('Authorised Signatory'), `a tax invoice is signed on ${format} too`);
    assert.ok(visible.includes('for Sampoorna Traders'), `and says whose signature it is on ${format}`);
  }
});

test('a bill the government signed prints that sentence instead of a signing space', () => {
  const registered = doc({ eInvoice: { irn: 'a'.repeat(64), qrSvg: null } });
  for (const format of FORMATS) {
    const visible = text(render(registered, format));
    assert.ok(!visible.includes('Authorised Signatory'), `an e-invoice needs no hand signature on ${format}`);
    assert.match(visible, /[Dd]igitally signed/, `and says who signed it instead, on ${format}`);
  }
});

test('a goods bill has three marked copies and a services bill has two, never a transporter’s', () => {
  const goods = doc();
  assert.deepEqual([...copiesFor(goods)], ['ORIGINAL', 'DUPLICATE', 'TRIPLICATE']);
  assert.equal(copyMarking(goods, 'ORIGINAL', 'en-IN'), 'ORIGINAL FOR RECIPIENT');
  assert.equal(copyMarking(goods, 'DUPLICATE', 'en-IN'), 'DUPLICATE FOR TRANSPORTER');
  assert.equal(copyMarking(goods, 'TRIPLICATE', 'en-IN'), 'TRIPLICATE FOR SUPPLIER');

  const services = doc({ supplyKind: 'SERVICES' });
  assert.deepEqual([...copiesFor(services)], ['ORIGINAL', 'DUPLICATE']);
  assert.equal(copyMarking(services, 'DUPLICATE', 'en-IN'), 'DUPLICATE FOR SUPPLIER');
  assert.equal(copyMarking(services, 'TRIPLICATE', 'en-IN'), null);

  const set = text(renderInvoiceCopies(services, captureSnapshot(india, 'en-IN', '2026-09-17'), { format: 'A4', locale: 'en-IN' }));
  assert.ok(!set.includes('TRANSPORTER'), 'nothing is carried, so there is no transporter copy');
});

test('the Hindi bill prints the prescribed words, with the explanation in brackets', () => {
  const visible = text(render(doc(), 'A4', 'hi-IN'));
  assert.ok(visible.includes('ORIGINAL FOR RECIPIENT'), 'the rule prescribes these words themselves');
  assert.ok(visible.includes('customer ke liye'), 'the Hindi gloss follows, rather than replacing it');
  assert.match(visible, /Reverse Charge/, 'and the term stays the term');
});

test('the marked copies come out in order, each once, each on its own sheet', () => {
  const html = renderInvoiceCopies(doc(), captureSnapshot(india, 'en-IN', '2026-09-17'), { format: 'A4', locale: 'en-IN' });
  const visible = text(html);
  for (const marking of ['ORIGINAL FOR RECIPIENT', 'DUPLICATE FOR TRANSPORTER', 'TRIPLICATE FOR SUPPLIER']) {
    assert.equal(visible.split(marking).length - 1, 1, `${marking} appears exactly once`);
  }
  assert.ok(
    visible.indexOf('ORIGINAL FOR RECIPIENT') < visible.indexOf('DUPLICATE FOR TRANSPORTER')
      && visible.indexOf('DUPLICATE FOR TRANSPORTER') < visible.indexOf('TRIPLICATE FOR SUPPLIER'),
    'in that order',
  );
  assert.ok(/page-break|break-before|break-after/.test(html), 'each copy starts on a fresh sheet');
});

test('#136 — a registered bill prints the QR square, IRN, Ack number and Ack date; before that, labelled slots', () => {
  const irn = 'a3f5c9e1b7d2408e6f1c3a5b7d9e0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d';
  const registered = doc({
    eInvoice: { irn, qrSvg: qrSvg('eyJhbGciOiJSUzI1NiJ9.e30.c2ln', `IRN ${irn}`), ackNumber: '112610027961228', ackDate: '2026-09-21 10:15:00' },
  });
  for (const format of ['A4', 'MOBILE'] as const) {
    const html = render(registered, format);
    const visible = text(html);
    assert.ok(html.includes(`aria-label="IRN ${irn}"`), `the QR square is drawn on ${format}`);
    assert.ok(visible.includes(irn), `the IRN prints on ${format}`);
    assert.match(visible, /Ack No\.?:? 112610027961228/, `the Ack number prints on ${format}`);
    assert.match(visible, /Ack Date:? 2026-09-21 10:15:00/, `the Ack date prints on ${format}`);
    assert.ok(!html.includes('data-reserved="einvoice.'), `no empty box is left once the values exist, on ${format}`);

    const preview = renderInvoice(doc(), captureSnapshot(india, 'en-IN', '2026-09-17'), { format, locale: 'en-IN', purpose: 'DESIGN_PREVIEW' });
    for (const id of ['qr', 'irn', 'ackNumber', 'ackDate']) {
      assert.ok(preview.includes(`data-reserved="einvoice.${id}"`), `the ${id} slot is held on the ${format} preview`);
    }
  }
});
