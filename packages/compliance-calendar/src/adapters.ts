/**
 * Issue #32 [E32] — the implementations: in-memory stores, the wiring to #39, and the readers that
 * turn other modules' unresolved work into consequences on a deadline.
 *
 * The stores here are the ones the tests and the demo run on. They are not a second implementation
 * of anything: the Postgres tables in migrations.ts hold exactly the same rows, and the repository
 * interfaces in ports.ts are what both sides satisfy.
 *
 * The readers below deserve a word. Each is a two-line interface over a module this issue depends
 * on but does not own — the purchase reconciliation (#31), the return workspace (#30), the IRN
 * lifecycle (#26). They are deliberately smaller than those modules' real interfaces: the calendar
 * asks "how many are unresolved, worth how much, which ones", and nothing else. That is the whole
 * of what a warning needs, it is stable enough to survive those modules changing, and it means this
 * module can be finished and tested against a mock without waiting for anybody.
 */
import { formatINR, type CompanyId, type IsoDate, type Money } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import type {
  NotificationService,
  NotificationTemplateRegistry,
  RequestContext,
} from '../../platform/src/index.ts';
import { OBLIGATION_CATALOGUE } from './catalogue.ts';
import type {
  AlertDelivery,
  AlertRecipient,
  AlertRepository,
  AlertTransport,
  CompanyProfilePort,
  ComplianceContactPort,
  ComplianceExceptionRepository,
  ComplianceSignalPort,
  DeadlineEvent,
  DeadlineEventPort,
  HolidayCalendarPort,
  ObligationDefinitionPort,
  OccurrenceRepository,
} from './ports.ts';
import {
  bilingual,
  type AffectedRecord,
  type Audience,
  type CompanyComplianceProfile,
  type ComplianceAlert,
  type ComplianceException,
  type ComplianceSignal,
  type ObligationDefinition,
  type ObligationOccurrence,
} from './types.ts';

// ---------------------------------------------------------------------------- stores

export class InMemoryOccurrences implements OccurrenceRepository {
  readonly #rows = new Map<string, ObligationOccurrence>();

  async find(companyId: CompanyId, key: string): Promise<ObligationOccurrence | null> {
    return this.#rows.get(`${companyId}:${key}`) ?? null;
  }

  async list(companyId: CompanyId, from: IsoDate, to: IsoDate): Promise<readonly ObligationOccurrence[]> {
    // The window is judged on the period, not the due date: July's return is due in August and is
    // still July's obligation, and a query that missed it would create a second one.
    return [...this.#rows.values()].filter(
      (row) => row.companyId === companyId && row.period.to >= from && row.period.from <= to,
    );
  }

  async put(occurrence: ObligationOccurrence): Promise<void> {
    this.#rows.set(`${occurrence.companyId}:${occurrence.key}`, occurrence);
  }

  all(): readonly ObligationOccurrence[] {
    return [...this.#rows.values()];
  }
}

export class InMemoryAlerts implements AlertRepository {
  readonly #rows: ComplianceAlert[] = [];

  async insert(alert: ComplianceAlert): Promise<void> {
    // The same guard the unique index gives in Postgres: one alert per obligation, level and due
    // date, so a repeated run cannot repeat a message even if a caller asks it to.
    if (this.#rows.some((row) => row.companyId === alert.companyId && row.deduplicationKey === alert.deduplicationKey)) return;
    this.#rows.push(alert);
  }

  async raisedKeys(companyId: CompanyId, occurrenceKey: string): Promise<ReadonlySet<string>> {
    return new Set(
      this.#rows.filter((row) => row.companyId === companyId && row.occurrenceKey === occurrenceKey).map((row) => row.deduplicationKey),
    );
  }

  async listForCompany(companyId: CompanyId): Promise<readonly ComplianceAlert[]> {
    return this.#rows.filter((row) => row.companyId === companyId);
  }
}

export class InMemoryComplianceExceptions implements ComplianceExceptionRepository {
  readonly #rows = new Map<string, ComplianceException>();

  async put(exception: ComplianceException): Promise<void> {
    this.#rows.set(`${exception.companyId}:${exception.code}:${exception.periodKey}`, exception);
  }

  async list(companyId: CompanyId): Promise<readonly ComplianceException[]> {
    return [...this.#rows.values()].filter((row) => row.companyId === companyId);
  }

  async clear(companyId: CompanyId, code: string, periodKey: string): Promise<void> {
    this.#rows.delete(`${companyId}:${code}:${periodKey}`);
  }
}

/** The catalogue, plus anything a business has declared for itself. */
export class CatalogueDefinitions implements ObligationDefinitionPort {
  readonly #declared = new Map<string, ObligationDefinition[]>();
  readonly #base: readonly ObligationDefinition[];

  constructor(base: readonly ObligationDefinition[] = OBLIGATION_CATALOGUE) {
    this.#base = base;
  }

  /**
   * Record a date a business supplied itself — usually an extension announced on the portal before
   * this product's register has caught up. It is used, it is attributed, and `reviewState` keeps it
   * visibly unchecked wherever it appears.
   */
  declare(companyId: CompanyId, definition: ObligationDefinition): void {
    const rows = this.#declared.get(companyId) ?? [];
    rows.push(definition);
    this.#declared.set(companyId, rows);
  }

  async definitionsFor(companyId: CompanyId): Promise<readonly ObligationDefinition[]> {
    return [...this.#base, ...(this.#declared.get(companyId) ?? [])];
  }
}

export class InMemoryProfiles implements CompanyProfilePort {
  readonly #rows = new Map<string, CompanyComplianceProfile>();

  set(profile: CompanyComplianceProfile): void {
    this.#rows.set(profile.companyId, profile);
  }

  async profileFor(companyId: CompanyId): Promise<CompanyComplianceProfile | null> {
    return this.#rows.get(companyId) ?? null;
  }
}

/**
 * A holiday list somebody supplied.
 *
 * There is no built-in list on purpose. Indian public holidays differ by state, several move with
 * the moon, and a list baked into a release is wrong the year after and confidently wrong forever.
 */
export class SuppliedHolidays implements HolidayCalendarPort {
  readonly #rows = new Map<string, Set<string>>();

  add(companyId: CompanyId, ...dates: readonly IsoDate[]): void {
    const set = this.#rows.get(companyId) ?? new Set<string>();
    for (const date of dates) set.add(date);
    this.#rows.set(companyId, set);
  }

  async nonWorkingDays(companyId: CompanyId, from: IsoDate, to: IsoDate): Promise<readonly IsoDate[]> {
    return [...(this.#rows.get(companyId) ?? new Set<string>())].filter((date) => date >= from && date <= to) as IsoDate[];
  }
}

export class InMemoryDeadlineEvents implements DeadlineEventPort {
  readonly #rows = new Map<string, DeadlineEvent[]>();

  set(companyId: CompanyId, events: readonly DeadlineEvent[]): void {
    this.#rows.set(companyId, [...events]);
  }

  async eventsFor(companyId: CompanyId, from: IsoDate, to: IsoDate): Promise<readonly DeadlineEvent[]> {
    return (this.#rows.get(companyId) ?? []).filter((event) => event.occurredOn <= to && (event.dueOn ?? event.occurredOn) >= from);
  }
}

// ---------------------------------------------------------------------------- the readers

/** What the purchase reconciliation (#31) knows about a month, reduced to what a warning needs. */
export interface UnresolvedPurchaseReader {
  unresolvedFor(
    companyId: CompanyId,
    periodKey: string,
  ): Promise<{ readonly count: number; readonly amount: Money; readonly records: readonly AffectedRecord[] } | null>;
}

/** What the return workspace (#30) knows: is the return prepared, and is there tax to pay. */
export interface ReturnReadinessReader {
  readinessFor(
    companyId: CompanyId,
    periodKey: string,
  ): Promise<{ readonly prepared: boolean; readonly taxPayable: Money; readonly blockingIssues: number } | null>;
}

/** What the IRN lifecycle (#26) knows: invoices that still have not reached the portal. */
export interface EInvoiceBacklogReader {
  pendingFor(
    companyId: CompanyId,
    periodKey: string,
  ): Promise<{ readonly count: number; readonly records: readonly AffectedRecord[] } | null>;
}

/**
 * The purchase mismatches, attached to the deadlines they actually affect.
 *
 * This is the user example from the issue, in code: the owner is warned that unresolved purchase
 * mismatches may affect the upcoming GSTR-3B, and is told to open the comparison rather than to
 * file the return. It is marked `BLOCKING`, which is what makes the alert's next action the review
 * instead of the filing.
 */
export const purchaseMismatchSignals = (reader: UnresolvedPurchaseReader): ComplianceSignalPort => ({
  name: 'purchase comparison',
  async signalsFor(companyId, occurrence) {
    if (occurrence.code !== 'GSTR3B' && occurrence.code !== 'ITC_REVIEW') return [];
    const unresolved = await reader.unresolvedFor(companyId, monthKeyOf(occurrence));
    if (unresolved === null || unresolved.count === 0) return [];
    return [
      {
        code: 'ITC_MISMATCH_UNRESOLVED',
        severity: 'BLOCKING',
        count: unresolved.count,
        headline: bilingual(
          `${unresolved.count} purchase ${unresolved.count === 1 ? 'bill does' : 'bills do'} not match what your suppliers told the government — ${formatINR(unresolved.amount)} of credit rests on them.`,
          `${unresolved.count} purchase bill suppliers ke bataye record se nahin mil rahe — ${formatINR(unresolved.amount)} ka credit inhi par tika hai.`,
        ),
        consequence: bilingual(
          'If they are still unresolved when you file, you either claim credit that may be reversed later with interest, or you leave credit you were entitled to.',
          'File karte waqt yeh na sulje to ya galat credit lena padta hai jo baad mein interest ke saath wapas hota hai, ya apna sahi credit chhoot jaata hai.',
        ),
        nextAction: bilingual('Open the purchase comparison and answer the unmatched bills.', 'Purchase comparison kholein aur na-milne wale bills ka jawab dein.'),
        actionCode: 'OPEN_ITC_WORKSPACE',
        affected: unresolved.records,
        amount: unresolved.amount,
        source: 'itc-reconciliation',
      },
    ];
  },
});

/** Whether the return is even prepared yet, and what it says is payable. */
export const returnReadinessSignals = (reader: ReturnReadinessReader): ComplianceSignalPort => ({
  name: 'return workspace',
  async signalsFor(companyId, occurrence) {
    if (occurrence.code !== 'GSTR1' && occurrence.code !== 'GSTR3B') return [];
    const readiness = await reader.readinessFor(companyId, monthKeyOf(occurrence));
    if (readiness === null) return [];
    const signals: ComplianceSignal[] = [];
    if (!readiness.prepared) {
      signals.push({
        code: 'RETURN_NOT_PREPARED',
        severity: 'WARNING',
        count: 1,
        headline: bilingual('This return has not been prepared yet.', 'Yeh return abhi tak taiyaar nahin hua hai.'),
        consequence: bilingual('Nothing can be filed until it is prepared and checked.', 'Jab tak taiyaar aur check nahin hota, kuch file nahin ho sakta.'),
        nextAction: bilingual('Open the return and prepare it.', 'Return kholein aur taiyaar karein.'),
        actionCode: 'OPEN_RETURN_WORKSPACE',
        affected: [],
        source: 'gst-returns',
      });
    }
    if (readiness.blockingIssues > 0) {
      signals.push({
        code: 'RETURN_NOT_PREPARED',
        severity: 'BLOCKING',
        count: readiness.blockingIssues,
        headline: bilingual(
          `${readiness.blockingIssues} ${readiness.blockingIssues === 1 ? 'bill' : 'bills'} in this return cannot be filed as ${readiness.blockingIssues === 1 ? 'it is' : 'they are'}.`,
          `Is return ke ${readiness.blockingIssues} bill abhi jaise hain waise file nahin ho sakte.`,
        ),
        consequence: bilingual('The portal will reject the return until they are fixed.', 'Jab tak yeh theek nahin hote, portal return nahin leta.'),
        nextAction: bilingual('Fix the bills the return workspace has flagged.', 'Return workspace ne jo bills flag kiye hain unhein theek karein.'),
        actionCode: 'OPEN_RETURN_WORKSPACE',
        affected: [],
        source: 'gst-returns',
      });
    }
    if (occurrence.code === 'GSTR3B' && readiness.taxPayable.minor > 0n) {
      signals.push({
        code: 'TAX_UNPAID',
        severity: 'WARNING',
        count: 1,
        headline: bilingual(`${formatINR(readiness.taxPayable)} of tax is payable with this return.`, `Is return ke saath ${formatINR(readiness.taxPayable)} tax bharna hai.`),
        consequence: bilingual('Interest runs on unpaid tax from the due date, day by day.', 'Bakaya tax par due date se rozana interest chadta hai.'),
        nextAction: bilingual('Arrange the money before the due date.', 'Due date se pehle paise ka intezaam karein.'),
        actionCode: 'OPEN_GSTR3B_WORKSPACE',
        affected: [],
        amount: readiness.taxPayable,
        source: 'gst-returns',
      });
    }
    return signals;
  },
});

/** Invoices that still need an IRN, attached to the monthly sweep and to the sales return. */
export const eInvoiceBacklogSignals = (reader: EInvoiceBacklogReader): ComplianceSignalPort => ({
  name: 'e-invoice queue',
  async signalsFor(companyId, occurrence) {
    if (occurrence.code !== 'EINVOICE_BACKLOG' && occurrence.code !== 'GSTR1') return [];
    const pending = await reader.pendingFor(companyId, monthKeyOf(occurrence));
    if (pending === null || pending.count === 0) return [];
    return [
      {
        code: 'IRN_PENDING',
        severity: 'BLOCKING',
        count: pending.count,
        headline: bilingual(
          `${pending.count} ${pending.count === 1 ? 'invoice has' : 'invoices have'} not been sent to the portal for an IRN.`,
          `${pending.count} invoice abhi tak IRN ke liye portal par nahin bheji gayi.`,
        ),
        consequence: bilingual(
          'After thirty days from the invoice date the portal will not accept them at all, and an invoice without an IRN is not valid.',
          'Invoice ki date se tees din baad portal inhein leta hi nahin, aur bina IRN ke invoice valid nahin hoti.',
        ),
        nextAction: bilingual('Send these invoices to the portal now.', 'Yeh invoices abhi portal par bhejein.'),
        actionCode: 'OPEN_EINVOICE_QUEUE',
        affected: pending.records,
        source: 'einvoice',
      },
    ];
  },
});

/** A monthly obligation's own month; for a quarter, the last month in it. */
const monthKeyOf = (occurrence: ObligationOccurrence): string => occurrence.period.to.slice(0, 7);

// ---------------------------------------------------------------------------- sending

export const COMPLIANCE_ALERT_TEMPLATE = 'compliance_deadline';

/**
 * The template registration for #39.
 *
 * The sentences are already written, in both languages, by the alert itself. The template picks a
 * language; it does not compose a sentence. Wording assembled in two places drifts, and one of the
 * copies is always the one that says something slightly untrue about a deadline.
 */
export const registerComplianceTemplates = (templates: NotificationTemplateRegistry): void => {
  for (const locale of ['en-IN', 'hi-IN'] as const) {
    templates.register(COMPLIANCE_ALERT_TEMPLATE, locale, (payload) => ({
      subject: String(payload[`headline_${locale}`] ?? payload.headline_en ?? 'A compliance deadline is coming up'),
      body: [payload[`detail_${locale}`], payload[`action_${locale}`]].filter((part) => typeof part === 'string' && part !== '').join('\n\n'),
    }));
  }
};

/**
 * Sending through GPT 2's notification service (#39).
 *
 * Compliance alerts are `internal`, which under #39's own policy table means in-app and email only.
 * That is the right answer as well as the required one: "you are late on your tax" is not a
 * sentence to put on a shared WhatsApp number.
 *
 * The escalation ladder is expressed as the recipient role rather than as a louder message. An
 * early reminder goes to whoever does the filing; an overdue one reaches the owner.
 */
export const notificationAlertTransport = (
  notifications: NotificationService,
  contextFor: (companyId: CompanyId) => RequestContext,
  now: () => number = Date.now,
): AlertTransport => ({
  async send(alert, recipients) {
    const context = contextFor(alert.companyId);
    const deliveries: AlertDelivery[] = [];
    for (const recipient of recipients) {
      for (const channel of ['in_app', 'email'] as const) {
        const notification = notifications.schedule(context, {
          recipientId: recipient.recipientId,
          recipientRole: alert.audiences.includes('OWNER') ? 'owner' : 'accountant',
          channel,
          template: COMPLIANCE_ALERT_TEMPLATE,
          locale: recipient.locale ?? 'en-IN',
          sensitivity: 'internal',
          payload: {
            headline_en: alert.headline['en-IN'],
            headline_hi: alert.headline['hi-IN'],
            detail_en: alert.detail['en-IN'],
            detail_hi: alert.detail['hi-IN'],
            action_en: alert.nextAction['en-IN'],
            action_hi: alert.nextAction['hi-IN'],
            rule: `${alert.code} v${alert.version}`,
            dueDate: alert.dueDate,
            affected: String(alert.affected.length),
          },
          // The alert's own key, so neither layer can produce a second message for one rung.
          deduplicationKey: `${alert.deduplicationKey}:${channel}:${recipient.recipientId}`,
          scheduledAt: now(),
        });
        deliveries.push({
          recipientId: recipient.recipientId,
          channel,
          state: notification.status === 'suppressed' ? 'SUPPRESSED' : 'SENT',
          notificationId: notification.id,
        });
      }
    }
    return deliveries;
  },
});

/** Everything a test or the demo needs to see what was sent, without a provider. */
export class RecordingAlertTransport implements AlertTransport {
  readonly sent: { readonly alert: ComplianceAlert; readonly recipients: readonly AlertRecipient[] }[] = [];
  #failNext = false;

  failOnce(): void {
    this.#failNext = true;
  }

  async send(alert: ComplianceAlert, recipients: readonly AlertRecipient[]): Promise<readonly AlertDelivery[]> {
    if (this.#failNext) {
      this.#failNext = false;
      throw new Error('The mail server did not answer.');
    }
    this.sent.push({ alert, recipients });
    return recipients.map((recipient) => ({ recipientId: recipient.recipientId, channel: 'in_app' as const, state: 'SENT' as const, notificationId: `n-${this.sent.length}` }));
  }
}

export class InMemoryContacts implements ComplianceContactPort {
  readonly #rows = new Map<string, AlertRecipient[]>();

  set(companyId: CompanyId, audience: Audience, recipients: readonly AlertRecipient[]): void {
    this.#rows.set(`${companyId}:${audience}`, [...recipients]);
  }

  async recipients(companyId: CompanyId, audience: Audience): Promise<readonly AlertRecipient[]> {
    return this.#rows.get(`${companyId}:${audience}`) ?? [];
  }
}

/**
 * The request context #39 expects, built from the actor this module was called with.
 *
 * The session id is passed in rather than invented: it belongs to the authenticated session, and a
 * module that made one up would be putting a fiction into somebody else's audit trail.
 */
export const requestContextFrom = (actor: ActorContext, sessionId: string): RequestContext => ({
  companyId: actor.companyId,
  branchId: actor.branchId ?? actor.companyId,
  actorId: actor.userId,
  permissions: new Set(['notification.send' as const]),
  sessionId,
});
