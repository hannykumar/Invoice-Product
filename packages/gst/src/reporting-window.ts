// Issue #236 — how long after its date a bill may still be sent for an e-invoice number.
//
// There is no single deadline for every business. The government's invoice registration portals
// refuse a document that is too old only for businesses at or above a turnover limit, and that
// limit has moved:
//
//   - GSTN advisory of 5 November 2024 ("Time limit for reporting e-Invoice on the IRP portal —
//     lowering of threshold to AATO 10 crores and above"): from 1 April 2025, a taxpayer whose
//     annual aggregate turnover is ₹10 crore or more is not allowed to report an e-invoice older
//     than 30 days on the date of reporting. Its own example: a bill dated 1 April 2025 cannot be
//     reported after 30 April 2025 — so the last day is the bill's date plus 29 days. It says in
//     terms that there is no such restriction below ₹10 crore.
//   - The same advisory records the earlier limit it replaced: 30 days for ₹100 crore and above,
//     enforced from 1 November 2023 (advisory of 13 September 2023).
//
// The limit is a check the portal makes on the day a document is reported, not a property of the
// document's date. So a bill dated before the limit started could still be reported, however old,
// until the day before it started, and from that day only if it was then within the window.
//
// Nothing here is guessed. A business that has not told us which side of the limit it is on gets
// "we do not know" and the date that would apply if it is, never a deadline it may not have.

import type { IsoDate, Paise } from "../../masters/src/types.ts";

export interface ReportingTimeLimit {
  /** The first day the portals enforced this limit. */
  readonly enforcedFrom: IsoDate;
  /** Annual aggregate turnover at or above which the limit applies, in paise. */
  readonly turnoverAtLeastPaise: Paise;
  /** How many days, counting the bill's own date as the first, a document may be reported in. */
  readonly days: number;
  readonly ruleId: string;
  readonly sourceRef: string;
}

/** Newest first. Each one applies to reports made on or after its own date. */
export const REPORTING_TIME_LIMITS: readonly ReportingTimeLimit[] = Object.freeze([
  {
    enforcedFrom: "2025-04-01",
    turnoverAtLeastPaise: 10_00_00_000_00n,
    days: 30,
    ruleId: "EINV.REPORTING_LIMIT.10CR",
    sourceRef: "GSTN advisory, 5 November 2024: time limit for reporting e-invoices on the IRP, AATO ₹10 crore and above",
  },
  {
    enforcedFrom: "2023-11-01",
    turnoverAtLeastPaise: 100_00_00_000_00n,
    days: 30,
    ruleId: "EINV.REPORTING_LIMIT.100CR",
    sourceRef: "GSTN advisory, 13 September 2023: time limit for reporting e-invoices on the IRP, AATO ₹100 crore and above",
  },
]);

/**
 * What the business has told us about last year's turnover, as bounds. An exact figure is both
 * bounds at once; a band such as "₹5 crore to ₹10 crore" is two; "not sure" is neither.
 */
export interface TurnoverBounds {
  /** Turnover is at least this. */
  readonly atLeastPaise?: Paise;
  /** Turnover is below this. */
  readonly belowPaise?: Paise;
}

export type ReportingDeadline =
  /** No time limit applies to this business: send it whenever it is ready. */
  | { readonly kind: "NO_LIMIT"; readonly message: string }
  /** A limit applies. `closed` is true once the last day has passed. */
  | {
      readonly kind: "LIMIT";
      readonly lastDay: IsoDate;
      readonly closed: boolean;
      readonly message: string;
      readonly ruleId: string;
      readonly sourceRef: string;
    }
  /** Whether a limit applies depends on a turnover fact we were not given. */
  | {
      readonly kind: "UNKNOWN";
      readonly lastDayIfItApplies: IsoDate;
      readonly turnoverAtLeastPaise: Paise;
      readonly message: string;
      readonly ruleId: string;
      readonly sourceRef: string;
    };

const addDays = (date: IsoDate, days: number): IsoDate => {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-26" as "26 Oct 2026", the way a date is read on a bill. */
export const readableDate = (date: IsoDate): string => {
  const [year, month, day] = date.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1] ?? month} ${year}`;
};

const later = (a: IsoDate, b: IsoDate): IsoDate => (a > b ? a : b);

const crore = (paise: Paise): string => `₹${(paise / 1_00_00_000_00n).toString()} crore`;

/** Whether a limit's turnover test is met: yes, no, or cannot tell from what we were told. */
const meets = (limit: ReportingTimeLimit, turnover: TurnoverBounds): boolean | undefined => {
  if (turnover.atLeastPaise !== undefined && turnover.atLeastPaise >= limit.turnoverAtLeastPaise) return true;
  if (turnover.belowPaise !== undefined && turnover.belowPaise <= limit.turnoverAtLeastPaise) return false;
  return undefined;
};

/** The last day a document dated `documentDate` may be reported under one limit. */
const lastDayUnder = (limit: ReportingTimeLimit, documentDate: IsoDate): IsoDate =>
  later(addDays(documentDate, limit.days - 1), addDays(limit.enforcedFrom, -1));

const WHAT_TO_DO =
  "A bill that should have carried an e-invoice number and did not is not a valid tax invoice, so your customer cannot claim GST credit on it. Ask your accountant; the usual fix is to cancel this bill and issue a fresh one dated today, then send that one straight away.";

/**
 * The deadline for reporting one document, judged on `today` (the day it would be sent).
 *
 * Pure: the same facts on the same day always give the same answer.
 */
export const reportingDeadline = (documentDate: IsoDate, turnover: TurnoverBounds, today: IsoDate): ReportingDeadline => {
  const judged = REPORTING_TIME_LIMITS.map((limit) => ({ limit, applies: meets(limit, turnover), lastDay: lastDayUnder(limit, documentDate) }));
  const certain = judged.filter((entry) => entry.applies === true).sort((a, b) => a.lastDay.localeCompare(b.lastDay))[0];
  const possible = judged.filter((entry) => entry.applies === undefined).sort((a, b) => a.lastDay.localeCompare(b.lastDay))[0];

  // A limit we cannot rule out would end sooner than any we know applies. If the one we know about
  // has already passed, the answer is certain anyway; otherwise it is a question.
  if (possible !== undefined && (certain === undefined || possible.lastDay < certain.lastDay) && !(certain !== undefined && certain.lastDay < today)) {
    return {
      kind: "UNKNOWN",
      lastDayIfItApplies: possible.lastDay,
      turnoverAtLeastPaise: possible.limit.turnoverAtLeastPaise,
      ruleId: possible.limit.ruleId,
      sourceRef: possible.limit.sourceRef,
      message: `We do not know whether your turnover last year was ${crore(possible.limit.turnoverAtLeastPaise)} or more. If it was, the government's portal accepts this bill only up to ${readableDate(possible.lastDay)}${possible.lastDay < today ? ", which has passed" : ""}. Tell us your turnover in Business details.`,
    };
  }

  if (certain === undefined) {
    return {
      kind: "NO_LIMIT",
      message: "There is no deadline for sending this bill: the 30-day limit applies only to businesses with turnover of ₹10 crore or more.",
    };
  }

  const closed = today > certain.lastDay;
  return {
    kind: "LIMIT",
    lastDay: certain.lastDay,
    closed,
    ruleId: certain.limit.ruleId,
    sourceRef: certain.limit.sourceRef,
    message: closed
      ? `This bill is more than ${certain.limit.days} days old. The last day to send it was ${readableDate(certain.lastDay)}, and the government's portal will now refuse it. ${WHAT_TO_DO}`
      : `This bill must be sent by ${readableDate(certain.lastDay)}. After that the government's portal will refuse it.`,
  };
};

/** The bounds an exact turnover figure gives: at least it, and below one paisa more. */
export const exactTurnover = (paise: Paise): TurnoverBounds => ({ atLeastPaise: paise, belowPaise: paise + 1n });
