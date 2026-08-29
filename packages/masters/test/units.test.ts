import assert from "node:assert/strict";
import test from "node:test";
import { UnitConversionError, createDefaultUnitRegistry, formatQuantity, quantity, toMicro } from "../src/index.ts";

test("decimal quantities are parsed without floating point error", () => {
  assert.equal(toMicro("0.1") + toMicro("0.2"), toMicro("0.3"));
  assert.equal(toMicro("2.5"), 2_500_000n);
  assert.equal(toMicro(3), 3_000_000n);
});

test("universal conversions are exact in both directions", () => {
  const units = createDefaultUnitRegistry();
  assert.equal(units.convertExact(quantity("2.5", "KGS"), "GMS").scaled, toMicro("2500"));
  assert.equal(units.convertExact(quantity("2500", "GMS"), "KGS").scaled, toMicro("2.5"));
  assert.equal(units.convertExact(quantity("1", "TON"), "KGS").scaled, toMicro("1000"));
  assert.equal(units.convertExact(quantity("3", "DOZ"), "PCS").scaled, toMicro("36"));
});

test("an item pack size applies only to that item", () => {
  const units = createDefaultUnitRegistry();
  units.registerConversion({ fromUnit: "BOX", toUnit: "PCS", numerator: 24n, denominator: 1n, itemId: "soap" });
  assert.equal(units.convertExact(quantity("2", "BOX"), "PCS", "soap").scaled, toMicro("48"));
  assert.throws(() => units.convert(quantity("2", "BOX"), "PCS", "cement"), (error: unknown) => error instanceof UnitConversionError && error.code === "NO_CONVERSION_PATH");
});

test("multi-hop conversions compose exactly", () => {
  const units = createDefaultUnitRegistry();
  // TON to GMS goes TON -> QTL -> KGS -> GMS with no rounding at any step.
  assert.equal(units.convertExact(quantity("1", "TON"), "GMS").scaled, toMicro("1000000"));
});

test("a conversion that cannot land on a whole quantity is refused, not rounded", () => {
  const units = createDefaultUnitRegistry();
  units.registerConversion({ fromUnit: "BOX", toUnit: "PCS", numerator: 3n, denominator: 1n, itemId: "tile" });
  const inexact = units.convert(quantity("1", "PCS"), "BOX", "tile");
  assert.equal(inexact.exact, false);
  assert.throws(() => units.convertExact(quantity("1", "PCS"), "BOX", "tile"), (error: unknown) => error instanceof UnitConversionError && error.code === "INEXACT_CONVERSION");
});

test("unknown units are refused rather than assumed", () => {
  const units = createDefaultUnitRegistry();
  assert.throws(() => units.unit("BARREL"), (error: unknown) => error instanceof UnitConversionError && error.code === "UNKNOWN_UNIT");
});

test("quantities display with the requested precision", () => {
  assert.equal(formatQuantity(quantity("2.5", "KGS"), 3), "2.500 KGS");
  assert.equal(formatQuantity(quantity("-1.25", "KGS"), 2), "-1.25 KGS");
  assert.equal(formatQuantity(quantity("7", "PCS"), 0), "7 PCS");
});
