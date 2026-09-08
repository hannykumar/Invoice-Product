/**
 * Issue #140 acceptance criteria, enforced automatically.
 *
 *  - "renders as a bordered grid: framed header, boxed meta rows, ruled item table, HSN summary,
 *     footer split into declaration, bank details and signature"
 *  - "becomes the default for WHOLESALE and MANUFACTURING"
 *  - "still refuses to drop a required field, and still renders on A4, 80 mm, 58 mm and mobile"
 *
 * plus the HSN summary's own rule from issue #135: **the summary has to add up to the bill.**
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isoDate, rupees, toDecimalString, type Money } from '@invoice/kernel';
import { MANDATORY_FIELDS } from '../src/mandatory.ts';
import { SHIPPED_TEMPLATES, recommendTemplates, templateById, validateTemplate, type PageFormat, type TemplateDefinition } from '../src/template.ts';
import { captureSnapshot } from '../src/snapshot.ts';
import { renderInvoice } from '../src/render.ts';
import { hsnSummary } from '../src/hsn-summary.ts';
import { amountInWords } from '../src/words.ts';
import type { InvoiceDocument, RenderableLine } from '../src/document.ts';

const nil = rupees(0);

const line = (overrides: Partial<RenderableLine> = {}): RenderableLine => ({
  lineId: 'l1',
  description: 'Plastic crate',
  hsnOrSac: '3923',
  kind: 'GOODS',
  quantityText: '40 PCS',
  unitPrice: rupees(210),
  discount: null,
  taxableValue: rupees(8400),
  ratePercentTimes100: 1800n,
  taxAmount: rupees(1512),
  cgst: rupees(756),
  sgst: rupees(756),
  utgst: nil,
  igst: nil,
  cess: nil,
  reverseCharge: false,
  batch: 'B-1',
  note: null,
  ...overrides,
});

const doc = (overrides: Partial<InvoiceDocument> = {}): InvoiceDocument => ({
  title: 'TAX_INVOICE',
  number: 'INV/KB/2026-27/00042',
  date: isoDate('2026-08-20'),
  dueDate: isoDate('2026-09-19'),
  seller: {
    name: 'Sharma Fruit Traders',
    addressLines: ['12/4, Ajmal Khan Road'],
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
    utgst: nil,
    igst: nil,
    cess: nil,
    roundOff: nil,
    invoiceValue: rupees(9912),
    reverseChargeTax: nil,
    amountPaid: null,
    outstanding: null,
  },
  transport: null,
  eInvoice: null,
  amountInWordsText: amountInWords(rupees(9912)),
  taxAmountInWordsText: amountInWords(rupees(1512)),
  declaredRateNotice: null,
  logoDataUri: null,
  bankDetails: null,
  terms: null,
  declaration: null,
  signatureDataUri: null,
  poReference: null,
  ...overrides,
});

const india = templateById('india-standard') as TemplateDefinition;
const snapshotOf = (t: TemplateDefinition) => captureSnapshot(t, 'en-IN', '2026-08-29');
const renderIndia = (d: InvoiceDocument, format: PageFormat = 'A4') =>
  renderInvoice(d, snapshotOf(india), { format, locale: 'en-IN' });

test('the India-standard design prints a ruled grid, not an airy page with a coloured band', () => {
  const html = renderIndia(doc());
  assert.equal(india.layout, 'BOXED');
  assert.ok(html.includes('data-layout="BOXED"'), 'the page states which layout produced it');
  assert.ok(html.includes('<body class="boxed">'));

  // Framed header, boxed meta rows, ruled item table, HSN summary, footer — each a real region.
  for (const region of ['grid head', 'grid inner', 'grid items', 'grid summary', 'grid foot']) {
    assert.ok(html.includes(`class="${region}"`) || html.includes(`class="${region} `), `the ${region} region must exist`);
  }
  assert.match(html, /\.boxed table\.grid[^{]*\{[^}]*border-collapse: collapse/);
  assert.ok(!html.includes('background: #1f4e79'), 'no coloured heading band on this design');
});

test('the item table reads like a bill: a serial column, the unit beside the rate, an amount', () => {
  const html = renderIndia(doc());
  for (const heading of ['>Sl<', '>Item<', '>HSN / SAC<', '>Qty<', '>Rate<', '>per<', '>Amount<']) {
    assert.ok(html.includes(heading), `the item table must have a ${heading} column`);
  }
  // "40 PCS" is split so the unit sits in its own column, exactly as a real bill prints it. The
  // quantity itself is never re-derived: this only separates a string formatted when it was raised.
  assert.ok(html.includes('>40</td>'), 'the quantity stands alone');
  assert.ok(html.includes('>PCS</td>'), 'and its unit is in the per column');
  assert.ok(html.includes('>1</td>'), 'lines are numbered from one');
});

test('there is one correct bill: every shipped design is boxed, and none is the weaker option', () => {
  assert.equal(recommendTemplates('WHOLESALE')[0]?.id, 'india-standard');
  assert.equal(recommendTemplates('MANUFACTURING')[0]?.id, 'india-standard');

  // A business is never offered a version of the bill that is missing something. Designs differ in
  // what optional extras they carry and what fits on their paper — never in whether the bill is
  // complete. The old airy design was deleted rather than kept as an alternative.
  assert.ok(
    SHIPPED_TEMPLATES.every((t) => t.layout === 'BOXED'),
    'no shipped design is airy any more',
  );
  assert.ok(!SHIPPED_TEMPLATES.some((t) => t.id === 'wholesale-classic'));

  // And the parts that make a bill correct come from the renderer, not from the design, so every
  // design on paper wide enough for them carries them.
  for (const template of SHIPPED_TEMPLATES.filter((t) => t.formats.includes('A4'))) {
    const html = renderInvoice(doc(), snapshotOf(template), { format: 'A4', locale: 'en-IN' });
    assert.ok(html.includes('Tax summary by HSN / SAC'), `${template.id} prints the tax summary`);
    assert.ok(html.includes('Tax amount in words'), `${template.id} prints the tax total in words`);
    assert.ok(html.includes('In words'), `${template.id} prints the amount in words`);
    assert.ok(html.includes('>Sl<') && html.includes('>Amount<'), `${template.id} has a proper item table`);
  }
});

test('no shipped design puts words on the bill that the business did not write', () => {
  for (const template of SHIPPED_TEMPLATES) {
    assert.equal(template.footerNote, null, `${template.id} ships no slogan or returns policy`);
  }
});

test('it still cannot drop a required field, and prints the compliance section on every paper', () => {
  assert.doesNotThrow(() => validateTemplate(india));
  // A design has no field with which to remove a mandatory one: stripping every optional field
  // leaves the compliance section standing.
  const bare: TemplateDefinition = { ...india, optionalFields: [], lineColumns: [] };
  const html = renderInvoice(doc(), snapshotOf(bare), { format: 'A4', locale: 'en-IN' });
  for (const required of ['INV/KB/2026-27/00042', 'Sharma Fruit Traders', 'ABC Traders', '07AAAAA0000A1Z4', 'Delhi']) {
    assert.ok(html.includes(required), `${required} survives a design that shows nothing optional`);
  }
  assert.ok(MANDATORY_FIELDS.length > 0);

  for (const format of ['A4', 'THERMAL_80MM', 'THERMAL_58MM', 'MOBILE'] as const) {
    const printed = renderIndia(doc(), format);
    assert.ok(printed.includes('Tax invoice') || printed.includes('TAX INVOICE'), `${format} says what the document is`);
    assert.ok(printed.includes('ABC Traders'), `${format} names the customer`);
    assert.ok(printed.includes('Total to pay'), `${format} shows what is owed`);
  }
  // A ten-column ruled table does not fit on till roll, so the narrow shapes keep the list.
  assert.ok(!renderIndia(doc(), 'THERMAL_58MM').includes('grid items'));
});

test('the design ships no words the business did not write', () => {
  assert.equal(india.footerNote, null, 'no slogan and no returns policy is shipped as a default');
  const html = renderIndia(doc());
  assert.ok(!html.includes('Declaration'), 'the declaration box appears only once a business writes one');

  const declared = renderIndia(doc({ declaration: 'We declare the particulars are true.' }));
  assert.ok(declared.includes('Declaration'), 'and it appears as soon as one is set');
  assert.ok(declared.includes('We declare the particulars are true.'));
});

test('a bill printed before this design existed still reprints as the page it was', () => {
  // A stored snapshot carries no layout at all. That has to keep meaning the original airy page,
  // or every old bill silently changes shape.
  const { layout: _dropped, ...old } = snapshotOf(india);
  const html = renderInvoice(doc(), old, { format: 'A4', locale: 'en-IN' });
  assert.ok(!html.includes('<body class="boxed">'));
  assert.ok(html.includes('data-layout="AIRY"'));
});

test('the HSN summary groups by code and rate, and adds up to the bill exactly', () => {
  const crates = line({ lineId: 'a', hsnOrSac: '3923', ratePercentTimes100: 1800n });
  const moreCrates = line({
    lineId: 'b', hsnOrSac: '3923', ratePercentTimes100: 1800n,
    taxableValue: rupees(1000), taxAmount: rupees(180), cgst: rupees(90), sgst: rupees(90),
  });
  // Same code, different rate: the buyer reconciles on the pair, so these must not merge.
  const juice = line({
    lineId: 'c', hsnOrSac: '2009', ratePercentTimes100: 500n,
    taxableValue: rupees(2000), taxAmount: rupees(100), cgst: rupees(50), sgst: rupees(50),
  });
  const bill = doc({
    lines: [crates, moreCrates, juice],
    totals: {
      taxableValue: rupees(11400), cgst: rupees(896), sgst: rupees(896), utgst: nil, igst: nil,
      cess: nil, roundOff: nil, invoiceValue: rupees(13192), reverseChargeTax: nil,
      amountPaid: null, outstanding: null,
    },
  });

  const summary = hsnSummary(bill);
  assert.equal(summary.rows.length, 2, 'two codes, and the two crate lines are one row');
  assert.equal(toDecimalString(summary.rows[0]?.taxableValue as Money), '9400.00');
  assert.equal(toDecimalString(summary.rows[1]?.taxableValue as Money), '2000.00');

  // The assertion this table exists for.
  assert.equal(toDecimalString(summary.totals.taxableValue), toDecimalString(bill.totals.taxableValue));
  assert.equal(toDecimalString(summary.totals.cgst), toDecimalString(bill.totals.cgst));
  assert.equal(toDecimalString(summary.totals.sgst), toDecimalString(bill.totals.sgst));

  const html = renderIndia(bill);
  assert.ok(html.includes('Tax summary by HSN / SAC'));
  assert.ok(html.includes('Tax amount in words'), 'the tax total is written out under it, as on a real bill');
});

test('the summary shows the taxes this bill actually carries, and no column of zeroes', () => {
  const interState = doc({
    split: 'IGST',
    lines: [line({ cgst: nil, sgst: nil, igst: rupees(1512) })],
    totals: { ...doc().totals, cgst: nil, sgst: nil, igst: rupees(1512) },
  });
  const html = renderIndia(interState);
  assert.ok(html.includes('>IGST<'), 'an inter-state bill shows one combined tax');
  assert.ok(!html.includes('<th colspan="2">CGST</th>'), 'and does not print an empty CGST column');

  const withinState = renderIndia(doc());
  assert.ok(withinState.includes('<th colspan="2">CGST</th>') && withinState.includes('<th colspan="2">SGST</th>'));
  assert.ok(!withinState.includes('<th colspan="2">IGST</th>'));
});

test('reverse-charge tax is not counted into the summary, because it was not charged', () => {
  // The customer pays this GST to the government directly. Adding it here would make the summary
  // disagree with what the customer actually owes, which is the one thing it may never do.
  const rcm = line({ reverseCharge: true });
  const summary = hsnSummary(doc({ lines: [rcm], totals: { ...doc().totals, cgst: nil, sgst: nil, reverseChargeTax: rupees(1512) } }));
  assert.equal(toDecimalString(summary.totals.cgst), '0.00');
  assert.equal(toDecimalString(summary.totals.taxableValue), '8400.00', 'the value is still reported');
});

test('what a shopkeeper types is escaped on this design too', () => {
  const html = renderIndia(doc({
    lines: [line({ description: '<script>alert(1)</script>' })],
    declaration: '<img src=x onerror=alert(1)>',
  }));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;script&gt;'));
});


/**
 * Issue #138 — the ten trade fields real bills carry.
 *
 * Each is small on its own. Together they are what makes a page read as a bill rather than a
 * printout, so each is checked for three things: it prints when the fact is there, it leaves no
 * empty label when it is not, and it stays off the till roll where there is no room.
 */
const withTradeFields = (): InvoiceDocument =>
  doc({
    seller: { ...doc().seller, pan: 'AAAAA0000A' },
    lines: [line({ packages: '80 Bags' })],
    transport: {
      transporter: 'Sharma Roadlines',
      vehicleNumber: 'DL01AB1234',
      eWayBillNumber: '3912 4455 6677',
      lrNumber: 'SRL/2026/44120',
      documentNumber: 'GC-88213',
      documentDate: isoDate('2026-08-20'),
      destination: 'Ghazipur Cold Store, Gate 4',
    },
  });

test('#138 — the trade fields print on A4 when the bill carries them', () => {
  const html = renderIndia(withTradeFields());
  for (const [what, expected] of [
    ['company PAN', 'AAAAA0000A'],
    ['number and kind of packages', '80 Bags'],
    ['the packages column heading', '>Packages<'],
    ['LR / RR number', 'SRL/2026/44120'],
    ['transport document number', 'GC-88213'],
    ['delivery destination', 'Ghazipur Cold Store, Gate 4'],
    ['a serial number column', '>Sl<'],
    ["the line's own amount", '>Amount<'],
    ['the unit beside the rate', '>per<'],
    ['tax amount in words', 'Tax amount in words'],
  ] as const) {
    assert.ok(html.includes(expected), `${what} must be printed`);
  }
  assert.ok(html.includes('Authorised Signatory'), 'and the bill is signed for');
});

test('#138 — a bill without a fact prints cleanly, with no empty label', () => {
  const bare = renderIndia(doc());
  assert.ok(!bare.includes('PAN'), 'no PAN line when the business has not given one');
  assert.ok(!bare.includes('LR / RR number'), 'no transporter paperwork row without a transporter');
  assert.ok(!bare.includes('Destination'), 'no destination label with nothing to put in it');

  // The packages column is a design choice, so a design that does not show it prints no heading.
  const withoutColumn = renderInvoice(
    withTradeFields(),
    { ...snapshotOf(india), lineColumns: ['line.discount'] },
    { format: 'A4', locale: 'en-IN' },
  );
  assert.ok(!withoutColumn.includes('>Packages<'));
});

test('#138 — none of them reach the till roll, where there is no room', () => {
  const html = renderIndia(withTradeFields(), 'THERMAL_58MM');
  // Checked by label rather than by value: a GSTIN has the PAN inside it (07**AAAAA0000A**1Z4), so
  // looking for the number alone would find the GSTIN and fail on a page that is perfectly correct.
  for (const absent of ['PAN', 'Packages', '80 Bags', 'SRL/2026/44120', 'GC-88213', 'Ghazipur Cold Store', 'Authorised Signatory']) {
    assert.ok(!html.includes(absent), `${absent} has no place on 58mm paper`);
  }
  // What a customer at a counter does need still prints.
  assert.ok(html.includes('ABC Traders') && html.includes('Total to pay'));
});

test('#138 — the signature is an uploaded image, with a reserved box until one exists', () => {
  const waiting = renderIndia(doc());
  assert.ok(waiting.includes('data-reserved="signature"'), 'the space is held at its final size');
  assert.ok(waiting.includes('Signature not uploaded yet'), 'and says why it is empty');
  assert.ok(!waiting.includes('<img class="sign-image"'));

  const signed = renderIndia(doc({ signatureDataUri: 'data:image/png;base64,iVBORw0KGgo=' }));
  assert.ok(signed.includes('<img class="sign-image"'), 'the real signature is printed once uploaded');
  assert.ok(!signed.includes('data-reserved="signature"'), 'and the reserved box gives way to it');
  assert.ok(signed.includes('Authorised Signatory'), 'the rule under it stays either way');
});

test('#138 — we state a fact about the document, but reserve nothing on the business behalf', () => {
  const html = renderIndia(doc());
  // This product produced the page, so it can say so.
  assert.ok(html.includes('This is a computer generated invoice.'));
  // "Errors and omissions excepted" is a reservation the business makes to its customer. It is off
  // until a business turns it on, like every other commitment on this bill.
  assert.ok(!html.includes('E. & O.E.'));
  assert.ok(!india.optionalFields.includes('footer.eoe'));

  const optedIn = renderInvoice(
    doc(),
    { ...snapshotOf(india), optionalFields: [...india.optionalFields, 'footer.eoe'] },
    { format: 'A4', locale: 'en-IN' },
  );
  assert.ok(optedIn.includes('E. &amp; O.E.'), 'and prints as soon as the business asks for it');
});
