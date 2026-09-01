/**
 * Issue #50 [X02] — the cost model.
 *
 * It computes; it does not estimate. Feed it a quotation and a volume and it says what a year
 * costs; feed it nothing and it says nothing, which is the correct output while nobody has quoted.
 *
 * The volumes are an input rather than a constant on purpose. A GSP's price list has four
 * per-document lines, and which one dominates depends entirely on the business: a hardware shop
 * with fifty e-way bills and two filings a month is a different customer from a distributor with two
 * thousand IRNs and the same two filings. Comparing providers on one imagined business is how the
 * cheap-looking one wins and then costs more.
 *
 * Money is paise in `bigint`, like everywhere else in this product.
 */
import type { CostShape } from './model.ts';

/**
 * What a month looks like for one business.
 *
 * The defaults describe a small trading business of the kind this product is built for. They are
 * a stated assumption, not a measurement, and the CLI prints them beside every figure so nobody
 * mistakes one for the other.
 */
export interface MonthlyVolume {
  readonly irnsPerGstin: number;
  readonly ewayBillsPerGstin: number;
  /** GSTR-1 and GSTR-3B is two, every month, for a monthly filer. */
  readonly returnFilingsPerGstin: number;
  /** Once a month is the minimum; twice is common when a business checks before filing. */
  readonly gstr2bFetchesPerGstin: number;
}

export const TYPICAL_SMALL_BUSINESS: MonthlyVolume = Object.freeze({
  irnsPerGstin: 120,
  ewayBillsPerGstin: 40,
  returnFilingsPerGstin: 2,
  gstr2bFetchesPerGstin: 2,
});

export interface Scale {
  readonly gstins: number;
  readonly volume: MonthlyVolume;
  /** Spread the one-off charge over this many months when judging the monthly figure. */
  readonly amortiseOneOffOverMonths: number;
}

export interface MonthlyCost {
  readonly platform: bigint;
  readonly perGstin: bigint;
  readonly documents: bigint;
  readonly amortisedOneOff: bigint;
  /** What the minimum adds when the usage does not reach it. The number that bites at ten. */
  readonly minimumTopUp: bigint;
  readonly total: bigint;
  readonly perGstinEffective: bigint;
}

export const monthlyCost = (cost: CostShape, scale: Scale): MonthlyCost => {
  const gstins = BigInt(Math.max(0, scale.gstins));
  const volume = scale.volume;
  const months = BigInt(Math.max(1, scale.amortiseOneOffOverMonths));

  const platform = cost.monthlyPlatformFeePaise;
  const perGstin = cost.perGstinPerMonthPaise * gstins;
  const documents =
    cost.perIrnPaise * gstins * BigInt(Math.max(0, volume.irnsPerGstin)) +
    cost.perEwayBillPaise * gstins * BigInt(Math.max(0, volume.ewayBillsPerGstin)) +
    cost.perReturnFilingPaise * gstins * BigInt(Math.max(0, volume.returnFilingsPerGstin)) +
    cost.perGstr2bFetchPaise * gstins * BigInt(Math.max(0, volume.gstr2bFetchesPerGstin));
  const amortisedOneOff = cost.oneOffOnboardingPaise / months;

  const beforeMinimum = platform + perGstin + documents;
  // A minimum is not an extra charge on top; it is a floor the usage is measured against. Adding it
  // as another line would overstate every quotation with one.
  const minimumTopUp = beforeMinimum >= cost.monthlyMinimumPaise ? 0n : cost.monthlyMinimumPaise - beforeMinimum;
  const total = beforeMinimum + minimumTopUp + amortisedOneOff;

  return {
    platform,
    perGstin,
    documents,
    amortisedOneOff,
    minimumTopUp,
    total,
    perGstinEffective: gstins === 0n ? total : total / gstins,
  };
};

/** The three scales the issue names, so every provider is judged on the same curve. */
export const SCALES: readonly number[] = Object.freeze([10, 25, 50]);

export const costCurve = (cost: CostShape, volume: MonthlyVolume = TYPICAL_SMALL_BUSINESS): readonly { readonly gstins: number; readonly monthly: MonthlyCost }[] =>
  SCALES.map((gstins) => ({ gstins, monthly: monthlyCost(cost, { gstins, volume, amortiseOneOffOverMonths: 12 }) }));
