/**
 * Issue #32 [E32] — what a compliance calendar is made of.
 *
 * The everyday problem first. A business has dates it must meet: the sales return on the 11th, the
 * summary return and the tax payment on the 20th, an invoice that must be reported for its IRN
 * within a month of being written, an e-way bill whose validity runs out tonight. Missing one of
 * them costs late fee and interest per day, and — the part nobody sees coming — a buyer's own
 * credit can be delayed by a supplier's late filing.
 *
 * A calendar that only prints those dates is a wall planner. This module is not that. Four rules
 * separate it from a wall planner, and they run through every type below.
 *
 *   1. **A deadline is not a date; it is a rule with a date in it.** Every obligation here is
 *      effective-dated and versioned, carries the notification it came from and the review state of
 *      that reading, and says in words what happens if it is missed. When the government moves a
 *      date, a new version of the definition takes effect from a date — nothing already recorded is
 *      rewritten, and last year's return keeps the deadline it actually had.
 *   2. **A deadline belongs to a company or it does not exist.** A composition dealer does not file
 *      GSTR-1, and a quarterly filer's summary return is not due on the 20th. Applicability is
 *      computed from the company's own registration and filing frequency, and when a fact needed to
 *      decide is missing the answer is "we cannot decide, here is the question" — never a guess and
 *      never a silent omission, because an obligation quietly dropped is the one that gets missed.
 *   3. **An alert names the consequence and the next action.** "GSTR-3B is due in three days" is a
 *      calendar. "GSTR-3B is due in three days and 3 purchase bills worth ₹1,20,000 do not match
 *      the portal, so the credit you are counting on may not be allowed — review them" is a warning.
 *      Alerts carry the rule, the deadline, the affected records and the one thing to do next.
 *   4. **Finishing something stops the noise.** A filed return with an acknowledgement number on it
 *      escalates to nobody, ever again. Silence after completion is not a nicety; an alert that
 *      keeps shouting after the work is done is how people learn to ignore alerts.
 *
 * Dates here are calendar dates in India. The clock is UTC, as everywhere else in this product, and
 * `todayIn` converts one to the other — a run at 19:30 UTC on the 19th is already the 20th in
 * Ludhiana, and the summary return is due today.
 */
import type { CompanyId, IsoDate, Money, UserId } from '@invoice/kernel';
import type { ReviewState } from '@invoice/rules-engine';
import type { Bilingual } from '../../gst-returns/src/types.ts';

export type { Bilingual };
export type { ReviewState };

// ---------------------------------------------------------------------------- the period

/**
 * The stretch of time an obligation covers.
 *
 * A month for most returns, a quarter for the QRMP scheme and the composition statement, a
 * financial year for the annual return, and — for the deadlines that are not periodic at all — a
 * single event: this invoice, written on this day, must reach the portal within thirty days.
 *
 * `key` is the stable half of an occurrence's identity. It is built only from facts that do not
 * move, so a recomputation re-attaches to the same occurrence and cannot create a second one.
 */
export type ObligationPeriod =
  | { readonly kind: 'MONTH'; readonly key: string; readonly from: IsoDate; readonly to: IsoDate }
  | { readonly kind: 'QUARTER'; readonly key: string; readonly from: IsoDate; readonly to: IsoDate }
  | { readonly kind: 'YEAR'; readonly key: string; readonly from: IsoDate; readonly to: IsoDate }
  | {
      readonly kind: 'EVENT';
      readonly key: string;
      readonly from: IsoDate;
      readonly to: IsoDate;
      /** What the event was, for a screen: "invoice SI-1042 dated 3 August 2026". */
      readonly label: Bilingual;
    };

export type Cadence = 'MONTHLY' | 'QUARTERLY' | 'ANNUAL' | 'EVENT';

// ---------------------------------------------------------------------------- the company

/** How the business is registered. Everything about which returns exist follows from this. */
export type RegistrationType = 'REGULAR' | 'COMPOSITION' | 'UNREGISTERED';

/** Monthly, or the quarterly (QRMP) scheme. A quarterly filer still reports month by month. */
export type FilingFrequency = 'MONTHLY' | 'QUARTERLY';

/**
 * A fact about the company that an applicability rule may need.
 *
 * Named as a closed set so a rule cannot ask for a fact nobody can supply, and so the question put
 * to the owner when one is missing can be written once, properly, in both languages.
 */
export type ProfileFactName =
  | 'registrationType'
  | 'gstFilingFrequency'
  | 'eInvoiceApplicable'
  | 'movesGoods'
  | 'stateCode';

/**
 * Where a profile fact came from.
 *
 * `DECLARED` is not a lesser source. Filing frequency is chosen on the portal, and for most small
 * businesses the only copy of that choice is in the accountant's head — so a person typing "we file
 * quarterly" is the ordinary case, not the fallback. What the source changes is what the audit
 * record says and whose name is on it, never what the rules then do with the fact.
 */
export type FactBasis = 'DERIVED' | 'DECLARED';

export interface ProfileFact<TValue> {
  readonly value: TValue;
  readonly basis: FactBasis;
  /** Required when declared, so an applicability decision always has somebody's name behind it. */
  readonly declaredBy?: UserId;
  readonly declaredOn?: IsoDate;
  /** What the business says the fact rests on — the portal screen, their accountant, a letter. */
  readonly basisNote?: string;
}

/**
 * What this module knows about a company, and what it admits it does not.
 *
 * Every fact is nullable and the nulls are load-bearing. A company whose filing frequency nobody
 * has recorded does not get a monthly deadline "for now"; it gets a question, and the obligations
 * that depend on the answer wait in the exception queue where somebody can see them.
 */
export interface CompanyComplianceProfile {
  readonly companyId: CompanyId;
  readonly legalName: string;
  readonly gstin: string | null;
  readonly registrationType: ProfileFact<RegistrationType> | null;
  readonly gstFilingFrequency: ProfileFact<FilingFrequency> | null;
  readonly eInvoiceApplicable: ProfileFact<boolean> | null;
  readonly movesGoods: ProfileFact<boolean> | null;
  /** The two-digit state code, which decides the quarterly summary-return date group. */
  readonly stateCode: ProfileFact<string> | null;
  /**
   * The date from which this product is answerable for the company's compliance.
   *
   * Usually the day the business started using it. Before that date the returns were filed — or
   * missed — somewhere this product cannot see, and a calendar that told a shopkeeper their May
   * return was sixty-seven days late, when their accountant filed it on time in a different
   * system, would be an accusation made out of an absence of data. So no occurrence is created for
   * a deadline that fell before this date. `null` means the business has asked for the whole
   * history, having said it has nothing filed elsewhere.
   */
  readonly calendarFrom: IsoDate | null;
  /** IANA zone. Always an Indian zone in practice; kept explicit so no code assumes the server's. */
  readonly timeZone: string;
  /** Saturdays are a working day for most Indian small businesses; Sundays are not. */
  readonly saturdayIsWorking: boolean;
}

// ---------------------------------------------------------------------------- the definitions

/**
 * The obligations this product knows about, named the way the forms are named.
 *
 * `ITC_REVIEW` and `EINVOICE_BACKLOG` are not government forms. They are this product's own
 * preventive obligations — review the purchase mismatches before the summary return is filed, clear
 * the invoices that have not reached the portal — and they are marked as policy rather than law so
 * no screen ever presents them as a statutory deadline.
 */
export type ObligationCode =
  | 'GSTR1'
  | 'GSTR3B'
  | 'CMP08'
  | 'GSTR9'
  | 'IRN_REPORTING'
  | 'EWAY_VALIDITY'
  | 'ITC_REVIEW'
  | 'EINVOICE_BACKLOG';

/** Law, or this product's own housekeeping. The two are never shown as the same kind of thing. */
export type ObligationKind = 'STATUTORY' | 'POLICY';

/**
 * How the due date is computed from the period.
 *
 * Three shapes cover every deadline in scope, and each is a calculation rather than a stored date,
 * so a period nobody has reached yet still has a deadline and an alert.
 *
 * `byState` exists because the quarterly summary return is genuinely due on different days in
 * different states. It is a real difference in the rule, not a rounding of one.
 */
export type DueRule =
  | {
      readonly kind: 'DAY_OF_MONTH_AFTER_PERIOD';
      /** How many months after the month the period ends in. 1 for "the month after". */
      readonly monthsAfter: number;
      readonly day: number;
      readonly byState?: readonly { readonly day: number; readonly stateCodes: readonly string[] }[];
    }
  | { readonly kind: 'DAYS_AFTER_PERIOD_END'; readonly days: number }
  | { readonly kind: 'DAYS_AFTER_EVENT'; readonly days: number };

/**
 * Whether a due date that lands on a Sunday or a holiday moves.
 *
 * The default is `NONE`, and that is a deliberate, uncomfortable choice. A GST due date on a Sunday
 * is still that Sunday: the portal accepts filings, and no notification says otherwise. A calendar
 * that helpfully slid the date to Monday would be inventing an extension nobody granted, which is
 * exactly the class of quiet guess this product refuses to make. What does move is the *reminder* —
 * see `workingDayBefore` in schedule.ts — so a business is nudged on the last working day it can
 * actually act on rather than on a holiday.
 */
export type DueDateShift = 'NONE' | 'NEXT_WORKING_DAY';

/** Who a step of the ladder is aimed at. Mapped to #39's roles by the transport adapter. */
export type Audience = 'ACCOUNTANT' | 'OWNER';

export type AlertLevel = 'EARLY' | 'DUE_SOON' | 'DUE_TODAY' | 'OVERDUE' | 'ESCALATED';

export const ALERT_LEVEL_ORDER: Readonly<Record<AlertLevel, number>> = Object.freeze({
  EARLY: 0,
  DUE_SOON: 1,
  DUE_TODAY: 2,
  OVERDUE: 3,
  ESCALATED: 4,
});

/**
 * One rung of the escalation ladder.
 *
 * `offsetDays` counts from the due date: negative is before, 0 is the day itself, positive is after.
 * A rung fires once per occurrence, per level, per due date — so a run repeated five times in a day
 * sends one message, and an extended deadline starts a fresh ladder for the new date rather than
 * staying silent because the old one was already rung.
 */
export interface LadderStep {
  readonly offsetDays: number;
  readonly level: AlertLevel;
  readonly audiences: readonly Audience[];
}

/**
 * A deadline as a versioned, effective-dated rule.
 *
 * This is the shape that makes "changed deadlines update without rewriting history" true rather
 * than aspirational. A new version is a new row with a later `effectiveFrom`; the old row stays
 * exactly as it was. Which version governs a period is decided by the period's own end date, so a
 * rule that takes effect in October cannot retrospectively re-date a return for July.
 */
export interface ObligationDefinition {
  readonly code: ObligationCode;
  readonly version: number;
  readonly kind: ObligationKind;
  readonly title: Bilingual;
  readonly description: Bilingual;
  readonly cadence: Cadence;
  readonly effectiveFrom: IsoDate;
  readonly effectiveTo: IsoDate | null;
  readonly applicability: ApplicabilityCriteria;
  readonly dueRule: DueRule;
  readonly dueDateShift: DueDateShift;
  readonly ladder: readonly LadderStep[];
  /** What being late actually costs, in words. No figure this product has not been given. */
  readonly consequence: Bilingual;
  /** The one thing to do next while there is still time. */
  readonly nextAction: Bilingual;
  readonly actionCode: string;
  /**
   * The notification or circular this reading came from, as the compliance register (#54) holds it.
   * `null` means nobody has linked a source yet, which `reviewState` should then reflect.
   */
  readonly sourceRef: string | null;
  /**
   * `DRAFT` until a person has checked the entry against the source. A draft deadline is shown and
   * alerted on — a shop still needs to know the 20th is coming — but it is labelled as unchecked
   * everywhere it appears, and `describeReviewState` writes that label.
   */
  readonly reviewState: ReviewState;
  /** Set when a business supplied the date itself, so no screen can present it as checked law. */
  readonly declaredBy?: UserId;
  readonly declaredBasis?: string;
}

export interface ApplicabilityCriteria {
  readonly registrationTypes: readonly RegistrationType[];
  /** Undefined means "either". Present means the obligation exists only for those filers. */
  readonly filingFrequencies?: readonly FilingFrequency[];
  readonly requiresEInvoice?: boolean;
  readonly requiresGoodsMovement?: boolean;
  /** The facts that must be known before applicability can be decided at all. */
  readonly requiredFacts: readonly ProfileFactName[];
}

export interface MissingProfileFact {
  readonly fact: ProfileFactName;
  readonly question: Bilingual;
}

/**
 * Whether an obligation is this company's problem.
 *
 * `CANNOT_DECIDE` is a first-class answer and never collapses into "does not apply". The difference
 * matters: "you do not file this" is a conclusion, "we do not know whether you file this" is a
 * question, and a business that is quietly given the first when the truth is the second finds out
 * on the day the late fee starts.
 */
export type ApplicabilityOutcome =
  | { readonly kind: 'APPLIES'; readonly because: Bilingual }
  | { readonly kind: 'DOES_NOT_APPLY'; readonly because: Bilingual }
  | { readonly kind: 'CANNOT_DECIDE'; readonly missing: readonly MissingProfileFact[]; readonly question: Bilingual };

// ---------------------------------------------------------------------------- the occurrences

export type OccurrenceStatus = 'OPEN' | 'COMPLETED' | 'NOT_APPLICABLE';

/**
 * A deadline that moved, recorded rather than applied.
 *
 * The old date is kept beside the new one with the version that produced each, so the question "the
 * screen said the 20th last week, what happened" has an answer that does not require a database
 * archaeologist. Revisions are append-only, and a completed occurrence never gets one — an
 * extension announced after a return was filed changes nothing that happened.
 */
export interface DueDateRevision {
  readonly at: string;
  readonly previousDueDate: IsoDate;
  readonly dueDate: IsoDate;
  readonly previousVersion: number;
  readonly version: number;
  readonly reason: Bilingual;
  readonly sourceRef: string | null;
}

/** How somebody proved the work was actually done. */
export type CompletionEvidenceKind =
  | 'ARN'
  | 'PORTAL_RECEIPT'
  | 'IRN'
  | 'PAYMENT_CHALLAN'
  /**
   * The module that owns the document reports it done — an IRN generated by #26, an e-way bill
   * extended by #27. Named separately from a person's confirmation because it is a different kind
   * of claim with a different thing to check when it turns out to be wrong.
   */
  | 'SOURCE_MODULE'
  /** A person saying, on the record, that they saw it done. See the note in `validateEvidence`. */
  | 'TYPED_CONFIRMATION';

export interface CompletionEvidence {
  readonly kind: CompletionEvidenceKind;
  /** The acknowledgement number, IRN or challan number. Empty only for a typed confirmation. */
  readonly reference: string;
  readonly filedOn: IsoDate;
  /** Required for a typed confirmation: who saw what, where. */
  readonly note: string;
}

export interface CompletionRecord {
  readonly evidence: CompletionEvidence;
  readonly completedBy: UserId;
  readonly completedAt: string;
}

/**
 * A completion that arrived from a module rather than a person carries the module's name instead of
 * a signature. `completedBy` still holds the user whose run observed it, so the trail is complete.
 */
export const isSystemCompletion = (record: CompletionRecord): boolean => record.evidence.kind === 'SOURCE_MODULE';

export interface SnoozeRecord {
  readonly until: IsoDate;
  readonly reason: string;
  readonly snoozedBy: UserId;
  readonly snoozedAt: string;
}

/**
 * One obligation, for one company, for one period.
 *
 * The identity is `key` — the obligation code and the period key — and nothing else. It carries no
 * date, so a deadline that moves does not create a second occurrence, and a person's completion or
 * snooze stays attached to the same thing it was attached to yesterday.
 */
export interface ObligationOccurrence {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly key: string;
  readonly code: ObligationCode;
  readonly obligationKind: ObligationKind;
  readonly title: Bilingual;
  readonly version: number;
  readonly reviewState: ReviewState;
  readonly sourceRef: string | null;
  readonly period: ObligationPeriod;
  readonly dueDate: IsoDate;
  /** The date the reminders are hung on: the last working day at or before the deadline. */
  readonly actionableBy: IsoDate;
  readonly status: OccurrenceStatus;
  readonly notApplicableReason: Bilingual | null;
  readonly snooze: SnoozeRecord | null;
  readonly completion: CompletionRecord | null;
  readonly revisions: readonly DueDateRevision[];
  /** The highest rung already rung, so a ladder never goes backwards on its own. */
  readonly highestAlertLevel: AlertLevel | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const occurrenceKey = (code: ObligationCode, period: ObligationPeriod): string =>
  `${code}:${period.key}`;

// ---------------------------------------------------------------------------- the consequences

/**
 * Something unresolved elsewhere in the product that this deadline will run into.
 *
 * The signals are the whole difference between a calendar and a warning. They come from the
 * modules that own the facts — the purchase reconciliation (#31), the return workspace (#30), the
 * IRN lifecycle (#26), the e-way bills (#27) — through the port in ports.ts, and they are never
 * recomputed here. This module asks "is there anything unresolved that touches this deadline", and
 * repeats the owning module's answer with the deadline attached.
 */
export type SignalCode =
  | 'ITC_MISMATCH_UNRESOLVED'
  | 'PURCHASE_EXCEPTION_OPEN'
  | 'RETURN_NOT_PREPARED'
  | 'IRN_PENDING'
  | 'EWAY_EXPIRING'
  | 'TAX_UNPAID';

export type SignalSeverity = 'INFORMATION' | 'WARNING' | 'BLOCKING';

/** A record the person can actually open. A count with nothing behind it is not evidence. */
export interface AffectedRecord {
  readonly kind: string;
  readonly id: string;
  readonly label: string;
  readonly amount?: Money;
}

export interface ComplianceSignal {
  readonly code: SignalCode;
  readonly severity: SignalSeverity;
  readonly count: number;
  readonly headline: Bilingual;
  /** What it will do to this deadline if nobody acts. */
  readonly consequence: Bilingual;
  readonly nextAction: Bilingual;
  readonly actionCode: string;
  readonly affected: readonly AffectedRecord[];
  readonly amount?: Money;
  /** The module that said so, so a disagreement has somewhere to go. */
  readonly source: string;
}

// ---------------------------------------------------------------------------- the alerts

/**
 * One warning, ready to be read by a person who has not been thinking about GST all week.
 *
 * Every field on it exists because the acceptance criteria name it: the rule and its version and
 * source, the deadline, the records affected, and the next action. An alert that cannot say which
 * rule it came from is an opinion, and an alert without a next action is a worry.
 */
export interface ComplianceAlert {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly occurrenceKey: string;
  readonly code: ObligationCode;
  readonly obligationKind: ObligationKind;
  readonly version: number;
  readonly reviewState: ReviewState;
  readonly sourceRef: string | null;
  readonly level: AlertLevel;
  readonly audiences: readonly Audience[];
  readonly dueDate: IsoDate;
  /** Negative once the deadline has passed. Zero on the day itself. */
  readonly daysRemaining: number;
  readonly period: ObligationPeriod;
  readonly headline: Bilingual;
  readonly detail: Bilingual;
  readonly nextAction: Bilingual;
  readonly actionCode: string;
  readonly consequence: Bilingual;
  readonly signals: readonly ComplianceSignal[];
  readonly affected: readonly AffectedRecord[];
  /**
   * One alert per occurrence, per level, per due date. Repeating a run cannot repeat a message, and
   * a moved deadline starts a fresh ladder instead of staying silent.
   */
  readonly deduplicationKey: string;
  readonly raisedAt: string;
  readonly raisedBy: UserId;
  /** Set when a person escalated by hand rather than the ladder reaching this rung. */
  readonly manualReason?: string;
}

export const alertKey = (occurrence: { readonly key: string; readonly dueDate: IsoDate }, level: AlertLevel): string =>
  `compliance:${occurrence.key}:${level}:${occurrence.dueDate}`;

/**
 * An obligation this product could not place, waiting for a person.
 *
 * It is the exception queue rule of the whole product applied to deadlines: a missing fact never
 * becomes a guess and never becomes silence. The question is written for the owner, and answering it
 * is all that is needed to turn the exception into a dated obligation on the next run.
 */
export interface ComplianceException {
  readonly companyId: CompanyId;
  readonly code: ObligationCode;
  readonly periodKey: string;
  readonly missing: readonly MissingProfileFact[];
  readonly question: Bilingual;
  readonly raisedAt: string;
}

/** What one `run` did, in the shape a screen and an operator both need. */
export interface CalendarRun {
  readonly at: string;
  readonly today: IsoDate;
  readonly occurrencesConsidered: number;
  readonly raised: readonly ComplianceAlert[];
  /** Alerts a snooze silenced. Recorded, because a silenced warning is still a fact. */
  readonly snoozed: readonly string[];
  /** Rungs already rung on an earlier run today. The proof that a repeat run is harmless. */
  readonly alreadyRaised: readonly string[];
  readonly exceptions: readonly ComplianceException[];
}

/** The calendar as a screen shows it: what is coming, what is late, what is done. */
export interface CalendarView {
  readonly companyId: CompanyId;
  readonly today: IsoDate;
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly entries: readonly CalendarEntry[];
  readonly exceptions: readonly ComplianceException[];
}

export interface CalendarEntry {
  readonly occurrence: ObligationOccurrence;
  readonly daysRemaining: number;
  readonly state: 'DONE' | 'DUE_LATER' | 'DUE_SOON' | 'DUE_TODAY' | 'OVERDUE' | 'NOT_APPLICABLE';
  readonly signals: readonly ComplianceSignal[];
  readonly nextAction: Bilingual;
  readonly reviewNote: Bilingual | null;
}

// ---------------------------------------------------------------------------- permissions

/**
 * Snoozing and escalating are separate permissions from viewing on purpose.
 *
 * Silencing a warning is a decision with a consequence, and it is not the same decision as reading
 * one. The staff member who watches the calendar should not be able to make the summary-return
 * warning go quiet on their own, and the record of who did it is half the point of having it.
 */
export const CALENDAR_PERMISSIONS = Object.freeze({
  view: 'compliance.calendar.view',
  refresh: 'compliance.calendar.refresh',
  complete: 'compliance.calendar.complete',
  snooze: 'compliance.calendar.snooze',
  escalate: 'compliance.calendar.escalate',
  declare: 'compliance.calendar.declare',
});

// ---------------------------------------------------------------------------- small helpers

export const bilingual = (en: string, hi: string): Bilingual => Object.freeze({ 'en-IN': en, 'hi-IN': hi });

/** The label every draft rule carries with it. A shop is told what is checked and what is not. */
export const describeReviewState = (state: ReviewState): Bilingual | null =>
  state === 'APPROVED'
    ? null
    : state === 'DRAFT'
      ? bilingual(
          'This date has not been checked against the government notification yet, so confirm it with your accountant.',
          'Yeh date abhi government notification se check nahin hui hai, apne accountant se confirm kar lein.',
        )
      : bilingual(
          'This rule has been replaced or withdrawn and is shown only for the record.',
          'Yeh niyam badal diya gaya hai, sirf record ke liye dikhaya ja raha hai.',
        );

export const higherLevel = (left: AlertLevel | null, right: AlertLevel): AlertLevel =>
  left === null || ALERT_LEVEL_ORDER[right] > ALERT_LEVEL_ORDER[left] ? right : left;
