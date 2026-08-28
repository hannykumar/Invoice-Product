/** Issue #4 [E04] — money must be exact. These tests are the reason no float touches an amount. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  add,
  allocateByWeight,
  allocateEvenly,
  compare,
  CurrencyMismatchError,
  equals,
  formatINR,
  fromDecimalString,
  isZero,
  money,
  mulDiv,
  negate,
  roundToWholeUnits,
  rupees,
  subtract,
  sum,
  toDecimalString,
} from '../src/money.ts';
import { divideRound } from '../src/rounding.ts';

test('exact decimals survive parsing and printing', () => {
  assert.equal(toDecimalString(fromDecimalString('1180.00')), '1180.00');
  assert.equal(toDecimalString(fromDecimalString('0.01')), '0.01');
  assert.equal(toDecimalString(fromDecimalString('-0.01')), '-0.01');
  assert.equal(toDecimalString(fromDecimalString('999.99')), '999.99');
  assert.equal(fromDecimalString('1180').minor, 118000n);
  assert.equal(fromDecimalString('1180.5').minor, 118050n);
});

test('an amount with more precision than the rupee is refused, not rounded', () => {
  assert.throws(() => fromDecimalString('1.005'), RangeError);
  assert.throws(() => fromDecimalString('abc'), RangeError);
});

test('the sum that trips up floating point is exact here', () => {
  const tenPaise = fromDecimalString('0.10');
  const twentyPaise = fromDecimalString('0.20');
  assert.ok(equals(add(tenPaise, twentyPaise), fromDecimalString('0.30')));
  const hundredth = fromDecimalString('0.01');
  const hundred = sum(Array.from({ length: 100 }, () => hundredth));
  assert.equal(toDecimalString(hundred), '1.00');
});

test('addition, subtraction and comparison behave', () => {
  assert.ok(equals(subtract(rupees(1180), rupees(180)), rupees(1000)));
  assert.ok(equals(negate(rupees(50)), rupees(-50)));
  assert.equal(compare(rupees(10), rupees(20)), -1);
  assert.equal(compare(rupees(20), rupees(20)), 0);
  assert.ok(isZero(subtract(rupees(5), rupees(5))));
});

test('two currencies can never be combined by accident', () => {
  const inr = rupees(100);
  const other = { currency: 'USD' as unknown as 'INR', minor: 100n };
  assert.throws(() => add(inr, other), CurrencyMismatchError);
});

test('a percentage is applied with an exact fraction and one rounding', () => {
  // 9% of ₹999.99 is ₹89.9991, which rounds half-up to ₹90.00 (worked example 3).
  assert.equal(toDecimalString(mulDiv(fromDecimalString('999.99'), 9n, 100n)), '90.00');
  assert.equal(toDecimalString(mulDiv(fromDecimalString('1000.00'), 18n, 100n)), '180.00');
  assert.equal(toDecimalString(mulDiv(fromDecimalString('40000.00'), 18n, 100n)), '7200.00');
});

test('rounding modes do what they say, including on negatives', () => {
  assert.equal(divideRound(5n, 10n, 'HALF_UP'), 1n);
  assert.equal(divideRound(4n, 10n, 'HALF_UP'), 0n);
  assert.equal(divideRound(-5n, 10n, 'HALF_UP'), -1n);
  assert.equal(divideRound(5n, 10n, 'HALF_EVEN'), 0n);
  assert.equal(divideRound(15n, 10n, 'HALF_EVEN'), 2n);
  assert.equal(divideRound(19n, 10n, 'DOWN'), 1n);
  assert.equal(divideRound(11n, 10n, 'UP'), 2n);
  assert.throws(() => divideRound(1n, 0n), RangeError);
});

test('rounding to whole rupees produces the invoice round-off of worked example 3', () => {
  const beforeRounding = fromDecimalString('1179.99');
  const rounded = roundToWholeUnits(beforeRounding);
  assert.equal(toDecimalString(rounded), '1180.00');
  assert.equal(toDecimalString(subtract(rounded, beforeRounding)), '0.01');
});

test('an even split loses nothing', () => {
  const shares = allocateEvenly(fromDecimalString('100.00'), 3);
  assert.deepEqual(shares.map(toDecimalString), ['33.34', '33.33', '33.33']);
  assert.equal(toDecimalString(sum(shares)), '100.00');
});

test('a weighted split loses nothing and favours the largest weight', () => {
  const shares = allocateByWeight(fromDecimalString('100.00'), [1n, 1n, 1n]);
  assert.equal(toDecimalString(sum(shares)), '100.00');
  const uneven = allocateByWeight(fromDecimalString('1000.01'), [7000n, 3000n]);
  assert.equal(toDecimalString(sum(uneven)), '1000.01');
  assert.deepEqual(uneven.map(toDecimalString), ['700.01', '300.00']);
  const negativeSplit = allocateByWeight(fromDecimalString('-100.00'), [1n, 2n]);
  assert.equal(toDecimalString(sum(negativeSplit)), '-100.00');
});

test('amounts are written the way an Indian business reads them', () => {
  assert.equal(formatINR(rupees(100000)), '₹1,00,000.00');
  assert.equal(formatINR(rupees(1180)), '₹1,180.00');
  assert.equal(formatINR(rupees(0, 1)), '₹0.01');
  assert.equal(formatINR(rupees(-50000)), '-₹50,000.00');
  assert.equal(formatINR(money(1234567890n)), '₹1,23,45,678.90');
});
