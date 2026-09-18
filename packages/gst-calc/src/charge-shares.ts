/**
 * Issue #188 — freight belongs under the code of the goods it travelled with.
 *
 * Freight the seller charges on goods is part of the value of those goods (CGST Act section
 * 15(2)(c)). On the item table it stays a line of its own (#131), because a customer checks a goods
 * line by multiplying quantity by rate. But the code-wise summaries — the one printed on the bill
 * and the one in GSTR-1 Table 12 — report every rupee of taxable value under a goods code. A charge
 * line has no code of its own, so without this it printed as a dash row on the bill and was
 * skipped altogether in the return.
 *
 * This is the one place the share-out is done, so the bill and the return can never disagree.
 *
 * - A charge line was built from one bucket of goods: the same rate and the same reverse-charge
 *   flag (see `#chargeLines` in compute.ts). It is shared only across that bucket.
 * - Within the bucket, it is shared across the goods codes in proportion to each code's taxable
 *   value, with leftover paise going to the largest code first, so the shares add back exactly.
 * - Each tax head is split separately from the tax already on the charge line. Tax is never worked
 *   out again on a share, or the summary would drift from the bill by a paisa.
 * - A charge with no goods in its bucket (a bill with no goods at all) keeps its own row.
 */
import { allocateByWeight, zero, type Money } from '@invoice/kernel';

/** The least a line has to say about itself to be shared out. Computed, printed and return lines all fit. */
export interface ChargeShareableLine {
  readonly kind: 'GOODS' | 'CHARGE';
  readonly hsnOrSac: string | null;
  readonly ratePercentTimes100: bigint | null;
  readonly reverseCharge: boolean;
  readonly taxableValue: Money;
  readonly cgst: Money;
  readonly sgst: Money;
  readonly utgst: Money;
  readonly igst: Money;
  readonly cess: Money;
}

/** One entry in a code-wise summary: a goods line as it is, or one code's share of a charge line. */
export interface HsnPart<L extends ChargeShareableLine> {
  /** The line this part came from. For a share, the charge line. */
  readonly source: L;
  /**
   * The goods line whose code this part is reported under: the line itself for goods, the first
   * goods line with that code in the bucket for a share, and `null` for a charge kept on its own.
   * A caller that needs a unit or a description for the row takes it from here.
   */
  readonly goods: L | null;
  readonly isChargeShare: boolean;
  readonly hsnOrSac: string | null;
  readonly ratePercentTimes100: bigint | null;
  readonly reverseCharge: boolean;
  readonly taxableValue: Money;
  readonly cgst: Money;
  readonly sgst: Money;
  readonly utgst: Money;
  readonly igst: Money;
  readonly cess: Money;
}

const bucketOf = (line: ChargeShareableLine): string => `${line.ratePercentTimes100 ?? 'none'}|${line.reverseCharge}`;

const partOf = <L extends ChargeShareableLine>(line: L, goods: L | null): HsnPart<L> => ({
  source: line,
  goods,
  isChargeShare: false,
  hsnOrSac: line.hsnOrSac,
  ratePercentTimes100: line.ratePercentTimes100,
  reverseCharge: line.reverseCharge,
  taxableValue: line.taxableValue,
  cgst: line.cgst,
  sgst: line.sgst,
  utgst: line.utgst,
  igst: line.igst,
  cess: line.cess,
});

/**
 * Goods lines come back unchanged and in order; each charge line is replaced by one share per goods
 * code in its bucket, placed after the goods. Grouping the result by code and rate gives a summary
 * with no charge rows, whose totals equal the bill's.
 */
export const apportionChargesToHsn = <L extends ChargeShareableLine>(lines: readonly L[]): HsnPart<L>[] => {
  const buckets = new Map<string, { codes: (string | null)[]; anchor: Map<string | null, L>; weight: Map<string | null, bigint> }>();
  for (const line of lines) {
    if (line.kind !== 'GOODS') continue;
    const key = bucketOf(line);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { codes: [], anchor: new Map(), weight: new Map() };
      buckets.set(key, bucket);
    }
    if (!bucket.anchor.has(line.hsnOrSac)) {
      bucket.codes.push(line.hsnOrSac);
      bucket.anchor.set(line.hsnOrSac, line);
      bucket.weight.set(line.hsnOrSac, 0n);
    }
    // The same rule `#chargeLines` used to share the charge between rates: a negative line adds nothing.
    const weight = line.taxableValue.minor < 0n ? 0n : line.taxableValue.minor;
    bucket.weight.set(line.hsnOrSac, (bucket.weight.get(line.hsnOrSac) as bigint) + weight);
  }

  const parts: HsnPart<L>[] = lines.filter((l) => l.kind === 'GOODS').map((l) => partOf(l, l));

  for (const charge of lines) {
    if (charge.kind === 'GOODS') continue;
    const bucket = buckets.get(bucketOf(charge));
    if (bucket === undefined) {
      parts.push(partOf(charge, null));
      continue;
    }
    const weights = bucket.codes.map((code) => bucket.weight.get(code) as bigint);
    const split = (amount: Money): Money[] =>
      amount.minor === 0n ? weights.map(() => zero(amount.currency)) : allocateByWeight(amount, weights);
    const taxable = split(charge.taxableValue);
    const cgst = split(charge.cgst);
    const sgst = split(charge.sgst);
    const utgst = split(charge.utgst);
    const igst = split(charge.igst);
    const cess = split(charge.cess);
    bucket.codes.forEach((code, i) => {
      parts.push({
        source: charge,
        goods: bucket.anchor.get(code) as L,
        isChargeShare: true,
        hsnOrSac: code,
        ratePercentTimes100: charge.ratePercentTimes100,
        reverseCharge: charge.reverseCharge,
        taxableValue: taxable[i] as Money,
        cgst: cgst[i] as Money,
        sgst: sgst[i] as Money,
        utgst: utgst[i] as Money,
        igst: igst[i] as Money,
        cess: cess[i] as Money,
      });
    });
  }

  return parts;
};
