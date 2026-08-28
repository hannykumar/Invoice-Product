/**
 * Quantities.
 *
 * Exact decimals with six places (assumption A4), held as scaled integers for the same reason
 * money is: 0.1 kg + 0.2 kg must be exactly 0.3 kg, and a stock ledger that drifts is a stock
 * ledger that eventually blocks a legitimate sale or allows an impossible one.
 */
export const QUANTITY_SCALE = 6;
const FACTOR = 10n ** BigInt(QUANTITY_SCALE);

export interface Quantity {
  /** Exact amount scaled by 10^6. 70 boxes is 70_000000n. */
  readonly scaled: bigint;
  /** The unit this quantity is expressed in, e.g. "BOX", "KG". */
  readonly unit: string;
}

export class UnitMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Cannot combine a quantity in ${a} with a quantity in ${b}. Convert to the item's base unit first.`);
    this.name = 'UnitMismatchError';
  }
}

export const quantity = (whole: number | bigint, unit: string): Quantity => ({
  scaled: BigInt(whole) * FACTOR,
  unit,
});

const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;

export const quantityFromString = (value: string, unit: string): Quantity => {
  const match = DECIMAL.exec(value.trim());
  if (match === null) throw new RangeError(`"${value}" is not an exact quantity`);
  const fractionText = match[3] ?? '';
  if (fractionText.length > QUANTITY_SCALE) {
    throw new RangeError(`"${value}" has more than ${QUANTITY_SCALE} decimal places; quantities are never rounded silently`);
  }
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = BigInt(match[2] as string);
  const fraction = BigInt(fractionText.padEnd(QUANTITY_SCALE, '0') || '0');
  return { scaled: sign * (whole * FACTOR + fraction), unit };
};

const sameUnit = (a: Quantity, b: Quantity): void => {
  if (a.unit !== b.unit) throw new UnitMismatchError(a.unit, b.unit);
};

export const addQuantity = (a: Quantity, b: Quantity): Quantity => {
  sameUnit(a, b);
  return { scaled: a.scaled + b.scaled, unit: a.unit };
};

export const subtractQuantity = (a: Quantity, b: Quantity): Quantity => {
  sameUnit(a, b);
  return { scaled: a.scaled - b.scaled, unit: a.unit };
};

export const negateQuantity = (a: Quantity): Quantity => ({ scaled: -a.scaled, unit: a.unit });

export const sumQuantity = (items: readonly Quantity[], unit: string): Quantity =>
  items.reduce((acc, q) => addQuantity(acc, q), { scaled: 0n, unit });

export const compareQuantity = (a: Quantity, b: Quantity): -1 | 0 | 1 => {
  sameUnit(a, b);
  return a.scaled < b.scaled ? -1 : a.scaled > b.scaled ? 1 : 0;
};

export const isQuantityZero = (a: Quantity): boolean => a.scaled === 0n;
export const isQuantityNegative = (a: Quantity): boolean => a.scaled < 0n;

/**
 * Converts to another unit using an exact factor, e.g. 1 BOX = 10 KG is `numerator 10n,
 * denominator 1n`. Conversion that would lose precision throws rather than rounding.
 */
export const convertQuantity = (
  q: Quantity,
  toUnit: string,
  numerator: bigint,
  denominator: bigint,
): Quantity => {
  if (denominator === 0n) throw new RangeError('convertQuantity: denominator must not be zero');
  const value = q.scaled * numerator;
  if (value % denominator !== 0n) {
    throw new RangeError(
      `Converting ${toQuantityString(q)} to ${toUnit} would lose precision. Quantities are never rounded silently.`,
    );
  }
  return { scaled: value / denominator, unit: toUnit };
};

/** Exact decimal string with trailing zeros trimmed, e.g. "70" or "1.5". */
export const toQuantityString = (q: Quantity): string => {
  const negative = q.scaled < 0n;
  const digits = (negative ? -q.scaled : q.scaled).toString().padStart(QUANTITY_SCALE + 1, '0');
  const whole = digits.slice(0, digits.length - QUANTITY_SCALE);
  const fraction = digits.slice(digits.length - QUANTITY_SCALE).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`;
};

/** How a quantity is spoken to a person: "70 boxes". Issue #46 owns the unit wording. */
export const formatQuantity = (q: Quantity): string => `${toQuantityString(q)} ${q.unit}`;
