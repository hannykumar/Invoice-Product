/**
 * Issue #143 — export and SEZ bills print with their title, the Rule 46 endorsement, the shipping
 * bill, the currency and the right tax treatment, from the same classification the e-invoice uses.
 *
 * Real sales through the real till (#9) and calculator (#25), not hand-built documents: the bill is
 * priced as zero-rated, finalised, posted, and only then printed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toDecimalString } from '@invoice/kernel';
import { EXPORT_SUPPLIES, type ExportParticulars } from '@invoice/gst';
import { ABC, inr, makeTill, on, qty } from '../../sales/test/fixtures.ts';
import { captureSnapshot } from '../src/snapshot.ts';
import { renderInvoice } from '../src/render.ts';
import { SHIPPED_TEMPLATES } from '../src/template.ts';
import { toInvoiceDocument } from '../src/from-sales.ts';

const SELLER = { name: 'Sharma Fruit Traders', addressLines: ['Karol Bagh, New Delhi 110005'], gstin: '07AAAAA0000A1Z4', stateCode: '07', stateName: 'Delhi' };
const BUYER = { name: 'ABC Traders', addressLines: ['Shop 8, Azadpur Mandi'], gstin: '07DDDDD3333D1ZV', stateCode: '07', stateName: 'Delhi' };

/** 10 crates at ₹1,000, 18% GST, sold the way `particulars` says. */
const sale = async (particulars: ExportParticulars | null) => {
  const till = await makeTill();
  const supply = particulars === null ? null : EXPORT_SUPPLIES[particulars.kind];
  const draft = await till.service.createDraft(till.actor, {
    idempotencyKey: `export-${particulars?.kind ?? 'domestic'}`,
    input: {
      partyId: ABC,
      customerType: 'B2B',
      supplyKind: 'GOODS',
      documentDate: on('2026-04-10'),
      lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: qty('10', 'PCS'), unitPrice: inr(1000), priceBasis: 'EXCLUSIVE' }],
      ...(supply === null || !supply.zeroRated ? {} : { zeroRated: supply.taxPaid ? 'WITH_TAX' as const : 'WITHOUT_TAX' as const }),
    },
  });
  const final = await till.service.finalise(till.actor, { idempotencyKey: `export-f-${particulars?.kind ?? 'domestic'}`, invoiceId: draft.id });
  const print = (exportSupply: ExportParticulars | null = particulars) =>
    toInvoiceDocument(final.invoice, { title: 'TAX_INVOICE', seller: SELLER, buyer: BUYER, placeOfSupplyStateName: 'Delhi', exportSupply });
  return { till, final, print };
};

const everyPage = (document: ReturnType<Awaited<ReturnType<typeof sale>>['print']>) =>
  SHIPPED_TEMPLATES.flatMap((template) =>
    (['A4', 'THERMAL_80MM'] as const).map((format) => ({
      where: `${template.id}/${format}`,
      html: renderInvoice(document, captureSnapshot(template, 'en-IN', '2026-04-10'), { format, locale: 'en-IN' }),
    })));

const LUT_EXPORT: ExportParticulars = {
  kind: 'EXPORT_WITHOUT_PAYMENT', countryCode: 'AE', currency: 'USD', exchangeRate: '83.25',
  shippingBill: { number: '4455667', date: '2026-04-12' as never, portCode: 'INNSA1' },
};

test('an export under LUT prints its title, the endorsement, the shipping bill and the dollars, with no tax', async () => {
  const { final, print } = await sale(LUT_EXPORT);
  assert.equal(toDecimalString(final.invoice.pricing!.totals.totalTax), '0.00');
  assert.equal(toDecimalString(final.invoice.pricing!.totals.invoiceValue), '10000.00');
  for (const { where, html } of everyPage(print())) {
    assert.ok(html.includes('Tax Invoice — Export'), `${where}: title`);
    assert.ok(html.includes('SUPPLY MEANT FOR EXPORT UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX'), `${where}: endorsement`);
    assert.ok(html.includes('United Arab Emirates'), `${where}: country`);
    assert.ok(html.includes('4455667, 12'), `${where}: shipping bill number and date`);
    assert.ok(html.includes('INNSA1'), `${where}: port`);
    assert.ok(html.includes('1 USD = ₹83.25'), `${where}: rate`);
    assert.ok(html.includes('USD 120.12'), `${where}: value in dollars`);
    assert.ok(html.includes('IGST (not charged: under bond or LUT)'), `${where}: the tax section says why there is no tax`);
    assert.ok(!html.includes('>CGST<') && !html.includes('>SGST<'), `${where}: no CGST or SGST`);
  }
});

test('an export on payment of tax is integrated tax, even with both parties in one state', async () => {
  const { final, print } = await sale({ kind: 'EXPORT_WITH_PAYMENT', countryCode: 'US' });
  const totals = final.invoice.pricing!.totals;
  assert.equal(toDecimalString(totals.igst), '1800.00');
  assert.equal(toDecimalString(totals.cgst), '0.00');
  for (const { where, html } of everyPage(print())) {
    assert.ok(html.includes('SUPPLY MEANT FOR EXPORT ON PAYMENT OF INTEGRATED TAX'), where);
    assert.ok(html.includes('United States'), where);
    assert.ok(!html.includes('Shipping Bill'), `${where}: no empty shipping bill label before one exists`);
    assert.ok(!html.includes('Exchange Rate'), `${where}: a sale in rupees prints no rate`);
    assert.ok(!html.includes('not charged'), where);
  }
});

test('an SEZ supply prints its own title and endorsement, in rupees', async () => {
  const { print } = await sale({ kind: 'SEZ_WITHOUT_PAYMENT' });
  for (const { where, html } of everyPage(print())) {
    assert.ok(html.includes('Tax Invoice — Supply to SEZ'), where);
    assert.ok(html.includes('SUPPLY TO SEZ UNIT OR SEZ DEVELOPER FOR AUTHORISED OPERATIONS UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX'), where);
    assert.ok(!html.includes('Country of Destination'), where);
  }
});

test('a deemed export is taxed like any sale and says what it is', async () => {
  const { final, print } = await sale({ kind: 'DEEMED_EXPORT' });
  assert.equal(toDecimalString(final.invoice.pricing!.totals.cgst), '900.00');
  const html = everyPage(print())[0]!.html;
  assert.ok(html.includes('Tax Invoice — Deemed Export'));
  assert.ok(html.includes('NOTIFICATION 48/2017-CENTRAL TAX'));
});

test('an ordinary bill prints exactly as before', async () => {
  const { print } = await sale(null);
  for (const { where, html } of everyPage(print())) {
    assert.ok(!html.includes('Export') && !html.includes('SEZ') && !html.includes('not charged'), where);
  }
});

test('the paper cannot disagree with the tax: a mismatch is refused, never printed', async () => {
  const ordinary = await sale(null);
  assert.throws(() => ordinary.print(LUT_EXPORT), /worked out for a different kind of sale/);
  const underLut = await sale(LUT_EXPORT);
  assert.throws(() => underLut.print(null), /printed as an ordinary one/);
  assert.throws(() => underLut.print({ kind: 'SEZ_WITH_PAYMENT' }), /worked out for a different kind of sale/);
});

test('the books of a sale under LUT carry no tax, and the customer owes the goods value', async () => {
  const { till, final } = await sale(LUT_EXPORT);
  const voucher = await till.ledger.getVoucher(till.actor, final.voucherId);
  assert.ok(voucher !== null);
  const debits = voucher.lines.reduce((a, l) => a + l.debit.minor, 0n);
  const credits = voucher.lines.reduce((a, l) => a + l.credit.minor, 0n);
  assert.equal(debits, 1_000_000n);
  assert.equal(credits, debits);
});
