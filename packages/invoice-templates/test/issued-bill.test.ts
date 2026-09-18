/**
 * Issue #189 — an issued bill carries only real things.
 *
 * Every bill used to print "Government QR, not received yet", "UPI id not saved yet" and "Signature
 * not uploaded yet" on the page the customer receives. The labelled boxes now belong to the design
 * preview, and an issued bill keeps the space without the words.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isoDate, rupees, type Money } from '@invoice/kernel';
import { captureSnapshot } from '../src/snapshot.ts';
import { renderInvoice } from '../src/render.ts';
import { templateById, type PageFormat, type TemplateDefinition } from '../src/template.ts';
import { amountInWords } from '../src/words.ts';
import { RESERVED_SLOTS } from '../src/reserved.ts';
import type { InvoiceDocument } from '../src/document.ts';

const nil: Money = rupees(0);

const doc = (overrides: Partial<InvoiceDocument> = {}): InvoiceDocument => ({
  title: 'TAX_INVOICE',
  number: 'INV/26-27/000042',
  date: isoDate('2026-08-20'),
  dueDate: null,
  seller: { name: 'Sharma Fruit Traders', addressLines: ['12/4, Ajmal Khan Road'], gstin: '07AAAAA0000A1Z4', stateCode: '07', stateName: 'Delhi' },
  buyer: { name: 'ABC Traders', addressLines: ['Shop 8, Azadpur Mandi'], gstin: '07DDDDD3333D1ZV', stateCode: '07', stateName: 'Delhi' },
  shipTo: null,
  placeOfSupplyStateCode: '07',
  placeOfSupplyStateName: 'Delhi',
  reverseCharge: false,
  supplyKind: 'GOODS',
  split: 'CGST_SGST',
  lines: [
    {
      lineId: 'l1', description: 'Plastic crate', hsnOrSac: '3923', kind: 'GOODS', quantityText: '40 PCS',
      unitPrice: rupees(210), discount: null, taxableValue: rupees(8400), ratePercentTimes100: 1800n,
      taxAmount: rupees(1512), cgst: rupees(756), sgst: rupees(756), utgst: nil, igst: nil, cess: nil,
      reverseCharge: false, batch: null, note: null,
    },
  ],
  totals: {
    taxableValue: rupees(8400), cgst: rupees(756), sgst: rupees(756), utgst: nil, igst: nil, cess: nil,
    roundOff: nil, invoiceValue: rupees(9912), reverseChargeTax: nil, amountPaid: null, outstanding: null,
  },
  transport: null,
  eInvoice: null,
  amountInWordsText: amountInWords(rupees(9912)),
  taxAmountInWordsText: amountInWords(rupees(1512)),
  declaredRateNotice: null,
  logoDataUri: null,
  bankDetails: null,
  bank: null,
  upiId: 'sharma.fruits@okicici',
  references: null,
  terms: null,
  declaration: null,
  signatureDataUri: null,
  poReference: null,
  ...overrides,
});

/** Both page styles — the ruled grid and the airy page — with every reserved slot switched on. */
const india = templateById('india-standard') as TemplateDefinition;
const designs = [india, { ...india, layout: 'AIRY' as const }].map((template) => {
  return captureSnapshot(
    { ...template, optionalFields: [...new Set([...template.optionalFields, 'qr.upi', 'qr.eInvoice'])] },
    'en-IN',
    '2026-09-18',
  );
});

const issued = (d: InvoiceDocument, format: PageFormat = 'A4') =>
  designs.map((snapshot) => renderInvoice(d, snapshot, { format, locale: 'en-IN' }));

const NOT_YET = ['not received yet', 'not saved yet', 'not uploaded yet'];

test('#189 — a small business: the issued bill has no "not yet" sentence and no e-invoice block', () => {
  const small = doc({ upiId: null, signatureDataUri: null, eInvoice: null });
  for (const format of ['A4', 'MOBILE'] as const) {
    for (const html of issued(small, format)) {
      for (const words of NOT_YET) assert.ok(!html.includes(words), `${format}: "${words}" must not be on a customer's bill`);
      // The page's own style sheet mentions an IRN in a comment; only what prints is checked.
      const printed = html.replace(/<style[\s\S]*?<\/style>/g, '');
      assert.ok(!printed.includes('IRN'), `${format}: a bill that will never be registered says nothing about registration`);
      assert.ok(!html.includes('data-reserved="einvoice.'), `${format}: and keeps no space for it`);
      assert.ok(html.includes('Authorised Signatory'), `${format}: the signature line is required by law and stays`);
    }
  }
});

test('#189 — a large business waiting for the government: a blank 26 × 26 mm area, no words', () => {
  const waiting = doc({ upiId: null, eInvoice: null, eInvoiceExpected: true });
  for (const html of issued(waiting)) {
    assert.ok(!html.includes('not received yet'));
    const box = /<div class="reserved-blank" data-reserved="einvoice\.qr" style="width:26mm;height:26mm">(.*?)<\/div>/.exec(html);
    assert.ok(box !== null, 'the e-invoice area is held at its final size');
    assert.equal(box[1], '', 'with nothing written in it');
  }
});

test('#189 — the design preview still shows every labelled box, as #148 built it', () => {
  const blank = doc({ upiId: null, signatureDataUri: null, eInvoice: null });
  const [boxed, airy] = designs.map((snapshot) =>
    renderInvoice(blank, snapshot, { format: 'A4', locale: 'en-IN', purpose: 'DESIGN_PREVIEW' }),
  ) as [string, string];
  for (const spec of RESERVED_SLOTS) {
    // The airy page has never had a signature box; its signing line is plain text.
    const pages = spec.id === 'signature' ? [boxed] : [boxed, airy];
    for (const html of pages) assert.ok(html.includes(spec.label['en-IN']), `${spec.id} is labelled on the preview`);
  }
});

test('#189 — a registered e-invoice prints in the same place, at the same size', () => {
  const registered = doc({ eInvoice: { irn: 'a'.repeat(64), qrSvg: '<svg role="img"><rect/></svg>' } });
  for (const html of issued(registered)) {
    assert.ok(html.includes('<svg role="img">'), 'the government\'s code is printed as given');
    assert.ok(html.includes('a'.repeat(64)), 'with its reference number');
    assert.match(html, /\.qr-slot \{[^}]*width: 26mm/, 'in a 26 mm square, the size of the blank area above');
    for (const words of NOT_YET) assert.ok(!html.includes(words));
  }
});

test('#189 — a UPI id, once saved, puts the square back on an issued bill', () => {
  for (const html of issued(doc({ upiId: 'sharma.fruits@okicici' }))) {
    assert.ok(html.includes('data-upi="sharma.fruits@okicici"'));
  }
});
