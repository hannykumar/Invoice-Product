// Issue #16 [E16] — decide whether a draft from #15 is safe for #17 to post.
//
// The one promise this file keeps: an unresolved material discrepancy cannot post. Everything
// is deterministic — exact integer arithmetic, or a decision from the rules engine (#7/#25).
// A model's reading is never treated as a fact; it is a claim that gets checked.

import { createHash } from "node:crypto";
import type { Party, PartyAddress } from "../../masters/src/types.ts";
import { gstinStateCode, normaliseIdentifier, validateGstin, validateHsnOrSac } from "../../masters/src/validation.ts";
import { GST_STATE_CODES } from "../../masters/src/validation.ts";
import { formatPaise } from "./money.ts";
import type { ExtractionDraft } from "./inbox-types.ts";
import { assessDuplicates } from "./duplicates.ts";
import { recomputeTotals, withinTolerance } from "./recompute.ts";
import {
  DEFAULT_TOLERANCE,
  type Correction,
  type ExistingPurchase,
  type Finding,
  type FindingSeverity,
  type PurchaseVerdict,
  type TaxCheck,
  type TaxSplitPort,
  type TolerancePolicy,
  type ValidationStatus,
} from "./validation-types.ts";

export interface ValidatePurchaseInput {
  readonly draft: ExtractionDraft;
  /** The supplier this draft was matched to, when #5 found one. */
  readonly supplier?: Party;
  readonly supplierAddress?: PartyAddress;
  /** The buying company's own state, for place of supply. */
  readonly buyerStateCode?: string;
  readonly existing?: readonly ExistingPurchase[];
  readonly policy?: TolerancePolicy;
  /** The rules engine, behind a narrow port. Omitted means tax is only self-checked. */
  readonly taxSplit?: TaxSplitPort;
  /** Today, as the caller sees it. Never read from the clock inside a decision. */
  readonly today: string;
}

/** How far back a purchase can be dated before it is worth a second look, in days. */
const OLD_INVOICE_DAYS = 400;

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function validatePurchase(input: ValidatePurchaseInput): PurchaseVerdict {
  const { draft, supplier, supplierAddress, buyerStateCode, today } = input;
  const policy = input.policy ?? DEFAULT_TOLERANCE;
  const findings: Finding[] = [];
  const corrections: Correction[] = [];

  const add = (finding: Finding) => findings.push(finding);

  // ---- Supplier identity -------------------------------------------------------------
  const printedGstin = draft.supplierGstin?.value;
  if (printedGstin !== undefined) {
    const gstinCheck = validateGstin(printedGstin, "supplierGstin");
    if (!gstinCheck.ok) {
      add({
        code: "SUPPLIER_GSTIN_INVALID",
        severity: "MATERIAL",
        field: "supplierGstin",
        message: gstinCheck.problems[0]?.message ?? "This GST number does not look right, so a digit was probably mistyped.",
        ...(draft.supplierGstin?.evidence ? { evidence: draft.supplierGstin.evidence } : {}),
      });
    } else if (supplier === undefined) {
      add({
        code: "SUPPLIER_GSTIN_UNKNOWN",
        severity: "SIGNIFICANT",
        field: "supplierGstin",
        message: `${printedGstin} is not a supplier you have dealt with before. Add them once and this bill can go through.`,
        ...(draft.supplierGstin?.evidence ? { evidence: draft.supplierGstin.evidence } : {}),
      });
    }

    // The GSTIN carries its own state. If the address on file says another state, one of them
    // is wrong, and place of supply — and therefore the tax split — depends on which.
    const gstinState = gstinCheck.ok ? gstinStateCode(printedGstin) : null;
    if (gstinState !== null && supplierAddress !== undefined && supplierAddress.stateCode !== gstinState) {
      add({
        code: "SUPPLIER_STATE_MISMATCH",
        severity: "SIGNIFICANT",
        field: "supplierGstin",
        message: `The GST number belongs to ${GST_STATE_CODES[gstinState]?.name ?? `state ${gstinState}`}, but this supplier's address is in ${GST_STATE_CODES[supplierAddress.stateCode]?.name ?? `state ${supplierAddress.stateCode}`}. The tax split depends on getting this right.`,
      });
    }

    if (supplier !== undefined && supplierAddress?.gstin !== undefined) {
      if (normaliseIdentifier(supplierAddress.gstin) !== normaliseIdentifier(printedGstin)) {
        add({
          code: "SUPPLIER_GSTIN_MISMATCH",
          severity: "MATERIAL",
          field: "supplierGstin",
          message: `This bill shows GST number ${printedGstin}, but ${supplier.legalName} is on file with ${supplierAddress.gstin}. Claiming credit against the wrong number will be rejected.`,
        });
        corrections.push({
          field: "supplierGstin",
          clears: "SUPPLIER_GSTIN_MISMATCH",
          currentValue: printedGstin,
          suggestedValue: supplierAddress.gstin,
          reason: `The GST number on file for ${supplier.legalName}.`,
        });
      }
    }
  }

  const printedName = draft.supplierName?.value;
  if (printedName !== undefined && supplier !== undefined) {
    const known = [supplier.legalName, supplier.tradeName, ...supplier.aliases]
      .filter((name): name is string => name !== undefined)
      .map((name) => name.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (!known.includes(printedName.toLowerCase().replace(/[^a-z0-9]/g, ""))) {
      add({
        code: "SUPPLIER_NAME_MISMATCH",
        severity: "MINOR",
        field: "supplierName",
        message: `This bill is printed as "${printedName}", which you have saved as "${supplier.legalName}". The GST number matches, so this is usually just a different spelling.`,
      });
    }
  }

  // ---- The invoice's own identity ----------------------------------------------------
  if (draft.invoiceNumber === undefined) {
    add({
      code: "INVOICE_NUMBER_MISSING",
      severity: "MATERIAL",
      field: "invoiceNumber",
      message: "No bill number could be read. Without it there is no way to tell this bill apart from the next one.",
    });
  }

  const invoiceDate = draft.invoiceDate?.value;
  if (invoiceDate === undefined) {
    add({
      code: "INVOICE_DATE_MISSING",
      severity: "MATERIAL",
      field: "invoiceDate",
      message: "No bill date could be read. The date decides which month's return this belongs to.",
    });
  } else {
    const age = daysBetween(invoiceDate, today);
    if (age < 0) {
      add({
        code: "INVOICE_DATE_IN_FUTURE",
        severity: "MATERIAL",
        field: "invoiceDate",
        message: `This bill is dated ${invoiceDate}, which is still in the future. Check the date before entering it.`,
        ...(draft.invoiceDate?.evidence ? { evidence: draft.invoiceDate.evidence } : {}),
      });
    } else if (age > OLD_INVOICE_DAYS) {
      add({
        code: "INVOICE_DATE_TOO_OLD",
        severity: "SIGNIFICANT",
        field: "invoiceDate",
        message: `This bill is dated ${invoiceDate}, over a year ago. The window to claim input credit on it has probably closed.`,
      });
    }
  }

  // ---- Lines -------------------------------------------------------------------------
  draft.lines.forEach((line, index) => {
    const hsn = line.hsnSac?.value;
    if (hsn !== undefined) {
      const hsnCheck = validateHsnOrSac(hsn, "goods", `lines[${index}].hsnSac`);
      if (!hsnCheck.ok) {
        add({
          code: "HSN_INVALID",
          severity: "SIGNIFICANT",
          field: `lines[${index}].hsnSac`,
          message: `The HSN code "${hsn}" on line ${index + 1} is not a valid one. It decides the tax rate, so it has to be right.`,
          ...(line.hsnSac?.evidence ? { evidence: line.hsnSac.evidence } : {}),
        });
      }
    }
    if (line.gstRateBasisPoints === undefined) {
      add({
        code: "GST_RATE_MISSING",
        severity: "SIGNIFICANT",
        field: `lines[${index}].gstRateBasisPoints`,
        message: `No GST rate could be read for line ${index + 1}, so the tax on it cannot be worked out.`,
      });
    }
  });

  // ---- Totals, recomputed rather than read -------------------------------------------
  const recomputed = recomputeTotals(draft.lines, policy);
  for (const problem of recomputed.lineProblems) {
    add({ code: "LINE_ARITHMETIC", severity: "SIGNIFICANT", field: problem.split(":")[0] ?? "lines", message: problem });
  }

  const compare = (
    field: "taxableValuePaise" | "totalTaxPaise" | "invoiceTotalPaise",
    code: "TAXABLE_VALUE_MISMATCH" | "TAX_MISMATCH" | "TOTAL_MISMATCH",
    severity: FindingSeverity,
    tolerance: bigint,
    relative: number,
    plain: string,
  ) => {
    const printed = draft[field]?.value;
    if (printed === undefined || !recomputed.complete) return;
    const ours = recomputed[field];
    if (withinTolerance(printed, ours, tolerance, relative)) return;
    add({
      code,
      severity,
      field,
      message: `${plain} The bill says ${formatPaise(printed)}, but the lines add up to ${formatPaise(ours)}.`,
      ...(draft[field]?.evidence ? { evidence: draft[field]!.evidence } : {}),
      documentSays: printed.toString(),
      weCalculated: ours.toString(),
    });
    corrections.push({
      field,
      clears: code,
      currentValue: printed.toString(),
      suggestedValue: ours.toString(),
      reason: "Worked out from the lines on the bill.",
      ...(draft[field]?.evidence ? { evidence: draft[field]!.evidence } : {}),
    });
  };

  compare("taxableValuePaise", "TAXABLE_VALUE_MISMATCH", "SIGNIFICANT", policy.roundingPaise, 0, "The value before tax does not match the lines.");
  compare("totalTaxPaise", "TAX_MISMATCH", "SIGNIFICANT", policy.taxAbsolutePaise, 0, "The tax does not match the lines.");
  compare("invoiceTotalPaise", "TOTAL_MISMATCH", "MATERIAL", policy.totalAbsolutePaise, policy.totalRelativeBasisPoints, "The total on this bill is not what the lines add up to.");

  // ---- Tax split, from the rules engine and never guessed ----------------------------
  const taxCheck = checkTaxSplit(input, printedGstin, buyerStateCode);
  if (taxCheck.basis === "SELF_CONSISTENCY_ONLY") {
    // Not wiring the rules engine at all is a caller's configuration choice, and is reported
    // without holding the bill up. The engine being unable to answer is a different matter:
    // that means a fact about this document is genuinely unknown, and a person must settle it.
    const consulted = input.taxSplit !== undefined;
    add({
      code: consulted
        ? taxCheck.missingFacts !== undefined && taxCheck.missingFacts.length > 0
          ? "TAX_SPLIT_UNDECIDED"
          : "PLACE_OF_SUPPLY_UNKNOWN"
        : "TAX_RULES_NOT_CONSULTED",
      severity: consulted ? "SIGNIFICANT" : "MINOR",
      field: "taxCheck",
      message: taxCheck.explanation,
    });
  }

  // ---- Duplicates --------------------------------------------------------------------
  const duplicate = assessDuplicates(draft, input.existing ?? []);
  if (duplicate.verdict === "CONFIRMED") {
    add({ code: "DUPLICATE_CONFIRMED", severity: "MATERIAL", field: "invoiceNumber", message: duplicate.message });
  } else if (duplicate.verdict === "LIKELY") {
    add({ code: "DUPLICATE_LIKELY", severity: "SIGNIFICANT", field: "invoiceNumber", message: duplicate.message });
  } else if (duplicate.verdict === "POSSIBLE") {
    add({ code: "DUPLICATE_POSSIBLE", severity: "MINOR", field: "invoiceNumber", message: duplicate.message });
  } else if (duplicate.verdict === "AMENDMENT") {
    // A reissued bill under the same number is legitimate, but it is not something to let
    // through unseen: the earlier one may already have been paid.
    add({ code: "INVOICE_AMENDMENT", severity: "SIGNIFICANT", field: "invoiceNumber", message: duplicate.message });
  }

  // Anything #15 already knew needed a human keeps needing one.
  for (const field of draft.fieldsNeedingReview) {
    add({
      code: "GST_RATE_MISSING",
      severity: "SIGNIFICANT",
      field,
      message: `"${field}" was read with low confidence, so it needs to be confirmed before this is entered.`,
    });
  }

  const status = statusFrom(findings);
  const fingerprint = createHash("sha256")
    .update([draft.id, duplicate.fingerprint, status, findings.map((f) => `${f.code}:${f.field}`).sort().join(","), policy.effectiveFrom].join("\n"))
    .digest("hex");

  return {
    draftId: draft.id,
    companyId: draft.companyId,
    status,
    findings,
    duplicate,
    recomputed,
    taxCheck,
    corrections,
    policy,
    fingerprint,
    summary: summarise(status, findings),
  };
}

function checkTaxSplit(input: ValidatePurchaseInput, supplierGstin: string | undefined, buyerStateCode: string | undefined): TaxCheck {
  const documentDate = input.draft.invoiceDate?.value;
  if (input.taxSplit === undefined) {
    return { basis: "SELF_CONSISTENCY_ONLY", explanation: "The tax rules were not available, so the tax on this bill was only checked against its own figures." };
  }
  if (supplierGstin === undefined || buyerStateCode === undefined || documentDate === undefined) {
    return {
      basis: "SELF_CONSISTENCY_ONLY",
      missingFacts: [
        ...(supplierGstin === undefined ? ["supply.supplierStateCode"] : []),
        ...(buyerStateCode === undefined ? ["supply.placeOfSupplyStateCode"] : []),
        ...(documentDate === undefined ? ["document.date"] : []),
      ],
      explanation: "Where this purchase counts for GST could not be established, so the tax split was not checked. Someone needs to confirm it.",
    };
  }
  const answer = input.taxSplit.splitFor({
    supplierStateCode: gstinStateCode(supplierGstin),
    placeOfSupplyStateCode: buyerStateCode,
    documentDate,
  });
  if (answer.kind === "CANNOT_DECIDE") {
    return { basis: "SELF_CONSISTENCY_ONLY", missingFacts: answer.missingFacts, explanation: answer.explanation };
  }
  return {
    basis: "RULES_ENGINE",
    intraState: answer.intraState,
    ruleSetVersion: answer.ruleSetVersion,
    ruleId: answer.ruleId,
    explanation: answer.explanation,
  };
}

const statusFrom = (findings: readonly Finding[]): ValidationStatus => {
  if (findings.some((finding) => finding.severity === "MATERIAL")) return "BLOCKED";
  if (findings.some((finding) => finding.severity === "SIGNIFICANT")) return "NEEDS_REVIEW";
  return "POSTABLE";
};

const summarise = (status: ValidationStatus, findings: readonly Finding[]): string => {
  if (status === "POSTABLE") return "This bill checks out and is ready to be entered.";
  const blocking = findings.filter((finding) => finding.severity === "MATERIAL");
  if (blocking.length > 0) return blocking[0]?.message ?? "This bill cannot be entered yet.";
  const count = findings.filter((finding) => finding.severity === "SIGNIFICANT").length;
  return count === 1
    ? "There is one thing to check before this bill is entered."
    : `There are ${count} things to check before this bill is entered.`;
};
