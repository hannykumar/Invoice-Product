/**
 * Issue #13 [E13] acceptance criteria, enforced automatically.
 *
 *  - "Required fields cannot be removed"
 *  - "Layouts remain readable from 1 to 100 items"
 *  - "Old invoices preserve their original template"
 *
 * plus the required long-item, multilingual-font and QR tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, isoDate, rupees, quantityFromString } from '@invoice/kernel';
import { MANDATORY_FIELDS, MANDATORY_FIELD_IDS, OPTIONAL_FIELDS } from '../src/mandatory.ts';
import { SHIPPED_TEMPLATES, recommendTemplates, templateById, validateTemplate, type TemplateDefinition } from '../src/template.ts';
import { captureSnapshot } from '../src/snapshot.ts';
import { escapeHtml, renderInvoice } from '../src/render.ts';
import { amountInWords } from '../src/words.ts';
import type { InvoiceDocument, RenderableLine } from '../src/document.ts';

const line = (overrides: Partial<RenderableLine> = {}): RenderableLine => ({
  lineId: 'l1',
  description: 'Plastic crate',
  hsnOrSac: '3923',
  quantityText: '40 PCS',
  unitPrice: rupees(210),
  discount: null,
  taxableValue: rupees(8400),
  ratePercentTimes100: 1800n,
  taxAmount: rupees(1512),
  cess: rupees(0),
  reverseCharge: false,
  batch: 'B-1',
  note: 'handle with care',
  ...overrides,
});

const doc = (overrides: Partial<InvoiceDocument> = {}): InvoiceDocument => ({
  title: 'TAX_INVOICE',
  number: 'INV/KB/2026-27/00042',
  date: isoDate('2026-08-20'),
  dueDate: isoDate('2026-09-19'),
  seller: {
    name: 'Sharma Fruit Traders',
    addressLines: ['12/4, Ajmal Khan Road', 'Karol Bagh, New Delhi 110005'],
    gstin: '07AAAAA0000A1Z4',
    stateCode: '07',
    stateName: 'Delhi',
    phone: '011 4000 1234',
  },
  buyer: {
    name: 'ABC Traders',
    addressLines: ['Shop 8, Azadpur Mandi'],
    gstin: '07DDDDD3333D1ZV',
    stateCode: '07',
    stateName: 'Delhi',
  },
  placeOfSupplyStateCode: '07',
  placeOfSupplyStateName: 'Delhi',
  reverseCharge: false,
  split: 'CGST_SGST',
  lines: [line()],
  totals: {
    taxableValue: rupees(8400),
    cgst: rupees(756),
    sgst: rupees(756),
    utgst: rupees(0),
    igst: rupees(0),
    cess: rupees(0),
    roundOff: rupees(0),
    invoiceValue: rupees(9912),
    reverseChargeTax: rupees(0),
    amountPaid: null,
    outstanding: null,
  },
  transport: null,
  eInvoice: null,
  amountInWordsText: amountInWords(rupees(9912)),
  declaredRateNotice: null,
  logoDataUri: null,
  bankDetails: null,
  terms: null,
  poReference: null,
  ...overrides,
});

const wholesale = templateById('wholesale-classic') as TemplateDefinition;
const snapshotOf = (t: TemplateDefinition) => captureSnapshot(t, 'en-IN', '2026-08-29');

test('a template cannot remove, add or rename a legally required field', () => {
  for (const mandatory of MANDATORY_FIELDS.slice(0, 6)) {
    assert.throws(
      () => validateTemplate({ ...wholesale, optionalFields: [mandatory.id] }),
      (e: unknown) => e instanceof DomainError && e.code === 'TEMPLATE_TOUCHES_MANDATORY_FIELD',
      `${mandatory.id} must be untouchable`,
    );
  }
  // And there is no overlap between the two lists at all.
  const overlap = OPTIONAL_FIELDS.filter((f) => MANDATORY_FIELD_IDS.has(f));
  assert.deepEqual(overlap, []);
});

test('the required section is printed whatever the template says', () => {
  // A template that shows nothing optional at all.
  const bare: TemplateDefinition = { ...wholesale, optionalFields: [], lineColumns: [] };
  validateTemplate(bare);
  const html = renderInvoice(doc(), snapshotOf(bare), { format: 'A4', locale: 'en-IN' });

  for (const needle of [
    'Tax invoice',
    'INV/KB/2026-27/00042',
    '20 August 2026',
    'Sharma Fruit Traders',
    '07AAAAA0000A1Z4',
    'ABC Traders',
    '07DDDDD3333D1ZV',
    'This sale counts in',
    'Plastic crate',
    '3923',
    '40 PCS',
    'Taxable value',
    'CGST',
    'SGST',
    'Total to pay',
    'In words',
  ]) {
    assert.ok(html.includes(needle), `the bill must always show "${needle}"`);
  }
});

test('each tax is shown separately, never lumped into one figure', () => {
  const interState = doc({
    split: 'IGST',
    totals: { ...doc().totals, cgst: rupees(0), sgst: rupees(0), igst: rupees(1512) },
  });
  const html = renderInvoice(interState, snapshotOf(wholesale), { format: 'A4', locale: 'en-IN' });
  assert.ok(html.includes('IGST'));
  assert.ok(!html.includes('>CGST<'), 'an inter-state bill must not print a CGST row');

  const unionTerritory = doc({
    split: 'CGST_UTGST',
    totals: { ...doc().totals, sgst: rupees(0), utgst: rupees(756) },
  });
  const utHtml = renderInvoice(unionTerritory, snapshotOf(wholesale), { format: 'A4', locale: 'en-IN' });
  assert.ok(utHtml.includes('UTGST'));
  assert.ok(!utHtml.includes('>SGST<'));
});

test('the layout holds from one item to a hundred', () => {
  for (const count of [1, 2, 25, 100]) {
    const lines = Array.from({ length: count }, (_unused, i) => line({ lineId: `l${i}`, description: `Item ${i + 1}` }));
    const html = renderInvoice(doc({ lines }), snapshotOf(wholesale), { format: 'A4', locale: 'en-IN' });

    const rows = html.split('<tr>').length - 1;
    assert.ok(rows >= count, `${count} items must produce at least ${count} rows`);
    assert.ok(html.includes('<thead>'), 'the column headings must exist');
    assert.ok(html.includes('display: table-header-group'), 'headings must repeat on every printed page');
    assert.ok(html.includes('page-break-inside: avoid'), 'a row must not be split across two pages');
    assert.ok(html.includes(`Item ${count}`), 'the last item must actually be printed');
    assert.ok(!html.includes('overflow: hidden'), 'nothing may be clipped away');
  }
});

test('a narrow paper prints a list, not a nine-column table', () => {
  const lines = Array.from({ length: 12 }, (_unused, i) => line({ lineId: `l${i}`, description: `Item ${i + 1}` }));
  for (const format of ['THERMAL_58MM', 'THERMAL_80MM'] as const) {
    const html = renderInvoice(doc({ lines }), snapshotOf(templateById('counter-thermal') as TemplateDefinition), {
      format,
      locale: 'en-IN',
    });
    assert.ok(!html.includes('<table class="items">'), `${format} must not use the wide table`);
    assert.ok(html.includes('class="tline"'), `${format} prints each item as a block`);
    assert.ok(html.includes('Item 12'));
    assert.ok(html.includes('Total to pay'));
    assert.ok(html.includes('Tax invoice'), 'the compliance section survives the narrowest paper');
  }
});

test('an old bill keeps its original design even after the template is redesigned', () => {
  const original = snapshotOf(wholesale);
  const before = renderInvoice(doc(), original, { format: 'A4', locale: 'en-IN' });

  // The business redesigns: new colours, bigger type, different optional fields.
  const redesigned: TemplateDefinition = {
    ...wholesale,
    version: '2.0.0',
    palette: { accent: '#aa0000', text: '#000000', muted: '#333333', border: '#cccccc' },
    typography: { ...wholesale.typography, baseSizePt: 12 },
    optionalFields: ['footer.thankYou'],
    lineColumns: [],
  };
  validateTemplate(redesigned);
  const after = renderInvoice(doc(), snapshotOf(redesigned), { format: 'A4', locale: 'en-IN' });

  assert.notEqual(after, before, 'the new design must actually differ');
  const reprinted = renderInvoice(doc(), original, { format: 'A4', locale: 'en-IN' });
  assert.equal(reprinted, before, 'reprinting the old bill must give exactly the old bill');
  assert.ok(before.includes('#1f4e79'), 'the old colour is preserved on the old bill');
  assert.ok(after.includes('#aa0000'));
});

test('the same bill rendered twice is byte-identical, so a visual change is always deliberate', () => {
  const a = renderInvoice(doc(), snapshotOf(wholesale), { format: 'A4', locale: 'en-IN' });
  const b = renderInvoice(doc(), snapshotOf(wholesale), { format: 'A4', locale: 'en-IN' });
  assert.equal(a, b);
});

test('every shipped template is well formed and names a font that will actually exist', () => {
  for (const template of SHIPPED_TEMPLATES) {
    validateTemplate(template);
    for (const stack of [template.typography.bodyStack, template.typography.headingStack]) {
      assert.match(stack, /Devanagari|Nirmala|Mangal/, `${template.id} must be able to print Hindi`);
      assert.match(stack, /sans-serif|serif$/, `${template.id} must end in a generic family`);
    }
    assert.ok(template.typography.baseSizePt >= 7, `${template.id} must stay readable`);
    assert.ok(template.formats.length > 0);
  }
});

test('a template is refused when it is unreadable, unknown or self-contradictory', () => {
  assert.throws(() => validateTemplate({ ...wholesale, optionalFields: ['seller.hair.colour'] }), (e: unknown) =>
    e instanceof DomainError && e.code === 'TEMPLATE_UNKNOWN_FIELD');
  assert.throws(() => validateTemplate({ ...wholesale, typography: { ...wholesale.typography, baseSizePt: 5 } }), (e: unknown) =>
    e instanceof DomainError && e.code === 'TEMPLATE_TEXT_TOO_SMALL');
  assert.throws(
    () => validateTemplate({ ...wholesale, typography: { ...wholesale.typography, bodyStack: "'Fancy Font'" } }),
    (e: unknown) => e instanceof DomainError && e.code === 'TEMPLATE_NO_FONT_FALLBACK',
  );
  assert.throws(() => validateTemplate({ ...wholesale, lineColumns: ['line.batch'], optionalFields: [] }), (e: unknown) =>
    e instanceof DomainError && e.code === 'TEMPLATE_COLUMN_NOT_SHOWN');
  assert.throws(
    () => validateTemplate({ ...wholesale, optionalFields: ['footer.terms'], lineColumns: ['footer.terms'] }),
    (e: unknown) => e instanceof DomainError && e.code === 'TEMPLATE_BAD_COLUMN',
  );
  assert.throws(() => validateTemplate({ ...wholesale, formats: [] }), (e: unknown) =>
    e instanceof DomainError && e.code === 'TEMPLATE_NO_FORMAT');
});

test('the QR area is big enough to scan, and says so when the code has not arrived', () => {
  const withCode = doc({ eInvoice: { irn: 'a'.repeat(64), qrSvg: '<svg role="img"><rect/></svg>' } });
  const html = renderInvoice(withCode, snapshotOf(wholesale), { format: 'A4', locale: 'en-IN' });
  assert.ok(html.includes('<svg role="img">'), 'the code we were given is printed as given');
  assert.ok(html.includes('a'.repeat(64)), 'the government reference is printed too');

  // 26mm at 203 dots per inch, the usual thermal head, is about 208 dots: comfortably above the
  // minimum for a dense QR, and the quiet zone comes from the 2mm padding.
  assert.match(html, /\.qr-slot \{[^}]*width: 26mm/);
  assert.match(html, /\.qr-slot \{[^}]*padding: 2mm/);

  const pending = doc({ eInvoice: { irn: 'irn-1', qrSvg: null } });
  const pendingHtml = renderInvoice(pending, snapshotOf(wholesale), { format: 'A4', locale: 'en-IN' });
  assert.ok(pendingHtml.includes('QR code not received yet'), 'an empty slot must explain itself');
  assert.ok(!pendingHtml.includes('<svg'), 'we never draw a placeholder that looks like a real code');
});

test('a styled bill is never presented as a registered e-invoice', () => {
  const html = renderInvoice(doc(), snapshotOf(wholesale), { format: 'A4', locale: 'en-IN' });
  assert.ok(!html.includes('IRN'), 'a bill with no government reference must not imply one');
  assert.ok(!html.includes('e-invoice'));
});

test('what a shopkeeper types is escaped, not executed', () => {
  const nasty = doc({
    lines: [line({ description: '<script>alert(1)</script>', note: '" onmouseover="x' })],
    buyer: { ...doc().buyer, name: '<img src=x onerror=alert(1)>' },
  });
  const html = renderInvoice(nasty, snapshotOf(wholesale), { format: 'A4', locale: 'en-IN' });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.equal(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
});

test('both languages render, and the Hindi one is actually different', () => {
  const en = renderInvoice(doc(), captureSnapshot(wholesale, 'en-IN', '2026-08-29'), { format: 'A4', locale: 'en-IN' });
  const hi = renderInvoice(doc(), captureSnapshot(wholesale, 'hi-IN', '2026-08-29'), { format: 'A4', locale: 'hi-IN' });
  assert.ok(en.includes('Billed to'));
  assert.ok(hi.includes('Kiske naam'));
  assert.ok(hi.includes('Kul dena'));
  assert.ok(hi.includes('lang="hi"'));
  assert.notEqual(en, hi);
});

test('the rate the business set is stated on the bill, not hidden in a setting', () => {
  const notice = 'The GST rates on this bill are the ones your business set.';
  const html = renderInvoice(doc({ declaredRateNotice: notice }), snapshotOf(wholesale), { format: 'A4', locale: 'en-IN' });
  assert.ok(html.includes(notice));

  const without = renderInvoice(doc(), snapshotOf(wholesale), { format: 'A4', locale: 'en-IN' });
  assert.ok(!without.includes('your business set'), 'a sourced bill carries no such notice');
});

test('templates are suggested for a business type, best first, and every type gets an answer', () => {
  for (const type of ['RETAIL', 'WHOLESALE', 'BAKERY', 'SERVICES', 'TRANSPORT', 'MANUFACTURING'] as const) {
    const suggestions = recommendTemplates(type);
    assert.equal(suggestions.length, SHIPPED_TEMPLATES.length, 'nothing is hidden, only reordered');
    assert.ok(suggestions[0]?.businessTypes.includes(type), `${type} must get a fitting suggestion first`);
  }
  assert.equal(recommendTemplates('BAKERY')[0]?.id, 'bakery-warm');
  assert.equal(recommendTemplates('TRANSPORT')[0]?.id, 'transport-consignment');
});

test('the amount in words uses lakh and crore, because that is what gets proof-read', () => {
  assert.equal(amountInWords(rupees(100000)), 'Rupees one lakh only');
  assert.equal(amountInWords(rupees(9912)), 'Rupees nine thousand nine hundred and twelve only');
  assert.equal(amountInWords(rupees(1179, 99)), 'Rupees one thousand one hundred and seventy-nine and paise ninety-nine only');
  assert.equal(amountInWords(rupees(12345678)), 'Rupees one crore twenty-three lakh forty-five thousand six hundred and seventy-eight only');
  assert.equal(amountInWords(rupees(0)), 'Rupees zero only');
  assert.ok(!amountInWords(rupees(100000)).includes('million'));
});

test('a quantity is printed as it was recorded, never re-derived at print time', () => {
  const q = quantityFromString('70.5', 'BOX');
  const html = renderInvoice(doc({ lines: [line({ quantityText: `${'70.5'} BOX` })] }), snapshotOf(wholesale), {
    format: 'A4',
    locale: 'en-IN',
  });
  assert.ok(html.includes('70.5 BOX'));
  assert.equal(q.unit, 'BOX');
});
