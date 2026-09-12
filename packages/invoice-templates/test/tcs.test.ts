/**
 * Issue #145 — what tax collected at source looks like on the printed bill.
 *
 * Two things have to be true on the paper, not just in the books: the amount stands on a line of
 * its own so nobody reads it as GST, and the bill says why it is there. A customer who is charged
 * an extra amount with no explanation queries the bill, and the business loses a day to it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isoDate, rupees, type Money } from '@invoice/kernel';
import { captureSnapshot } from '../src/snapshot.ts';
import { renderInvoice } from '../src/render.ts';
import { templateById, SHIPPED_TEMPLATES, type TemplateDefinition } from '../src/template.ts';
import { amountInWords } from '../src/words.ts';
import type { InvoiceDocument, RenderableLine } from '../src/document.ts';

const nil: Money = rupees(0);

const NOTICE =
  'Sales to this customer in 2026-27 have crossed ₹50,00,000. TCS of 0.10% has been collected on ₹9,00,000 of this bill and will be paid to the government.';

const line: RenderableLine = {
  lineId: 'l1',
  description: 'Plastic crate',
  hsnOrSac: '3923',
  kind: 'GOODS',
  quantityText: '5000 PCS',
  unitPrice: rupees(1000),
  discount: null,
  taxableValue: rupees(5000000),
  ratePercentTimes100: 1800n,
  taxAmount: rupees(900000),
  cgst: rupees(450000),
  sgst: rupees(450000),
  utgst: nil,
  igst: nil,
  cess: nil,
  reverseCharge: false,
  batch: null,
  note: null,
};

const doc = (withTcs: boolean): InvoiceDocument => ({
  title: 'TAX_INVOICE',
  number: 'INV/26-27/000042',
  date: isoDate('2026-04-10'),
  dueDate: null,
  seller: {
    name: 'Sharma Fruit Traders',
    addressLines: ['12/4, Ajmal Khan Road', 'Karol Bagh, New Delhi 110005'],
    gstin: '07AAAAA0000A1Z4',
    stateCode: '07',
    stateName: 'Delhi',
  },
  buyer: {
    name: 'ABC Traders',
    addressLines: ['Shop 8, Azadpur Mandi'],
    gstin: '07DDDDD3333D1ZV',
    stateCode: '07',
    stateName: 'Delhi',
  },
  shipTo: null,
  placeOfSupplyStateCode: '07',
  placeOfSupplyStateName: 'Delhi',
  reverseCharge: false,
  supplyKind: 'GOODS',
  split: 'CGST_SGST',
  lines: [line],
  totals: {
    taxableValue: rupees(5000000),
    cgst: rupees(450000),
    sgst: rupees(450000),
    utgst: nil,
    igst: nil,
    cess: nil,
    roundOff: nil,
    tcs: withTcs ? rupees(900) : nil,
    invoiceValue: withTcs ? rupees(5900900) : rupees(5900000),
    reverseChargeTax: nil,
    amountPaid: null,
    outstanding: null,
  },
  transport: null,
  eInvoice: null,
  taxAmountInWordsText: amountInWords(rupees(900000)),
  declaration: null,
  signatureDataUri: null,
  amountInWordsText: amountInWords(withTcs ? rupees(5900900) : rupees(5900000)),
  declaredRateNotice: null,
  tcsNotice: withTcs ? NOTICE : null,
  logoDataUri: null,
  bankDetails: null,
  bank: null,
  references: null,
  terms: null,
  poReference: null,
});

const snapshotOf = (t: TemplateDefinition) => captureSnapshot(t, 'en-IN', '2026-04-10');

test('every shipped design prints the collected amount and says why it was collected', () => {
  for (const template of SHIPPED_TEMPLATES) {
    const html = renderInvoice(doc(true), snapshotOf(template), { format: 'A4', locale: 'en-IN' });
    assert.match(html, />TCS</, `${template.id} does not label the collected amount`);
    assert.ok(html.includes('9,00,900.00'), `${template.id} does not show the total including it`);
    assert.ok(html.includes('900.00'), `${template.id} does not show the collected amount`);
  }
});

test('the note naming the customer threshold is printed', () => {
  const html = renderInvoice(doc(true), snapshotOf(templateById('india-standard') as TemplateDefinition), {
    format: 'A4',
    locale: 'en-IN',
  });
  assert.ok(html.includes('crossed ₹50,00,000'), 'the bill must say which threshold was crossed');
  assert.ok(html.includes('₹9,00,000 of this bill'), 'the bill must say what was charged on');
});

test('a bill with nothing collected carries no line for it and no note', () => {
  for (const template of SHIPPED_TEMPLATES) {
    const html = renderInvoice(doc(false), snapshotOf(template), { format: 'A4', locale: 'en-IN' });
    assert.doesNotMatch(html, />TCS</, `${template.id} prints an empty line for it`);
    assert.ok(!html.includes('crossed'), `${template.id} prints the note when nothing was collected`);
  }
});
