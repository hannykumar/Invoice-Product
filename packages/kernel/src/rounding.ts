/**
 * Rounding, stated once for the whole product.
 *
 * Every rounding decision in this product goes through this file. Two modules that round
 * differently will disagree by a paisa, and a paisa of disagreement is enough to make a voucher
 * fail to balance, which is a release-blocking defect under issue #48.
 */
export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP';

/** The product default. Half-up at two decimals is what an Indian business expects on a bill. */
export const DEFAULT_ROUNDING: RoundingMode = 'HALF_UP';

const abs = (v: bigint): bigint => (v < 0n ? -v : v);

/**
 * Divides `numerator` by `denominator` exactly, then rounds to an integer with the given mode.
 * Sign is handled by rounding the magnitude, so -0.5 and 0.5 round symmetrically.
 */
export const divideRound = (numerator: bigint, denominator: bigint, mode: RoundingMode = DEFAULT_ROUNDING): bigint => {
  if (denominator === 0n) throw new RangeError('divideRound: denominator must not be zero');
  const negative = numerator < 0n !== denominator < 0n;
  const n = abs(numerator);
  const d = abs(denominator);
  const q = n / d;
  const r = n % d;
  let magnitude: bigint;
  if (r === 0n) {
    magnitude = q;
  } else {
    switch (mode) {
      case 'DOWN':
        magnitude = q;
        break;
      case 'UP':
        magnitude = q + 1n;
        break;
      case 'HALF_UP':
        magnitude = r * 2n >= d ? q + 1n : q;
        break;
      case 'HALF_EVEN': {
        const twice = r * 2n;
        if (twice > d) magnitude = q + 1n;
        else if (twice < d) magnitude = q;
        else magnitude = q % 2n === 0n ? q : q + 1n;
        break;
      }
    }
  }
  return negative ? -magnitude : magnitude;
};
