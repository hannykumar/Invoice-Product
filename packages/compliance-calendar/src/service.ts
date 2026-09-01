/**
 * Issue #32 [E32] — the calendar as a thing a business uses.
 *
 * Everything before this file is pure. This is where deadlines acquire a life: a company with half
 * its profile filled in, a sweep that runs every morning, an owner who marks a return filed, an
 * accountant who says "not this week", and a government that moves a date in the middle of it.
 *
 * Four promises are kept here rather than anywhere else.
 *
 *   1. **The calendar is recomputed, never accumulated.** Occurrences are rebuilt from the rules on
 *      every refresh and matched to what is stored by a key that carries no date. A deadline that
 *      moves updates the same occurrence and records the move; it never leaves a second row behind
 *      for the same month, which is how a business ends up being warned twice about one return and
 *      then ignoring both.
 *   2. **History is not rewritten.** A completed obligation is frozen: an extension announced after
 *      a return was filed changes nothing that happened. An open one whose date moves keeps the old
 *      date in a revision beside the new one, and the ladder starts again for the new deadline.
 *   3. **Nothing is guessed.** A profile without a filing frequency produces an exception with a
 *      question in it, not a monthly deadline "for now".
 *   4. **Tenancy comes from the actor.** Every method takes the company from the authenticated
 *      context and never from the caller's input.
 */
import { conflict, forbidden, invalid, notFound, type Clock, type CompanyId, type IsoDate, type UserId } from '@invoice/kernel';
import type { ActorContext, AuditPort } from '@invoice/ledger';
import { buildAlert, entryState, nextLadderStep } from './alerts.ts';
import { applicabilityOf, chooseDefinition } from './applicability.ts';
import { definitionsFor } from './catalogue.ts';
import { validateEvidence, validateSnooze } from './completion.ts';
import type {
  AlertRepository,
  AlertTransport,
  ComplianceContactPort,
  ComplianceExceptionRepository,
  ComplianceSignalPort,
  CompanyProfilePort,
  DeadlineEvent,
  DeadlineEventPort,
  HolidayCalendarPort,
  ObligationDefinitionPort,
  OccurrenceRepository,
} from './ports.ts';
import {
  addDays,
  daysBetween,
  describePeriod,
  dueDateFor,
  nextPeriod,
  periodContaining,
  previousPeriod,
  todayIn,
  workingDayBefore,
  type WorkingDayPolicy,
} from './schedule.ts';
import {
  CALENDAR_PERMISSIONS,
  alertKey,
  bilingual,
  describeReviewState,
  higherLevel,
  occurrenceKey,
  type Audience,
  type CalendarEntry,
  type CalendarRun,
  type CalendarView,
  type CompanyComplianceProfile,
  type ComplianceAlert,
  type ComplianceException,
  type ComplianceSignal,
  type CompletionEvidence,
  type ObligationCode,
  type ObligationDefinition,
  type ObligationOccurrence,
  type ObligationPeriod,
} from './types.ts';

export interface CalendarServiceDeps {
  readonly definitions: ObligationDefinitionPort;
  readonly profiles: CompanyProfilePort;
  readonly occurrences: OccurrenceRepository;
  readonly alerts: AlertRepository;
  readonly exceptions: ComplianceExceptionRepository;
  readonly audit: AuditPort;
  readonly clock: Clock;
  readonly holidays?: HolidayCalendarPort;
  readonly events?: DeadlineEventPort;
  readonly signals?: readonly ComplianceSignalPort[];
  readonly contacts?: ComplianceContactPort;
  readonly transport?: AlertTransport;
  readonly idFactory?: () => string;
  /** How far back and forward the calendar is built, in days. Defaults cover a filing cycle. */
  readonly window?: { readonly back: number; readonly ahead: number };
}

export interface WindowInput {
  readonly from?: IsoDate;
  readonly to?: IsoDate;
}

export interface CompleteInput {
  readonly key: string;
  readonly evidence: CompletionEvidence;
  /** A retry of the same completion returns the first one instead of arguing about it. */
  readonly idempotencyKey?: string;
}

export interface RunReportDelivery {
  readonly alert: ComplianceAlert;
  readonly deliveries: readonly { readonly recipientId: string; readonly state: string }[];
}

export class ComplianceCalendarService {
  readonly #definitions: ObligationDefinitionPort;
  readonly #profiles: CompanyProfilePort;
  readonly #occurrences: OccurrenceRepository;
  readonly #alerts: AlertRepository;
  readonly #exceptions: ComplianceExceptionRepository;
  readonly #audit: AuditPort;
  readonly #clock: Clock;
  readonly #holidays: HolidayCalendarPort | undefined;
  readonly #events: DeadlineEventPort | undefined;
  readonly #signals: readonly ComplianceSignalPort[];
  readonly #contacts: ComplianceContactPort | undefined;
  readonly #transport: AlertTransport | undefined;
  readonly #newId: () => string;
  readonly #window: { readonly back: number; readonly ahead: number };

  constructor(deps: CalendarServiceDeps) {
    this.#definitions = deps.definitions;
    this.#profiles = deps.profiles;
    this.#occurrences = deps.occurrences;
    this.#alerts = deps.alerts;
    this.#exceptions = deps.exceptions;
    this.#audit = deps.audit;
    this.#clock = deps.clock;
    this.#holidays = deps.holidays;
    this.#events = deps.events;
    this.#signals = deps.signals ?? [];
    this.#contacts = deps.contacts;
    this.#transport = deps.transport;
    this.#newId = deps.idFactory ?? (() => crypto.randomUUID());
    this.#window = deps.window ?? { back: 95, ahead: 45 };
  }

  // ------------------------------------------------------------------ reading

  /** Today, in the company's own time zone. A deadline is a date in India, not an instant here. */
  async today(actor: ActorContext): Promise<IsoDate> {
    const profile = await this.#profile(actor.companyId);
    return todayIn(this.#clock, profile.timeZone);
  }

  /**
   * The calendar as a screen shows it.
   *
   * Reading writes nothing. The occurrences are recomputed for the window and merged with what is
   * stored, so a screen can never show a deadline that a rule change has already moved — and a
   * viewer without the refresh permission still sees the truth.
   */
  async calendar(actor: ActorContext, window: WindowInput = {}): Promise<CalendarView> {
    this.#require(actor, CALENDAR_PERMISSIONS.view);
    const { today, from, to, planned, exceptions } = await this.#plan(actor, window);
    const entries: CalendarEntry[] = [];
    for (const item of planned) {
      const signals = item.occurrence.status === 'OPEN' ? await this.#signalsFor(actor.companyId, item.occurrence) : [];
      entries.push({
        occurrence: item.occurrence,
        daysRemaining: daysBetween(today, item.occurrence.dueDate),
        state: entryState(item.occurrence, today),
        signals,
        nextAction: item.definition.nextAction,
        reviewNote: describeReviewState(item.occurrence.reviewState),
      });
    }
    entries.sort((left, right) =>
      left.occurrence.dueDate < right.occurrence.dueDate ? -1 : left.occurrence.dueDate > right.occurrence.dueDate ? 1 : left.occurrence.key < right.occurrence.key ? -1 : 1,
    );
    return Object.freeze({ companyId: actor.companyId, today, from, to, entries, exceptions });
  }

  /** Everything recorded about one obligation: its revisions, its completion and every alert. */
  async history(
    actor: ActorContext,
    key: string,
  ): Promise<{ readonly occurrence: ObligationOccurrence; readonly alerts: readonly ComplianceAlert[] }> {
    this.#require(actor, CALENDAR_PERMISSIONS.view);
    const occurrence = await this.#occurrences.find(actor.companyId, key);
    if (occurrence === null) throw notFound('COMPLIANCE_OCCURRENCE_NOT_FOUND', 'That obligation is not on this calendar.');
    const alerts = (await this.#alerts.listForCompany(actor.companyId)).filter((alert) => alert.occurrenceKey === key);
    return { occurrence, alerts };
  }

  // ------------------------------------------------------------------ writing the calendar

  /**
   * Materialise the window: create what is missing, re-date what moved, leave the rest alone.
   *
   * Safe to run as often as anybody likes. Running it twice in a second changes nothing the second
   * time, which is what makes the morning sweep, a user pressing refresh and a retry after a crash
   * the same operation.
   */
  async refresh(actor: ActorContext, window: WindowInput = {}): Promise<readonly ObligationOccurrence[]> {
    this.#require(actor, CALENDAR_PERMISSIONS.refresh);
    const { planned, exceptions } = await this.#plan(actor, window);
    for (const item of planned) await this.#persist(actor, item.occurrence, item.stored);
    for (const exception of exceptions) await this.#exceptions.put(exception);
    return planned.map((item) => item.occurrence);
  }

  /**
   * The sweep: refresh, then raise whatever is due and send it.
   *
   * One rung per occurrence per run, deduplicated by obligation, level and due date — so five runs
   * before lunch send one message, and an extended deadline starts a fresh ladder rather than
   * staying silent because the old one was already rung.
   */
  async run(actor: ActorContext, window: WindowInput = {}): Promise<CalendarRun> {
    this.#require(actor, CALENDAR_PERMISSIONS.refresh);
    const { today, planned, exceptions } = await this.#plan(actor, window);
    const raised: ComplianceAlert[] = [];
    const snoozed: string[] = [];
    const alreadyRaised: string[] = [];

    for (const item of planned) {
      const occurrence = await this.#persist(actor, item.occurrence, item.stored);
      if (occurrence.status !== 'OPEN') continue;

      const raisedKeys = await this.#alerts.raisedKeys(actor.companyId, occurrence.key);
      const decision = nextLadderStep(occurrence, item.definition.ladder, today, raisedKeys);
      if (decision.step === null) {
        if (decision.suppressedBy === 'SNOOZE' && decision.suppressedStep !== null) {
          snoozed.push(alertKey(occurrence, decision.suppressedStep.level));
        } else if (decision.suppressedBy === 'ALREADY_RAISED' && decision.suppressedStep !== null) {
          alreadyRaised.push(alertKey(occurrence, decision.suppressedStep.level));
        }
        continue;
      }

      const signals = await this.#signalsFor(actor.companyId, occurrence);
      const alert = buildAlert({
        occurrence,
        definition: item.definition,
        step: decision.step,
        today,
        signals,
        id: this.#newId(),
        at: this.#clock.now().toISOString(),
        raisedBy: actor.userId,
      });
      await this.#raise(actor, occurrence, alert);
      raised.push(alert);
    }

    for (const exception of exceptions) {
      await this.#exceptions.put(exception);
      await this.#audit.record({
        companyId: actor.companyId,
        actorId: actor.userId,
        at: this.#clock.now().toISOString(),
        action: 'compliance.calendar.exception_raised',
        subjectType: 'compliance_obligation',
        subjectId: `${exception.code}:${exception.periodKey}`,
        summary: 'An obligation could not be placed because a company fact is missing.',
        details: { code: exception.code, period: exception.periodKey, missing: exception.missing.map((item) => item.fact).join(',') },
      });
    }

    return Object.freeze({
      at: this.#clock.now().toISOString(),
      today,
      occurrencesConsidered: planned.length,
      raised,
      snoozed,
      alreadyRaised,
      exceptions,
    });
  }

  // ------------------------------------------------------------------ what people do

  /**
   * Mark an obligation done, with proof.
   *
   * From this moment it escalates to nobody. That is the acceptance criterion and it is also the
   * reason evidence is required: the only thing that permanently silences a warning has to be a
   * record somebody can check.
   */
  async complete(actor: ActorContext, input: CompleteInput): Promise<ObligationOccurrence> {
    this.#require(actor, CALENDAR_PERMISSIONS.complete);
    validateEvidence(input.evidence);
    const occurrence = await this.#load(actor, input.key);

    if (occurrence.status === 'COMPLETED') {
      const existing = occurrence.completion;
      if (existing !== null && existing.evidence.reference.trim() === input.evidence.reference.trim() && existing.evidence.kind === input.evidence.kind) {
        return occurrence;
      }
      throw conflict(
        'COMPLIANCE_ALREADY_COMPLETED',
        `This was already marked done on ${occurrence.completion?.evidence.filedOn ?? 'an earlier date'}. To change it, record a correction rather than a second completion.`,
      );
    }

    const at = this.#clock.now().toISOString();
    const completed: ObligationOccurrence = {
      ...occurrence,
      status: 'COMPLETED',
      completion: { evidence: input.evidence, completedBy: actor.userId, completedAt: at },
      snooze: null,
      updatedAt: at,
    };
    await this.#occurrences.put(completed);
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: 'compliance.calendar.completed',
      subjectType: 'compliance_obligation',
      subjectId: occurrence.key,
      summary: `${occurrence.title['en-IN']} for ${describePeriod(occurrence.period)['en-IN']} was marked done.`,
      details: {
        evidenceKind: input.evidence.kind,
        reference: input.evidence.reference,
        filedOn: input.evidence.filedOn,
        dueDate: occurrence.dueDate,
        late: String(input.evidence.filedOn > occurrence.dueDate),
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      },
    });
    return completed;
  }

  /** Quiet the early reminders for a while. Never the overdue ones — see `validateSnooze`. */
  async snooze(actor: ActorContext, key: string, until: IsoDate, reason: string): Promise<ObligationOccurrence> {
    this.#require(actor, CALENDAR_PERMISSIONS.snooze);
    const occurrence = await this.#load(actor, key);
    if (occurrence.status !== 'OPEN') {
      throw invalid('COMPLIANCE_SNOOZE_NOT_OPEN', 'Only an obligation that is still to be done can be put off.');
    }
    const today = await this.today(actor);
    validateSnooze(occurrence, until, reason, today);
    const at = this.#clock.now().toISOString();
    const snoozed: ObligationOccurrence = {
      ...occurrence,
      snooze: { until, reason, snoozedBy: actor.userId, snoozedAt: at },
      updatedAt: at,
    };
    await this.#occurrences.put(snoozed);
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: 'compliance.calendar.snoozed',
      subjectType: 'compliance_obligation',
      subjectId: key,
      summary: `Reminders for ${occurrence.title['en-IN']} were put off until ${until}.`,
      details: { until, dueDate: occurrence.dueDate },
      overrideReason: reason,
    });
    return snoozed;
  }

  /**
   * Escalate by hand, before the ladder gets there.
   *
   * The accountant who can see that a return will not be filed on time should be able to put it in
   * front of the owner today rather than waiting five days for the rung to arrive.
   */
  async escalate(actor: ActorContext, key: string, reason: string): Promise<ComplianceAlert> {
    this.#require(actor, CALENDAR_PERMISSIONS.escalate);
    if (reason.trim().length < 3) {
      throw invalid('COMPLIANCE_ESCALATION_REASON_REQUIRED', 'Say briefly why this needs the owner’s attention now.');
    }
    const occurrence = await this.#load(actor, key);
    if (occurrence.status !== 'OPEN') {
      throw invalid('COMPLIANCE_ESCALATE_NOT_OPEN', 'This obligation is not outstanding, so there is nothing to escalate.');
    }
    const raisedKeys = await this.#alerts.raisedKeys(actor.companyId, key);
    if (raisedKeys.has(alertKey(occurrence, 'ESCALATED'))) {
      throw conflict('COMPLIANCE_ALREADY_ESCALATED', 'This has already been escalated to the owner for this deadline.');
    }
    const definition = await this.#definitionFor(actor.companyId, occurrence);
    const today = await this.today(actor);
    const signals = await this.#signalsFor(actor.companyId, occurrence);
    const alert = buildAlert({
      occurrence,
      definition,
      step: { offsetDays: daysBetween(occurrence.dueDate, today), level: 'ESCALATED', audiences: ['OWNER'] },
      today,
      signals,
      id: this.#newId(),
      at: this.#clock.now().toISOString(),
      raisedBy: actor.userId,
      manualReason: reason,
    });
    await this.#raise(actor, occurrence, alert);
    return alert;
  }

  /**
   * Record that an obligation does not apply to this business after all, with the reason in words.
   *
   * Kept separate from completion because they are different statements: "we filed it" and "we do
   * not file this" are answered by different people and checked in different ways.
   */
  async markNotApplicable(actor: ActorContext, key: string, reason: string): Promise<ObligationOccurrence> {
    this.#require(actor, CALENDAR_PERMISSIONS.complete);
    if (reason.trim().length < 3) {
      throw invalid('COMPLIANCE_REASON_REQUIRED', 'Say briefly why this does not apply to your business.');
    }
    const occurrence = await this.#load(actor, key);
    const at = this.#clock.now().toISOString();
    const updated: ObligationOccurrence = {
      ...occurrence,
      status: 'NOT_APPLICABLE',
      notApplicableReason: bilingual(reason, reason),
      updatedAt: at,
    };
    await this.#occurrences.put(updated);
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: 'compliance.calendar.marked_not_applicable',
      subjectType: 'compliance_obligation',
      subjectId: key,
      summary: `${occurrence.title['en-IN']} was recorded as not applicable.`,
      details: { dueDate: occurrence.dueDate },
      overrideReason: reason,
    });
    return updated;
  }

  // ------------------------------------------------------------------ the planner

  async #plan(
    actor: ActorContext,
    window: WindowInput,
  ): Promise<{
    readonly today: IsoDate;
    readonly from: IsoDate;
    readonly to: IsoDate;
    readonly planned: readonly PlannedOccurrence[];
    readonly exceptions: readonly ComplianceException[];
  }> {
    const companyId = actor.companyId;
    const profile = await this.#profile(companyId);
    const today = todayIn(this.#clock, profile.timeZone);
    const from = window.from ?? addDays(today, -this.#window.back);
    const to = window.to ?? addDays(today, this.#window.ahead);
    const definitions = await this.#definitions.definitionsFor(companyId);
    const policy = await this.#workingDayPolicy(companyId, addDays(from, -30), addDays(to, 30), profile);
    const stored = await this.#occurrences.list(companyId, from, to);
    const storedByKey = new Map(stored.map((item) => [item.key, item] as const));

    const planned: PlannedOccurrence[] = [];
    const exceptions: ComplianceException[] = [];
    const at = this.#clock.now().toISOString();

    for (const code of codesIn(definitions)) {
      const periods = this.#periodsFor(definitions, code, from, to, profile);
      for (const period of periods) {
        const candidates = definitionsFor(definitions, code, period.to);
        if (candidates.length === 0) continue;
        const { definition, outcome } = chooseDefinition(candidates, profile);
        if (definition === null) {
          if (outcome.kind === 'CANNOT_DECIDE') {
            exceptions.push({
              companyId,
              code,
              periodKey: period.key,
              missing: outcome.missing,
              question: outcome.question,
              raisedAt: at,
            });
          }
          continue;
        }
        const key = occurrenceKey(code, period);
        const existing = storedByKey.get(key) ?? null;
        const due = dueDateFor({
          rule: definition.dueRule,
          shift: definition.dueDateShift,
          period,
          stateCode: profile.stateCode?.value ?? null,
          policy,
        });
        // A deadline that fell before this product was answerable for the company is not this
        // product's to announce. See `calendarFrom`.
        if (profile.calendarFrom !== null && due.dueDate < profile.calendarFrom) continue;
        planned.push({
          definition,
          stored: existing,
          occurrence: this.#merge({ companyId, key, code, definition, period, dueDate: due.dueDate, actionableBy: due.actionableBy, existing, at }),
        });
      }
    }

    if (this.#events !== undefined) {
      for (const event of await this.#events.eventsFor(companyId, from, to)) {
        if (profile.calendarFrom !== null && event.occurredOn < profile.calendarFrom) continue;
        const entry = await this.#planEvent(companyId, profile, definitions, policy, event, storedByKey, at);
        if (entry !== null) planned.push(entry);
      }
    }

    return { today, from, to, planned, exceptions };
  }

  /**
   * A deadline that comes from a document rather than a month.
   *
   * The owning module (#26 for an IRN, #27 for an e-way bill) says when the event happened and
   * whether it is resolved. A resolved event closes its occurrence with the module named as the
   * evidence — an obligation that has been met stops escalating whether a person ticked it off or
   * the system saw it happen.
   */
  async #planEvent(
    companyId: CompanyId,
    profile: CompanyComplianceProfile,
    definitions: readonly ObligationDefinition[],
    policy: WorkingDayPolicy,
    event: DeadlineEvent,
    storedByKey: ReadonlyMap<string, ObligationOccurrence>,
    at: string,
  ): Promise<PlannedOccurrence | null> {
    const candidates = definitionsFor(definitions, event.code, event.occurredOn);
    const { definition } = chooseDefinition(candidates, profile);
    if (definition === null) return null;
    const period: ObligationPeriod = {
      kind: 'EVENT',
      key: event.key,
      from: event.occurredOn,
      to: event.dueOn ?? event.occurredOn,
      label: event.label,
    };
    const due =
      event.dueOn === undefined
        ? dueDateFor({ rule: definition.dueRule, shift: definition.dueDateShift, period, stateCode: profile.stateCode?.value ?? null, policy })
        : { dueDate: event.dueOn, actionableBy: workingDayBefore(event.dueOn, policy), shiftedFrom: null };
    const key = occurrenceKey(event.code, period);
    const existing = storedByKey.get(key) ?? null;
    let occurrence = this.#merge({ companyId, key, code: event.code, definition, period, dueDate: due.dueDate, actionableBy: due.actionableBy, existing, at });
    if (event.resolved && occurrence.status === 'OPEN') {
      occurrence = {
        ...occurrence,
        status: 'COMPLETED',
        completion: {
          evidence: {
            kind: 'SOURCE_MODULE',
            reference: event.key,
            filedOn: due.dueDate,
            note: `Reported as done by the module that owns this document.`,
          },
          completedBy: SYSTEM_ACTOR,
          completedAt: at,
        },
      };
    }
    return { definition, stored: existing, occurrence };
  }

  /**
   * Merge a freshly computed occurrence with what is already stored.
   *
   * This is where "changed deadlines update without rewriting history" actually happens.
   *
   *   - Nothing stored: a new occurrence, with no revisions.
   *   - Stored and completed: frozen. An extension announced after the return was filed does not
   *     touch the record of what was due when it was filed.
   *   - Stored, open, same date: unchanged, so a refresh does not churn the row or the audit log.
   *   - Stored, open, different date: the old date is kept in an appended revision, the new one
   *     takes effect, and `highestAlertLevel` is cleared so the ladder runs again for the new
   *     deadline. A business given three extra weeks should be warned again as those weeks run out.
   */
  #merge(input: {
    readonly companyId: CompanyId;
    readonly key: string;
    readonly code: ObligationCode;
    readonly definition: ObligationDefinition;
    readonly period: ObligationPeriod;
    readonly dueDate: IsoDate;
    readonly actionableBy: IsoDate;
    readonly existing: ObligationOccurrence | null;
    readonly at: string;
  }): ObligationOccurrence {
    const { definition, existing } = input;
    const base = {
      companyId: input.companyId,
      key: input.key,
      code: input.code,
      obligationKind: definition.kind,
      title: definition.title,
      version: definition.version,
      reviewState: definition.reviewState,
      sourceRef: definition.sourceRef,
      period: input.period,
      dueDate: input.dueDate,
      actionableBy: input.actionableBy,
    };

    if (existing === null) {
      return Object.freeze({
        ...base,
        id: this.#newId(),
        status: 'OPEN' as const,
        notApplicableReason: null,
        snooze: null,
        completion: null,
        revisions: [],
        highestAlertLevel: null,
        createdAt: input.at,
        updatedAt: input.at,
      });
    }

    if (existing.status !== 'OPEN') return existing;
    if (existing.dueDate === input.dueDate && existing.version === definition.version) return existing;

    if (existing.dueDate === input.dueDate) {
      // Same date, new version of the rule: record the version without disturbing the ladder.
      return Object.freeze({ ...existing, ...base, updatedAt: input.at });
    }

    return Object.freeze({
      ...existing,
      ...base,
      revisions: [
        ...existing.revisions,
        {
          at: input.at,
          previousDueDate: existing.dueDate,
          dueDate: input.dueDate,
          previousVersion: existing.version,
          version: definition.version,
          reason: bilingual(
            `The deadline for ${describePeriod(input.period)['en-IN']} moved from ${existing.dueDate} to ${input.dueDate}.`,
            `${describePeriod(input.period)['hi-IN']} ki deadline ${existing.dueDate} se badal kar ${input.dueDate} ho gayi.`,
          ),
          sourceRef: definition.sourceRef,
        },
      ],
      highestAlertLevel: null,
      updatedAt: input.at,
    });
  }

  /** The periods of one obligation that overlap the window, by the cadence of its own versions. */
  #periodsFor(
    definitions: readonly ObligationDefinition[],
    code: ObligationCode,
    from: IsoDate,
    to: IsoDate,
    profile: CompanyComplianceProfile,
  ): readonly ObligationPeriod[] {
    const cadences = new Set(
      definitions
        .filter((definition) => definition.code === code && definition.cadence !== 'EVENT')
        .filter((definition) => applicabilityOf(definition, profile).kind !== 'DOES_NOT_APPLY')
        .map((definition) => definition.cadence),
    );
    const periods: ObligationPeriod[] = [];
    for (const cadence of cadences) {
      // A period is in scope when its deadline could fall in the window, which is later than the
      // period itself: July's return is due in August. Walking back a full year of periods and
      // filtering on the computed due date would be tidier and far more work; two extra periods on
      // each side is enough for every cadence in the catalogue.
      let period = periodContaining(cadence, addDays(from, -1));
      period = previousPeriod(cadence, period);
      for (let guard = 0; guard < 64; guard += 1) {
        if (period.from > to) break;
        periods.push(period);
        period = nextPeriod(cadence, period);
      }
    }
    return periods;
  }

  // ------------------------------------------------------------------ plumbing

  async #persist(actor: ActorContext, occurrence: ObligationOccurrence, stored: ObligationOccurrence | null): Promise<ObligationOccurrence> {
    if (stored !== null && stored === occurrence) return occurrence;
    await this.#occurrences.put(occurrence);
    const revision = occurrence.revisions[occurrence.revisions.length - 1];
    if (stored !== null && revision !== undefined && (stored.revisions.length !== occurrence.revisions.length)) {
      await this.#audit.record({
        companyId: actor.companyId,
        actorId: actor.userId,
        at: revision.at,
        action: 'compliance.calendar.deadline_revised',
        subjectType: 'compliance_obligation',
        subjectId: occurrence.key,
        summary: revision.reason['en-IN'],
        details: {
          previousDueDate: revision.previousDueDate,
          dueDate: revision.dueDate,
          previousVersion: String(revision.previousVersion),
          version: String(revision.version),
          sourceRef: revision.sourceRef ?? '',
        },
      });
    }
    return occurrence;
  }

  /** Record the alert, mark the rung as rung, then try to send it. In that order, deliberately. */
  async #raise(actor: ActorContext, occurrence: ObligationOccurrence, alert: ComplianceAlert): Promise<void> {
    await this.#alerts.insert(alert);
    await this.#occurrences.put({
      ...occurrence,
      highestAlertLevel: higherLevel(occurrence.highestAlertLevel, alert.level),
      updatedAt: alert.raisedAt,
    });
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at: alert.raisedAt,
      action: 'compliance.calendar.alert_raised',
      subjectType: 'compliance_obligation',
      subjectId: occurrence.key,
      summary: alert.headline['en-IN'],
      details: {
        level: alert.level,
        dueDate: alert.dueDate,
        daysRemaining: String(alert.daysRemaining),
        rule: `${alert.code} v${alert.version}`,
        sourceRef: alert.sourceRef ?? '',
        signals: alert.signals.map((signal) => `${signal.code}:${signal.count}`).join(','),
        affected: String(alert.affected.length),
        nextAction: alert.actionCode,
        ...(alert.manualReason === undefined ? {} : { manualReason: alert.manualReason }),
      },
    });

    if (this.#transport === undefined || this.#contacts === undefined) return;
    const recipients: { readonly recipientId: string; readonly locale?: 'en-IN' | 'hi-IN' }[] = [];
    for (const audience of alert.audiences) {
      for (const recipient of await this.#contacts.recipients(actor.companyId, audience as Audience)) {
        if (!recipients.some((existing) => existing.recipientId === recipient.recipientId)) recipients.push(recipient);
      }
    }
    if (recipients.length === 0) return;
    try {
      await this.#transport.send(alert, recipients);
    } catch (error) {
      // Delivery failed; the warning still exists and still shows in the app. A mail server being
      // down must never change a compliance record, so this is recorded and swallowed.
      await this.#audit.record({
        companyId: actor.companyId,
        actorId: actor.userId,
        at: this.#clock.now().toISOString(),
        action: 'compliance.calendar.alert_delivery_failed',
        subjectType: 'compliance_alert',
        subjectId: alert.id,
        summary: 'The alert was raised but could not be delivered. It is visible in the app and delivery can be retried.',
        details: { level: alert.level, reason: error instanceof Error ? error.message : 'unknown' },
      });
    }
  }

  async #signalsFor(companyId: CompanyId, occurrence: ObligationOccurrence): Promise<readonly ComplianceSignal[]> {
    const signals: ComplianceSignal[] = [];
    for (const port of this.#signals) {
      try {
        signals.push(...(await port.signalsFor(companyId, occurrence)));
      } catch (error) {
        // A module that cannot answer must not stop the deadline being announced. The alert goes
        // out with the deadline and without the extra detail, which is still better than silence.
        signals.push({
          code: 'PURCHASE_EXCEPTION_OPEN',
          severity: 'INFORMATION',
          count: 0,
          headline: bilingual(
            `We could not check ${port.name} just now, so this warning may be missing something.`,
            `${port.name} abhi check nahin ho paaya, isliye is warning mein kuch chhoot sakta hai.`,
          ),
          consequence: bilingual('Open it yourself before you file.', 'File karne se pehle khud dekh lein.'),
          nextAction: bilingual('Open it and check.', 'Kholein aur dekhein.'),
          actionCode: 'OPEN_MODULE',
          affected: [],
          source: port.name,
        });
      }
    }
    return signals;
  }

  async #load(actor: ActorContext, key: string): Promise<ObligationOccurrence> {
    const stored = await this.#occurrences.find(actor.companyId, key);
    if (stored !== null) return stored;
    // The obligation may be perfectly real and simply not materialised yet — somebody opened the
    // calendar for next quarter and pressed "done" on it. Plan the window it belongs to and try
    // once more before saying it does not exist.
    const { planned } = await this.#plan(actor, {});
    const found = planned.find((item) => item.occurrence.key === key);
    if (found === undefined) {
      throw notFound('COMPLIANCE_OCCURRENCE_NOT_FOUND', 'That obligation is not on this calendar.');
    }
    await this.#occurrences.put(found.occurrence);
    return found.occurrence;
  }

  async #definitionFor(companyId: CompanyId, occurrence: ObligationOccurrence): Promise<ObligationDefinition> {
    const definitions = await this.#definitions.definitionsFor(companyId);
    const exact = definitions.find((definition) => definition.code === occurrence.code && definition.version === occurrence.version);
    if (exact !== undefined) return exact;
    const anyVersion = definitions.find((definition) => definition.code === occurrence.code);
    if (anyVersion === undefined) {
      throw notFound('COMPLIANCE_RULE_NOT_FOUND', 'The rule behind this deadline is no longer in the register.');
    }
    return anyVersion;
  }

  async #profile(companyId: CompanyId): Promise<CompanyComplianceProfile> {
    const profile = await this.#profiles.profileFor(companyId);
    if (profile === null) {
      throw notFound('COMPLIANCE_PROFILE_NOT_FOUND', 'This business has no compliance details recorded yet, so no deadlines can be worked out.');
    }
    return profile;
  }

  async #workingDayPolicy(
    companyId: CompanyId,
    from: IsoDate,
    to: IsoDate,
    profile: CompanyComplianceProfile,
  ): Promise<WorkingDayPolicy> {
    const holidays = this.#holidays === undefined ? [] : await this.#holidays.nonWorkingDays(companyId, from, to);
    return { saturdayIsWorking: profile.saturdayIsWorking, holidays: new Set(holidays) };
  }

  #require(actor: ActorContext, permission: string): void {
    if (!actor.permissions.includes(permission)) {
      throw forbidden('COMPLIANCE_CALENDAR_FORBIDDEN', 'You do not have permission to do that on the compliance calendar.', {
        details: { permission },
      });
    }
  }
}

interface PlannedOccurrence {
  readonly definition: ObligationDefinition;
  readonly stored: ObligationOccurrence | null;
  readonly occurrence: ObligationOccurrence;
}

const codesIn = (definitions: readonly ObligationDefinition[]): readonly ObligationCode[] => {
  const seen: ObligationCode[] = [];
  for (const definition of definitions) {
    if (definition.cadence === 'EVENT') continue;
    if (!seen.includes(definition.code)) seen.push(definition.code);
  }
  return seen;
};

/** Completions observed from another module carry this in place of a person's id. */
const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000' as UserId;

export { SYSTEM_ACTOR };
