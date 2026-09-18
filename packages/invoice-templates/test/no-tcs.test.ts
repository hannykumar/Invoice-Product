/**
 * Issue #184 — no sales bill carries tax collected at source (TCS).
 *
 * TCS on the sale of goods above ₹50 lakh a year stopped on 1 April 2025 (Finance Act 2025, proviso
 * to section 206C(1H); the Income-tax Act 2025 has no such entry). Issue #145 had built it as
 * current law, behind a switch. The switch was the defect, so these tests check that there is no
 * switch left, and that a customer whose year passes ₹50 lakh gets an ordinary bill: on the total,
 * on the printed page, and in the books.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toDecimalString } from '@invoice/kernel';
import * as gstCalc from '@invoice/gst-calc';
import { DEFAULT_SALES_POLICY, type SalesPolicy } from '@invoice/sales';
import { ABC, inr, makeTill, on, qty } from '../../sales/test/fixtures.ts';
import { captureSnapshot } from '../src/snapshot.ts';
import { renderInvoice } from '../src/render.ts';
import { SHIPPED_TEMPLATES } from '../src/template.ts';
import { toInvoiceDocument } from '../src/from-sales.ts';

/**
 * The setting #145 shipped, switched on: ₹50 lakh a year per customer, 0.1% above it. A business
 * that still has it saved must get no TCS from it, so every sale below is made with it in place.
 */
const OLD_SWITCHED_ON_SETTING = {
  tcs: { collects: true, thresholdPerCustomerPerYear: inr(5000000), ratePercentTimes100: 10n, rateWithoutTaxNumberPercentTimes100: 100n },
} as Partial<SalesPolicy>;

/** Two identical sales to ABC Traders: 3,000 crates at ₹1,000 = ₹30,00,000 taxable, at 18% GST. */
const twoThirtyLakhSales = async () => {
  const till = await makeTill({ policy: OLD_SWITCHED_ON_SETTING });
  const issued = [];
  for (const n of [1, 2]) {
    const draft = await till.service.createDraft(till.actor, {
      idempotencyKey: `no-tcs-${n}`,
      input: {
        partyId: ABC,
        customerType: 'B2B',
        supplyKind: 'GOODS',
        documentDate: on('2026-04-10'),
        lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: qty('3000', 'PCS'), unitPrice: inr(1000), priceBasis: 'EXCLUSIVE' }],
      },
    });
    issued.push(await till.service.finalise(till.actor, { idempotencyKey: `no-tcs-f${n}`, invoiceId: draft.id }));
  }
  return { till, first: issued[0]!, second: issued[1]! };
};

test('there is no TCS switch left for a business to turn on', () => {
  assert.equal('tcs' in DEFAULT_SALES_POLICY, false, 'the sales policy must not carry a TCS setting');
  for (const name of ['computeTcs', 'DEFAULT_TCS_POLICY']) {
    assert.equal(name in gstCalc, false, `the tax calculator must not export ${name}`);
  }
});

test('a customer whose year passes ₹50 lakh is charged GST and nothing else', async () => {
  const { first, second } = await twoThirtyLakhSales();

  // GST on each: 18% of ₹30,00,000 = ₹5,40,000. Each bill: ₹30,00,000 + ₹5,40,000 = ₹35,40,000.
  // The customer's year: ₹35,40,000 + ₹35,40,000 = ₹70,80,000, which is past ₹50,00,000.
  for (const { invoice } of [first, second]) {
    const totals = invoice.pricing!.totals;
    assert.equal(toDecimalString(totals.taxableValue), '3000000.00');
    assert.equal(toDecimalString(totals.totalTax), '540000.00');
    assert.equal(toDecimalString(totals.invoiceValue), '3540000.00');
    assert.equal('tcs' in totals, false, 'the totals must not carry a TCS figure');
    assert.equal('tcs' in invoice.pricing!, false, 'the pricing must not carry a TCS working');
  }
});

test('the printed second bill says nothing about tax collected at source', async () => {
  const { second } = await twoThirtyLakhSales();
  const document = toInvoiceDocument(second.invoice, {
    title: 'TAX_INVOICE',
    seller: { name: 'Sharma Fruit Traders', addressLines: ['Karol Bagh, New Delhi 110005'], gstin: '07AAAAA0000A1Z4', stateCode: '07', stateName: 'Delhi' },
    buyer: { name: 'ABC Traders', addressLines: ['Shop 8, Azadpur Mandi'], gstin: '07DDDDD3333D1ZV', stateCode: '07', stateName: 'Delhi' },
    placeOfSupplyStateName: 'Delhi',
  });
  for (const template of SHIPPED_TEMPLATES) {
    for (const locale of ['en-IN', 'hi-IN'] as const) {
      const html = renderInvoice(document, captureSnapshot(template, locale, '2026-04-10'), { format: 'A4', locale });
      assert.ok(html.includes('35,40,000.00'), `${template.id}/${locale} must print the total of ₹35,40,000`);
      for (const words of ['TCS', 'Tax collected', 'Sarkar ke liye liya gaya tax']) {
        assert.ok(!html.includes(words), `${template.id}/${locale} prints "${words}"`);
      }
    }
  }
});

test('the books hold nothing for the government beyond GST', async () => {
  const { till, second } = await twoThirtyLakhSales();
  const voucher = await till.ledger.getVoucher(till.actor, second.voucherId);
  assert.ok(voucher !== null);
  assert.equal(
    voucher.lines.find((l) => l.accountId === till.account('TCS_PAYABLE')),
    undefined,
    'nothing may be posted to account 2400',
  );
  const debits = voucher.lines.reduce((a, l) => a + l.debit.minor, 0n);
  assert.equal(debits, 354000000n, 'the customer is debited ₹35,40,000 and not a paisa more');
});
