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
import { renderInvoice, renderInvoiceCopies, renderInvoiceCopySet } from '../src/render.ts';
import { copiesFor, copyMarking } from '../src/copies.ts';
import { shipToFromDelivery } from '../src/from-sales.ts';
import { t, totalQuantityText, WORDING_KEYS } from '../src/parts.ts';
import { lintUserFacingText } from '../../ux-vocabulary/src/lint.ts';
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
  shipTo: null,
  placeOfSupplyStateCode: '07',
  placeOfSupplyStateName: 'Delhi',
  reverseCharge: false,
  supplyKind: 'GOODS',
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
  bank: null,
  references: null,
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
  for (const heading of ['>Sl No.<', '>Description of Goods<', '>HSN / SAC<', '>Quantity<', '>Rate<', '>per<', '>Amount<']) {
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
    assert.ok(html.includes('HSN / SAC Summary'), `${template.id} prints the tax summary`);
    assert.ok(html.includes('Tax Amount (in words)'), `${template.id} prints the tax total in words`);
    assert.ok(html.includes('Amount Chargeable (in words)'), `${template.id} prints the amount in words`);
    assert.ok(html.includes('>Sl No.<') && html.includes('>Amount<'), `${template.id} has a proper item table`);
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
    assert.ok(printed.includes('Tax Invoice'), `${format} says what the document is`);
    assert.ok(printed.includes('ABC Traders'), `${format} names the customer`);
    assert.ok(printed.includes('Balance Due') || printed.includes('>Total<'), `${format} shows what is owed`);
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
  assert.ok(html.includes('HSN / SAC Summary'));
  assert.ok(html.includes('Tax Amount (in words)'), 'the tax total is written out under it, as on a real bill');
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
    ['the packages column heading', '>No. &amp; Kind of Pkgs<'],
    ['LR / RR No.', 'SRL/2026/44120'],
    ['transport document number', 'GC-88213'],
    ['delivery destination', 'Ghazipur Cold Store, Gate 4'],
    ['a serial number column', '>Sl No.<'],
    ["the line's own amount", '>Amount<'],
    ['the unit beside the rate', '>per<'],
    ['tax amount in words', 'Tax Amount (in words)'],
  ] as const) {
    assert.ok(html.includes(expected), `${what} must be printed`);
  }
  assert.ok(html.includes('Authorised Signatory'), 'and the bill is signed for');
});

test('#138 — a bill without a fact prints cleanly, with no empty label', () => {
  const bare = renderIndia(doc());
  assert.ok(!bare.includes('PAN'), 'no PAN line when the business has not given one');
  assert.ok(!bare.includes('LR / RR No.'), 'no transporter paperwork row without a transporter');
  assert.ok(!bare.includes('Destination'), 'no destination label with nothing to put in it');

  // The packages column is a design choice, so a design that does not show it prints no heading.
  const withoutColumn = renderInvoice(
    withTradeFields(),
    { ...snapshotOf(india), lineColumns: ['line.discount'] },
    { format: 'A4', locale: 'en-IN' },
  );
  assert.ok(!withoutColumn.includes('Kind of Pkgs'));
});

test('#138 — none of them reach the till roll, where there is no room', () => {
  const html = renderIndia(withTradeFields(), 'THERMAL_58MM');
  // Checked by label rather than by value: a GSTIN has the PAN inside it (07**AAAAA0000A**1Z4), so
  // looking for the number alone would find the GSTIN and fail on a page that is perfectly correct.
  for (const absent of ['PAN', 'Kind of Pkgs', '80 Bags', 'SRL/2026/44120', 'GC-88213', 'Ghazipur Cold Store', 'Authorised Signatory']) {
    assert.ok(!html.includes(absent), `${absent} has no place on 58mm paper`);
  }
  // What a customer at a counter does need still prints.
  assert.ok(html.includes('ABC Traders') && html.includes('Total'));
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

test('#138 — the bill states a fact and keeps the protection real bills carry', () => {
  const html = renderIndia(doc());
  // This product produced the page, so it can say so.
  assert.ok(html.includes('This is a computer generated invoice.'));

  // "E. & O.E." — errors and omissions excepted — lets a business correct a mistake on a bill it
  // has already sent. It is on by default because it protects the business and costs the customer
  // nothing, which is what separates it from a payment term or a returns policy: those give
  // something away, and those are still never a default.
  assert.ok(html.includes('E. &amp; O.E.'));
  assert.ok(india.optionalFields.includes('footer.eoe'));

  const withoutIt = renderInvoice(
    doc(),
    { ...snapshotOf(india), optionalFields: india.optionalFields.filter((f) => f !== 'footer.eoe') },
    { format: 'A4', locale: 'en-IN' },
  );
  assert.ok(!withoutIt.includes('E. &amp; O.E.'), 'and a business can still take it off');
});


/**
 * Issue #137 — the marked copies.
 *
 * GST asks for three copies of a goods invoice, each marked so anyone holding one knows which it
 * is. A business cannot hand an unmarked sheet to a lorry driver and call it the transporter copy.
 */
test('#137 — a goods bill prints three marked copies, a services bill two', () => {
  const goods = doc();
  assert.deepEqual(copiesFor(goods), ['ORIGINAL', 'DUPLICATE', 'TRIPLICATE']);
  assert.equal(copyMarking(goods, 'ORIGINAL', 'en-IN'), 'ORIGINAL FOR RECIPIENT');
  assert.equal(copyMarking(goods, 'DUPLICATE', 'en-IN'), 'DUPLICATE FOR TRANSPORTER');
  assert.equal(copyMarking(goods, 'TRIPLICATE', 'en-IN'), 'TRIPLICATE FOR SUPPLIER');

  // Nothing is carried anywhere on a services bill, so the second copy is the seller's own and
  // there is no third. Asking for one returns nothing rather than inventing a transporter.
  const services = doc({ supplyKind: 'SERVICES' });
  assert.deepEqual(copiesFor(services), ['ORIGINAL', 'DUPLICATE']);
  assert.equal(copyMarking(services, 'DUPLICATE', 'en-IN'), 'DUPLICATE FOR SUPPLIER');
  assert.equal(copyMarking(services, 'TRIPLICATE', 'en-IN'), null);
});

test('#137 — the marking prints at the top, and an unmarked bill carries none', () => {
  const marked = renderInvoice(doc(), snapshotOf(india), { format: 'A4', locale: 'en-IN', copy: 'DUPLICATE' });
  assert.ok(marked.includes('DUPLICATE FOR TRANSPORTER'));
  assert.ok(marked.includes('data-copy="DUPLICATE"'), 'the page says which copy it is');
  // Beside the title, which is where an Indian bill carries it.
  assert.ok(marked.includes('copy-mark-inline'));

  const preview = renderIndia(doc());
  assert.ok(!preview.includes('FOR TRANSPORTER'), 'a preview is not a copy of anything');
  assert.ok(!preview.includes('data-copy='));
});

test('#137 — printing all the copies is one action, one document, one page each', () => {
  const html = renderInvoiceCopies(doc(), snapshotOf(india), { format: 'A4', locale: 'en-IN' });

  // One document, so one press of Print produces the set.
  assert.equal(html.match(/<!doctype html>/gi)?.length, 1);
  assert.equal(html.match(/<body/g)?.length, 1);
  assert.equal(html.match(/class="sheet"/g)?.length, 3, 'three sheets for a goods bill');
  for (const marking of ['ORIGINAL FOR RECIPIENT', 'DUPLICATE FOR TRANSPORTER', 'TRIPLICATE FOR SUPPLIER']) {
    assert.ok(html.includes(marking), `${marking} is one of the pages`);
  }
  assert.match(html, /\.sheet \+ \.sheet \{[^}]*page-break-before: always/, 'each copy starts on a fresh sheet');

  const services = renderInvoiceCopies(doc({ supplyKind: 'SERVICES' }), snapshotOf(india), {
    format: 'A4',
    locale: 'en-IN',
  });
  assert.equal(services.match(/class="sheet"/g)?.length, 2);
  assert.ok(!services.includes('FOR TRANSPORTER'));
});

/**
 * Issue #139 — two vocabularies, one place.
 *
 * The friendly wording is right on a screen and wrong on paper. A CA, a GST officer and the buyer's
 * accounts clerk all scan a bill for the standard terms, and "Bill number" is not one of them.
 */
test('#139 — the printed bill uses the terms an accountant scans for', () => {
  const html = renderIndia(doc({ totals: { ...doc().totals, amountPaid: rupees(5000), outstanding: rupees(4912) } }));
  for (const [friendly, standard] of [
    ['Bill number', 'Invoice No.'],
    ['This sale counts in', 'Place of Supply'],
    ['Total to pay', 'Total'],
    ['Still due', 'Balance Due'],
    ['GST number', 'GSTIN'],
    // Escaped, because an apostrophe is escaped like everything else the page prints.
    ['Your order reference', 'Buyer&#39;s Order No.'],
  ] as const) {
    assert.ok(html.includes(standard), `the paper must say "${standard}"`);
    assert.ok(!html.includes(friendly), `and never "${friendly}", which nobody checking a bill looks for`);
  }
});

test('#139 — there is one English word per thing, and it is the one the world uses', () => {
  // Corrected on 2026-09-09. Being easy for a shopkeeper who never studied accounting means the
  // product is easy to operate, not that standard terms get renamed. A user who has only ever seen
  // "Bill number" cannot follow a customer who says "invoice number".
  assert.equal(t('invoiceNo', 'en-IN'), 'Invoice No.');
  assert.equal(t('outstanding', 'en-IN'), 'Balance Due');
  assert.equal(t('placeOfSupply', 'en-IN'), 'Place of Supply');

  // Every key has exactly one English word: there is no second vocabulary to drift from.
  for (const key of WORDING_KEYS) {
    assert.equal(typeof t(key, 'en-IN'), 'string');
    assert.ok(t(key, 'en-IN').length > 0, `${key} must have a word`);
  }

  // Hindi keeps its plain form throughout, because Indian bills carry no standard Hindi to match.
  assert.equal(t('invoiceNo', 'hi-IN'), 'Bill number');
  assert.equal(t('outstanding', 'hi-IN'), 'Abhi baaki');
  const hindiIssues = WORDING_KEYS.flatMap((key) => lintUserFacingText(t(key, 'hi-IN'), { locale: 'hi-IN' }));
  assert.deepEqual(hindiIssues, [], 'the Hindi wording stays plain by the product own standard');
});

/**
 * Issue #137, as corrected on 2026-09-09 — the copies must also come out separately.
 *
 * One three-page file is right for a business printing the set on its own printer, and wrong for a
 * business sending them: the transporter's copy goes to the transporter and the buyer's to the
 * buyer, and splitting a PDF first is work handed back to the user.
 */
test('#137 — the copies come out separately as well as together', () => {
  const set = renderInvoiceCopySet(doc(), snapshotOf(india), { format: 'A4', locale: 'en-IN' });
  assert.equal(set.length, 3);
  assert.deepEqual(set.map((c) => c.copy), ['ORIGINAL', 'DUPLICATE', 'TRIPLICATE']);
  assert.deepEqual(set.map((c) => c.marking), [
    'ORIGINAL FOR RECIPIENT',
    'DUPLICATE FOR TRANSPORTER',
    'TRIPLICATE FOR SUPPLIER',
  ]);
  for (const { copy, marking, html } of set) {
    // Each is a whole document on its own: sendable as it is, with nothing to split first.
    assert.equal(html.match(/<!doctype html>/gi)?.length, 1, `${copy} is a complete document`);
    assert.equal(html.match(/class="sheet"/g)?.length, 1, `${copy} is one sheet`);
    assert.ok(html.includes(marking));
  }

  const services = renderInvoiceCopySet(doc({ supplyKind: 'SERVICES' }), snapshotOf(india), {
    format: 'A4',
    locale: 'en-IN',
  });
  assert.equal(services.length, 2);
});

/**
 * Issue #134 — the consignee box.
 *
 * Where goods are delivered is often not the customer's registered office, and both real bills we
 * compared against print it as its own box.
 */
test('#134 — the bill prints where the goods went, beside who was billed', () => {
  const consignee = {
    name: 'Peenya Cold Store',
    addressLines: ['Plot 44, Peenya Phase 2', 'Bengaluru 560058'],
    gstin: '29ZZZZZ9999Z1Z9',
    stateCode: '29',
    stateName: 'Karnataka',
  };
  const html = renderIndia(doc({ shipTo: consignee }));
  assert.ok(html.includes('Consignee (Ship to)'), 'the box is there and is named the way a bill names it');
  assert.ok(html.includes('Peenya Cold Store'));
  assert.ok(html.includes('Plot 44, Peenya Phase 2'));
  assert.ok(html.includes('29ZZZZZ9999Z1Z9'), 'with its own GSTIN, which an officer checks');
  assert.ok(html.includes('ABC Traders'), 'and the buyer is still shown separately');
});

test('#134 — goods going to the buyer repeat the address in full, as both real bills do', () => {
  // Corrected on 2026-09-10 against the samples in docs/reference/real-bills. Blessing Export
  // repeats the buyer's name, address, GSTIN and state in full under Consignee (Ship to), identical
  // to the box beside it; KK Polyplast prints the delivery address on its own. Neither ever
  // cross-references. Anyone handling the goods reads one box and needs the whole address in it.
  const html = renderIndia(doc());
  assert.ok(html.includes('Consignee (Ship to)'));
  assert.ok(!html.includes('Same as'), 'a real bill never sends the reader to another box');
  assert.equal(html.match(/Shop 8, Azadpur Mandi/g)?.length, 2, 'the address stands in both boxes');
  assert.equal(html.match(/ABC Traders/g)?.length, 2);
  assert.equal(html.match(/07DDDDD3333D1ZV/g)?.length, 2, 'with the GSTIN an officer checks');
});

test('#134 — the item table totals the quantity, as both real bills do', () => {
  const html = renderIndia(doc({
    lines: [
      line({ lineId: 'a', quantityText: '2000.000 KGS' }),
      line({ lineId: 'b', quantityText: '550.500 KGS' }),
      line({ lineId: 'c', kind: 'CHARGE', description: 'Freight', quantityText: '1 NOS' }),
    ],
  }));
  // The charge line carries no goods, so it is not counted into the load.
  assert.ok(html.includes('2,550.500 KGS'), 'the total a godown counts the load against');

  // Lines in different units cannot be added, so nothing is printed rather than a wrong number.
  // Asserted on the helper, because "92" appears in plenty of amounts and HSN codes on the page.
  assert.equal(
    totalQuantityText([line({ lineId: 'a', quantityText: '80 BAGS' }), line({ lineId: 'b', quantityText: '12 MTR' })]),
    '',
    'bags and metres have no sensible total',
  );
  assert.equal(totalQuantityText([line({ quantityText: '70 BOX' })]), '70 BOX');
});

test('#134 — the delivery party is the one the e-way bill uses, not a second copy typed by hand', () => {
  // This is the shape `Movement.shipTo` already has in packages/transport. Taking it unchanged is
  // what stops a bill and an e-way bill disagreeing about where a load went.
  const movementShipTo = {
    legalName: 'Peenya Cold Store',
    gstin: '29ZZZZZ9999Z1Z9',
    address1: 'Plot 44, Peenya Phase 2',
    address2: 'Behind the weighbridge',
    place: 'Bengaluru',
    pincode: '560058',
    stateCode: '29',
  };
  const printed = shipToFromDelivery(movementShipTo, 'Karnataka');
  assert.equal(printed.name, 'Peenya Cold Store');
  assert.equal(printed.gstin, '29ZZZZZ9999Z1Z9');
  assert.equal(printed.stateCode, '29');
  assert.deepEqual(printed.addressLines, ['Plot 44, Peenya Phase 2', 'Behind the weighbridge', 'Bengaluru 560058']);

  // An unregistered delivery point has no GSTIN, and prints none rather than an empty label.
  assert.equal(shipToFromDelivery({ ...movementShipTo, gstin: '' }, 'Karnataka').gstin, null);
});

test('#134 — till roll gets the delivery address as one line, not a second box', () => {
  const consignee = {
    name: 'Peenya Cold Store',
    addressLines: ['Plot 44, Peenya Phase 2'],
    gstin: null,
    stateCode: '29',
    stateName: 'Karnataka',
  };
  const html = renderIndia(doc({ shipTo: consignee }), 'THERMAL_58MM');
  assert.ok(html.includes('ship-line'), 'one line, because there is no room for a box');
  assert.ok(html.includes('Peenya Cold Store'));
  // Checked on the markup, not the stylesheet: the boxed rules are in every page's CSS, and it is
  // the boxes themselves that must not be drawn here.
  assert.ok(!html.includes('<td class="party-cell"'), 'and none of the boxed grid comes with it');
});


/**
 * Issue #156 — the order-and-delivery references, and bank details as named fields.
 *
 * All of these are on the Tally sample in docs/reference/real-bills and none is required by Rule
 * 46. They are carried because a buyer's accounts department matches on them when it queries a bill.
 */
const withReferences = (): InvoiceDocument =>
  doc({
    references: {
      deliveryNoteNumber: 'DN/2026/0912',
      deliveryNoteDate: isoDate('2026-08-19'),
      dispatchDocNumber: 'DSP-4471',
      referenceNumber: 'ABC/REF/2026/77',
      referenceDate: isoDate('2026-08-18'),
      otherReferences: 'Weekly supply contract',
      termsOfDelivery: 'Delivered at the buyer godown',
      paymentTerms: 'Credit, 30 days',
    },
  });

test('#156 — the order and delivery references print when the bill carries them', () => {
  const html = renderIndia(withReferences());
  for (const [label, value] of [
    ['Delivery Note', 'DN/2026/0912'],
    ['Delivery Note Date', '19 August 2026'],
    ['Dispatch Doc No.', 'DSP-4471'],
    ['Reference No. &amp; Date', 'ABC/REF/2026/77, 18 August 2026'],
    ['Other References', 'Weekly supply contract'],
    ['Terms of Delivery', 'Delivered at the buyer godown'],
    ['Mode / Terms of Payment', 'Credit, 30 days'],
  ] as const) {
    assert.ok(html.includes(label), `${label} must be labelled`);
    assert.ok(html.includes(value), `${label} must show ${value}`);
  }
});

test('#156 — a bill without them prints no empty labels', () => {
  const bare = renderIndia(doc());
  for (const label of ['Delivery Note', 'Dispatch Doc No.', 'Reference No.', 'Other References', 'Terms of Delivery', 'Mode / Terms of Payment']) {
    assert.ok(!bare.includes(label), `${label} must not stand on a bill that has no such reference`);
  }

  // A row appears as soon as one of its two cells has something, and the empty cell keeps its
  // label — which is what Tally does inside a row it draws.
  const half = renderIndia(doc({ references: { deliveryNoteNumber: 'DN/1' } }));
  assert.ok(half.includes('Delivery Note'));
  assert.ok(half.includes('Delivery Note Date'), 'the other half of a drawn row keeps its label');
  assert.ok(!half.includes('Dispatch Doc No.'), 'but a row with nothing in it is not drawn at all');
});

test('#156 — bank details are named fields, and free text still works', () => {
  const named = renderIndia(doc({
    bank: { bankName: 'HDFC Bank Ltd.', accountNumber: '50200012345678', branch: 'Karol Bagh', ifsc: 'HDFC0000123' },
  }));
  // Labelling each part is what makes an account number safe to copy.
  assert.ok(named.includes('Bank Name') && named.includes('HDFC Bank Ltd.'));
  assert.ok(named.includes('A/c No.') && named.includes('50200012345678'));
  assert.ok(named.includes('Branch &amp; IFS Code') && named.includes('Karol Bagh &amp; HDFC0000123'));

  // A business that only ever typed free lines loses nothing.
  const free = renderIndia(doc({ bankDetails: ['State Bank, Sadar Bazar', 'A/c 3311 2255 8899'] }));
  assert.ok(free.includes('State Bank, Sadar Bazar'));
  assert.ok(free.includes('A/c 3311 2255 8899'));
  assert.ok(!free.includes('Bank Name'), 'and gets no labels it did not fill in');

  const neither = renderIndia(doc());
  assert.ok(!neither.includes('Bank Details'), 'a bill with no bank details prints no bank box');
});

test('#156 — none of it reaches the till roll', () => {
  const html = renderIndia(withReferences(), 'THERMAL_58MM');
  for (const absent of ['Delivery Note', 'Dispatch Doc No.', 'Terms of Delivery', 'Mode / Terms of Payment']) {
    assert.ok(!html.includes(absent), `${absent} has no place on 58mm paper`);
  }
});
