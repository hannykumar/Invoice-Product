// Issue #16 [E16] — work the invoice out again from the lines upward.
//
// The figures printed on a supplier's document are treated as claims, not facts. Everything
// here is exact integer arithmetic: quantities are micro-units, money is paise, GST rates are
// basis points. No float ever touches a financial figure (rule 9).

import { MICRO, toMicro } from "../../masters/src/units.ts";
import type { Paise } from "../../masters/src/types.ts";
import type { ExtractedLine } from "./inbox-types.ts";
import type { RecomputedTotals, TolerancePolicy } from "./validation-types.ts";

/** Round half-up, away from zero, so ₹0.005 becomes ₹0.01 rather than disappearing. */
export function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("divideRoundHalfUp: denominator is zero");
  const negative = numerator < 0n !== denominator < 0n;
  const a = numerator < 0n ? -numerator : numerator;
  const b = denominator < 0n ? -denominator : denominator;
  const quotient = a / b;
  const doubled = (a % b) * 2n;
  const rounded = doubled >= b ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** quantity (micro-units) × rate (paise per unit) → paise. */
export function lineTaxableValue(quantityMicro: bigint, ratePaise: Paise): Paise {
  return divideRoundHalfUp(quantityMicro * ratePaise, MICRO);
}

/** tax = taxable × basis points ÷ 10,000. */
export function taxOn(taxablePaise: Paise, gstRateBasisPoints: number): Paise {
  return divideRoundHalfUp(taxablePaise * BigInt(gstRateBasisPoints), 10_000n);
}

const readQuantityMicro = (raw: string | undefined): bigint | null => {
  if (raw === undefined) return null;
  const cleaned = raw.replace(/,/g, "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  try {
    return toMicro(cleaned);
  } catch {
    return null;
  }
};

const within = (a: Paise, b: Paise, tolerance: Paise): boolean => {
  const difference = a > b ? a - b : b - a;
  return difference <= tolerance;
};

/**
 * Recompute taxable value, tax and total from the lines.
 *
 * A line contributes its own quantity × rate where both are readable. Where they are not, the
 * taxable value printed on the line is used instead and the line is reported — the figure is
 * still used, but the reviewer is told it was taken on trust rather than checked.
 */
export function recomputeTotals(
  lines: readonly ExtractedLine[],
  policy: TolerancePolicy,
): RecomputedTotals {
  const linesTaxable: Paise[] = [];
  const lineProblems: string[] = [];
  let taxable = 0n;
  let tax = 0n;
  let complete = lines.length > 0;

  lines.forEach((line, index) => {
    const label = `lines[${index}]`;
    const quantityMicro = readQuantityMicro(line.quantity?.value);
    const rate = line.ratePaise?.value;
    const printedTaxable = line.taxableValuePaise?.value;

    let lineTaxable: Paise | null = null;
    if (quantityMicro !== null && rate !== undefined) {
      lineTaxable = lineTaxableValue(quantityMicro, rate);
      if (printedTaxable !== undefined && !within(lineTaxable, printedTaxable, policy.roundingPaise)) {
        lineProblems.push(
          `${label}: the quantity and rate work out to ${lineTaxable} paise, but the line shows ${printedTaxable} paise.`,
        );
      }
    } else if (printedTaxable !== undefined) {
      lineTaxable = printedTaxable;
      lineProblems.push(
        `${label}: the quantity or rate could not be read, so the amount printed on the line was used without checking it.`,
      );
    } else {
      complete = false;
      lineProblems.push(`${label}: no amount could be worked out for this line.`);
    }

    if (lineTaxable === null) {
      linesTaxable.push(0n);
      return;
    }
    linesTaxable.push(lineTaxable);
    taxable += lineTaxable;

    const gstRate = line.gstRateBasisPoints?.value;
    if (gstRate === undefined) {
      complete = false;
    } else {
      tax += taxOn(lineTaxable, gstRate);
    }
  });

  return {
    taxableValuePaise: taxable,
    totalTaxPaise: tax,
    invoiceTotalPaise: taxable + tax,
    linesTaxableValuePaise: linesTaxable,
    lineProblems,
    complete,
  };
}

/** True when two money figures agree once the company's tolerance is allowed for. */
export function withinTolerance(
  documentSays: Paise,
  weCalculated: Paise,
  absoluteTolerance: Paise,
  relativeBasisPoints = 0,
): boolean {
  const difference = documentSays > weCalculated ? documentSays - weCalculated : weCalculated - documentSays;
  const base = documentSays < 0n ? -documentSays : documentSays;
  const relative = relativeBasisPoints > 0 ? divideRoundHalfUp(base * BigInt(relativeBasisPoints), 10_000n) : 0n;
  const allowed = absoluteTolerance > relative ? absoluteTolerance : relative;
  return difference <= allowed;
}
