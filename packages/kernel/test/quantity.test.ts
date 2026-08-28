/** Issue #4 [E04] / #12 [E12] — quantities must be exact and never silently rounded. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addQuantity,
  compareQuantity,
  convertQuantity,
  formatQuantity,
  isQuantityNegative,
  quantity,
  quantityFromString,
  subtractQuantity,
  sumQuantity,
  toQuantityString,
  UnitMismatchError,
} from '../src/quantity.ts';
import { financialYearOf, financialYearRange, formatDate, isoDate, monthKeyOf, monthRange } from '../src/dates.ts';

test('quantities are exact', () => {
  assert.equal(toQuantityString(quantity(70, 'BOX')), '70');
  assert.equal(toQuantityString(quantityFromString('1.5', 'KG')), '1.5');
  assert.equal(toQuantityString(quantityFromString('0.000001', 'KG')), '0.000001');
  const third = quantityFromString('0.1', 'KG');
  const twoThirds = quantityFromString('0.2', 'KG');
  assert.equal(toQuantityString(addQuantity(third, twoThirds)), '0.3');
});

test('more precision than we hold is refused, not rounded', () => {
  assert.throws(() => quantityFromString('0.0000001', 'KG'), RangeError);
  assert.throws(() => quantityFromString('two', 'KG'), RangeError);
});

test('two units can never be added by accident', () => {
  assert.throws(() => addQuantity(quantity(1, 'BOX'), quantity(1, 'KG')), UnitMismatchError);
});

test('unit conversion is exact or it fails', () => {
  const boxes = quantity(7, 'BOX');
  assert.equal(toQuantityString(convertQuantity(boxes, 'KG', 10n, 1n)), '70');
  assert.throws(() => convertQuantity(quantityFromString('1', 'BOX'), 'KG', 1n, 3n), RangeError);
});

test('the stock arithmetic of worked example 4 holds', () => {
  const purchased = quantity(100, 'BOX');
  const sold = quantity(70, 'BOX');
  const remaining = subtractQuantity(purchased, sold);
  assert.equal(toQuantityString(remaining), '30');
  const wanted = quantity(70, 'BOX');
  const shortfall = subtractQuantity(wanted, remaining);
  assert.equal(toQuantityString(shortfall), '40');
  assert.equal(compareQuantity(remaining, wanted), -1);
  assert.ok(isQuantityNegative(subtractQuantity(remaining, wanted)));
  assert.equal(formatQuantity(remaining), '30 BOX');
  assert.equal(toQuantityString(sumQuantity([purchased, { scaled: -sold.scaled, unit: 'BOX' }], 'BOX')), '30');
});

test('the Indian financial year is derived, not configured per call', () => {
  assert.equal(financialYearOf(isoDate('2026-04-01')), '2026-27');
  assert.equal(financialYearOf(isoDate('2027-03-31')), '2026-27');
  assert.equal(financialYearOf(isoDate('2026-03-31')), '2025-26');
  assert.deepEqual(financialYearRange('2026-27'), { from: '2026-04-01', to: '2027-03-31' });
});

test('monthly periods and dates behave', () => {
  assert.equal(monthKeyOf(isoDate('2026-04-15')), '2026-04');
  assert.deepEqual(monthRange('2026-02'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(monthRange('2028-02'), { from: '2028-02-01', to: '2028-02-29' });
  assert.equal(formatDate(isoDate('2026-04-15')), '15 April 2026');
  assert.throws(() => isoDate('2026-02-30'), RangeError);
  assert.throws(() => isoDate('15/04/2026'), RangeError);
});
