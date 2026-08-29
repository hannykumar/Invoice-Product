// Units of measure and exact unit conversion.
//
// Quantities are integers in micro-units (1 unit = 1_000_000 micro) so that no
// binary floating point ever touches a stock figure. Conversions are exact
// rationals; when a conversion cannot land on a whole micro-unit the caller is
// told, because silently rounding stock is how a warehouse drifts.

export class UnitConversionError extends Error {
  public readonly code: "UNKNOWN_UNIT" | "NO_CONVERSION_PATH" | "INEXACT_CONVERSION";
  constructor(code: "UNKNOWN_UNIT" | "NO_CONVERSION_PATH" | "INEXACT_CONVERSION", message: string) {
    super(message);
    this.code = code;
  }
}

export const MICRO = 1_000_000n;

export interface UnitOfMeasure {
  /** Uppercase short code used on documents, e.g. PCS, KGS, BOX. */
  readonly code: string;
  readonly name: string;
  /** Decimal places shown to the user. Stock is still held at micro precision. */
  readonly displayDecimals: number;
  /** Optional UQC (unit quantity code) required on e-invoices and GST returns. */
  readonly uqc?: string;
}

/**
 * There is one `Quantity` in this product and it lives in `@invoice/kernel`.
 *
 * This module used to declare a second one, `{ micro, unitCode }`, meaning exactly the same
 * integer in the same six-decimal scale. Every crossing between the two needed a rename, and a
 * rename that has to be remembered is a rename that eventually is not — on a stock figure, which
 * is the one number that must never drift. The registry and the exact-conversion rules below stay
 * here, because unit conversion is master data's; only the shape is shared.
 */
import type { Quantity } from "@invoice/kernel";
export type { Quantity };

/** 1 `fromUnit` equals `numerator / denominator` `toUnit`, optionally only for one item. */
export interface UnitConversion {
  readonly fromUnit: string;
  readonly toUnit: string;
  readonly numerator: bigint;
  readonly denominator: bigint;
  /** Absent means the conversion is universal (kg to g). Present means it holds for one item only (box to pieces). */
  readonly itemId?: string;
}

export const quantity = (value: string | number | bigint, unit: string): Quantity => ({ scaled: toMicro(value), unit: unit.toUpperCase() });

/** Parses a decimal string without floating point, so "0.001" stays exact. */
export function toMicro(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value * MICRO;
  const text = typeof value === "number" ? String(value) : value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new UnitConversionError("UNKNOWN_UNIT", `"${text}" is not a plain decimal quantity.`);
  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = text.replace("-", "").split(".");
  const padded = (fraction + "000000").slice(0, 6);
  if (fraction.length > 6) throw new UnitConversionError("INEXACT_CONVERSION", "Quantities are held to 6 decimal places.");
  const micro = BigInt(whole) * MICRO + BigInt(padded);
  return negative ? -micro : micro;
}

export function formatQuantity(value: Quantity, decimals = 3): string {
  const negative = value.scaled < 0n;
  const absolute = negative ? -value.scaled : value.scaled;
  const whole = absolute / MICRO;
  const fraction = (absolute % MICRO).toString().padStart(6, "0").slice(0, decimals);
  const text = decimals > 0 ? `${whole}.${fraction}` : String(whole);
  return `${negative ? "-" : ""}${text} ${value.unit}`;
}

/**
 * A per-company registry of units and the conversions between them. Conversions are
 * stored in both directions so a path search never has to invert on the fly.
 */
export class UnitRegistry {
  readonly #units = new Map<string, UnitOfMeasure>();
  readonly #edges = new Map<string, { readonly to: string; readonly numerator: bigint; readonly denominator: bigint }[]>();

  registerUnit(unit: UnitOfMeasure): void {
    this.#units.set(unit.code.toUpperCase(), { ...unit, code: unit.code.toUpperCase() });
  }

  unit(code: string): UnitOfMeasure {
    const found = this.#units.get(code.toUpperCase());
    if (!found) throw new UnitConversionError("UNKNOWN_UNIT", `Unit "${code}" is not set up yet.`);
    return found;
  }

  units(): readonly UnitOfMeasure[] {
    return [...this.#units.values()];
  }

  registerConversion(conversion: UnitConversion): void {
    const from = conversion.fromUnit.toUpperCase();
    const to = conversion.toUnit.toUpperCase();
    this.unit(from);
    this.unit(to);
    if (conversion.numerator <= 0n || conversion.denominator <= 0n) throw new UnitConversionError("INEXACT_CONVERSION", "A conversion factor must be a positive ratio.");
    this.#addEdge(conversion.itemId, from, { to, numerator: conversion.numerator, denominator: conversion.denominator });
    this.#addEdge(conversion.itemId, to, { to: from, numerator: conversion.denominator, denominator: conversion.numerator });
  }

  #addEdge(itemId: string | undefined, from: string, edge: { to: string; numerator: bigint; denominator: bigint }): void {
    const scope = itemId ?? "*";
    const mapKey = `${scope}|${from}`;
    const list = this.#edges.get(mapKey) ?? [];
    const existing = list.findIndex((candidate) => candidate.to === edge.to);
    if (existing >= 0) list[existing] = edge;
    else list.push(edge);
    this.#edges.set(mapKey, list);
  }

  #neighbours(from: string, itemId?: string): readonly { to: string; numerator: bigint; denominator: bigint }[] {
    const itemEdges = itemId ? this.#edges.get(`${itemId}|${from}`) ?? [] : [];
    const globalEdges = this.#edges.get(`*|${from}`) ?? [];
    // Item-specific conversions win over universal ones with the same target.
    const merged = new Map(globalEdges.map((edge) => [edge.to, edge]));
    for (const edge of itemEdges) merged.set(edge.to, edge);
    return [...merged.values()];
  }

  /** The exact ratio that turns one `from` unit into `to` units, or null when unrelated. */
  factor(from: string, to: string, itemId?: string): { numerator: bigint; denominator: bigint } | null {
    const start = from.toUpperCase();
    const target = to.toUpperCase();
    if (start === target) return { numerator: 1n, denominator: 1n };
    const seen = new Set([start]);
    let frontier: { unit: string; numerator: bigint; denominator: bigint }[] = [{ unit: start, numerator: 1n, denominator: 1n }];
    while (frontier.length > 0) {
      const next: typeof frontier = [];
      for (const node of frontier) {
        for (const edge of this.#neighbours(node.unit, itemId)) {
          if (seen.has(edge.to)) continue;
          const numerator = node.numerator * edge.numerator;
          const denominator = node.denominator * edge.denominator;
          if (edge.to === target) return reduce(numerator, denominator);
          seen.add(edge.to);
          next.push({ unit: edge.to, numerator, denominator });
        }
      }
      frontier = next;
    }
    return null;
  }

  /**
   * Converts a quantity. `exact` is false when the true result needed more than six
   * decimal places; callers that move stock must refuse or ask rather than absorb it.
   */
  convert(value: Quantity, toUnit: string, itemId?: string): { quantity: Quantity; exact: boolean } {
    const target = toUnit.toUpperCase();
    const ratio = this.factor(value.unit, target, itemId);
    if (!ratio) throw new UnitConversionError("NO_CONVERSION_PATH", `There is no set-up relationship between ${value.unit} and ${target}.`);
    const scaled = value.scaled * ratio.numerator;
    const converted = scaled / ratio.denominator;
    const exact = scaled % ratio.denominator === 0n;
    return { quantity: { scaled: converted, unit: target }, exact };
  }

  /** Convert, or refuse when the result would not be exact. Used on stock movements. */
  convertExact(value: Quantity, toUnit: string, itemId?: string): Quantity {
    const result = this.convert(value, toUnit, itemId);
    if (!result.exact) throw new UnitConversionError("INEXACT_CONVERSION", `${formatQuantity(value)} does not divide evenly into ${toUnit.toUpperCase()}. Please enter the quantity in ${toUnit.toUpperCase()} instead.`);
    return result.quantity;
  }
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) { const t = x % y; x = y; y = t; }
  return x;
}

function reduce(numerator: bigint, denominator: bigint): { numerator: bigint; denominator: bigint } {
  const divisor = gcd(numerator, denominator) || 1n;
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

/** The units almost every Indian MSME needs on day one, with their GST UQC codes. */
export const DEFAULT_UNITS: readonly UnitOfMeasure[] = Object.freeze([
  { code: "PCS", name: "Pieces", displayDecimals: 0, uqc: "PCS" },
  { code: "NOS", name: "Numbers", displayDecimals: 0, uqc: "NOS" },
  { code: "BOX", name: "Box", displayDecimals: 0, uqc: "BOX" },
  { code: "BAG", name: "Bag", displayDecimals: 0, uqc: "BAG" },
  { code: "KGS", name: "Kilograms", displayDecimals: 3, uqc: "KGS" },
  { code: "GMS", name: "Grams", displayDecimals: 3, uqc: "GMS" },
  { code: "QTL", name: "Quintal", displayDecimals: 3, uqc: "QTL" },
  { code: "TON", name: "Tonnes", displayDecimals: 3, uqc: "TON" },
  { code: "LTR", name: "Litres", displayDecimals: 3, uqc: "LTR" },
  { code: "MLT", name: "Millilitres", displayDecimals: 0, uqc: "MLT" },
  { code: "MTR", name: "Metres", displayDecimals: 3, uqc: "MTR" },
  { code: "CMS", name: "Centimetres", displayDecimals: 2, uqc: "CMS" },
  { code: "SQF", name: "Square feet", displayDecimals: 2, uqc: "SQF" },
  { code: "DOZ", name: "Dozen", displayDecimals: 0, uqc: "DOZ" },
]);

/** Universal conversions that are true for every item, unlike box-to-pieces. */
export const DEFAULT_CONVERSIONS: readonly UnitConversion[] = Object.freeze([
  { fromUnit: "KGS", toUnit: "GMS", numerator: 1000n, denominator: 1n },
  { fromUnit: "QTL", toUnit: "KGS", numerator: 100n, denominator: 1n },
  { fromUnit: "TON", toUnit: "QTL", numerator: 10n, denominator: 1n },
  { fromUnit: "LTR", toUnit: "MLT", numerator: 1000n, denominator: 1n },
  { fromUnit: "MTR", toUnit: "CMS", numerator: 100n, denominator: 1n },
  { fromUnit: "DOZ", toUnit: "PCS", numerator: 12n, denominator: 1n },
]);

export function createDefaultUnitRegistry(): UnitRegistry {
  const registry = new UnitRegistry();
  for (const unit of DEFAULT_UNITS) registry.registerUnit(unit);
  for (const conversion of DEFAULT_CONVERSIONS) registry.registerConversion(conversion);
  return registry;
}
