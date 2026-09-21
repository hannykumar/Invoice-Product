// Issue #143 — one table decides the e-invoice supply type, the GSTR-1 treatment and the paper.
import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPORT_SUPPLIES, checkExportParticulars, exportSupplyKindFor, foreignValue, printedExportSupply,
} from "../src/export-supply.ts";
import { buildEInvoicePayload } from "../src/payload.ts";
import { invoiceDocument } from "../src/einvoice-fixtures.ts";

test("every kind has one row: its e-invoice type, its return treatment, and its endorsement", () => {
  assert.deepEqual(
    Object.entries(EXPORT_SUPPLIES).map(([kind, c]) => [kind, c.eInvoiceSupplyType, c.returnTreatment, c.taxPaid]),
    [
      ["EXPORT_WITH_PAYMENT", "EXPWP", "EXPORT_WITH_TAX", true],
      ["EXPORT_WITHOUT_PAYMENT", "EXPWOP", "EXPORT_WITHOUT_TAX", false],
      ["SEZ_WITH_PAYMENT", "SEZWP", "SEZ_WITH_TAX", true],
      ["SEZ_WITHOUT_PAYMENT", "SEZWOP", "SEZ_WITHOUT_TAX", false],
      ["DEEMED_EXPORT", "DEXP", "DEEMED_EXPORT", true],
    ],
  );
  assert.match(EXPORT_SUPPLIES.EXPORT_WITHOUT_PAYMENT.endorsement, /^SUPPLY MEANT FOR EXPORT UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX$/);
  assert.match(EXPORT_SUPPLIES.SEZ_WITH_PAYMENT.endorsement, /SEZ UNIT OR SEZ DEVELOPER FOR AUTHORISED OPERATIONS ON PAYMENT OF INTEGRATED TAX$/);
  assert.equal(EXPORT_SUPPLIES.DEEMED_EXPORT.zeroRated, false);
});

test("the customer's master record decides the kind; only an overseas sale asks about LUT", () => {
  assert.equal(exportSupplyKindFor("overseas", true), "EXPORT_WITHOUT_PAYMENT");
  assert.equal(exportSupplyKindFor("overseas", false), "EXPORT_WITH_PAYMENT");
  assert.equal(exportSupplyKindFor("sez_without_payment", false), "SEZ_WITHOUT_PAYMENT");
  assert.equal(exportSupplyKindFor("deemed_export", true), "DEEMED_EXPORT");
  assert.equal(exportSupplyKindFor("regular", true), null);
});

test("an export needs a country, a real currency and a rate; the problems come all at once", () => {
  const problems = checkExportParticulars({ kind: "EXPORT_WITH_PAYMENT", countryCode: "XX", currency: "DOLLARS", exchangeRate: "abc" });
  assert.deepEqual(problems.map((p) => p.field), ["countryCode", "currency", "exchangeRate"]);
  assert.deepEqual(checkExportParticulars({ kind: "EXPORT_WITHOUT_PAYMENT", countryCode: "AE" }), [], "an export billed in rupees needs no rate");
  assert.deepEqual(checkExportParticulars({ kind: "SEZ_WITH_PAYMENT", currency: "USD", exchangeRate: "83" }).map((p) => p.field), ["currency"]);
});

test("a half-filled shipping bill is refused part by part", () => {
  const problems = checkExportParticulars({
    kind: "EXPORT_WITHOUT_PAYMENT", countryCode: "US",
    shippingBill: { number: "SB 12", date: "2026-9-1" as never, portCode: "nhava" },
  });
  assert.deepEqual(problems.map((p) => p.field), ["shippingBill.number", "shippingBill.date", "shippingBill.portCode"]);
});

test("the foreign value is exact, rounded half up to the cent, with no float", () => {
  assert.equal(foreignValue(8_325_00n, "83.25"), "100.00");
  assert.equal(foreignValue(1_00n, "3"), "0.33");
  assert.equal(foreignValue(2_00n, "3"), "0.67");
  assert.equal(foreignValue(1_04_960_00n, "83.2512"), "1260.76");
});

test("the printed particulars carry the title, the endorsement, the country and the currency", () => {
  const printed = printedExportSupply({
    kind: "EXPORT_WITHOUT_PAYMENT", countryCode: "AE", currency: "USD", exchangeRate: "83.25",
    shippingBill: { number: "4455667", date: "2026-09-20" as never, portCode: "INNSA1" },
  }, 8_325_000_00n);
  assert.equal(printed.title["en-IN"], "Tax Invoice — Export");
  assert.equal(printed.country, "United Arab Emirates");
  assert.deepEqual(printed.currency, { code: "USD", exchangeRate: "83.25", invoiceValue: "100000.00" });
  assert.equal(printed.taxPaid, false);
  assert.throws(() => printedExportSupply({ kind: "EXPORT_WITH_PAYMENT" }, 1n), /which country/);
});

test("the e-invoice carries the same shipping bill, port and currency", () => {
  const built = buildEInvoicePayload(invoiceDocument({
    recipientKind: "EXPORT_WITHOUT_PAYMENT", totalIgstPaise: 0n, invoiceValuePaise: 82_000_00n,
    countryCode: "AE", currency: "USD",
    shippingBill: { number: "4455667", date: "2026-09-20" as never, portCode: "INNSA1" },
  }));
  assert.ok(built.ok);
  assert.equal((built.payload.TranDtls as Record<string, unknown>).SupTyp, "EXPWOP");
  assert.deepEqual(built.payload.ExpDtls, { ShipBNo: "4455667", ShipBDt: "20/09/2026", Port: "INNSA1", CntCode: "AE", ForCur: "USD" });
  const noCountry = buildEInvoicePayload(invoiceDocument({ recipientKind: "EXPORT_WITH_PAYMENT" }));
  assert.ok(!noCountry.ok);
  assert.equal(noCountry.problems[0]!.field, "ExpDtls.countryCode");
});
