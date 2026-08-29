// Issue #19 [E19] — turning what we know about a supplier into warnings a buyer can act on.
//
// Pure: no database, no network, no permissions. The same facts always give the same warnings,
// which is what lets an assessment be shown to a supplier who disputes it.
//
// The three guarantees this file exists to keep, each enforced rather than intended:
//
//   1. **Every warning names its evidence.** `warn()` refuses to build one without it.
//   2. **No party is called fraudulent from a score.** A `ModelHint` is rendered as a guess at
//      INFORMATION and is excluded from the level calculation by construction, not by policy.
//   3. **Missing or stale government data is never held against the supplier.** It produces its
//      own INFORMATION warning about *our* data, and cannot raise the level.

import { createHash } from "node:crypto";
import { formatPaise } from "./money.ts";
import { ageInDays, maskAccount, readableDate, safeMessage } from "./supplier-risk-wording.ts";
import { DEFAULT_RISK_POLICY } from "./supplier-risk-types.ts";
import type {
  AssessmentConfidence, Evidence, EvidenceSource, GstinLookupOutcome, GstinRecord, Gstr2bSignal,
  LightColour, ModelHint, RiskLevel, RiskLight, RiskPolicy, SourceStatus, SupplierHistory,
  SupplierRiskAssessment, SupplierRiskCode, SupplierRiskWarning,
} from "./supplier-risk-types.ts";
import type { Id, IsoDate } from "../../masters/src/types.ts";

export interface SupplierRiskInput {
  readonly companyId: Id;
  readonly supplierPartyId: Id;
  readonly supplierName: string;
  readonly gstin?: string;
  /** The state we believe they are in, from the supplier master. */
  readonly expectedStateCode?: string;
  readonly invoiceNumber?: string;
  readonly invoiceDate?: IsoDate;
  /** What the GST portal said, or why it could not say. */
  readonly gstin_lookup?: GstinLookupOutcome;
  /** Our own books. Always present — we can always read our own records. */
  readonly history: SupplierHistory;
  /** #31's signal, when it exists. Absent means "not checked", never "missing, so suspicious". */
  readonly gstr2b?: Gstr2bSignal;
  /** A model's opinion, shown as a guess and never allowed to change the level. */
  readonly modelHint?: ModelHint;
  /** The day the assessment is being made, for staleness and date comparisons. */
  readonly on: IsoDate;
}

const LEVEL_RANK: Record<RiskLevel, number> = { SERIOUS: 0, CAUTION: 1, INFORMATION: 2 };

/** Levels a source that could not answer is allowed to reach. Deliberately only the lowest. */
const worst = (levels: readonly RiskLevel[]): RiskLevel =>
  levels.reduce<RiskLevel>((best, level) => (LEVEL_RANK[level] < LEVEL_RANK[best] ? level : best), "INFORMATION");

/**
 * Compares two business names loosely enough to ignore how they are written down.
 *
 * "Shree Ram Steels Pvt Ltd" and "SHREE RAM STEELS PRIVATE LIMITED" are the same business, and
 * flagging that pair would train people to ignore the warning that matters.
 */
const namesAgree = (left: string, right: string): boolean => {
  const normalise = (value: string): string =>
    value.toUpperCase()
      .replace(/\bPRIVATE\b/g, "PVT").replace(/\bLIMITED\b/g, "LTD")
      .replace(/\bAND\b/g, "&").replace(/[^A-Z0-9&]/g, "");
  return normalise(left) === normalise(right);
};

/**
 * Assesses one supplier against everything we know about them.
 *
 * Any of the government sources may be missing. When they are, the assessment says so and carries
 * `confidence: "PARTIAL"` — it never pretends a clean result, because "we could not check" and
 * "we checked and it was fine" are different things and a buyer deserves to know which they have.
 */
export const assessSupplierRisk = (
  input: SupplierRiskInput,
  policy: RiskPolicy = DEFAULT_RISK_POLICY,
  clock: () => Date = () => new Date(),
): SupplierRiskAssessment => {
  const warnings: SupplierRiskWarning[] = [];

  /** Builds a warning. Refuses to make one without evidence, and screens its wording. */
  const warn = (
    code: SupplierRiskCode,
    level: RiskLevel,
    message: string,
    suggestedAction: string,
    evidence: readonly Evidence[],
  ): void => {
    if (evidence.length === 0) {
      throw new Error(`Supplier warning ${code} was built with no evidence, which is not something we are willing to show.`);
    }
    warnings.push({
      code, level,
      message: safeMessage(message),
      suggestedAction: safeMessage(suggestedAction),
      evidence,
    });
  };

  const ours = (statement: string, effectiveFrom?: IsoDate): Evidence => ({
    source: "OUR_RECORDS", statement, stale: false,
    ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
  });

  // ------------------------------------------------------------------ the GST registration

  const lookup = input.gstin_lookup;
  let gstRecord: GstinRecord | undefined;
  let gstStale = false;
  let gstAnswered = false;

  if (input.gstin === undefined) {
    // Not a fault: plenty of small suppliers are not registered, and reverse charge covers it.
    warn("GOVERNMENT_DATA_UNAVAILABLE", "INFORMATION",
      `We have no GST number on record for ${input.supplierName}, so nothing could be checked with the GST department.`,
      "If they are registered, add their GST number so we can check it for you.",
      [ours("No GST number is saved against this supplier.")]);
  } else if (lookup === undefined || lookup.kind === "UNAVAILABLE") {
    const fallback = lookup?.kind === "UNAVAILABLE" ? lookup.lastKnown : undefined;
    if (fallback !== undefined) {
      gstRecord = fallback;
      gstStale = true;
      gstAnswered = true;
    }
    const reason = lookup?.kind === "UNAVAILABLE" ? lookup.reason : "NOT_CONFIGURED";
    const explanation = lookup?.kind === "UNAVAILABLE" ? lookup.explanation : "The GST check has not been switched on for this business yet.";
    warn("GOVERNMENT_DATA_UNAVAILABLE", "INFORMATION",
      `We could not reach the GST department just now, so this supplier's registration has not been checked today. ${explanation}`,
      fallback === undefined
        ? "Try again in a little while. Nothing here says anything is wrong with this supplier."
        : `We are showing you what we last saw, from ${readableDate(fallback.observedAt)}. Try again in a little while for an up-to-date answer.`,
      [{
        source: "GST_PORTAL",
        statement: "The GST department could not be reached for this check.",
        stale: true,
        unavailable: { reason, retryable: lookup?.kind === "UNAVAILABLE" ? lookup.retryable : false },
      }]);
  }

  if (lookup?.kind === "FOUND") {
    gstRecord = lookup.record;
    gstAnswered = true;
    gstStale = ageInDays(lookup.record.observedAt, input.on) > policy.governmentDataStaleAfterDays;
  }

  if (gstRecord !== undefined) {
    const record = gstRecord;
    const age = ageInDays(record.observedAt, input.on);
    const gst = (statement: string, effectiveFrom?: IsoDate): Evidence => ({
      source: "GST_PORTAL", statement, observedAt: record.observedAt, ageInDays: age, stale: gstStale,
      ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
    });

    if (gstStale) {
      // A reading taken today that we simply could not refresh is not "old"; saying it was would
      // be its own small untruth, and this module is built on not telling those.
      warn("GOVERNMENT_DATA_STALE", "INFORMATION",
        age === 0
          ? `We could not check with the GST department again just now, so what you see below is the answer we already had from earlier today.`
          : `The GST department's answer about this supplier is ${age} ${age === 1 ? "day" : "days"} old, from ${readableDate(record.observedAt)}. It may have changed since.`,
        "Refresh the check if you are about to pay a large amount.",
        [gst(`This reading was taken on ${readableDate(record.observedAt)}.`)]);
    }

    const changed = record.statusChangedOn;
    const invoiceDate = input.invoiceDate;

    if (record.status === "CANCELLED") {
      // The user's own example. Whether the cancellation predates the bill changes everything:
      // a bill raised before cancellation is ordinarily fine, and saying otherwise would be wrong.
      const before = changed !== undefined && invoiceDate !== undefined && changed <= invoiceDate;
      if (before) {
        warn("GSTIN_CANCELLED_BEFORE_INVOICE", "SERIOUS",
          `The GST department's records show this supplier's GST number ${record.gstin} was cancelled on ${readableDate(changed)}, which is before the date on this bill (${readableDate(invoiceDate)}). GST charged on a cancelled number normally cannot be claimed back.`,
          "Check with the supplier before you pay, and ask them for a bill under a valid GST number.",
          [gst(`GST number ${record.gstin} is shown as cancelled with effect from ${readableDate(changed)}.`, changed),
           { source: "SUPPLIER_DOCUMENT", statement: `The bill is dated ${readableDate(invoiceDate)}.`, stale: false, effectiveFrom: invoiceDate }]);
      } else if (changed !== undefined && invoiceDate !== undefined) {
        warn("GSTIN_CANCELLED_AFTER_INVOICE", "CAUTION",
          `This supplier's GST number was cancelled on ${readableDate(changed)}, which is after this bill was raised on ${readableDate(invoiceDate)}. This bill itself is not affected, but any later bill from this number would be.`,
          "Ask them for their current GST number before the next purchase.",
          [gst(`GST number ${record.gstin} is shown as cancelled with effect from ${readableDate(changed)}.`, changed)]);
      } else {
        warn("GSTIN_CANCELLED_BEFORE_INVOICE", "SERIOUS",
          `The GST department's records show this supplier's GST number ${record.gstin} is cancelled. The department did not give a date for it.`,
          "Check with the supplier before you pay.",
          [gst(`GST number ${record.gstin} is shown as cancelled.`)]);
      }
    }

    if (record.status === "SUSPENDED") {
      warn("GSTIN_SUSPENDED", "SERIOUS",
        `The GST department's records show this supplier's GST number ${record.gstin} is suspended${changed === undefined ? "" : ` with effect from ${readableDate(changed)}`}. A suspended number usually means the department is asking them something.`,
        "Check with the supplier before you pay. They may be able to clear it up quickly.",
        [gst(`GST number ${record.gstin} is shown as suspended.`, changed)]);
    }

    if (record.status === "INACTIVE") {
      warn("GSTIN_INACTIVE", "CAUTION",
        `The GST department's records show this supplier's GST number ${record.gstin} is no longer active.`,
        "Ask the supplier which GST number to use for this purchase.",
        [gst(`GST number ${record.gstin} is shown as inactive.`, changed)]);
    }

    if (record.status === "PROVISIONAL") {
      warn("GSTIN_PROVISIONAL", "INFORMATION",
        `This supplier's GST registration is still provisional, which means the department has not finished processing it.`,
        "Nothing to do. Their registration should become regular on its own.",
        [gst(`GST number ${record.gstin} is shown as provisional.`)]);
    }

    if (record.status === "NOT_FOUND") {
      // The portal actively said there is no such number. That is a fact about the number, and it
      // is stated as one — the honest reading is a typo at least as often as anything else.
      warn("GSTIN_NOT_FOUND", "SERIOUS",
        `The GST department has no record of the number ${record.gstin}. Most often this means a digit was mistyped when the number was saved.`,
        "Check the GST number against their bill, correct it if it is wrong, and check with the supplier if it still does not come up.",
        [gst(`The GST department returned no registration for ${record.gstin}.`)]);
    }

    if (record.registeredOn !== undefined && record.status === "ACTIVE") {
      const days = ageInDays(`${record.registeredOn}T00:00:00Z`, input.on);
      if (days <= policy.newRegistrationDays) {
        warn("GSTIN_REGISTERED_RECENTLY", "INFORMATION",
          `This supplier's GST registration is recent — it was taken on ${readableDate(record.registeredOn)}, ${days} days ago. New businesses are new, and that is all this means.`,
          "Nothing to do. Worth knowing if this is also a large first order.",
          [gst(`GST number ${record.gstin} was registered on ${readableDate(record.registeredOn)}.`, record.registeredOn)]);
      }
    }

    const portalName = record.legalName ?? record.tradeName;
    if (portalName !== undefined && !namesAgree(portalName, input.supplierName)) {
      warn("GSTIN_NAME_DIFFERS", "CAUTION",
        `The name against this GST number at the department is "${portalName}", but you have this supplier saved as "${input.supplierName}".`,
        "Check you have the right GST number for this supplier, or update the name you have saved.",
        [gst(`GST number ${record.gstin} is registered to "${portalName}".`),
         ours(`This supplier is saved here as "${input.supplierName}".`)]);
    }

    if (record.stateCode !== undefined && input.expectedStateCode !== undefined && record.stateCode !== input.expectedStateCode) {
      warn("GSTIN_STATE_DIFFERS", "CAUTION",
        `This GST number is registered in state ${record.stateCode}, but you have this supplier's address in state ${input.expectedStateCode}. That changes whether the bill should carry IGST or CGST and SGST.`,
        "Check which state they are supplying from, so the tax on the bill goes under the right head.",
        [gst(`GST number ${record.gstin} belongs to state code ${record.stateCode}.`),
         ours(`This supplier's address is in state code ${input.expectedStateCode}.`)]);
    }

    const missed = record.filings.filter((filing) => filing.status === "NOT_FILED");
    // Counted by period, not by form: a month with both GSTR-1 and GSTR-3B outstanding is one
    // month behind, and saying "07-2026, 07-2026" would just look like a bug to the reader.
    const missedPeriods = [...new Set(missed.map((filing) => filing.period))].sort();
    if (missedPeriods.length >= policy.missedReturnPeriods) {
      warn("RETURNS_NOT_FILED", "CAUTION",
        `The GST department's records show this supplier has not filed returns for ${missedPeriods.length} ${missedPeriods.length === 1 ? "period" : "periods"} (${missedPeriods.join(", ")}). Until they file, the GST on their bills may not show up for you to claim.`,
        "You can still record the bill. Ask them when they plan to file, before you claim the GST back.",
        [gst(`Returns not filed for: ${missed.map((filing) => `${filing.returnType} ${filing.period}`).join(", ")}.`)]);
    }

    if (record.eInvoiceEnabled === true && input.invoiceNumber !== undefined) {
      warn("EINVOICE_EXPECTED_BUT_ABSENT", "INFORMATION",
        `This supplier is required to issue e-invoices, so their bill should carry an IRN and a QR code. We have not been given one for bill ${input.invoiceNumber}.`,
        "Ask them for the e-invoice. Without it, claiming the GST back can be held up.",
        [gst(`GST number ${record.gstin} is marked as required to issue e-invoices.`),
         { source: "SUPPLIER_DOCUMENT", statement: `No IRN was recorded against bill ${input.invoiceNumber}.`, stale: false }]);
    }
  }

  // ----------------------------------------------------------------- IMS / GSTR-2B (#31)

  if (input.gstr2b === undefined) {
    warn("GSTR2B_NOT_CHECKED", "INFORMATION",
      "We have not checked this bill against your GSTR-2B yet, because that part of the product is not connected.",
      "Nothing to do. This is about what we can see, not about the supplier.",
      [ours("GSTR-2B reconciliation is not connected for this business.")]);
  } else {
    const signal = input.gstr2b;
    const evidence: Evidence = {
      source: "IMS_GSTR2B",
      statement: signal.present
        ? `Bill found in the GSTR-2B data for ${signal.period}.`
        : `Bill not found in the GSTR-2B data for ${signal.period}.`,
      observedAt: signal.observedAt,
      ageInDays: ageInDays(signal.observedAt, input.on),
      stale: ageInDays(signal.observedAt, input.on) > policy.governmentDataStaleAfterDays,
    };
    if (!signal.present) {
      warn("NOT_IN_GSTR2B", "CAUTION",
        `This bill has not appeared in your GSTR-2B for ${signal.period}. That usually means the supplier has not filed it yet, and it often appears in a later month.`,
        "You can record the bill. Wait for it to appear before claiming the GST back, or ask them when they will file.",
        [evidence]);
    } else if (signal.theirTaxableValue !== undefined && signal.ourTaxableValue !== undefined && signal.theirTaxableValue !== signal.ourTaxableValue) {
      warn("GSTR2B_VALUE_DIFFERS", "CAUTION",
        `The value this supplier reported to the GST department for this bill (${formatPaise(BigInt(signal.theirTaxableValue))}) is not the same as the value on the bill you have (${formatPaise(BigInt(signal.ourTaxableValue))}).`,
        "Compare the two bills. One of you probably has an amended copy.",
        [evidence, { source: "SUPPLIER_DOCUMENT", statement: `The bill you hold shows ${formatPaise(BigInt(signal.ourTaxableValue))}.`, stale: false }]);
    }
  }

  // ------------------------------------------------------------------------ our own books

  const history = input.history;

  if (history.billsRecorded === 0) {
    warn("FIRST_TIME_SUPPLIER", "INFORMATION",
      `This is the first bill you have recorded from ${input.supplierName}.`,
      "Nothing to do. Worth a second look if the amount is large.",
      [ours("No earlier bills from this supplier are on record.")]);
  }

  for (const change of history.bankDetailChanges) {
    const days = ageInDays(`${change.changedOn}T00:00:00Z`, input.on);
    const recent = days <= policy.bankChangeRecentDays;
    warn("BANK_DETAILS_CHANGED", recent ? "SERIOUS" : "CAUTION",
      `The bank account saved for ${input.supplierName} was changed on ${readableDate(change.changedOn)}${recent ? `, which is only ${days} days ago` : ""}. It went from ${change.previousAccountMasked} to ${change.currentAccountMasked}.`,
      "Ring the supplier on a number you already had — not one from the email or bill asking for the change — and check the new account with them before paying.",
      [ours(`Bank account changed from ${change.previousAccountMasked} to ${change.currentAccountMasked}.`, change.changedOn)]);
  }

  if (history.overdueDocuments > 0) {
    warn("OVERDUE_TO_SUPPLIER", "INFORMATION",
      `You have ${history.overdueDocuments} bill${history.overdueDocuments === 1 ? "" : "s"} from ${input.supplierName} past the due date, the oldest by ${history.oldestOverdueDays} days. ${formatPaise(history.totalOutstandingPaise)} is owed to them in total.`,
      "Nothing here is a problem with the supplier. It is what you owe them.",
      [ours(`${history.overdueDocuments} open bill(s) past due; ${formatPaise(history.totalOutstandingPaise)} outstanding.`)]);
  }

  for (const dispute of history.openDisputes) {
    warn("OPEN_DISPUTE", "CAUTION",
      `Someone here marked bill ${dispute.documentNumber} from ${input.supplierName} as disputed on ${readableDate(dispute.raisedOn)}: ${dispute.note}`,
      "Settle the earlier bill before you take on another one, or check whether the dispute still stands.",
      [ours(`Bill ${dispute.documentNumber} was marked disputed on ${readableDate(dispute.raisedOn)}.`, dispute.raisedOn)]);
  }

  // --------------------------------------------------------------------- a model's guess

  // Shown, labelled, and kept out of the level. The acceptance criterion is that no party is
  // called fraudulent from a score; the guarantee is that a score cannot reach the level at all.
  if (input.modelHint !== undefined) {
    const hint = input.modelHint;
    warn("MODEL_HINT", "INFORMATION",
      `A computer check flagged this supplier as "${hint.label}". This is a guess from a pattern, not something anyone has verified, and no part of it comes from the GST department. ${hint.explanation}`,
      "Treat this as a prompt to look at the facts above, not as a finding in itself.",
      [{ source: "OUR_RECORDS", statement: `Model ${hint.modelVersion} scored this ${hint.score.toFixed(2)} for "${hint.label}".`, stale: false }]);
  }

  // ------------------------------------------------------------------- level and summary

  // A model hint can never raise the level; nor can a warning about our own data being missing.
  const levelBearing = warnings.filter(
    (warning) => warning.code !== "MODEL_HINT"
      && warning.code !== "GOVERNMENT_DATA_UNAVAILABLE"
      && warning.code !== "GOVERNMENT_DATA_STALE"
      && warning.code !== "GSTR2B_NOT_CHECKED",
  );
  const level = worst(levelBearing.map((warning) => warning.level));

  const sources = buildSources(input, gstAnswered, gstStale, gstRecord);
  const confidence: AssessmentConfidence =
    sources.every((source) => !source.consulted || (source.answered && !source.stale)) ? "COMPLETE" : "PARTIAL";

  const ordered = [...warnings].sort((left, right) => LEVEL_RANK[left.level] - LEVEL_RANK[right.level]);
  const lights = buildLights(ordered, gstAnswered, input);
  const assessedAt = clock().toISOString();

  return {
    companyId: input.companyId,
    supplierPartyId: input.supplierPartyId,
    supplierName: input.supplierName,
    ...(input.gstin === undefined ? {} : { gstin: input.gstin }),
    ...(input.invoiceNumber === undefined ? {} : { invoiceNumber: input.invoiceNumber }),
    ...(input.invoiceDate === undefined ? {} : { invoiceDate: input.invoiceDate }),
    level,
    warnings: ordered,
    lights,
    sources,
    confidence,
    policy,
    fingerprint: fingerprintOfAssessment(input, policy),
    summary: summarise(input.supplierName, level, ordered, confidence),
    assessedAt,
  };
};

/**
 * Codes that describe the state of our own checking rather than anything about the supplier.
 *
 * None of them may colour a light: "we could not reach the GST department" is a fact about us, and
 * a model's guess is not evidence at all. Both are shown in the list; neither is a verdict.
 */
const NOT_A_VERDICT = new Set<SupplierRiskCode>([
  "GOVERNMENT_DATA_UNAVAILABLE", "GOVERNMENT_DATA_STALE", "GSTR2B_NOT_CHECKED", "MODEL_HINT",
]);

const COLOUR_OF: Record<RiskLevel, LightColour> = { SERIOUS: "RED", CAUTION: "AMBER", INFORMATION: "GREEN" };

const HEADLINE_OF: Record<LightColour, string> = {
  RED: "Stop and check before you pay",
  AMBER: "Worth a look",
  GREEN: "Looks fine",
  GREY: "We could not check",
};

/**
 * Issue #99 — two lights, so a person who is not looking for a problem still sees one.
 *
 * A warning belongs to the government light when any of its evidence came from the GST department
 * or from GSTR-2B; otherwise it belongs to our own. That attribution is read from the evidence
 * itself rather than from a hand-kept list, so a new warning cannot quietly land on the wrong one.
 */
const buildLights = (
  warnings: readonly SupplierRiskWarning[],
  gstAnswered: boolean,
  input: SupplierRiskInput,
): RiskLight[] => {
  const counts = warnings.filter((warning) => !NOT_A_VERDICT.has(warning.code));
  const fromGovernment = counts.filter((warning) =>
    warning.evidence.some((evidence) => evidence.source === "GST_PORTAL" || evidence.source === "IMS_GSTR2B"));
  const fromOurs = counts.filter((warning) => !fromGovernment.includes(warning));

  // Grey, not green. "We checked and it was fine" and "we could not check" are different answers,
  // and showing the second as the first is the one mistake this light must never make.
  const governmentColour: LightColour = !gstAnswered ? "GREY" : COLOUR_OF[worst(fromGovernment.map((warning) => warning.level))];
  const oursColour: LightColour = COLOUR_OF[worst(fromOurs.map((warning) => warning.level))];

  // The warning's own message already names its source, so a "the GST department raised…" prefix
  // would say it twice. Only the count is worth adding, and only when there is more than one.
  const lead = (found: readonly SupplierRiskWarning[]): string => {
    const first = found[0]?.message ?? "";
    return found.length > 1 ? `${found.length} things to check. ${first}` : first;
  };

  const governmentDetail = governmentColour === "GREY"
    ? input.gstin === undefined
      ? "No GST number is saved for this supplier, so the GST department was not asked."
      : "The GST department could not be reached, so nothing here has been checked with them."
    : governmentColour === "GREEN"
      ? "The GST department's records show nothing wrong with this supplier's registration."
      : lead(fromGovernment);

  const oursDetail = oursColour === "GREEN"
    ? "Nothing in your own books needs attention on this supplier."
    : lead(fromOurs);

  return [
    {
      scope: "GOVERNMENT",
      colour: governmentColour,
      title: "The GST department's records",
      headline: HEADLINE_OF[governmentColour],
      detail: safeMessage(governmentDetail),
      warningCount: fromGovernment.length,
    },
    {
      scope: "OUR_RECORDS",
      colour: oursColour,
      title: "Your own records",
      headline: HEADLINE_OF[oursColour],
      detail: safeMessage(oursDetail),
      warningCount: fromOurs.length,
    },
  ];
};

/** Which sources were asked, which answered, and how fresh each answer was. */
const buildSources = (
  input: SupplierRiskInput,
  gstAnswered: boolean,
  gstStale: boolean,
  record: GstinRecord | undefined,
): SourceStatus[] => {
  const consultedGst = input.gstin !== undefined;
  const gst: SourceStatus = {
    source: "GST_PORTAL",
    consulted: consultedGst,
    answered: gstAnswered,
    stale: gstStale,
    ...(record === undefined ? {} : { observedAt: record.observedAt }),
    note: !consultedGst
      ? "No GST number is saved for this supplier, so the department was not asked."
      : !gstAnswered
        ? "The GST department could not be reached, so nothing here has been checked with them."
        : gstStale
          ? `Last checked on ${readableDate(record?.observedAt ?? input.on)}; this answer may be out of date.`
          : `Checked with the GST department on ${readableDate(record?.observedAt ?? input.on)}.`,
  };
  const ims: SourceStatus = {
    source: "IMS_GSTR2B",
    consulted: input.gstr2b !== undefined,
    answered: input.gstr2b !== undefined,
    stale: false,
    ...(input.gstr2b === undefined ? {} : { observedAt: input.gstr2b.observedAt }),
    note: input.gstr2b === undefined
      ? "GSTR-2B reconciliation is not connected yet, so this bill has not been matched against it."
      : `Matched against the GSTR-2B data for ${input.gstr2b.period}.`,
  };
  const own: SourceStatus = {
    source: "OUR_RECORDS", consulted: true, answered: true, stale: false,
    note: "Read from your own books and supplier records, which are always up to date.",
  };
  return [gst, ims, own];
};

/** One line, leading with what matters and never with an accusation. */
const summarise = (
  supplierName: string,
  level: RiskLevel,
  warnings: readonly SupplierRiskWarning[],
  confidence: AssessmentConfidence,
): string => {
  const serious = warnings.filter((warning) => warning.level === "SERIOUS");
  const caution = warnings.filter((warning) => warning.level === "CAUTION");
  const incomplete = confidence === "PARTIAL" ? " Some checks could not be completed, so this is not the full picture." : "";
  if (level === "SERIOUS") {
    return safeMessage(`There ${serious.length === 1 ? "is 1 thing" : `are ${serious.length} things`} worth checking with ${supplierName} before you pay. ${serious[0]?.message ?? ""}${incomplete}`);
  }
  if (level === "CAUTION") {
    return safeMessage(`${supplierName}: ${caution.length === 1 ? "one thing is" : `${caution.length} things are`} worth knowing about before you record this bill. ${caution[0]?.message ?? ""}${incomplete}`);
  }
  return safeMessage(`Nothing about ${supplierName} needs your attention.${incomplete}`);
};

/**
 * A stable hash over the facts and the policy.
 *
 * The same facts give the same fingerprint, so an acknowledgement can be pinned to exactly what
 * was on screen when somebody accepted it — and a new warning next week is not covered by it.
 */
export const fingerprintOfAssessment = (input: SupplierRiskInput, policy: RiskPolicy): string => {
  const record = input.gstin_lookup?.kind === "FOUND" ? input.gstin_lookup.record : undefined;
  const parts = [
    `company=${input.companyId}`,
    `supplier=${input.supplierPartyId}`,
    `gstin=${input.gstin ?? "none"}`,
    `invoice=${input.invoiceNumber ?? "none"}:${input.invoiceDate ?? "none"}`,
    `status=${record?.status ?? input.gstin_lookup?.kind ?? "not_checked"}`,
    `changed=${record?.statusChangedOn ?? "none"}`,
    `filings=${(record?.filings ?? []).map((filing) => `${filing.returnType}${filing.period}${filing.status}`).sort().join(",")}`,
    `gstr2b=${input.gstr2b === undefined ? "none" : `${input.gstr2b.period}:${input.gstr2b.present}`}`,
    `bills=${input.history.billsRecorded}`,
    `overdue=${input.history.overdueDocuments}`,
    `disputes=${input.history.openDisputes.map((dispute) => dispute.documentNumber).sort().join(",")}`,
    `bank=${input.history.bankDetailChanges.map((change) => `${change.changedOn}:${change.currentAccountMasked}`).sort().join(",")}`,
    `policy=${policy.governmentDataStaleAfterDays}/${policy.newRegistrationDays}/${policy.bankChangeRecentDays}/${policy.missedReturnPeriods}/${policy.effectiveFrom}`,
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
};

/** Warnings a person should see before money moves. */
export const blockingWarnings = (assessment: SupplierRiskAssessment): readonly SupplierRiskWarning[] =>
  assessment.warnings.filter((warning) => warning.level === "SERIOUS");

export { maskAccount };
export type { EvidenceSource };
