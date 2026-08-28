// Deterministic identifier validation for Indian business master data.
//
// Every rule here is a format or checksum rule published by the issuing authority.
// Nothing in this file guesses: a value is valid, invalid with a stated reason, or
// unknown-and-therefore-rejected. Live GSTIN lookup is explicitly out of scope for
// issue #5 (non-goal) — this module only proves that an identifier is well formed.

export interface ValidationProblem {
  readonly field: string;
  /** Stable machine code so callers can branch without parsing English. */
  readonly code: string;
  /** Wording aimed at a shopkeeper, not an accountant. */
  readonly message: string;
}

export type ValidationResult = { readonly ok: true } | { readonly ok: false; readonly problems: readonly ValidationProblem[] };

const ok: ValidationResult = { ok: true };
const fail = (field: string, code: string, message: string): ValidationResult => ({ ok: false, problems: [{ field, code, message }] });

/**
 * GST state codes as published in the GST state-code list. `union` marks union
 * territories, which matters for place-of-supply and UTGST-vs-SGST decisions made
 * later in the GST module (#30).
 */
export const GST_STATE_CODES: Readonly<Record<string, { readonly name: string; readonly union: boolean; readonly retired?: true }>> = Object.freeze({
  "01": { name: "Jammu and Kashmir", union: true },
  "02": { name: "Himachal Pradesh", union: false },
  "03": { name: "Punjab", union: false },
  "04": { name: "Chandigarh", union: true },
  "05": { name: "Uttarakhand", union: false },
  "06": { name: "Haryana", union: false },
  "07": { name: "Delhi", union: true },
  "08": { name: "Rajasthan", union: false },
  "09": { name: "Uttar Pradesh", union: false },
  "10": { name: "Bihar", union: false },
  "11": { name: "Sikkim", union: false },
  "12": { name: "Arunachal Pradesh", union: false },
  "13": { name: "Nagaland", union: false },
  "14": { name: "Manipur", union: false },
  "15": { name: "Mizoram", union: false },
  "16": { name: "Tripura", union: false },
  "17": { name: "Meghalaya", union: false },
  "18": { name: "Assam", union: false },
  "19": { name: "West Bengal", union: false },
  "20": { name: "Jharkhand", union: false },
  "21": { name: "Odisha", union: false },
  "22": { name: "Chhattisgarh", union: false },
  "23": { name: "Madhya Pradesh", union: false },
  "24": { name: "Gujarat", union: false },
  // 25 and 28 were merged away in 2020 and 2014. They still appear on older purchase
  // invoices, so they stay valid for historical documents and are flagged as retired.
  "25": { name: "Daman and Diu (merged into 26)", union: true, retired: true },
  "26": { name: "Dadra and Nagar Haveli and Daman and Diu", union: true },
  "27": { name: "Maharashtra", union: false },
  "28": { name: "Andhra Pradesh (before Telangana split)", union: false, retired: true },
  "29": { name: "Karnataka", union: false },
  "30": { name: "Goa", union: false },
  "31": { name: "Lakshadweep", union: true },
  "32": { name: "Kerala", union: false },
  "33": { name: "Tamil Nadu", union: false },
  "34": { name: "Puducherry", union: true },
  "35": { name: "Andaman and Nicobar Islands", union: true },
  "36": { name: "Telangana", union: false },
  "37": { name: "Andhra Pradesh", union: false },
  "38": { name: "Ladakh", union: true },
  "97": { name: "Other Territory", union: true },
});

const GSTIN_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_SHAPE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC_SHAPE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const PINCODE_SHAPE = /^[1-9][0-9]{5}$/;
/** Classic state-series plate, e.g. KA01AB1234, and the newer Bharat (BH) series. */
const VEHICLE_STATE_SERIES = /^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$/;
const VEHICLE_BH_SERIES = /^[0-9]{2}BH[0-9]{4}[A-Z]{1,2}$/;

/** Uppercase and drop spaces/hyphens so user typing quirks never change the verdict. */
export const normaliseIdentifier = (raw: string): string => raw.replace(/[\s-]/g, "").toUpperCase();

/**
 * The GSTIN check digit, exactly as specified: each of the first 14 characters is
 * weighted 1, 2, 1, 2 … and the digit sum of every product (base 36) is totalled.
 */
export function gstinCheckDigit(first14: string): string {
  let sum = 0;
  for (let position = 0; position < 14; position += 1) {
    const value = GSTIN_CHARSET.indexOf(first14[position] ?? "");
    if (value < 0) throw new Error("GSTIN contains a character outside 0-9 and A-Z.");
    const product = value * (position % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARSET[(36 - (sum % 36)) % 36] as string;
}

export function validateGstin(raw: string, field = "gstin"): ValidationResult {
  const value = normaliseIdentifier(raw);
  if (value.length !== 15) return fail(field, "GSTIN_LENGTH", "A GST number has 15 characters. Please check the number on the invoice.");
  if (!GSTIN_SHAPE.test(value)) return fail(field, "GSTIN_SHAPE", "This does not look like a GST number. Expected 2 digits, then a PAN, then 3 more characters.");
  const stateCode = value.slice(0, 2);
  if (!GST_STATE_CODES[stateCode]) return fail(field, "GSTIN_STATE_CODE", `${stateCode} is not a valid GST state code.`);
  if (gstinCheckDigit(value.slice(0, 14)) !== value[14]) return fail(field, "GSTIN_CHECKSUM", "The last character of this GST number does not match the rest of it, so a digit was probably mistyped.");
  return ok;
}

export function validatePan(raw: string, field = "pan"): ValidationResult {
  const value = normaliseIdentifier(raw);
  if (!PAN_SHAPE.test(value)) return fail(field, "PAN_SHAPE", "A PAN has 5 letters, 4 digits and 1 letter, like ABCDE1234F.");
  return ok;
}

/** The PAN embedded in a GSTIN must be the party's own PAN — a common data-entry mismatch. */
export function gstinPan(raw: string): string {
  return normaliseIdentifier(raw).slice(2, 12);
}

export function gstinStateCode(raw: string): string {
  return normaliseIdentifier(raw).slice(0, 2);
}

/** True when the GSTIN carries a state code that no longer issues new registrations. */
export function isRetiredStateCode(stateCode: string): boolean {
  return GST_STATE_CODES[stateCode]?.retired === true;
}

/**
 * HSN for goods, SAC for services. Small taxpayers may report 2 digits, so 2, 4, 6 and
 * 8 are all acceptable lengths; SAC is always 6 digits beginning 99.
 */
export function validateHsnOrSac(raw: string, kind: "goods" | "service", field = "hsnSac"): ValidationResult {
  const value = normaliseIdentifier(raw);
  if (!/^[0-9]+$/.test(value)) return fail(field, "HSN_NOT_NUMERIC", "An HSN or SAC code contains digits only.");
  if (kind === "service") {
    if (value.length !== 6) return fail(field, "SAC_LENGTH", "A service accounting code (SAC) has exactly 6 digits.");
    if (!value.startsWith("99")) return fail(field, "SAC_PREFIX", "Service accounting codes start with 99.");
    return ok;
  }
  if (![2, 4, 6, 8].includes(value.length)) return fail(field, "HSN_LENGTH", "An HSN code has 2, 4, 6 or 8 digits.");
  return ok;
}

export function validateIfsc(raw: string, field = "ifsc"): ValidationResult {
  const value = normaliseIdentifier(raw);
  if (!IFSC_SHAPE.test(value)) return fail(field, "IFSC_SHAPE", "An IFSC has 4 bank letters, a 0, then 6 characters, like HDFC0001234.");
  return ok;
}

export function validatePincode(raw: string, field = "pincode"): ValidationResult {
  if (!PINCODE_SHAPE.test(raw.trim())) return fail(field, "PINCODE_SHAPE", "A PIN code has 6 digits and cannot start with 0.");
  return ok;
}

export function validateVehicleNumber(raw: string, field = "vehicleNumber"): ValidationResult {
  const value = normaliseIdentifier(raw);
  if (VEHICLE_STATE_SERIES.test(value) || VEHICLE_BH_SERIES.test(value)) return ok;
  return fail(field, "VEHICLE_NUMBER_SHAPE", "This does not look like an Indian vehicle number, for example KA01AB1234.");
}

export function validateBankAccountNumber(raw: string, field = "accountNumber"): ValidationResult {
  const value = raw.replace(/\s/g, "");
  if (!/^[0-9]{9,18}$/.test(value)) return fail(field, "BANK_ACCOUNT_SHAPE", "A bank account number has 9 to 18 digits.");
  return ok;
}

/** Ten digits, optionally written with +91 or a leading 0. */
export function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  const local = digits.startsWith("91") && digits.length === 12 ? digits.slice(2) : digits.startsWith("0") && digits.length === 11 ? digits.slice(1) : digits;
  return /^[6-9][0-9]{9}$/.test(local) ? local : null;
}

export function validatePhone(raw: string, field = "phone"): ValidationResult {
  return normalisePhone(raw) ? ok : fail(field, "PHONE_SHAPE", "An Indian mobile number has 10 digits and starts with 6, 7, 8 or 9.");
}

/** Collect problems from several checks so a form can show every issue at once. */
export function combine(...results: readonly ValidationResult[]): ValidationResult {
  const problems = results.flatMap((result) => (result.ok ? [] : result.problems));
  return problems.length === 0 ? ok : { ok: false, problems };
}
