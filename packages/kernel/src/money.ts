/**
 * Money.
 *
 * Amounts are exact integers of the smallest unit of the currency — paise for the rupee. No
 * floating-point number ever holds an amount anywhere in this product, because 0.1 + 0.2 is not
 * 0.3 and a ledger that believes otherwise is not a ledger.
 *
 * See docs/product/00-principles-and-scope.md, assumption A3.
 */
import { divideRound, DEFAULT_ROUNDING, type RoundingMode } from './rounding.ts';

/** Only the rupee is supported at first release (assumption A1). */
export type Currency = 'INR';

export const MINOR_UNITS: Record<Currency, number> = { INR: 2 };

export interface Money {
  readonly currency: Currency;
  /** Exact amount in the currency's smallest unit. ₹1,180.00 is 118000n paise. */
  readonly minor: bigint;
}

export class CurrencyMismatchError extends Error {
  constructor(a: Currency, b: Currency) {
    super(`Cannot combine ${a} with ${b}. This product is single-currency (assumption A1).`);
    this.name = 'CurrencyMismatchError';
  }
}

export const money = (minor: bigint, currency: Currency = 'INR'): Money => ({ currency, minor });

export const zero = (currency: Currency = 'INR'): Money => money(0n, currency);

/** ₹1,180.00 is `rupees(1180)`; ₹1,179.99 is `rupees(1179, 99)`. */
export const rupees = (whole: number | bigint, paise: number | bigint = 0): Money =>
  money(BigInt(whole) * 100n + BigInt(paise));

const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;

/**
 * Parses an exact decimal string such as "1180.00" or "-0.01".
 *
 * More decimal places than the currency supports is refused rather than rounded, because a
 * silently rounded input is a silently wrong amount.
 */
export const fromDecimalString = (value: string, currency: Currency = 'INR'): Money => {
  const match = DECIMAL.exec(value.trim());
  if (match === null) throw new RangeError(`"${value}" is not an exact decimal amount`);
  const scale = MINOR_UNITS[currency];
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = BigInt(match[2] as string);
  const fractionText = match[3] ?? '';
  if (fractionText.length > scale) {
    throw new RangeError(`"${value}" has more than ${scale} decimal places, which ${currency} cannot represent exactly`);
  }
  const fraction = BigInt(fractionText.padEnd(scale, '0') === '' ? '0' : fractionText.padEnd(scale, '0'));
  return money(sign * (whole * 10n ** BigInt(scale) + fraction), currency);
};

const same = (a: Money, b: Money): void => {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
};

export const add = (a: Money, b: Money): Money => {
  same(a, b);
  return money(a.minor + b.minor, a.currency);
};

export const subtract = (a: Money, b: Money): Money => {
  same(a, b);
  return money(a.minor - b.minor, a.currency);
};

export const negate = (a: Money): Money => money(-a.minor, a.currency);

export const absolute = (a: Money): Money => money(a.minor < 0n ? -a.minor : a.minor, a.currency);

export const sum = (amounts: readonly Money[], currency: Currency = 'INR'): Money =>
  amounts.reduce((acc, m) => add(acc, m), zero(currency));

export const isZero = (a: Money): boolean => a.minor === 0n;
export const isNegative = (a: Money): boolean => a.minor < 0n;
export const isPositive = (a: Money): boolean => a.minor > 0n;

export const compare = (a: Money, b: Money): -1 | 0 | 1 => {
  same(a, b);
  return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0;
};

export const equals = (a: Money, b: Money): boolean => a.currency === b.currency && a.minor === b.minor;

export const min = (a: Money, b: Money): Money => (compare(a, b) <= 0 ? a : b);
export const max = (a: Money, b: Money): Money => (compare(a, b) >= 0 ? a : b);

/**
 * Multiplies an amount by the exact fraction `numerator / denominator` and rounds once.
 *
 * This is how a percentage is applied: 18% is `mulDiv(amount, 18n, 100n)`. Rates are passed as
 * exact integer fractions so that a rate can never arrive as 0.1799999999.
 */
export const mulDiv = (
  amount: Money,
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode = DEFAULT_ROUNDING,
): Money => money(divideRound(amount.minor * numerator, denominator, mode), amount.currency);

export const multiply = (amount: Money, factor: bigint): Money => money(amount.minor * factor, amount.currency);

/**
 * Splits an amount into `parts` shares that add back to exactly the original amount.
 *
 * The remainder is spread one minor unit at a time over the first shares, so nothing is created
 * or lost. Used wherever one amount is distributed, such as a payment across invoices.
 */
export const allocateEvenly = (amount: Money, parts: number): Money[] => {
  if (parts <= 0 || !Number.isInteger(parts)) throw new RangeError('allocateEvenly: parts must be a positive integer');
  const n = BigInt(parts);
  const base = amount.minor / n;
  let remainder = amount.minor - base * n;
  const step = remainder < 0n ? -1n : 1n;
  const shares: Money[] = [];
  for (let i = 0; i < parts; i += 1) {
    let share = base;
    if (remainder !== 0n) {
      share += step;
      remainder -= step;
    }
    shares.push(money(share, amount.currency));
  }
  return shares;
};

/**
 * Splits an amount in proportion to `weights`, giving the leftover minor units to the largest
 * weights first. The shares always add back to exactly the original amount.
 */
export const allocateByWeight = (amount: Money, weights: readonly bigint[]): Money[] => {
  if (weights.length === 0) throw new RangeError('allocateByWeight: needs at least one weight');
  if (weights.some((w) => w < 0n)) throw new RangeError('allocateByWeight: weights must not be negative');
  const total = weights.reduce((a, w) => a + w, 0n);
  if (total === 0n) return allocateEvenly(amount, weights.length);
  const shares = weights.map((w) => divideRound(amount.minor * w, total, 'DOWN'));
  let remainder = amount.minor - shares.reduce((a, s) => a + s, 0n);
  const order = weights
    .map((w, i) => ({ w, i }))
    .sort((a, b) => (b.w === a.w ? a.i - b.i : b.w > a.w ? 1 : -1));
  const step = remainder < 0n ? -1n : 1n;
  let cursor = 0;
  while (remainder !== 0n) {
    const target = order[cursor % order.length] as { i: number };
    shares[target.i] = (shares[target.i] as bigint) + step;
    remainder -= step;
    cursor += 1;
  }
  return shares.map((s) => money(s, amount.currency));
};

/** Exact decimal string, e.g. "1180.00". Never locale-formatted; this is the wire format. */
export const toDecimalString = (a: Money): string => {
  const scale = MINOR_UNITS[a.currency];
  const negative = a.minor < 0n;
  const digits = (negative ? -a.minor : a.minor).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
};

/**
 * Indian digit grouping with the rupee sign, e.g. "₹1,00,000.00".
 *
 * Display only. Issue #46 owns the wording around it; this owns the digits.
 */
export const formatINR = (a: Money): string => {
  const decimal = toDecimalString(a);
  const negative = decimal.startsWith('-');
  const [whole, fraction] = (negative ? decimal.slice(1) : decimal).split('.') as [string, string];
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest === '' ? last3 : `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
  return `${negative ? '-' : ''}₹${grouped}.${fraction}`;
};

/**
 * Rounds an amount to a whole rupee. Used for the invoice round-off, where the difference is
 * itself posted so the voucher still balances.
 */
export const roundToWholeUnits = (a: Money, mode: RoundingMode = DEFAULT_ROUNDING): Money => {
  const factor = 10n ** BigInt(MINOR_UNITS[a.currency]);
  return money(divideRound(a.minor, factor, mode) * factor, a.currency);
};
