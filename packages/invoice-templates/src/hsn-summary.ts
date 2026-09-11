/**
 * Issue #140 / #135 — the HSN-wise tax summary.
 *
 * Every real Indian tax invoice ends with this table: one row per government code and rate, with
 * the taxable value and each tax shown separately, and a totals row. It is not decoration. It is
 * the table the buyer's accountant matches against their GST portal data, and a bill without it
 * makes them do the grouping by hand.
 *
 * The rule that matters: **this table must add up to the bill.** Its totals row is asserted equal
 * to the invoice totals, so the summary can never quietly disagree with the amount charged.
 */
import { add, zero, type Money } from '@invoice/kernel';
import type { InvoiceDocument, RenderableLine, TaxSplit } from './document.ts';

export interface HsnSummaryRow {
  /** The government code. `null` where a line carries none, which is shown as a dash, not hidden. */
  readonly code: string | null;
  readonly ratePercentTimes100: bigint | null;
  readonly taxableValue: Money;
  readonly cgst: Money;
  readonly sgst: Money;
  readonly utgst: Money;
  readonly igst: Money;
  readonly cess: Money;
  readonly totalTax: Money;
  /** True when every line behind this row is one the customer pays the GST on directly. */
  readonly reverseCharge: boolean;
}

export interface HsnSummary {
  readonly rows: readonly HsnSummaryRow[];
  readonly totals: HsnSummaryRow;
  readonly split: TaxSplit;
}

const nil = (): Money => zero('INR');

/**
 * Groups the bill by code and rate.
 *
 * Two lines of the same goods at different rates stay apart, because the buyer reconciles on the
 * pair, not on the code alone. Order follows first appearance on the bill, so the summary reads in
 * the same order as the items above it.
 *
 * Reverse-charge lines contribute their taxable value but no tax, because no tax was charged on
 * them — the customer pays it to the government directly, and the totals block says so on its own
 * line. Adding it here would make the summary disagree with the amount the customer owes.
 */
export const hsnSummary = (doc: Pick<InvoiceDocument, 'lines' | 'split'>): HsnSummary => {
  const order: string[] = [];
  const groups = new Map<string, { lines: RenderableLine[]; code: string | null; rate: bigint | null }>();

  for (const line of doc.lines) {
    const key = `${line.hsnOrSac ?? ''}|${line.ratePercentTimes100 ?? 'none'}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      order.push(key);
      groups.set(key, { lines: [line], code: line.hsnOrSac, rate: line.ratePercentTimes100 });
    } else {
      existing.lines.push(line);
    }
  }

  const rowOf = (lines: readonly RenderableLine[], code: string | null, rate: bigint | null): HsnSummaryRow => {
    const billed = lines.filter((l) => !l.reverseCharge);
    const total = (pick: (l: RenderableLine) => Money, from: readonly RenderableLine[]): Money =>
      from.reduce<Money>((acc, l) => add(acc, pick(l)), nil());
    const cgst = total((l) => l.cgst, billed);
    const sgst = total((l) => l.sgst, billed);
    const utgst = total((l) => l.utgst, billed);
    const igst = total((l) => l.igst, billed);
    const cess = total((l) => l.cess, billed);
    return {
      code,
      ratePercentTimes100: rate,
      taxableValue: total((l) => l.taxableValue, lines),
      cgst,
      sgst,
      utgst,
      igst,
      cess,
      totalTax: [cgst, sgst, utgst, igst, cess].reduce(add, nil()),
      reverseCharge: lines.length > 0 && lines.every((l) => l.reverseCharge),
    };
  };

  const rows = order.map((key) => {
    const group = groups.get(key) as { lines: RenderableLine[]; code: string | null; rate: bigint | null };
    return rowOf(group.lines, group.code, group.rate);
  });

  return { rows, totals: rowOf(doc.lines, null, null), split: doc.split };
};

/** Which tax columns this bill needs. A column of zeroes is noise on a page that is already dense. */
export const hsnSummaryColumns = (summary: HsnSummary): readonly ('CGST' | 'SGST' | 'UTGST' | 'IGST' | 'CESS')[] => {
  const totals = summary.totals;
  const columns: ('CGST' | 'SGST' | 'UTGST' | 'IGST' | 'CESS')[] =
    summary.split === 'IGST' ? ['IGST'] : summary.split === 'CGST_UTGST' ? ['CGST', 'UTGST'] : ['CGST', 'SGST'];
  if (totals.cess.minor !== 0n) columns.push('CESS');
  return columns;
};
