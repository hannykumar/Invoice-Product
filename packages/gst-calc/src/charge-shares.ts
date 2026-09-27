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

/** A line that also knows what it adds to the bill, which is what a government item's total needs. */
export interface FoldableLine extends ChargeShareableLine {
  readonly lineTotal: Money;
}

/**
 * One item as a government document reports it: a goods line with its share of every charge on the
 * bill already inside its taxable value and tax, or — only on a bill with no goods at all — a charge
 * that had nothing to ride on and is kept as it is.
 */
export interface FoldedItem<L extends FoldableLine> {
  /** The goods line this item is, or the charge kept on its own. */
  readonly line: L;
  /** How much of the taxable value below came from freight and other charges. Zero when none. */
  readonly chargeValue: Money;
  readonly taxableValue: Money;
  readonly cgst: Money;
  readonly sgst: Money;
  readonly utgst: Money;
  readonly igst: Money;
  readonly cess: Money;
  readonly lineTotal: Money;
}

const plus = (a: Money, b: Money): Money => ({ currency: a.currency, minor: a.minor + b.minor });

/**
 * Issue #231 — freight folded into the goods items, for the e-way bill and the e-invoice.
 *
 * The government documents list goods and nothing else: every item needs a goods code, and freight
 * the seller charges on its own goods is part of their value (CGST Act s.15(2)(c)), taxed with them
 * as one supply (s.8(a)). So a charge line never becomes an item of its own there. It is shared out
 * exactly as the printed HSN summary and GSTR-1 share it — by `apportionChargesToHsn`, per goods
 * code within its rate — and each code's share is then split between that code's goods lines by
 * their taxable value, leftover paise to the largest line first. So the items add up, code by code,
 * to the same figures the printed bill and the return show, and in total to the bill itself.
 *
 * Every tax head is split from the tax already on the charge line; nothing is worked out again.
 * Goods lines come back in their own order.
 */
export const foldChargesIntoGoods = <L extends FoldableLine>(lines: readonly L[]): FoldedItem<L>[] => {
  const goods = lines.filter((l) => l.kind === 'GOODS');
  const items = new Map<L, FoldedItem<L>>();
  for (const line of goods) {
    items.set(line, {
      line,
      chargeValue: zero(line.taxableValue.currency),
      taxableValue: line.taxableValue,
      cgst: line.cgst,
      sgst: line.sgst,
      utgst: line.utgst,
      igst: line.igst,
      cess: line.cess,
      lineTotal: line.lineTotal,
    });
  }
  const loose: FoldedItem<L>[] = [];

  for (const part of apportionChargesToHsn(lines)) {
    if (!part.isChargeShare) {
      if (part.source.kind !== 'GOODS') {
        // A charge with no goods to ride on stays visible, so the document refuses it honestly.
        const charge = part.source;
        loose.push({
          line: charge, chargeValue: charge.taxableValue, taxableValue: charge.taxableValue,
          cgst: charge.cgst, sgst: charge.sgst, utgst: charge.utgst, igst: charge.igst, cess: charge.cess,
          lineTotal: charge.lineTotal,
        });
      }
      continue;
    }
    // The goods lines this code's share rides on: same code, same rate, same reverse-charge flag.
    const targets = goods.filter((g) =>
      g.hsnOrSac === part.hsnOrSac
      && g.ratePercentTimes100 === part.ratePercentTimes100
      && g.reverseCharge === part.reverseCharge);
    const weights = targets.map((g) => (g.taxableValue.minor < 0n ? 0n : g.taxableValue.minor));
    const split = (amount: Money): Money[] =>
      amount.minor === 0n ? weights.map(() => zero(amount.currency)) : allocateByWeight(amount, weights);
    const taxable = split(part.taxableValue);
    const cgst = split(part.cgst);
    const sgst = split(part.sgst);
    const utgst = split(part.utgst);
    const igst = split(part.igst);
    const cess = split(part.cess);
    targets.forEach((target, i) => {
      const current = items.get(target) as FoldedItem<L>;
      const t = taxable[i] as Money;
      const tax = [cgst[i], sgst[i], utgst[i], igst[i], cess[i]] as Money[];
      // A charge line's total is its value plus its tax, or its value alone under reverse charge,
      // where the buyer pays the tax (see `#chargeLine` in compute.ts). The share follows the same rule.
      const shareTotal = part.reverseCharge ? t : tax.reduce(plus, t);
      items.set(target, {
        line: target,
        chargeValue: plus(current.chargeValue, t),
        taxableValue: plus(current.taxableValue, t),
        cgst: plus(current.cgst, tax[0] as Money),
        sgst: plus(current.sgst, tax[1] as Money),
        utgst: plus(current.utgst, tax[2] as Money),
        igst: plus(current.igst, tax[3] as Money),
        cess: plus(current.cess, tax[4] as Money),
        lineTotal: plus(current.lineTotal, shareTotal),
      });
    });
  }

  return [...goods.map((g) => items.get(g) as FoldedItem<L>), ...loose];
};
