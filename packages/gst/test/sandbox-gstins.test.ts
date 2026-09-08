// Issue #26 — the sandbox GSTIN allowance, and the proof that it cannot admit a real mistake.
//
// The allowance exists so the product can be run end to end against the government's own sandbox,
// whose test GSTINs are malformed by the government's own hand. These tests exist because an
// exception to a validation rule is only safe if somebody can see exactly how wide it is.

import assert from "node:assert/strict";
import test from "node:test";
import { isSandboxGstin } from "../src/sandbox-gstins.ts";
import { buildEInvoicePayload } from "../src/payload.ts";
import { invoiceDocument, cementLine } from "../src/einvoice-fixtures.ts";

const sandboxDocument = () => invoiceDocument({
  supplier: { gstin: "33AAGCB1286Q003", legalName: "BVM TN", address1: "14 Anna Salai", location: "Chennai", pincode: "600002", stateCode: "33" },
  recipient: { gstin: "27AAGCB1286Q005", legalName: "BVM MH", address1: "22 Laxmi Road", location: "Pune", pincode: "411030", stateCode: "27" },
  placeOfSupplyStateCode: "27",
  lines: [cementLine()],
});

test("off by default: the government's own test numbers are still refused", async () => {
  const built = buildEInvoicePayload(sandboxDocument());

  assert.equal(built.ok, false);
  assert.ok(built.problems.some((problem) => problem.field === "SellerDtls.Gstin"));
});

test("switched on, the sandbox document builds", async () => {
  const built = buildEInvoicePayload(sandboxDocument(), { allowSandboxGstins: true });

  assert.equal(built.ok, true, built.ok ? "" : built.problems.map((p) => p.message).join(" | "));
});

test("the allowance admits nothing that could be a real GST number", async () => {
  // Every number it accepts fails the published format in the fourteenth position, where a real
  // GSTIN carries Z. GSTN cannot have issued one, so no shopkeeper can mistype into this set.
  assert.ok(isSandboxGstin("33AAGCB1286Q003"));
  assert.ok(isSandboxGstin("27AAGCB1286Q005"));
  for (const gstin of ["33AAGCB1286Q003", "01AAGCB1286Q007", "36AAGCB1286Q004"]) {
    assert.equal(gstin[13], "0", "the fourteenth character is never Z, which is what makes it fake");
  }

  // A well-formed GSTIN is not "sandbox", whatever it looks like — including one on the same PAN.
  assert.equal(isSandboxGstin("33AAGCB1286Q1ZB"), false, "a real-shaped number never enters by this door");
  assert.equal(isSandboxGstin("29AAFCD1234K1Z5"), false);
  // Nor anything merely similar: a different PAN, a wrong length, or extra characters.
  assert.equal(isSandboxGstin("33AAGCB1287Q003"), false);
  assert.equal(isSandboxGstin("33AAGCB1286Q00"), false);
  assert.equal(isSandboxGstin("33AAGCB1286Q0034"), false);
  assert.equal(isSandboxGstin(""), false);
});

test("the allowance does not relax anything else on the bill", async () => {
  // It is a GSTIN exception, not a general amnesty: a missing HSN code still stops the bill.
  const built = buildEInvoicePayload(
    invoiceDocument({
      supplier: { gstin: "33AAGCB1286Q003", legalName: "BVM TN", address1: "14 Anna Salai", location: "Chennai", pincode: "600002", stateCode: "33" },
      recipient: { gstin: "27AAGCB1286Q005", legalName: "BVM MH", address1: "22 Laxmi Road", location: "Pune", pincode: "411030", stateCode: "27" },
      placeOfSupplyStateCode: "27",
      lines: [cementLine({ hsnOrSac: "" })],
    }),
    { allowSandboxGstins: true },
  );

  assert.equal(built.ok, false);
  assert.ok(built.problems.some((problem) => problem.field === "ItemList[0].HsnCd"));
});
