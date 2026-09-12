/**
 * Issue #145 — tax collected at source.
 *
 * The cases that decide whether a wholesaler's bills are right:
 *
 *  - nothing is collected until the year's sales to that one customer cross the threshold,
 *  - the bill that crosses it is charged only on the part above the line, not on the whole bill,
 *  - the amount never enters any GST figure, and
 *  - the threshold and the rate are settings, so a change in the law is a change in configuration.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rupees, toDecimalString } from '@invoice/kernel';
import { lintUserFacingText } from '../../ux-vocabulary/src/lint.ts';
import { DEFAULT_TCS_POLICY, type TcsPolicy } from '../src/tcs.ts';
import { SOURCE, SHARMA, inr, makeCalculator, on, qty } from './fixtures.ts';
import type { ComputeInput, ComputeResult } from '../src/compute.ts';

const COLLECTING: TcsPolicy = { ...DEFAULT_TCS_POLICY, collects: true };

const computed = (result: ComputeResult) => {
  assert.equal(result.status, 'COMPUTED', result.status === 'CANNOT_COMPUTE' ? result.explanation['en-IN'] : '');
  return result as Extract<ComputeResult, { status: 'COMPUTED' }>;
};

/** A ₹10,00,000 sale of crates at 18%, which comes to ₹11,80,000 with GST. */
const bigSale = (priorSalesThisYear: ReturnType<typeof rupees> | null, policy: TcsPolicy = COLLECTING): ComputeInput => ({
  companyId: SHARMA,
  documentDate: on('2026-04-10'),
  partyId: 'abc-traders',
  supplyKind: 'GOODS',
  lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: qty('1000', 'PCS'), unitPrice: inr(1000), priceBasis: 'EXCLUSIVE' }],
  source: SOURCE,
  ...(priorSalesThisYear === null
    ? {}
    : { tcs: { policy, financialYear: '2026-27', priorSalesThisYear } }),
});

test('nothing is collected while the year is still short of the threshold', () => {
  const { calculator } = makeCalculator();
  const result = computed(calculator.compute(bigSale(rupees(1000000))));

  assert.equal(result.tcsCharge, null);
  assert.equal(toDecimalString(result.totals.tcs), '0.00');
  assert.equal(toDecimalString(result.totals.invoiceValue), '1180000.00');
});

test('the bill that crosses the threshold is charged only on the part above it', () => {
  const { calculator } = makeCalculator();
  // ₹45,00,000 already billed, ₹11,80,000 on this bill: ₹6,80,000 of it sits above ₹50,00,000.
  const result = computed(calculator.compute(bigSale(rupees(4500000))));

  const tcs = result.tcsCharge;
  assert.ok(tcs !== null);
  assert.equal(toDecimalString(tcs.chargedOn), '680000.00');
  assert.equal(toDecimalString(tcs.amount), '680.00');
  assert.equal(toDecimalString(tcs.totalSalesThisYear), '5680000.00');
  assert.equal(toDecimalString(result.totals.tcs), '680.00');
  assert.equal(toDecimalString(result.totals.invoiceValue), '1180680.00');
});

test('a customer already past the threshold is charged on the whole bill', () => {
  const { calculator } = makeCalculator();
  const result = computed(calculator.compute(bigSale(rupees(6000000))));

  const tcs = result.tcsCharge;
  assert.ok(tcs !== null);
  assert.equal(toDecimalString(tcs.chargedOn), '1180000.00');
  assert.equal(toDecimalString(tcs.amount), '1180.00');
  assert.equal(toDecimalString(result.totals.invoiceValue), '1181180.00');
});

test('the amount collected at source is never mixed into any GST figure', () => {
  const { calculator } = makeCalculator();
  const plain = computed(calculator.compute(bigSale(null)));
  const withTcs = computed(calculator.compute(bigSale(rupees(6000000))));

  for (const field of ['cgst', 'sgst', 'utgst', 'igst', 'cess', 'totalTax', 'taxableValue'] as const) {
    assert.equal(
      toDecimalString(withTcs.totals[field]),
      toDecimalString(plain.totals[field]),
      `${field} changed when tax was collected at source, and it must not`,
    );
  }
  // The whole difference in what the customer pays is the collected amount itself.
  assert.equal(
    withTcs.totals.invoiceValue.minor - plain.totals.invoiceValue.minor,
    withTcs.totals.tcs.minor,
  );
});

test('the threshold and the rate are settings, so a change in the law needs no new code', () => {
  const { calculator } = makeCalculator();
  const changed: TcsPolicy = {
    ...COLLECTING,
    thresholdPerCustomerPerYear: rupees(2000000),
    ratePercentTimes100: 50n,
  };
  const result = computed(calculator.compute(bigSale(rupees(4500000), changed)));

  const tcs = result.tcsCharge;
  assert.ok(tcs !== null);
  // Already past ₹20,00,000, so the whole ₹11,80,000 is above the line, at 0.50%.
  assert.equal(toDecimalString(tcs.chargedOn), '1180000.00');
  assert.equal(toDecimalString(tcs.amount), '5900.00');
});

test('a business that does not collect at source has nothing added to its bills', () => {
  const { calculator } = makeCalculator();
  const result = computed(calculator.compute(bigSale(rupees(6000000), DEFAULT_TCS_POLICY)));

  assert.equal(result.tcsCharge, null);
  assert.equal(toDecimalString(result.totals.invoiceValue), '1180000.00');
});

test('a customer with no tax number of their own is charged at the higher rate', () => {
  const { calculator } = makeCalculator();
  const walkIn: ComputeInput = {
    ...bigSale(rupees(6000000)),
    partyId: 'walk-in',
    placeOfSupplyStateCode: '07',
  };
  const result = computed(calculator.compute(walkIn));

  const tcs = result.tcsCharge;
  assert.ok(tcs !== null);
  assert.equal(tcs.ratePercentTimes100, 100n);
  assert.equal(toDecimalString(tcs.amount), '11800.00');
});

test('the bill says which customer threshold was crossed, in words a shopkeeper reads', () => {
  const { calculator } = makeCalculator();
  const result = computed(calculator.compute(bigSale(rupees(4500000))));
  const tcs = result.tcsCharge;
  assert.ok(tcs !== null);

  const note = tcs.note['en-IN'];
  assert.match(note, /2026-27/);
  assert.match(note, /50,00,000/);
  assert.match(note, /6,80,000/);
  assert.match(note, /0\.10%/);
  assert.deepEqual(lintUserFacingText(note, { locale: 'en-IN', allow: ['tcs'] }), []);
  assert.deepEqual(lintUserFacingText(tcs.note['hi-IN'], { locale: 'hi-IN', allow: ['tcs'] }), []);
  // The explanation of the whole bill carries it too, after the sentence about GST.
  assert.ok(result.explanation['en-IN'].endsWith(note));
});
