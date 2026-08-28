import assert from "node:assert/strict";
import test from "node:test";
import { gstinCheckDigit, isRetiredStateCode, normalisePhone, syntheticGstin, validateBankAccountNumber, validateGstin, validateHsnOrSac, validateIfsc, validatePan, validatePincode, validateVehicleNumber } from "../src/index.ts";

test("a well formed GSTIN with a correct check digit is accepted", () => {
  const gstin = syntheticGstin("29", "AABCA1234C");
  assert.equal(gstin.length, 15);
  assert.equal(validateGstin(gstin).ok, true);
});

test("a single mistyped character is caught by the check digit", () => {
  const gstin = syntheticGstin("29", "AABCA1234C");
  const mistyped = `${gstin.slice(0, 5)}${gstin[5] === "A" ? "B" : "A"}${gstin.slice(6)}`;
  const result = validateGstin(mistyped);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.problems[0]?.code, "GSTIN_CHECKSUM");
});

test("an unknown state code is rejected and a retired one is flagged rather than refused", () => {
  const unknown = validateGstin(syntheticGstin("99", "AABCA1234C").replace(/^\d\d/, "99"));
  assert.equal(unknown.ok, false);
  assert.equal(isRetiredStateCode("25"), true);
  assert.equal(isRetiredStateCode("29"), false);
  assert.equal(validateGstin(syntheticGstin("25", "AABCA1234C")).ok, true);
});

test("GSTIN input tolerates spacing and case but not a wrong length", () => {
  const gstin = syntheticGstin("27", "AAECS5678D");
  assert.equal(validateGstin(` ${gstin.toLowerCase()} `).ok, true);
  const short = validateGstin(gstin.slice(0, 14));
  assert.equal(short.ok === false && short.problems[0]?.code, "GSTIN_LENGTH");
});

test("check digit is computed, not guessed", () => {
  assert.equal(gstinCheckDigit("29AABCA1234C1Z"), syntheticGstin("29", "AABCA1234C").slice(14));
});

test("PAN, IFSC, pincode, bank account and vehicle formats", () => {
  assert.equal(validatePan("AABCA1234C").ok, true);
  assert.equal(validatePan("AABC12345C").ok, false);
  assert.equal(validateIfsc("HDFC0001234").ok, true);
  assert.equal(validateIfsc("HDFC1001234").ok, false);
  assert.equal(validatePincode("560001").ok, true);
  assert.equal(validatePincode("060001").ok, false);
  assert.equal(validateBankAccountNumber("00112233445566").ok, true);
  assert.equal(validateBankAccountNumber("12345").ok, false);
  assert.equal(validateVehicleNumber("KA01AB1234").ok, true);
  assert.equal(validateVehicleNumber("ka 01 ab 1234").ok, true);
  assert.equal(validateVehicleNumber("22BH1234AB").ok, true);
  assert.equal(validateVehicleNumber("LORRY-1").ok, false);
});

test("HSN and SAC rules differ for goods and services", () => {
  assert.equal(validateHsnOrSac("72142090", "goods").ok, true);
  assert.equal(validateHsnOrSac("7214", "goods").ok, true);
  assert.equal(validateHsnOrSac("72142", "goods").ok, false);
  assert.equal(validateHsnOrSac("996511", "service").ok, true);
  assert.equal(validateHsnOrSac("881100", "service").ok, false);
});

test("phone numbers normalise from the forms people actually type", () => {
  assert.equal(normalisePhone("+91 98450 12345"), "9845012345");
  assert.equal(normalisePhone("098450-12345"), "9845012345");
  assert.equal(normalisePhone("12345"), null);
  assert.equal(normalisePhone("1845012345"), null);
});
