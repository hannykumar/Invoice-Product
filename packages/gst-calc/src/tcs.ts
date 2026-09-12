/**
 * Issue #145 — tax collected at source (TCS) on sales to one customer in a financial year.
 *
 * Once a seller's sales to a single buyer cross a threshold in a financial year, the seller must
 * collect a small extra amount from that buyer and pay it to the government. It is not GST: it is
 * not charged on the goods, it is not claimed back as input credit, and it must never be added
 * into a GST figure. It is a separate amount on a separate line.
 *
 * Two things in here decide the money, and both are configuration rather than constants, because
 * the government changes them:
 *
 *  - the threshold, which is per customer per financial year, and
 *  - the rate, which is applied only to the part of the year's sales that sits *above* the
 *    threshold — never to the whole bill and never to the whole year.
 *
 * The arithmetic is deliberately dull. Everything it needs is handed to it: what this customer has
 * already been billed this year, and what this bill comes to including GST.
 */
import { max, money, mulDiv, subtract, rupees, toDecimalString, zero, type Money } from '@invoice/kernel';

/**
 * What a business has been told to collect. Held as configuration so a change in the law is a
 * settings change, not a release.
 */
export interface TcsPolicy {
  /**
   * Whether this seller collects TCS at all. Only a business above the government's own turnover
   * limit has to, so the default is `false` and a business turns it on deliberately.
   */
  readonly collects: boolean;
  /** Sales to one customer, in one financial year, above which the rate starts to apply. */
  readonly thresholdPerCustomerPerYear: Money;
  /** The rate, as hundredths of a percent: 10 means 0.10 per cent. */
  readonly ratePercentTimes100: bigint;
  /** The higher rate used when the customer has not given their tax number. */
  readonly rateWithoutTaxNumberPercentTimes100: bigint;
}

/**
 * The position as it stands today: fifty lakh a year per customer, a tenth of a per cent above it,
 * and one per cent when the customer has given no tax number. A business that must collect turns
 * `collects` on; nothing is collected until it does.
 */
export const DEFAULT_TCS_POLICY: TcsPolicy = {
  collects: false,
  thresholdPerCustomerPerYear: rupees(5000000),
  ratePercentTimes100: 10n,
  rateWithoutTaxNumberPercentTimes100: 100n,
};

/** What the calculator is told about this customer's year before it works out the amount. */
export interface TcsContext {
  readonly policy: TcsPolicy;
  /** The financial year the running total belongs to, e.g. "2026-27". */
  readonly financialYear: string;
  /**
   * What this customer has already been billed in this financial year, including GST and excluding
   * any TCS already collected. TCS collected is money held for the government, not a sale, so it
   * does not itself push the customer closer to the threshold.
   */
  readonly priorSalesThisYear: Money;
  /**
   * Whether the customer has given their tax number, which decides which of the two rates applies.
   * Left out when the caller does not know: the calculator then reads it from the customer's record.
   */
  readonly customerHasTaxNumber?: boolean;
}

/** The answer, kept whole so the bill, the books and the screen all show the same working. */
export interface TcsCharge {
  readonly amount: Money;
  readonly ratePercentTimes100: bigint;
  /** The part of this bill that sits above the threshold, which is what the rate was applied to. */
  readonly chargedOn: Money;
  readonly threshold: Money;
  readonly financialYear: string;
  readonly priorSalesThisYear: Money;
  /** Prior sales plus this bill, so a person can check the crossing for themselves. */
  readonly totalSalesThisYear: Money;
  readonly note: { readonly 'en-IN': string; readonly 'hi-IN': string };
}

/** "0.10" from 10, "1.00" from 100 — the rate as it is printed. */
export const tcsRateText = (ratePercentTimes100: bigint): string =>
  toDecimalString(money(ratePercentTimes100));

/** Indian digit grouping without the rupee sign, for wording that already says "rupees". */
const grouped = (amount: Money): string => {
  const [whole] = toDecimalString(amount).split('.') as [string, string];
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  return rest === '' ? last3 : `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
};

/**
 * Works out the TCS on one bill.
 *
 * Returns `null` — not a zero charge — when nothing is due, so that a bill with no TCS carries no
 * TCS line, no note and no ledger entry at all.
 */
export const computeTcs = (context: TcsContext | undefined, billValueWithGst: Money): TcsCharge | null => {
  if (context === undefined || !context.policy.collects) return null;

  const { policy, priorSalesThisYear } = context;
  const totalSalesThisYear = { currency: billValueWithGst.currency, minor: priorSalesThisYear.minor + billValueWithGst.minor };
  // The rate applies to what crosses the line, not to the whole bill. If the customer was already
  // past the threshold, the whole bill is above it; if this bill is what crosses it, only the part
  // beyond the threshold counts; if the year is still short of it, nothing counts.
  const alreadyCounted = max(priorSalesThisYear, policy.thresholdPerCustomerPerYear);
  const chargedOn = max(zero(billValueWithGst.currency), subtract(totalSalesThisYear, alreadyCounted));
  if (chargedOn.minor <= 0n) return null;

  const rate =
    context.customerHasTaxNumber === false
      ? policy.rateWithoutTaxNumberPercentTimes100
      : policy.ratePercentTimes100;
  const amount = mulDiv(chargedOn, rate, 10000n);
  if (amount.minor === 0n) return null;

  const rateText = tcsRateText(rate);
  return {
    amount,
    ratePercentTimes100: rate,
    chargedOn,
    threshold: policy.thresholdPerCustomerPerYear,
    financialYear: context.financialYear,
    priorSalesThisYear,
    totalSalesThisYear,
    note: {
      'en-IN': `Sales to this customer in ${context.financialYear} have crossed ₹${grouped(policy.thresholdPerCustomerPerYear)}. TCS of ${rateText}% has been collected on ₹${grouped(chargedOn)} of this bill and will be paid to the government.`,
      'hi-IN': `Is customer ko ${context.financialYear} mein ki gayi bikri ₹${grouped(policy.thresholdPerCustomerPerYear)} paar kar chuki hai. Is bill ke ₹${grouped(chargedOn)} par ${rateText}% TCS liya gaya hai, jo sarkar ko bhara jayega.`,
    },
  };
};
