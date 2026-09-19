/**
 * Issue #188 — freight on the printed HSN summary and in the GSTR-1 HSN table.
 *
 * The bill is the demo bill (`npm run demo:invoice`): three goods lines and ₹1,500 of freight.
 * Before the fix the summary printed three extra dash rows for the freight, and the GSTR-1 HSN
 * table left the ₹1,500 out altogether.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { asId, isoDate, toDecimalString, type Money } from '@invoice/kernel';
import { GstCalculator, InMemoryDeclaredRates, RateTable, type ComputeResult } from '@invoice/gst-calc';
import { RulesEngine, shippedRegistry } from '@invoice/rules-engine';
import { SOURCE, SHARMA, inr, makeCalculator, on, qty } from '../../gst-calc/test/fixtures.ts';
import { buildGstr1 } from '../../gst-returns/src/gstr1.ts';
import { salesInvoiceToDocument } from '../../gst-returns/src/adapters.ts';
import { B2clThresholdTable } from '../../gst-returns/src/thresholds.ts';
import { taxPeriod } from '../../gst-returns/src/types.ts';
import { hsnSummary } from '../src/hsn-summary.ts';
import { renderableLine } from '../src/from-sales.ts';

/** The demo's own rates, as the business declared them: crates at 18%, juice at 5%. */
const declare = (code: string, rate: bigint) => ({
  companyId: SHARMA, code, kind: 'GOODS' as const, ratePercentTimes100: rate,
  effectiveFrom: isoDate('2026-04-01'), effectiveTo: null,
  declaredBy: asId<'User'>('demo-owner'), declaredOn: isoDate('2026-04-01'), basis: 'The rate the business charges',
});

const demoBill = () => {
  const { masterData } = makeCalculator();
  const calculator = new GstCalculator({
    masterData,
    rates: new RateTable([]),
    gstEngine: new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.gst', mode: 'production' }),
    mode: 'production',
    declaredRates: new InMemoryDeclaredRates().declare(declare('3923', 1800n)).declare(declare('2009', 500n)),
  });
  const result = calculator.compute({
    companyId: SHARMA,
    documentDate: on('2026-08-20'),
    partyId: 'abc-traders',
    supplyKind: 'GOODS',
    lines: [
      { lineId: 'l1', itemId: 'APL-BOX-10', quantity: qty('70', 'BOX'), unitPrice: inr(800), priceBasis: 'EXCLUSIVE' },
      { lineId: 'l2', itemId: 'CRATE-P', quantity: qty('40', 'PCS'), unitPrice: inr(210), priceBasis: 'EXCLUSIVE' },
      { lineId: 'l3', itemId: 'JUICE-1L', quantity: qty('120', 'PCS'), unitPrice: inr(95), priceBasis: 'EXCLUSIVE', discount: { kind: 'PERCENT', percentTimes100: 500n } },
    ],
    freight: inr(1500),
    source: SOURCE,
  });
  assert.equal(result.status, 'COMPUTED', result.status === 'CANNOT_COMPUTE' ? result.explanation['en-IN'] : '');
  return result as Extract<ComputeResult, { status: 'COMPUTED' }>;
};

const d = (m: Money): string => toDecimalString(m);

test('the printed HSN summary has only real codes: freight sits inside 0808, 3923 and 2009', () => {
  const bill = demoBill();
  const summary = hsnSummary({ lines: bill.lines.map((l) => renderableLine(l)), split: 'CGST_SGST' });

  assert.deepEqual(
    summary.rows.map((r) => [r.code, d(r.taxableValue), d(r.cgst), d(r.sgst), d(r.totalTax)]),
    [
      // 56,000.00 + 1,116.58 of freight = 57,116.58, no tax.
      ['0808', '57116.58', '0.00', '0.00', '0.00'],
      // 8,400.00 + 167.48 = 8,567.48. CGST 756.00 + 15.07 = 771.07, SGST the same.
      ['3923', '8567.48', '771.07', '771.07', '1542.14'],
      // 10,830.00 + 215.94 = 11,045.94. CGST 270.75 + 5.40 = 276.15, SGST the same.
      ['2009', '11045.94', '276.15', '276.15', '552.30'],
    ],
  );
  assert.ok(summary.rows.every((r) => r.code !== null), 'no dash rows');

  // The totals row must still equal the bill.
  assert.equal(d(summary.totals.taxableValue), '76730.00');
  assert.equal(d(summary.totals.taxableValue), d(bill.totals.taxableValue));
  assert.equal(d(summary.totals.cgst), '1047.22');
  assert.equal(d(summary.totals.sgst), '1047.22');
  assert.equal(d(summary.totals.totalTax), '2094.44');
});

test('the GSTR-1 HSN table carries the freight: its taxable total equals the bill and the B2B table', () => {
  const bill = demoBill();
  const document = salesInvoiceToDocument(
    {
      id: 'inv-demo', companyId: 'company-sharma' as never, state: 'FINAL', number: 'INV/26-27/000001',
      documentDate: '2026-08-20', partyId: 'abc-traders', customerType: 'B2B', placeOfSupplyStateCode: '07',
      voucherId: 'vch-demo', pricing: { lines: bill.lines, totals: { invoiceValue: bill.totals.invoiceValue } },
    },
    { name: 'ABC Traders', gstin: '07DDDDD3333D1ZV', stateCode: '07', unregisteredConfirmed: false },
    { gstin: '07AAAAA0000A1Z4', stateCode: '07' },
  );
  const built = buildGstr1(
    { period: taxPeriod('2026-08'), gstin: '07AAAAA0000A1Z4', documents: [document] },
    { thresholds: new B2clThresholdTable(), mode: 'development' },
  );

  const hsnTaxable = built.return.hsn.reduce((acc, r) => acc + r.amounts.taxableValue.minor, 0n);
  const b2b = built.return.sections.find((s) => s.id === 'B2B');
  assert.ok(b2b !== undefined, 'the demo bill is a sale to a registered business');
  assert.equal(toDecimalString({ currency: 'INR', minor: hsnTaxable }), '76730.00');
  assert.equal(hsnTaxable, b2b.totals.taxableValue.minor);

  const hsnCgst = built.return.hsn.reduce((acc, r) => acc + r.amounts.cgst.minor, 0n);
  assert.equal(toDecimalString({ currency: 'INR', minor: hsnCgst }), '1047.22');

  assert.deepEqual(built.return.hsn.map((r) => r.hsnOrSac).sort(), ['0808', '2009', '3923']);
  // Freight adds value, never quantity: 3923 is still the 40 crates on the bill.
  assert.equal(built.return.hsn.find((r) => r.hsnOrSac === '3923')?.quantity, '40');
  assert.ok(
    !built.findings.some((f) => f.code === 'GSTR1_HSN_MISSING'),
    'the demo bill must not be listed as having a line with no code',
  );
});
