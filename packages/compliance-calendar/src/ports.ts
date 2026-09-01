/**
 * Issue #32 [E32] — everything this module needs from outside, and nothing more.
 *
 * The calendar owns deadlines. It owns nothing else, and that is what these ports say. The purchase
 * reconciliation belongs to #31, the return workspace to #30, the IRN lifecycle to #26, the e-way
 * bills to #27, sending to #39 and the company profile to onboarding (#7). Each of them reaches
 * this module through one narrow interface, and every one of those interfaces is small enough to
 * implement in a test in a few lines — which is what makes the acceptance tests real tests rather
 * than an integration run in disguise.
 *
 * `ComplianceSignalPort` is deliberately the widest thing here, and it is still narrow: it answers
 * one question — "is there anything unresolved that touches this deadline" — and this module never
 * recomputes the answer. If the reconciliation says three bills are unmatched, three is the number
 * the alert carries. A second opinion computed here would eventually disagree with the screen the
 * owner is looking at, and then neither number would be trusted.
 */
import type { CompanyId, IsoDate } from '@invoice/kernel';
import type {
  Bilingual,
  ComplianceAlert,
  ComplianceException,
  ComplianceSignal,
  CompanyComplianceProfile,
  ObligationDefinition,
  ObligationOccurrence,
  Audience,
} from './types.ts';

/**
 * The obligation definitions in force for a company.
 *
 * Company-scoped rather than global because a business may have declared a date itself while the
 * compliance register (#54) catches up. A declared entry is used, attributed, and never shown as
 * checked law — the same bargain the return workspace strikes with a business-declared threshold.
 */
export interface ObligationDefinitionPort {
  definitionsFor(companyId: CompanyId): Promise<readonly ObligationDefinition[]>;
}

/** The company's own compliance facts, from onboarding (#7). Nulls travel; they are not filled in. */
export interface CompanyProfilePort {
  profileFor(companyId: CompanyId): Promise<CompanyComplianceProfile | null>;
}

/**
 * Non-working days, by company.
 *
 * Holidays differ by state and change every year, so they are supplied rather than hard-coded. A
 * built-in list would be wrong within twelve months and confidently wrong forever after.
 */
export interface HolidayCalendarPort {
  nonWorkingDays(companyId: CompanyId, from: IsoDate, to: IsoDate): Promise<readonly IsoDate[]>;
}

/**
 * Deadlines that come from a single event rather than from a period: this invoice needs an IRN
 * within thirty days, this e-way bill expires tonight.
 *
 * Owned by #26 and #27. The calendar asks what is outstanding and dates it; it never decides
 * whether an invoice needed an IRN in the first place.
 */
export interface DeadlineEvent {
  readonly code: 'IRN_REPORTING' | 'EWAY_VALIDITY';
  /** Stable for the life of the underlying document, so an occurrence is never duplicated. */
  readonly key: string;
  readonly occurredOn: IsoDate;
  /** Set when the owning module already knows the date, as an e-way bill's expiry is known. */
  readonly dueOn?: IsoDate;
  readonly label: Bilingual;
  readonly affected: ComplianceSignal['affected'];
  readonly resolved: boolean;
}

export interface DeadlineEventPort {
  eventsFor(companyId: CompanyId, from: IsoDate, to: IsoDate): Promise<readonly DeadlineEvent[]>;
}

/** What is unresolved beneath a deadline, asked of the modules that own the facts. */
export interface ComplianceSignalPort {
  readonly name: string;
  signalsFor(companyId: CompanyId, occurrence: ObligationOccurrence): Promise<readonly ComplianceSignal[]>;
}

export interface OccurrenceRepository {
  find(companyId: CompanyId, key: string): Promise<ObligationOccurrence | null>;
  list(companyId: CompanyId, from: IsoDate, to: IsoDate): Promise<readonly ObligationOccurrence[]>;
  /** Insert or replace by (company, key). The key carries no date, so a moved deadline updates. */
  put(occurrence: ObligationOccurrence): Promise<void>;
}

/**
 * Alerts, append-only.
 *
 * Nothing here is ever updated. A warning that was raised was raised, and the history of what a
 * business was told, and when, is the evidence behind "we did warn you before the deadline".
 */
export interface AlertRepository {
  insert(alert: ComplianceAlert): Promise<void>;
  raisedKeys(companyId: CompanyId, occurrenceKey: string): Promise<ReadonlySet<string>>;
  listForCompany(companyId: CompanyId): Promise<readonly ComplianceAlert[]>;
}

/** Unresolved applicability, waiting for a person to answer one question. */
export interface ComplianceExceptionRepository {
  put(exception: ComplianceException): Promise<void>;
  list(companyId: CompanyId): Promise<readonly ComplianceException[]>;
  clear(companyId: CompanyId, code: string, periodKey: string): Promise<void>;
}

export interface AlertRecipient {
  readonly recipientId: string;
  readonly locale?: 'en-IN' | 'hi-IN';
}

/** Who to tell. Roles map to #39's recipient roles in the adapter, not here. */
export interface ComplianceContactPort {
  recipients(companyId: CompanyId, audience: Audience): Promise<readonly AlertRecipient[]>;
}

export type AlertDeliveryState = 'SENT' | 'SUPPRESSED' | 'FAILED';

export interface AlertDelivery {
  readonly recipientId: string;
  readonly channel: 'in_app' | 'email';
  readonly state: AlertDeliveryState;
  readonly notificationId: string | null;
  readonly detail?: string;
}

/**
 * Sending, through GPT 2's notification service (#39).
 *
 * Compliance alerts are `internal` sensitivity, which under #39's own table means in-app and email
 * and nothing else. This module accepts that table rather than widening it: a WhatsApp message
 * saying a business is late on its tax is a message on a phone somebody else may be holding.
 *
 * A delivery failure is a failure of delivery only. The alert was still raised, it still appears in
 * the app, and no deadline, occurrence or completion changes because a mail server was down.
 */
export interface AlertTransport {
  send(alert: ComplianceAlert, recipients: readonly AlertRecipient[]): Promise<readonly AlertDelivery[]>;
}
