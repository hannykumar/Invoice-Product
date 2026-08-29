// Issue #26 [E26] — deciding whether an invoice needs an IRN at all.
//
// The non-goal that shapes this file is "assume every GST invoice needs an IRN". Registering
// everything looks like the safe default and is not one: an e-invoice that did not need to exist
// sits on the government's record, and after twenty-four hours it cannot be withdrawn. The
// shopkeeper who raises four bills a day needs none of this, and telling them otherwise is wrong.
//
// So every answer here is a decision with a reason, a rule id, an effective date and the
// notification it came from. Where a fact is missing the answer is `CANNOT_DECIDE`, never a guess
// in either direction — rule 4 of the brief, and the reason the exception queue exists.

import { formatPaise } from "../../purchasing/src/money.ts";
import type {
  ApplicabilityDecision, EInvoiceApplicabilityInput, TurnoverThreshold,
} from "./einvoice-types.ts";

export const EINVOICE_RULE_SET_VERSION = "in.gst.einvoice.2026.1";

/**
 * The turnover thresholds, newest first.
 *
 * Every one of these moved because of a notification, and an invoice is judged under the
 * threshold in force on its own date — which is why a 2021 invoice and a 2026 invoice from the
 * same business can honestly get different answers.
 *
 * Figures are aggregate annual turnover in paise. ₹5 crore is 5,00,00,000 rupees.
 */
export const TURNOVER_THRESHOLDS: readonly TurnoverThreshold[] = Object.freeze([
  {
    effectiveFrom: "2023-08-01",
    thresholdPaise: 5_00_00_000_00n,
    sourceRef: "Notification 10/2023 - Central Tax, 10 May 2023",
    ruleId: "EINV.THRESHOLD.5CR",
  },
  {
    effectiveFrom: "2022-10-01",
    thresholdPaise: 10_00_00_000_00n,
    sourceRef: "Notification 17/2022 - Central Tax, 1 August 2022",
    ruleId: "EINV.THRESHOLD.10CR",
  },
  {
    effectiveFrom: "2022-04-01",
    thresholdPaise: 20_00_00_000_00n,
    sourceRef: "Notification 1/2022 - Central Tax, 24 February 2022",
    ruleId: "EINV.THRESHOLD.20CR",
  },
  {
    effectiveFrom: "2021-04-01",
    thresholdPaise: 50_00_00_000_00n,
    sourceRef: "Notification 5/2021 - Central Tax, 8 March 2021",
    ruleId: "EINV.THRESHOLD.50CR",
  },
  {
    effectiveFrom: "2020-10-01",
    thresholdPaise: 500_00_00_000_00n,
    sourceRef: "Notification 61/2020 - Central Tax, 30 July 2020",
    ruleId: "EINV.THRESHOLD.500CR",
  },
]);

/** The threshold in force on a date, or null when e-invoicing had not begun yet. */
export const thresholdOn = (documentDate: string): TurnoverThreshold | null =>
  TURNOVER_THRESHOLDS.find((threshold) => threshold.effectiveFrom <= documentDate) ?? null;

/** Recipient kinds that are reportable when the supplier is above the threshold. */
const REPORTABLE_RECIPIENTS = new Set([
  "B2B", "EXPORT_WITH_PAYMENT", "EXPORT_WITHOUT_PAYMENT",
  "SEZ_WITH_PAYMENT", "SEZ_WITHOUT_PAYMENT", "DEEMED_EXPORT",
]);

const EXEMPT_LABELS: Record<string, string> = {
  SEZ_UNIT: "a unit in a Special Economic Zone",
  INSURANCE: "an insurance business",
  BANKING_OR_NBFC: "a bank or a non-banking finance company",
  GOODS_TRANSPORT_AGENCY: "a goods transport agency",
  PASSENGER_TRANSPORT: "a passenger transport business",
  CINEMA_ADMISSION: "a cinema showing films",
  GOVERNMENT_DEPARTMENT: "a government department",
};

/**
 * Decides whether this document needs an IRN.
 *
 * Reads nothing and writes nothing: the same facts always give the same answer, so a decision can
 * be re-run and defended long after the invoice was raised.
 */
export const decideApplicability = (input: EInvoiceApplicabilityInput): ApplicabilityDecision => {
  const base = { ruleSetVersion: EINVOICE_RULE_SET_VERSION } as const;

  // A bill of supply carries no tax and is never reported, whatever the turnover.
  if (input.isBillOfSupply === true) {
    return {
      ...base, outcome: "NOT_APPLICABLE", ruleId: "EINV.DOC.BILL_OF_SUPPLY",
      reason: "This is a bill of supply, which carries no GST, so it never needs an e-invoice number.",
    };
  }

  // Before e-invoicing existed, nothing was reportable. A back-dated document must not acquire an
  // obligation that did not exist when it was raised.
  const threshold = thresholdOn(input.documentDate);
  if (threshold === null) {
    return {
      ...base, outcome: "NOT_APPLICABLE", ruleId: "EINV.NOT_YET_IN_FORCE",
      reason: `E-invoicing did not apply to any business on ${input.documentDate}, so this bill needs no e-invoice number.`,
    };
  }

  // A business the notifications exempt is exempt however much it turns over.
  const exempt = (input.supplier.exemptCategories ?? [])[0];
  if (exempt !== undefined) {
    return {
      ...base, outcome: "NOT_APPLICABLE", ruleId: `EINV.EXEMPT.${exempt}`,
      sourceRef: "Notification 13/2020 - Central Tax, 21 March 2020, as amended",
      reason: `This business is ${EXEMPT_LABELS[exempt] ?? "in an exempt category"}, which the rules exempt from e-invoicing whatever its turnover.`,
    };
  }

  // Only these three documents can carry an IRN. A delivery challan or a receipt cannot.
  if (!["INVOICE", "CREDIT_NOTE", "DEBIT_NOTE"].includes(input.documentType)) {
    return {
      ...base, outcome: "NOT_APPLICABLE", ruleId: "EINV.DOC.NOT_REPORTABLE",
      reason: "Only invoices, credit notes and debit notes are reported to the government. This document is none of those.",
    };
  }

  // A sale to a consumer never carries an IRN, however large. Large B2C bills need a dynamic QR
  // code instead, which is a separate obligation and not this module's.
  if (input.recipientKind === "B2C") {
    return {
      ...base, outcome: "NOT_APPLICABLE", ruleId: "EINV.RECIPIENT.B2C",
      reason: "This is a sale to a customer who is not GST-registered, and those are never given an e-invoice number, however large the bill.",
    };
  }

  if (!REPORTABLE_RECIPIENTS.has(input.recipientKind)) {
    return {
      ...base, outcome: "NOT_APPLICABLE", ruleId: "EINV.RECIPIENT.NOT_REPORTABLE",
      reason: "This kind of sale is not reported to the government's e-invoice system.",
    };
  }

  // A B2B sale needs the buyer's GST number, and its absence is a question, not a decision.
  if (input.recipientKind === "B2B" && (input.recipientGstin ?? "").trim() === "") {
    return {
      ...base, outcome: "CANNOT_DECIDE", ruleId: "EINV.RECIPIENT.GSTIN_MISSING",
      reason: "This is marked as a sale to a GST-registered business, but the buyer's GST number is missing, so we cannot tell whether it needs an e-invoice number.",
      missingFacts: ["recipientGstin"],
    };
  }

  // The department can require a business to report regardless of its turnover.
  if (input.supplier.mandatedByDepartment === true) {
    return {
      ...base, outcome: "APPLICABLE", ruleId: "EINV.MANDATED",
      reason: "The department has told this business it must report its invoices, so this bill needs an e-invoice number before it goes to the customer.",
      thresholdApplied: threshold,
    };
  }

  // Turnover is the deciding fact, and we will not guess it. A business that has not told us its
  // turnover gets a question rather than a wrong answer in either direction.
  const turnover = input.supplier.aggregateTurnoverPaise;
  if (turnover === undefined) {
    return {
      ...base, outcome: "CANNOT_DECIDE", ruleId: "EINV.TURNOVER.UNKNOWN",
      sourceRef: threshold.sourceRef,
      reason: `Whether this bill needs an e-invoice number depends on your yearly turnover, and we have not been told it. Businesses turning over more than ${formatPaise(threshold.thresholdPaise)} a year must report their bills.`,
      missingFacts: ["supplier.aggregateTurnoverPaise"],
      thresholdApplied: threshold,
    };
  }

  if (turnover >= threshold.thresholdPaise) {
    return {
      ...base, outcome: "APPLICABLE", ruleId: threshold.ruleId, sourceRef: threshold.sourceRef,
      reason: `Your yearly turnover of ${formatPaise(turnover)} is at or above the ${formatPaise(threshold.thresholdPaise)} limit that applies from ${threshold.effectiveFrom}, so this bill needs an e-invoice number before it goes to the customer.`,
      thresholdApplied: threshold,
    };
  }

  return {
    ...base, outcome: "NOT_APPLICABLE", ruleId: threshold.ruleId, sourceRef: threshold.sourceRef,
    reason: `Your yearly turnover of ${formatPaise(turnover)} is below the ${formatPaise(threshold.thresholdPaise)} limit, so this bill does not need an e-invoice number. It is an ordinary GST bill.`,
    thresholdApplied: threshold,
  };
};
