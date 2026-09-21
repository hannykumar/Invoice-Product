/**
 * Issue #144 acceptance criteria, enforced automatically.
 *
 *  - "A business can save its UPI id once" — a UPI id no app could pay to is refused.
 *  - "The bill prints a UPI QR carrying the payee, the invoice number and the exact amount due."
 *  - "Before a UPI id is saved, the bill shows a bordered, labelled reserved slot."
 *  - "The square is omitted on 58 mm paper, and on any bill with nothing due."
 *
 * The QR drawing itself was checked against an independent reader (jsQR) for every text length a
 * version 1 to 15 square holds; the square fixed below is one of those, so any change to the drawing
 * that would make a phone read something else fails here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DomainError, isoDate, rupees, type Money } from '@invoice/kernel';
import { captureSnapshot } from '../src/snapshot.ts';
import { renderInvoice } from '../src/render.ts';
import { SHIPPED_TEMPLATES, templateById, type PageFormat, type TemplateDefinition } from '../src/template.ts';
import { amountInWords } from '../src/words.ts';
import { encodeQr, MAX_QR_BYTES } from '../src/qr.ts';
import { amountDue, upiPaymentLink, validateUpiId } from '../src/upi.ts';
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

const india = templateById('india-standard') as TemplateDefinition;
const render = (d: InvoiceDocument, format: PageFormat = 'A4', template: TemplateDefinition = india) =>
  renderInvoice(d, captureSnapshot(template, 'en-IN', '2026-09-13'), { format, locale: 'en-IN' });

const matrixHash = (text: string): string =>
  createHash('sha256').update(encodeQr(text).map((r) => r.map((d) => (d ? '1' : '0')).join('')).join('\n')).digest('hex');

test('a UPI id is saved in the form every app reads, and a mistyped one is refused', () => {
  assert.equal(validateUpiId('  Sharma.Fruits@OKICICI '), 'sharma.fruits@okicici');
  assert.equal(validateUpiId('9876543210@ybl'), '9876543210@ybl');
  for (const wrong of ['', 'sharmafruits', 'sharma fruits@okicici', '@okicici', 'sharma@', 'sharma@ok icici', 'a@b@c']) {
    assert.throws(() => validateUpiId(wrong), (e: unknown) => e instanceof DomainError, `"${wrong}" must be refused`);
  }
});

test('the square carries the payee, the bill number and the exact amount, and reads back as that', () => {
  const link = upiPaymentLink('Sharma.Fruits@OKICICI', 'Sharma Fruit Traders', rupees(9912), 'INV/26-27/000042');
  assert.equal(link, 'upi://pay?pa=sharma.fruits@okicici&pn=Sharma%20Fruit%20Traders&am=9912.00&cu=INR&tn=INV%2F26-27%2F000042');
  // This exact square was read back by an independent QR reader as the link above.
  assert.equal(encodeQr(link).length, 41, 'a 41-module square, which is 0.6 mm a module at 26 mm');
  assert.equal(matrixHash(link), 'ba1ee94788d622d0150b43ed024f12545eb1d014ac20cc6fb3f517c1b3f18789');
});

test('the square has the three corner targets a phone camera locks on to', () => {
  const m = encodeQr('upi://pay?pa=a1@ybl&am=1.00&cu=INR');
  const size = m.length;
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let d = -3; d <= 3; d++) {
      assert.equal(m[cy - 3]![cx + d], true, 'outer ring is dark');
      assert.equal(m[cy + d]![cx]!, Math.abs(d) !== 2, 'dark, light ring, dark centre');
    }
  }
});

test('text too long for a square is refused, never cut short', () => {
  assert.throws(() => encodeQr('x'.repeat(MAX_QR_BYTES + 1)), /too long/);
  assert.doesNotThrow(() => encodeQr('x'.repeat(MAX_QR_BYTES)));
});

test('the amount asked for is what is still due, not the bill total', () => {
  assert.equal(amountDue(doc()).minor, rupees(9912).minor);
  const partlyPaid = doc({ totals: { ...doc().totals, amountPaid: rupees(4000), outstanding: null } });
  assert.equal(amountDue(partlyPaid).minor, rupees(5912).minor);
  const html = render(partlyPaid);
  const link = upiPaymentLink('sharma.fruits@okicici', 'Sharma Fruit Traders', rupees(5912), 'INV/26-27/000042');
  assert.ok(html.includes(`data-upi="sharma.fruits@okicici"`));
  assert.ok(html.includes(`<svg`) && html.includes('UPI payment to sharma.fruits@okicici'));
  // The square on the page is exactly the square for ₹5,912.00, not for ₹9,912.00.
  const path = (text: string) => {
    let p = '';
    encodeQr(text).forEach((row, y) => row.forEach((dark, x) => { if (dark) p += `M${x + 4} ${y + 4}h1v1h-1z`; }));
    return p;
  };
  assert.ok(html.includes(path(link)));
  assert.ok(!html.includes(path(link.replace('5912.00', '9912.00'))));
});

test('with a UPI id saved, the boxed bill prints the square beside the bank details, with the id under it', () => {
  const html = render(doc());
  assert.ok(html.includes('class="upi-cell"'));
  assert.ok(html.includes('Scan to pay by UPI'));
  assert.ok(html.includes('UPI ID: sharma.fruits@okicici'));
  assert.ok(!html.includes('data-reserved="upi.qr"'), 'no empty box once the real square is there');
});

test('before a UPI id is saved, the design preview keeps a labelled box at the square’s size', () => {
  const preview = (d: InvoiceDocument, format: PageFormat = 'A4') =>
    renderInvoice(d, captureSnapshot(india, 'en-IN', '2026-09-13'), { format, locale: 'en-IN', purpose: 'DESIGN_PREVIEW' });
  const html = preview(doc({ upiId: null }));
  assert.ok(html.includes('data-reserved="upi.qr"'));
  assert.ok(html.includes('Pay by scan, UPI id not saved yet'));
  assert.ok(html.includes('width:26mm;height:26mm'));
  assert.ok(!html.includes('Scan to pay by UPI'), 'the bill does not invite a scan it cannot take');
  assert.ok(preview(doc({ upiId: null }), 'MOBILE').includes('data-reserved="upi.qr"'));
});

test('#189 — an issued bill with no UPI id has no square and no box', () => {
  for (const format of ['A4', 'MOBILE'] as const) {
    const html = render(doc({ upiId: null }), format);
    assert.ok(!html.includes('data-reserved="upi.qr"'), format);
    assert.ok(!html.includes('not saved yet'), format);
    assert.ok(!html.includes('Scan to pay by UPI'), format);
  }
});

test('no square, and no empty box, on a bill with nothing left to pay or on a credit note', () => {
  const paid = doc({ totals: { ...doc().totals, amountPaid: rupees(9912), outstanding: rupees(0) } });
  for (const d of [paid, doc({ ...paid, upiId: null }), doc({ title: 'CREDIT_NOTE' }), doc({ title: 'CREDIT_NOTE', upiId: null })]) {
    for (const format of ['A4', 'MOBILE', 'THERMAL_80MM'] as const) {
      const html = render(d, format);
      assert.ok(!html.includes('class="upi-square"') && !html.includes('data-reserved="upi.qr"'), `${d.title} on ${format}`);
    }
  }
});

test('no square on 58 mm till roll; on 80 mm it prints once the id is saved, but no empty box does', () => {
  for (const template of SHIPPED_TEMPLATES.filter((t) => t.formats.includes('THERMAL_58MM'))) {
    const html = render(doc(), 'THERMAL_58MM', template);
    assert.ok(!html.includes('class="upi-square"') && !html.includes('data-reserved="upi.qr"'), template.id);
  }
  const counter = templateById('counter-thermal') as TemplateDefinition;
  assert.ok(render(doc(), 'THERMAL_80MM', counter).includes('class="upi-square"'));
  assert.ok(!render(doc({ upiId: null }), 'THERMAL_80MM', counter).includes('data-reserved="upi.qr"'));
});

test('every shipped design carries the square, and a bill saved before this change reprints unchanged', () => {
  for (const template of SHIPPED_TEMPLATES) assert.ok(template.optionalFields.includes('qr.upi'), template.id);
  const before = captureSnapshot(india, 'en-IN', '2026-09-01');
  const oldSnapshot = { ...before, templateVersion: '1.0.0', optionalFields: before.optionalFields.filter((f) => f !== 'qr.upi') };
  const html = renderInvoice(doc(), oldSnapshot, { format: 'A4', locale: 'en-IN' });
  assert.ok(!html.includes('class="upi-cell"'), 'the snapshot decides, so an old bill does not grow a square');
});

/**
 * Issue #136 — the government's signed e-invoice QR is a signed token of about a thousand
 * characters. The squares used to stop at 412 bytes, so a real one would have stopped the bill
 * printing. This synthetic token has the real one's shape and length; the pinned square below was
 * read back by an independent reader (zxing-cpp) as exactly this text.
 */
const b64 = (s: string | Buffer): string => Buffer.from(s).toString('base64url');
const SYNTHETIC_SIGNED_QR = [
  b64('{"alg":"RS256","kid":"B8BE5B1A2C4D6E8F0A1B2C3D4E5F6A7B8C9D0E1F","typ":"JWT","x5t":"uL5bGixNbo8KGyw9Tl9qe4ydDh8"}'),
  b64(JSON.stringify({
    data: JSON.stringify({
      SellerGstin: '27AAPFU0939F1ZV', BuyerGstin: '29AAGCB7383J1Z4', DocNo: 'INV/26-27/000042', DocTyp: 'INV',
      DocDt: '21/09/2026', TotInvVal: 99120, ItemCnt: 3, MainHsnCode: '39021000',
      Irn: 'a3f5c9e1b7d2408e6f1c3a5b7d9e0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d', IrnDt: '2026-09-21 10:15:00',
    }),
    iss: 'NIC Sandbox',
  })),
  b64(Buffer.from(Array.from({ length: 256 }, (_, i) => (i * 37 + 11) % 256))),
].join('.');

test('the government signed QR, a thousand-character token, draws as one readable square', () => {
  assert.ok(SYNTHETIC_SIGNED_QR.length > 900, `${SYNTHETIC_SIGNED_QR.length} characters, as long as a real one`);
  const m = encodeQr(SYNTHETIC_SIGNED_QR);
  assert.ok(m.length > 77, 'larger than the old version-15 limit');
  assert.equal(matrixHash(SYNTHETIC_SIGNED_QR), '772b75748a8bc789e006a150be473170f48c6c37de8681c43aa34df57c832e1c');
});
