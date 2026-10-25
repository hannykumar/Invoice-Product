/**
 * Issue #289, part 2b — when the buyer's reverse-charge tax falls due, and how long the buyer has to
 * issue the self-invoice. Pure functions: dates in, a date and the clause that chose it out.
 *
 * Law read on 21 Oct 2026 from the current CBIC text (taxinformation.cbic.gov.in):
 *
 *  - CGST s.12(3) — goods on reverse charge: the EARLIEST of
 *      (a) the date the goods are received;
 *      (b) the date of payment as entered in the recipient's books, or debited in his bank account,
 *          whichever is earlier;
 *      (c) the date immediately following thirty days from the date the supplier issued the invoice
 *          (or any other document in lieu of it).
 *    Proviso: if none can be found, the date of entry in the recipient's books.
 *  - CGST s.13(3) — services on reverse charge, as substituted/inserted by s.117 of the Finance
 *    (No. 2) Act, 2024 (No. 15 of 2024, 16.08.2024), in force 01.11.2024 (Notification
 *    17/2024-Central Tax, 27.09.2024): the EARLIER of
 *      (a) the date of payment (books or bank, whichever is earlier);
 *      (b) the date immediately following sixty days from the supplier's invoice, where the
 *          supplier is the one who must issue it;
 *      (c) the date of issue of the invoice by the recipient, where the recipient must issue it.
 *    First proviso: if none can be found, the date of entry in the recipient's books.
 *  - CGST s.31(3)(f) (amended by s.122 of the same Act): a registered person liable under s.9(3)/(4)
 *    issues the invoice for what he receives from a supplier who is not registered, "within the
 *    period as may be prescribed". Explanation: a supplier registered only to deduct tax under s.51
 *    counts as not registered.
 *  - CGST Rule 47A (Notification 20/2024-Central Tax, 08.10.2024, in force 01.11.2024): that invoice
 *    is issued "within a period of thirty days from the date of receipt of the said supply".
 *
 * Counting days. "From a date" excludes that date (General Clauses Act, 1897, s.9), so:
 *  - thirty days from a 1 October receipt end on 31 October — the last day for the self-invoice;
 *  - "the date immediately following thirty days from" a 1 October invoice is 1 November (s.12(3)(c)),
 *    and sixty days from a 1 October invoice is followed by 1 December (s.13(3)(b)).
 *  Not verified: no CBIC circular on the counting for Rule 47A was found; s.9 is applied as written.
 */
import { isoDate, type IsoDate } from "@invoice/kernel";

export type RcmSupplyKind = "GOODS" | "SERVICES";

/** The clause that fixed the date, so the reason can be said and the return traced. */
export type RcmTimeOfSupplyClause =
  | "s.12(3)(a)" | "s.12(3)(b)" | "s.12(3)(c)" | "s.12(3) proviso"
  | "s.13(3)(a)" | "s.13(3)(b)" | "s.13(3)(c)" | "s.13(3) first proviso";

export interface RcmTimeOfSupplyInput {
  readonly supplyKind: RcmSupplyKind;
  /** The supplier's invoice or other document, as dated by them. `null` when they gave none. */
  readonly supplierDocumentDate: IsoDate | null;
  /**
   * Whether the supplier is the one who must issue the invoice. `false` for a supplier who is not
   * registered (or registered only for TDS): then the recipient issues it, s.31(3)(f).
   */
  readonly supplierIssuesInvoice: boolean;
  /** When the goods or the service reached the buyer. */
  readonly receivedOn: IsoDate | null;
  /** The earliest payment against this purchase, as entered in the books. `null` while unpaid. */
  readonly paidOn: IsoDate | null;
  /** The buyer's own invoice (self-invoice) for it, once issued. */
  readonly selfInvoiceOn: IsoDate | null;
  /** The date it was entered in the buyer's books: the provisos' fallback. */
  readonly enteredInBooksOn: IsoDate;
}

export interface RcmTimeOfSupply {
  readonly date: IsoDate;
  readonly clause: RcmTimeOfSupplyClause;
  /**
   * `false` when the date is only the provisos' fallback (the books date) because none of the
   * section's own dates is known yet — a service from an unregistered supplier with neither a
   * payment nor a self-invoice. A payment recorded later can still bring any date forward.
   */
  readonly settled: boolean;
  /** One sentence for the shopkeeper: what the date is and why. */
  readonly words: string;
}

const DAY_MS = 86_400_000;

/** `date` plus `days` calendar days. */
export const addDays = (date: IsoDate, days: number): IsoDate => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return isoDate(new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10));
};

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from: IsoDate, to: IsoDate): number => {
  const at = (value: IsoDate) => {
    const [y, m, d] = value.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((at(to) - at(from)) / DAY_MS);
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const spoken = (date: IsoDate): string => {
  const [y, m, d] = date.split("-") as [string, string, string];
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
};

/** s.12(3)(c): the day after thirty days from the supplier's document. */
export const goodsDeemedDate = (supplierDocumentDate: IsoDate): IsoDate => addDays(supplierDocumentDate, 31);
/** s.13(3)(b): the day after sixty days from the supplier's invoice. */
export const servicesDeemedDate = (supplierInvoiceDate: IsoDate): IsoDate => addDays(supplierInvoiceDate, 61);

/**
 * The time of supply of a reverse-charge purchase — the date whose month carries its tax in GSTR-3B
 * Table 3.1(d). Ties go to the clause listed first in the section.
 */
export const rcmTimeOfSupply = (input: RcmTimeOfSupplyInput): RcmTimeOfSupply => {
  type Candidate = { date: IsoDate; clause: RcmTimeOfSupplyClause; words: string };
  const candidates: Candidate[] = [];
  if (input.supplyKind === "GOODS") {
    if (input.receivedOn !== null) candidates.push({ date: input.receivedOn, clause: "s.12(3)(a)", words: "the day the goods were received" });
    if (input.paidOn !== null) candidates.push({ date: input.paidOn, clause: "s.12(3)(b)", words: "the day you paid for them" });
    if (input.supplierDocumentDate !== null) {
      candidates.push({ date: goodsDeemedDate(input.supplierDocumentDate), clause: "s.12(3)(c)", words: `the day after 30 days from the seller's bill of ${spoken(input.supplierDocumentDate)}` });
    }
  } else {
    if (input.paidOn !== null) candidates.push({ date: input.paidOn, clause: "s.13(3)(a)", words: "the day you paid for it" });
    if (input.supplierIssuesInvoice && input.supplierDocumentDate !== null) {
      candidates.push({ date: servicesDeemedDate(input.supplierDocumentDate), clause: "s.13(3)(b)", words: `the day after 60 days from the supplier's bill of ${spoken(input.supplierDocumentDate)}` });
    }
    if (!input.supplierIssuesInvoice && input.selfInvoiceOn !== null) {
      candidates.push({ date: input.selfInvoiceOn, clause: "s.13(3)(c)", words: "the date of your own self-invoice for it" });
    }
  }
  if (candidates.length === 0) {
    const clause: RcmTimeOfSupplyClause = input.supplyKind === "GOODS" ? "s.12(3) proviso" : "s.13(3) first proviso";
    return {
      date: input.enteredInBooksOn,
      clause,
      settled: false,
      words: `The GST on this falls due on ${spoken(input.enteredInBooksOn)}, the day it was entered in your books, because none of the other dates in CGST ${input.supplyKind === "GOODS" ? "s.12(3)" : "s.13(3)"} is known yet (${clause}). It moves earlier only if one of them turns out earlier.`,
    };
  }
  // Earliest wins; on a tie the clause that came first in the list (the section's own order) stays.
  const chosen = candidates.reduce((best, next) => (next.date < best.date ? next : best));
  return {
    date: chosen.date,
    clause: chosen.clause,
    settled: true,
    words: `The GST on this falls due on ${spoken(chosen.date)}: ${chosen.words}, the earliest of the dates in CGST ${chosen.clause}.`,
  };
};

/** Rule 47A: the last day to issue the self-invoice — thirty days from (so not counting) the receipt. */
export const selfInvoiceLastDay = (receivedOn: IsoDate): IsoDate => addDays(receivedOn, 30);

/** How many days before the last day the reminder starts. A setting, not law. */
export const SELF_INVOICE_REMINDER_DAYS = 5;

export type SelfInvoiceDueState = "ISSUED" | "NOT_YET_DUE" | "DUE_SOON" | "LAST_DAY" | "OVERDUE";

export interface SelfInvoiceDue {
  readonly state: SelfInvoiceDueState;
  readonly lastDay: IsoDate;
  /** Days from today to the last day: 0 on the last day, negative once it has passed. */
  readonly daysLeft: number;
  readonly words: string;
}

/** Where a self-invoice stands on `today`: in good time, due soon, its last day, or late. */
export const selfInvoiceDue = (receivedOn: IsoDate, today: IsoDate, issuedOn: IsoDate | null): SelfInvoiceDue => {
  const lastDay = selfInvoiceLastDay(receivedOn);
  const daysLeft = daysBetween(today, lastDay);
  if (issuedOn !== null) {
    return {
      state: "ISSUED", lastDay, daysLeft,
      words: issuedOn <= lastDay
        ? `Self-invoice issued on ${spoken(issuedOn)}, within the 30 days (CGST Rule 47A).`
        : `Self-invoice issued on ${spoken(issuedOn)}, after the 30 days ended on ${spoken(lastDay)} (CGST Rule 47A).`,
    };
  }
  if (daysLeft < 0) {
    return { state: "OVERDUE", lastDay, daysLeft, words: `The 30 days to issue the self-invoice ended on ${spoken(lastDay)} (CGST Rule 47A). Issue it now: the law still requires it.` };
  }
  if (daysLeft === 0) {
    return { state: "LAST_DAY", lastDay, daysLeft, words: `Today, ${spoken(lastDay)}, is the last of the 30 days to issue the self-invoice (CGST Rule 47A).` };
  }
  if (daysLeft <= SELF_INVOICE_REMINDER_DAYS) {
    return { state: "DUE_SOON", lastDay, daysLeft, words: `Issue the self-invoice by ${spoken(lastDay)} — ${daysLeft} day${daysLeft === 1 ? "" : "s"} left of the 30 (CGST Rule 47A).` };
  }
  return { state: "NOT_YET_DUE", lastDay, daysLeft, words: `Issue the self-invoice by ${spoken(lastDay)}, 30 days from receiving it (CGST Rule 47A).` };
};
