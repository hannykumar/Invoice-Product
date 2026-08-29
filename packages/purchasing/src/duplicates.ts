// Issue #16 [E16] — has this bill already been entered?
//
// Paying a supplier twice is one of the few mistakes this product must never allow through
// quietly. Two independent signals are computed and reported separately, so a reviewer can
// see *why* something was flagged rather than being handed a score.

import { createHash } from "node:crypto";
import type { IsoDate, Paise } from "../../masters/src/types.ts";
import { normaliseIdentifier } from "../../masters/src/validation.ts";
import { formatPaise } from "./money.ts";
import type { ExtractionDraft } from "./inbox-types.ts";
import type { DuplicateAssessment, DuplicateMatch, ExistingPurchase } from "./validation-types.ts";

/**
 * Supplier invoice numbers are written inconsistently — "INV/2026/001", "INV-2026-001" and
 * "inv 2026 001" are the same bill. Punctuation and case are dropped for comparison only;
 * the original is always what gets stored and shown.
 */
export const normaliseInvoiceNumber = (raw: string): string => raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

/** Weights sum to 1. These are arithmetic, not a learned score. */
const WEIGHTS = { supplierGstin: 0.3, invoiceNumber: 0.3, invoiceDate: 0.2, invoiceTotal: 0.2 } as const;

/**
 * A hash over what identifies an invoice, not over the file. Two scans of the same bill produce
 * different files but the same fingerprint, which is what catches a re-send that was retyped.
 */
export function contentFingerprint(input: {
  readonly supplierGstin?: string;
  readonly invoiceNumber?: string;
  readonly invoiceDate?: string;
  readonly invoiceTotalPaise?: Paise;
  readonly lines?: readonly { readonly hsnSac?: string; readonly quantity?: string; readonly ratePaise?: Paise }[];
}): string {
  const lines = (input.lines ?? [])
    .map((line) => [line.hsnSac ?? "", (line.quantity ?? "").replace(/,/g, ""), (line.ratePaise ?? 0n).toString()].join("|"))
    .sort();
  const canonical = [
    normaliseIdentifier(input.supplierGstin ?? ""),
    normaliseInvoiceNumber(input.invoiceNumber ?? ""),
    input.invoiceDate ?? "",
    (input.invoiceTotalPaise ?? 0n).toString(),
    ...lines,
  ].join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

export function fingerprintOfDraft(draft: ExtractionDraft): string {
  return contentFingerprint({
    ...(draft.supplierGstin ? { supplierGstin: draft.supplierGstin.value } : {}),
    ...(draft.invoiceNumber ? { invoiceNumber: draft.invoiceNumber.value } : {}),
    ...(draft.invoiceDate ? { invoiceDate: draft.invoiceDate.value } : {}),
    ...(draft.invoiceTotalPaise ? { invoiceTotalPaise: draft.invoiceTotalPaise.value } : {}),
    lines: draft.lines.map((line) => ({
      ...(line.hsnSac ? { hsnSac: line.hsnSac.value } : {}),
      ...(line.quantity ? { quantity: line.quantity.value } : {}),
      ...(line.ratePaise ? { ratePaise: line.ratePaise.value } : {}),
    })),
  });
}

const laterThan = (a: IsoDate, b: IsoDate): boolean => a > b;

/**
 * Compare a draft against the purchases already on record.
 *
 * An amended invoice is deliberately not a duplicate: suppliers reissue a corrected bill under
 * the same number, and blocking that would stop legitimate work. Same number, a later date and a
 * different total reads as an amendment and is surfaced as such, for a person to confirm.
 */
export function assessDuplicates(draft: ExtractionDraft, existing: readonly ExistingPurchase[]): DuplicateAssessment {
  const fingerprint = fingerprintOfDraft(draft);
  const gstin = draft.supplierGstin ? normaliseIdentifier(draft.supplierGstin.value) : null;
  const number = draft.invoiceNumber ? normaliseInvoiceNumber(draft.invoiceNumber.value) : null;
  const date = draft.invoiceDate?.value ?? null;
  const total = draft.invoiceTotalPaise?.value ?? null;

  const matches: DuplicateMatch[] = [];
  let amendment = false;

  for (const candidate of existing) {
    if (candidate.companyId !== draft.companyId) continue; // tenancy is never crossed (rule 6)

    const agreed: string[] = [];
    const disagreed: string[] = [];
    let score = 0;

    const compare = (field: keyof typeof WEIGHTS, mine: string | null, theirs: string) => {
      if (mine === null) return;
      if (mine === theirs) {
        agreed.push(field);
        score += WEIGHTS[field];
      } else {
        disagreed.push(field);
      }
    };

    compare("supplierGstin", gstin, normaliseIdentifier(candidate.supplierGstin));
    compare("invoiceNumber", number, normaliseInvoiceNumber(candidate.invoiceNumber));
    compare("invoiceDate", date, candidate.invoiceDate);
    compare("invoiceTotal", total === null ? null : total.toString(), candidate.invoiceTotalPaise.toString());

    const byFingerprint = candidate.contentFingerprint === fingerprint;
    if (byFingerprint && !agreed.includes("contentFingerprint")) score = Math.max(score, 0.95);

    const looksAmended =
      agreed.includes("supplierGstin") &&
      agreed.includes("invoiceNumber") &&
      disagreed.includes("invoiceTotal") &&
      date !== null &&
      laterThan(date, candidate.invoiceDate);
    if (looksAmended) amendment = true;

    if (score < 0.45 && !byFingerprint) continue;

    const matchedBy: ("LOGICAL_KEY" | "CONTENT_FINGERPRINT")[] = [];
    if (agreed.length === 4) matchedBy.push("LOGICAL_KEY");
    if (byFingerprint) matchedBy.push("CONTENT_FINGERPRINT");

    matches.push({
      purchaseId: candidate.id,
      invoiceNumber: candidate.invoiceNumber,
      invoiceDate: candidate.invoiceDate,
      invoiceTotalPaise: candidate.invoiceTotalPaise.toString(),
      enteredOn: candidate.enteredOn,
      agreed,
      disagreed,
      confidence: Math.round(Math.min(score, 1) * 100) / 100,
      matchedBy,
    });
  }

  matches.sort((a, b) => b.confidence - a.confidence);
  const best = matches[0];

  if (best === undefined) {
    return { verdict: "NONE", matches: [], fingerprint, message: "This bill has not been entered before." };
  }

  const strongest = best.matchedBy.length > 0 || best.confidence >= 0.95;
  if (amendment && !best.matchedBy.includes("LOGICAL_KEY")) {
    return {
      verdict: "AMENDMENT",
      matches,
      fingerprint,
      message: `This looks like a corrected copy of bill ${best.invoiceNumber} dated ${best.invoiceDate}, not the same bill again. Please confirm before entering it.`,
    };
  }
  if (strongest) {
    return {
      verdict: "CONFIRMED",
      matches,
      fingerprint,
      message: `This bill has already been entered on ${best.enteredOn} for ${formatPaise(BigInt(best.invoiceTotalPaise))}, so adding it again would pay the same supplier twice.`,
    };
  }
  if (best.confidence >= 0.7) {
    return {
      verdict: "LIKELY",
      matches,
      fingerprint,
      message: `This is very close to bill ${best.invoiceNumber} entered on ${best.enteredOn}. Please check it is not the same bill before continuing.`,
    };
  }
  return {
    verdict: "POSSIBLE",
    matches,
    fingerprint,
    message: `This has something in common with bill ${best.invoiceNumber} entered on ${best.enteredOn}. It is probably a different bill, but worth a look.`,
  };
}
