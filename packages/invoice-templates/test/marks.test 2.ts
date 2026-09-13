/**
 * Issue #147 acceptance criteria, enforced automatically.
 *
 *  - "Both work, and both are optional."
 *  - "A maximum opacity is enforced in code, the same way `validateTemplate` already refuses a
 *     design that touches a required field. It must never make the tax details harder to read."
 *  - "The watermark is ignored outright on THERMAL_58MM and THERMAL_80MM."
 *  - "The picture is frozen onto the bill, like the logo and the template."
 *
 * The rule underneath all four is the one from `no-invented-text-on-the-bill`: a bill is the
 * business speaking, so nothing appears on it that the business did not choose.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, isoDate, rupees } from '@invoice/kernel';
import { templateById, type PageFormat, type TemplateDefinition } from '../src/template.ts';
import { captureSnapshot } from '../src/snapshot.ts';
import { renderInvoice } from '../src/render.ts';
import { amountInWords } from '../src/words.ts';
import {
  MAX_TRADE_MARK_OPACITY_PERCENT,
  searchTradeMarks,
  tradeMarkDataUri,
  tradeMarkFromLibrary,
  tradeMarkFromOwnPicture,
  tradeMarkPicture,
  tradeMarkPictures,
  validateTradeMark,
} from '../src/marks.ts';
import type { InvoiceDocument, RenderableLine } from '../src/document.ts';

const nil = rupees(0);

const line: RenderableLine = {
  lineId: 'l1',
  description: 'Apple box, 10 kg',
  hsnOrSac: '0808',
  kind: 'GOODS',
  quantityText: '40 BOX',
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
  batch: null,
  note: null,
};

const doc = (overrides: Partial<InvoiceDocument> = {}): InvoiceDocument => ({
  title: 'TAX_INVOICE',
  number: 'INV/26-27/000042',
  date: isoDate('2026-08-20'),
  dueDate: null,
  seller: {
    name: 'Sharma Fruit Traders',
    addressLines: ['12/4, Ajmal Khan Road'],
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
const render = (d: InvoiceDocument, format: PageFormat = 'A4'): string =>
  renderInvoice(d, captureSnapshot(india, 'en-IN', '2026-08-29'), { format, locale: 'en-IN' });

// ------------------------------------------------------------------- the library and finding things in it

test('the library is a real choice, not a handful of given options', () => {
  const pictures = tradeMarkPictures();
  assert.ok(pictures.length > 1500, `expected thousands of pictures, found ${pictures.length}`);
  for (const picture of pictures) {
    assert.ok(picture.id.length > 0);
    assert.ok(picture.paths.length > 0, `${picture.id} has no drawing`);
    assert.ok(picture.words.length > 0, `${picture.id} cannot be found by any word`);
  }
});

test('no other company’s logo is in the library', () => {
  const brands = tradeMarkPictures().filter((p) => p.id.startsWith('brand-'));
  assert.deepEqual(brands, [], 'another company’s mark has no business on your bill');
});

test('a business finds pictures by what it sells, in the words it would actually type', () => {
  const found = (query: string): readonly string[] => searchTradeMarks(query, 8).map((r) => r.picture.id);

  // English, where the library's own word is the obvious one.
  assert.ok(found('bread').includes('bread'));
  assert.ok(found('truck').includes('truck'));

  // The trade's own word, including Hindi as it is typed on a phone. The library is an English set
  // drawn abroad, so without this a sweet shop searching "mithai" would be told we have nothing.
  assert.ok(found('mithai').includes('candy') || found('mithai').includes('cake'));
  assert.ok(found('kapda').includes('shirt'));
  assert.ok(found('dawa').includes('pill'));
  assert.ok(found('tyre').includes('wheel') || found('tyre').includes('car'));

  // Two words that no single drawing answers still return something to look at.
  assert.ok(found('plastic dana').length > 0, 'a described trade must never come back empty');

  // The same drawing over and over with a tick or a cog stuck on it is not a choice, it is a wall.
  assert.deepEqual(tradeMarkPictures().filter((p) => p.id.endsWith('-cog')), []);
});

test('a search with nothing in it returns nothing, rather than the whole library', () => {
  assert.deepEqual(searchTradeMarks(''), []);
  assert.deepEqual(searchTradeMarks('   '), []);
});

// ------------------------------------------------------------------- what a business ends up with

test('a picture is frozen into the choice, so printing needs neither the library nor a network', () => {
  const choice = tradeMarkFromLibrary('apple');
  assert.equal(choice.source, 'LIBRARY');
  assert.equal(choice.pictureId, 'apple');
  assert.ok(choice.imageDataUri.startsWith('data:image/svg+xml'));
  // Nothing inside the picture reaches out: it is strokes and nothing else. (The `xmlns` in an SVG
  // reads like a web address but is only a name, and nothing is fetched from it.)
  assert.ok(!choice.imageDataUri.includes('%3Cimage'), 'a bill must not fetch anything to print');
  assert.ok(!choice.imageDataUri.includes('href'), 'a bill must not fetch anything to print');

  // The same picture, every time. A reprint in three years is the drawing the customer was given.
  assert.equal(choice.imageDataUri, tradeMarkDataUri(tradeMarkPicture('apple')!));
});

test('a picture we do not have is refused rather than quietly dropped', () => {
  assert.throws(() => tradeMarkFromLibrary('not-a-real-picture'), (e: unknown) => {
    assert.ok(e instanceof DomainError);
    assert.equal(e.code, 'TRADE_MARK_UNKNOWN_PICTURE');
    return true;
  });
});

test('a watermark darker than the cap is refused, exactly as a template touching a required field is', () => {
  assert.throws(
    () => tradeMarkFromLibrary('apple', MAX_TRADE_MARK_OPACITY_PERCENT + 1),
    (e: unknown) => {
      assert.ok(e instanceof DomainError);
      assert.equal(e.code, 'TRADE_MARK_TOO_DARK');
      return true;
    },
  );
  // Fainter than the cap is a business's own business.
  assert.equal(tradeMarkFromLibrary('apple', 2).opacityPercent, 2);
});

test('a mark that points at a web address instead of carrying the picture is refused', () => {
  assert.throws(
    () => tradeMarkFromOwnPicture('https://example.com/logo.png'),
    (e: unknown) => {
      assert.ok(e instanceof DomainError);
      assert.equal(e.code, 'TRADE_MARK_NOT_A_PICTURE');
      return true;
    },
  );
});

test('a library choice that forgot which picture it was is refused', () => {
  assert.throws(
    () => validateTradeMark({ source: 'LIBRARY', pictureId: null, imageDataUri: 'data:image/svg+xml;utf8,x', opacityPercent: 3 }),
    (e: unknown) => {
      assert.ok(e instanceof DomainError);
      assert.equal(e.code, 'TRADE_MARK_NO_PICTURE_ID');
      return true;
    },
  );
});

// ------------------------------------------------------------------- what reaches the paper

test('a bill with no mark is a complete bill, and prints no watermark at all', () => {
  const html = render(doc());
  assert.ok(!html.includes('class="watermark"'));
  // Everything a bill must carry is still there.
  assert.ok(html.includes('INV/26-27/000042'));
  assert.ok(html.includes('07AAAAA0000A1Z4'));
});

test('a chosen mark prints behind the bill, under everything else on the page', () => {
  const html = render(doc({ tradeMark: tradeMarkFromLibrary('apple') }));
  assert.ok(html.includes('class="watermark"'), 'the mark must reach the page');
  assert.ok(html.includes('opacity:0.060'), 'it prints at the faintness that was chosen');
  // Drawn as a picture rather than a CSS background, because a browser printing a page throws
  // backgrounds away and the business would get nothing on paper.
  assert.ok(/<div class="watermark"[^>]*><img /.test(html));
  assert.ok(html.includes('.sheet > *:not(.watermark) { position: relative; z-index: 1; }'));
  assert.ok(html.includes('pointer-events: none'));
});

test('a mark stored darker than the cap is still printed at the cap', () => {
  // Belt and braces: the setter refuses it, and the renderer will not honour it even if a stored
  // record from somewhere else says otherwise. The thing under the watermark is the tax.
  const tampered = { source: 'LIBRARY' as const, pictureId: 'apple', imageDataUri: 'data:image/svg+xml;utf8,x', opacityPercent: 80 };
  const html = render(doc({ tradeMark: tampered }));
  assert.ok(html.includes(`opacity:${(MAX_TRADE_MARK_OPACITY_PERCENT / 100).toFixed(3)}`));
  assert.ok(!html.includes('opacity:0.800'));
});

test('till roll never gets a watermark, on any design', () => {
  const withMark = doc({ tradeMark: tradeMarkFromLibrary('apple') });
  for (const format of ['THERMAL_58MM', 'THERMAL_80MM'] as const) {
    const html = render(withMark, format);
    assert.ok(!html.includes('class="watermark"'), `${format} prints one ink and no grey`);
    // The bill itself is untouched.
    assert.ok(html.includes('INV/26-27/000042'));
  }
});

test('the mark never becomes a template’s decision', () => {
  // A design cannot switch it on: it prints because the document carries one, and for no other
  // reason. Rendering the same document on every shipped design proves the design is not the gate.
  const withMark = doc({ tradeMark: tradeMarkFromLibrary('apple') });
  for (const id of ['india-standard', 'services-simple']) {
    const template = templateById(id) as TemplateDefinition;
    const html = renderInvoice(withMark, captureSnapshot(template, 'en-IN', '2026-08-29'), {
      format: 'A4',
      locale: 'en-IN',
    });
    assert.ok(html.includes('class="watermark"'), `${id} must print the business’s own choice`);
  }
});
