/**
 * Issue #32 [E32] acceptance criteria, enforced automatically.
 *
 *   - "Alerts identify rule, deadline, affected records and next action"
 *   - "Changed deadlines update without rewriting history"
 *   - "Completed obligations stop escalating"
 *
 * plus the tests the issue asks for by name: deadline change, time zone and holiday behaviour,
 * escalation and completion, and applicability when a company fact is missing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, asId, fixedClock, isoDate, type CompanyId, type IsoDate } from '@invoice/kernel';
import { InMemoryAuditPort } from '@invoice/ledger';
import {
  CatalogueDefinitions,
  InMemoryAlerts,
  InMemoryComplianceExceptions,
  InMemoryContacts,
  InMemoryDeadlineEvents,
  InMemoryOccurrences,
  InMemoryProfiles,
  RecordingAlertTransport,
  SuppliedHolidays,
  eInvoiceBacklogSignals,
  purchaseMismatchSignals,
  returnReadinessSignals,
} from '../src/adapters.ts';
import { applicabilityOf, chooseDefinition } from '../src/applicability.ts';
import { OBLIGATION_CATALOGUE, definitionsFor } from '../src/catalogue.ts';
import { validateEvidence } from '../src/completion.ts';
import {
  ACCOUNTANT_USER,
  COMPOSITION_PROFILE,
  KONKAN_COMPANY,
  KONKAN_PROFILE,
  OWNER_USER,
  SUNRISE_COMPANY,
  SUNRISE_PROFILE,
  actorWith,
  julyEInvoiceBacklog,
  julyMismatches,
  julyReturnReadiness,
  ownerOf,
} from '../src/fixtures.ts';
import { ComplianceCalendarService } from '../src/service.ts';
import { dueDateFor, isWorkingDay, periodContaining, todayIn, workingDayBefore } from '../src/schedule.ts';
import {
  CALENDAR_PERMISSIONS,
  bilingual,
  type CompanyComplianceProfile,
  type ObligationDefinition,
  type ObligationOccurrence,
} from '../src/types.ts';

const WINDOW = { from: isoDate('2026-07-01'), to: isoDate('2026-09-30') };

interface Desk {
  readonly service: ComplianceCalendarService;
  readonly audit: InMemoryAuditPort;
  readonly transport: RecordingAlertTransport;
  readonly definitions: CatalogueDefinitions;
  readonly occurrences: InMemoryOccurrences;
  readonly holidays: SuppliedHolidays;
  readonly events: InMemoryDeadlineEvents;
  readonly alertsStore: InMemoryAlerts;
}

const makeDesk = (options: { at?: string; profiles?: readonly CompanyComplianceProfile[]; withSignals?: boolean } = {}): Desk => {
  const clock = fixedClock(options.at ?? '2026-08-17T04:30:00.000Z');
  const profiles = new InMemoryProfiles();
  for (const profile of options.profiles ?? [SUNRISE_PROFILE, KONKAN_PROFILE, COMPOSITION_PROFILE]) profiles.set(profile);
  const definitions = new CatalogueDefinitions();
  const occurrences = new InMemoryOccurrences();
  const alertsStore = new InMemoryAlerts();
  const audit = new InMemoryAuditPort();
  const transport = new RecordingAlertTransport();
  const holidays = new SuppliedHolidays();
  const events = new InMemoryDeadlineEvents();
  const contacts = new InMemoryContacts();
  contacts.set(SUNRISE_COMPANY, 'OWNER', [{ recipientId: OWNER_USER }]);
  contacts.set(SUNRISE_COMPANY, 'ACCOUNTANT', [{ recipientId: ACCOUNTANT_USER }]);
  let counter = 0;
  const service = new ComplianceCalendarService({
    definitions,
    profiles,
    occurrences,
    alerts: alertsStore,
    exceptions: new InMemoryComplianceExceptions(),
    audit,
    clock,
    holidays,
    events,
    contacts,
    transport,
    idFactory: () => `id-${++counter}`,
    signals:
      options.withSignals === false
        ? []
        : [
            purchaseMismatchSignals(julyMismatches),
            returnReadinessSignals(julyReturnReadiness),
            eInvoiceBacklogSignals(julyEInvoiceBacklog),
          ],
  });
  return { service, audit, transport, definitions, occurrences, holidays, events, alertsStore };
};

const entryFor = async (desk: Desk, key: string, actor = ownerOf()): Promise<ObligationOccurrence> => {
  const view = await desk.service.calendar(actor, WINDOW);
  const entry = view.entries.find((candidate) => candidate.occurrence.key === key);
  assert.ok(entry !== undefined, `expected ${key} on the calendar`);
  return entry.occurrence;
};

// ------------------------------------------------------------------- the dates themselves

test('the monthly returns fall on the days the rules give', () => {
  const july = periodContaining('MONTHLY', isoDate('2026-07-15'));
  const policy = { saturdayIsWorking: true, holidays: new Set<string>() };
  const gstr1 = OBLIGATION_CATALOGUE.find((definition) => definition.code === 'GSTR1' && definition.version === 1);
  const gstr3b = OBLIGATION_CATALOGUE.find((definition) => definition.code === 'GSTR3B' && definition.version === 1);
  assert.ok(gstr1 && gstr3b);
  assert.equal(dueDateFor({ rule: gstr1.dueRule, shift: 'NONE', period: july, stateCode: '29', policy }).dueDate, '2026-08-11');
  assert.equal(dueDateFor({ rule: gstr3b.dueRule, shift: 'NONE', period: july, stateCode: '29', policy }).dueDate, '2026-08-20');
});

test('the quarterly summary return is due on a different day in different states', () => {
  const quarter = periodContaining('QUARTERLY', isoDate('2026-08-15'));
  assert.equal(quarter.key, '2026-Q2');
  assert.equal(quarter.from, '2026-07-01');
  assert.equal(quarter.to, '2026-09-30');
  const policy = { saturdayIsWorking: true, holidays: new Set<string>() };
  const rule = OBLIGATION_CATALOGUE.find((definition) => definition.code === 'GSTR3B' && definition.version === 2)?.dueRule;
  assert.ok(rule);
  assert.equal(dueDateFor({ rule, shift: 'NONE', period: quarter, stateCode: '29', policy }).dueDate, '2026-10-22');
  assert.equal(dueDateFor({ rule, shift: 'NONE', period: quarter, stateCode: '09', policy }).dueDate, '2026-10-24');
});

test('January to March belongs to the previous financial year, not to a calendar quarter', () => {
  const quarter = periodContaining('QUARTERLY', isoDate('2027-02-11'));
  assert.equal(quarter.key, '2026-Q4');
  assert.equal(quarter.from, '2027-01-01');
  assert.equal(quarter.to, '2027-03-31');
  assert.equal(periodContaining('ANNUAL', isoDate('2027-02-11')).key, '2026-27');
});

test('a rule that says "the 31st" in a thirty-day month means the last day, not the 1st of the next', () => {
  const policy = { saturdayIsWorking: true, holidays: new Set<string>() };
  // A year ending 30 June with a "9 months later, the 31st" rule lands on 31 March; the same rule
  // for a year ending 31 August would otherwise walk off the end of a 30-day month.
  const period = { kind: 'YEAR' as const, key: 'test', from: isoDate('2025-09-01'), to: isoDate('2026-08-31') };
  const outcome = dueDateFor({ rule: { kind: 'DAY_OF_MONTH_AFTER_PERIOD', monthsAfter: 3, day: 31 }, shift: 'NONE', period, stateCode: null, policy });
  assert.equal(outcome.dueDate, '2026-11-30');
});

// ------------------------------------------------------------------- time zones and holidays

test('a deadline is a date in India, not an instant on the server', () => {
  // 19:30 UTC on the 19th is already half past one in the morning on the 20th in Bengaluru.
  assert.equal(todayIn(fixedClock('2026-09-19T19:30:00.000Z')), '2026-09-20');
  assert.equal(todayIn(fixedClock('2026-09-19T18:00:00.000Z')), '2026-09-19');
});

test('a run just after midnight in India treats the day as over, and the return as late', async () => {
  const desk = makeDesk({ at: '2026-09-20T19:00:00.000Z', withSignals: false });
  const owner = ownerOf();
  assert.equal(await desk.service.today(owner), '2026-09-21');
  const run = await desk.service.run(owner, { from: isoDate('2026-08-01'), to: isoDate('2026-09-30') });
  const august = run.raised.find((alert) => alert.occurrenceKey === 'GSTR3B:2026-08');
  assert.ok(august !== undefined, 'the August summary return should have been raised');
  assert.equal(august.level, 'OVERDUE');
  assert.equal(august.daysRemaining, -1);
});

test('a deadline on a Sunday stays on that Sunday; the reminder moves to the working day before', async () => {
  const desk = makeDesk({ at: '2026-09-15T04:30:00.000Z', withSignals: false });
  const occurrence = await entryFor(desk, 'GSTR3B:2026-08');
  assert.equal(occurrence.dueDate, '2026-09-20');
  assert.equal(new Date(`${occurrence.dueDate}T00:00:00Z`).getUTCDay(), 0, 'the due date is a Sunday');
  assert.equal(occurrence.actionableBy, '2026-09-19');
});

test('a holiday moves the reminder further back, and still never moves the deadline', async () => {
  const desk = makeDesk({ at: '2026-09-15T04:30:00.000Z', withSignals: false });
  desk.holidays.add(SUNRISE_COMPANY, isoDate('2026-09-19'), isoDate('2026-09-18'));
  const occurrence = await entryFor(desk, 'GSTR3B:2026-08');
  assert.equal(occurrence.dueDate, '2026-09-20');
  assert.equal(occurrence.actionableBy, '2026-09-17');
});

test('Sunday is never a working day and Saturday follows the company', () => {
  const withSaturday = { saturdayIsWorking: true, holidays: new Set<string>() };
  const withoutSaturday = { saturdayIsWorking: false, holidays: new Set<string>() };
  assert.equal(isWorkingDay(isoDate('2026-09-20'), withSaturday), false);
  assert.equal(isWorkingDay(isoDate('2026-09-19'), withSaturday), true);
  assert.equal(isWorkingDay(isoDate('2026-09-19'), withoutSaturday), false);
  assert.equal(workingDayBefore(isoDate('2026-09-20'), withoutSaturday), '2026-09-18');
});

// ------------------------------------------------------------------- applicability

test('a composition dealer files CMP-08 and does not file GSTR-1 or GSTR-3B', async () => {
  const desk = makeDesk({ withSignals: false });
  const view = await desk.service.calendar(ownerOf(COMPOSITION_PROFILE.companyId), WINDOW);
  const codes = new Set(view.entries.map((entry) => entry.occurrence.code));
  assert.ok(codes.has('CMP08'));
  assert.equal(codes.has('GSTR1'), false);
  assert.equal(codes.has('GSTR3B'), false);
});

test('a missing filing frequency produces a question, not a guessed deadline', async () => {
  const desk = makeDesk({ withSignals: false });
  const view = await desk.service.calendar(ownerOf(KONKAN_COMPANY), WINDOW);
  assert.equal(view.entries.filter((entry) => entry.occurrence.code === 'GSTR3B').length, 0);
  const exception = view.exceptions.find((item) => item.code === 'GSTR3B');
  assert.ok(exception !== undefined, 'the obligation must appear as a question rather than vanish');
  assert.deepEqual(exception.missing.map((item) => item.fact), ['gstFilingFrequency']);
  assert.match(exception.question['en-IN'], /every month, or once every three months/);
  assert.match(exception.question['hi-IN'], /teen maheene/);
});

test('an unanswered question is recorded as an exception and audited, never silently dropped', async () => {
  const desk = makeDesk({ withSignals: false });
  const run = await desk.service.run(ownerOf(KONKAN_COMPANY), WINDOW);
  assert.ok(run.exceptions.length > 0);
  assert.ok(desk.audit.events.some((event) => event.action === 'compliance.calendar.exception_raised'));
  assert.equal(run.raised.filter((alert) => alert.code === 'GSTR3B').length, 0);
});

test('the monthly and quarterly versions of one return are told apart by the filing frequency', () => {
  const candidates = definitionsFor(OBLIGATION_CATALOGUE, 'GSTR1', isoDate('2026-07-31'));
  assert.equal(candidates.length, 2);
  const monthly = chooseDefinition(candidates, SUNRISE_PROFILE);
  assert.equal(monthly.definition?.version, 1, 'a monthly filer must not be given the quarterly dates');
  const quarterlyProfile: CompanyComplianceProfile = { ...SUNRISE_PROFILE, gstFilingFrequency: { value: 'QUARTERLY', basis: 'DECLARED', declaredBy: OWNER_USER, declaredOn: isoDate('2026-04-02') } };
  assert.equal(chooseDefinition(candidates, quarterlyProfile).definition?.version, 2);
});

test('an obligation whose applicability cannot be decided is never reported as not applicable', () => {
  const gstr1 = OBLIGATION_CATALOGUE.find((definition) => definition.code === 'GSTR1');
  assert.ok(gstr1);
  const outcome = applicabilityOf(gstr1, KONKAN_PROFILE);
  assert.equal(outcome.kind, 'CANNOT_DECIDE');
});

test('deadlines that fell before this product was responsible are not announced', async () => {
  const desk = makeDesk({ withSignals: false });
  const view = await desk.service.calendar(ownerOf(), { from: isoDate('2026-01-01'), to: isoDate('2026-09-30') });
  const earliest = view.entries.map((entry) => entry.occurrence.dueDate).sort()[0];
  assert.ok(earliest !== undefined && earliest >= (SUNRISE_PROFILE.calendarFrom as IsoDate));
});

// ------------------------------------------------------------------- what an alert says

test('an alert names the rule, the deadline, the affected records and the next action', async () => {
  const desk = makeDesk();
  const run = await desk.service.run(ownerOf(), WINDOW);
  const alert = run.raised.find((candidate) => candidate.occurrenceKey === 'GSTR3B:2026-07');
  assert.ok(alert !== undefined);
  assert.equal(alert.code, 'GSTR3B');
  assert.equal(alert.version, 1);
  assert.equal(alert.sourceRef, 'cbic:gstr3b-monthly-due-date');
  assert.equal(alert.dueDate, '2026-08-20');
  assert.equal(alert.daysRemaining, 3);
  assert.equal(alert.affected.length, 3);
  assert.deepEqual(alert.affected.map((record) => record.id), ['bill-STL-2210', 'bill-PNT-118', 'bill-PPR-77']);
  assert.equal(alert.actionCode, 'OPEN_ITC_WORKSPACE');
  assert.match(alert.nextAction['en-IN'], /purchase comparison/);
});

test('the user example: unresolved purchase mismatches are named as a risk to the coming GSTR-3B', async () => {
  const desk = makeDesk();
  const run = await desk.service.run(ownerOf(), WINDOW);
  const alert = run.raised.find((candidate) => candidate.occurrenceKey === 'GSTR3B:2026-07');
  assert.ok(alert !== undefined);
  const mismatch = alert.signals.find((signal) => signal.code === 'ITC_MISMATCH_UNRESOLVED');
  assert.ok(mismatch !== undefined);
  assert.equal(mismatch.count, 3);
  assert.match(alert.detail['en-IN'], /3 purchase bills do not match/);
  assert.match(alert.detail['en-IN'], /₹36,000.00/);
  assert.match(alert.detail['hi-IN'], /suppliers ke bataye record se nahin mil rahe/);
});

test('an unchecked date carries the caveat that it is unchecked', async () => {
  const desk = makeDesk({ withSignals: false });
  const run = await desk.service.run(ownerOf(), WINDOW);
  const alert = run.raised.find((candidate) => candidate.occurrenceKey === 'GSTR3B:2026-07');
  assert.ok(alert !== undefined);
  assert.equal(alert.reviewState, 'DRAFT');
  assert.match(alert.detail['en-IN'], /has not been checked against the government notification/);
});

test('running the sweep repeatedly sends one message, and every alert is audited', async () => {
  const desk = makeDesk({ withSignals: false });
  const owner = ownerOf();
  const first = await desk.service.run(owner, WINDOW);
  const second = await desk.service.run(owner, WINDOW);
  const third = await desk.service.run(owner, WINDOW);
  assert.ok(first.raised.length > 0);
  assert.equal(second.raised.length, 0);
  assert.equal(third.raised.length, 0);
  assert.ok(second.alreadyRaised.length > 0);
  assert.equal(desk.transport.sent.length, first.raised.length);
  assert.equal(desk.audit.events.filter((event) => event.action === 'compliance.calendar.alert_raised').length, first.raised.length);
});

test('the ladder climbs one rung at a time and reaches the owner when the deadline passes', async () => {
  const early = makeDesk({ at: '2026-08-13T04:30:00.000Z', withSignals: false });
  const earlyRun = await early.service.run(ownerOf(), WINDOW);
  const earlyAlert = earlyRun.raised.find((alert) => alert.occurrenceKey === 'GSTR3B:2026-07');
  assert.equal(earlyAlert?.level, 'EARLY', 'a week out, only the person who does the filing is told');
  assert.deepEqual(earlyAlert?.audiences, ['ACCOUNTANT']);

  const soon = makeDesk({ at: '2026-08-17T04:30:00.000Z', withSignals: false });
  const soonAlert = (await soon.service.run(ownerOf(), WINDOW)).raised.find((alert) => alert.occurrenceKey === 'GSTR3B:2026-07');
  assert.equal(soonAlert?.level, 'DUE_SOON');
  assert.deepEqual(soonAlert?.audiences, ['ACCOUNTANT', 'OWNER']);

  const late = makeDesk({ at: '2026-08-26T04:30:00.000Z', withSignals: false });
  const lateRun = await late.service.run(ownerOf(), WINDOW);
  const lateAlert = lateRun.raised.find((alert) => alert.occurrenceKey === 'GSTR3B:2026-07');
  assert.equal(lateAlert?.level, 'ESCALATED');
  assert.deepEqual(lateAlert?.audiences, ['OWNER']);
});

test('a delivery failure never changes the compliance record', async () => {
  const desk = makeDesk({ withSignals: false });
  desk.transport.failOnce();
  const run = await desk.service.run(ownerOf(), WINDOW);
  assert.ok(run.raised.length > 0);
  assert.ok(desk.audit.events.some((event) => event.action === 'compliance.calendar.alert_delivery_failed'));
  const history = await desk.service.history(ownerOf(), run.raised[0]!.occurrenceKey);
  assert.equal(history.alerts.length, 1, 'the warning still exists in the app');
});

test('a module that cannot answer does not silence the deadline', async () => {
  const desk = makeDesk({ withSignals: false });
  const brokenService = new ComplianceCalendarService({
    definitions: desk.definitions,
    profiles: (() => {
      const profiles = new InMemoryProfiles();
      profiles.set(SUNRISE_PROFILE);
      return profiles;
    })(),
    occurrences: new InMemoryOccurrences(),
    alerts: new InMemoryAlerts(),
    exceptions: new InMemoryComplianceExceptions(),
    audit: new InMemoryAuditPort(),
    clock: fixedClock('2026-08-17T04:30:00.000Z'),
    signals: [
      {
        name: 'purchase comparison',
        async signalsFor() {
          throw new Error('the reconciliation is down');
        },
      },
    ],
  });
  const run = await brokenService.run(ownerOf(), WINDOW);
  const alert = run.raised.find((candidate) => candidate.occurrenceKey === 'GSTR3B:2026-07');
  assert.ok(alert !== undefined, 'the deadline is still announced');
  assert.match(alert.detail['en-IN'], /could not check purchase comparison/);
});

// ------------------------------------------------------------------- changed deadlines

const extendedGstr3b = (day: number, version: number): ObligationDefinition => {
  const base = OBLIGATION_CATALOGUE.find((definition) => definition.code === 'GSTR3B' && definition.version === 1);
  assert.ok(base);
  return {
    ...base,
    version,
    effectiveFrom: isoDate('2026-07-01'),
    dueRule: { kind: 'DAY_OF_MONTH_AFTER_PERIOD', monthsAfter: 1, day },
    sourceRef: 'portal:extension-notice',
    reviewState: 'DRAFT',
    declaredBy: OWNER_USER,
    declaredBasis: 'The extension was announced on the portal and read by the owner.',
  };
};

test('a changed deadline updates the same obligation and keeps the old date in the record', async () => {
  const desk = makeDesk({ withSignals: false });
  const owner = ownerOf();
  await desk.service.refresh(owner, WINDOW);
  const before = await entryFor(desk, 'GSTR3B:2026-07');
  assert.equal(before.dueDate, '2026-08-20');
  assert.equal(before.revisions.length, 0);

  desk.definitions.declare(SUNRISE_COMPANY, extendedGstr3b(25, 3));
  await desk.service.refresh(owner, WINDOW);
  const after = await entryFor(desk, 'GSTR3B:2026-07');

  assert.equal(after.key, before.key, 'the same obligation, not a second one');
  assert.equal(after.dueDate, '2026-08-25');
  assert.equal(after.version, 3);
  assert.equal(after.revisions.length, 1);
  assert.equal(after.revisions[0]?.previousDueDate, '2026-08-20');
  assert.equal(after.revisions[0]?.dueDate, '2026-08-25');
  assert.equal(after.revisions[0]?.sourceRef, 'portal:extension-notice');
  assert.equal(desk.occurrences.all().filter((row) => row.key === 'GSTR3B:2026-07').length, 1);
  assert.ok(desk.audit.events.some((event) => event.action === 'compliance.calendar.deadline_revised'));
});

test('an extension starts the ladder again, so the new deadline is warned about too', async () => {
  const desk = makeDesk({ withSignals: false });
  const owner = ownerOf();
  const first = await desk.service.run(owner, WINDOW);
  assert.equal(first.raised.find((alert) => alert.occurrenceKey === 'GSTR3B:2026-07')?.level, 'DUE_SOON');

  desk.definitions.declare(SUNRISE_COMPANY, extendedGstr3b(25, 3));
  const quiet = await desk.service.run(owner, WINDOW);
  assert.equal(
    quiet.raised.filter((alert) => alert.occurrenceKey === 'GSTR3B:2026-07').length,
    0,
    'three more weeks is not something to warn about on the day it is granted',
  );

  const later = makeDeskAt(desk, '2026-08-19T04:30:00.000Z');
  const again = (await later.run(owner, WINDOW)).raised.find((alert) => alert.occurrenceKey === 'GSTR3B:2026-07');
  assert.ok(again !== undefined, 'the moved deadline must be warned about on its own terms');
  assert.equal(again.dueDate, '2026-08-25');
  assert.equal(again.level, 'EARLY');

  const history = await desk.service.history(owner, 'GSTR3B:2026-07');
  assert.equal(history.alerts.length, 2);
  assert.deepEqual(history.alerts.map((alert) => alert.dueDate), ['2026-08-20', '2026-08-25']);
});

test('a deadline that moves after the return was filed does not rewrite what was filed', async () => {
  const desk = makeDesk({ withSignals: false });
  const owner = ownerOf();
  await desk.service.refresh(owner, WINDOW);
  await desk.service.complete(owner, {
    key: 'GSTR3B:2026-07',
    evidence: { kind: 'ARN', reference: 'AA2908260012345', filedOn: isoDate('2026-08-16'), note: '' },
  });

  desk.definitions.declare(SUNRISE_COMPANY, extendedGstr3b(25, 3));
  await desk.service.refresh(owner, WINDOW);

  const after = await entryFor(desk, 'GSTR3B:2026-07');
  assert.equal(after.status, 'COMPLETED');
  assert.equal(after.dueDate, '2026-08-20', 'a completed obligation keeps the deadline it actually had');
  assert.equal(after.version, 1);
  assert.equal(after.revisions.length, 0);
});

test('a new version with the same date is recorded without disturbing the ladder', async () => {
  const desk = makeDesk({ withSignals: false });
  const owner = ownerOf();
  await desk.service.run(owner, WINDOW);
  desk.definitions.declare(SUNRISE_COMPANY, extendedGstr3b(20, 4));
  await desk.service.refresh(owner, WINDOW);
  const after = await entryFor(desk, 'GSTR3B:2026-07');
  assert.equal(after.version, 4);
  assert.equal(after.revisions.length, 0);
  assert.equal(after.highestAlertLevel, 'DUE_SOON');
});

// ------------------------------------------------------------------- completion

test('a completed obligation stops escalating, at every level, for good', async () => {
  const desk = makeDesk({ withSignals: false });
  const owner = ownerOf();
  await desk.service.run(owner, WINDOW);
  await desk.service.complete(owner, {
    key: 'GSTR3B:2026-07',
    evidence: { kind: 'ARN', reference: 'AA2908260012345', filedOn: isoDate('2026-08-18'), note: '' },
  });

  const later = makeDeskAt(desk, '2026-09-30T04:30:00.000Z');
  const run = await later.run(owner, WINDOW);
  assert.equal(run.raised.filter((alert) => alert.occurrenceKey === 'GSTR3B:2026-07').length, 0);
  const occurrence = await entryFor(desk, 'GSTR3B:2026-07');
  assert.equal(occurrence.status, 'COMPLETED');
});

test('completion requires evidence somebody can check', () => {
  assert.throws(
    () => validateEvidence({ kind: 'ARN', reference: '', filedOn: isoDate('2026-08-18'), note: '' }),
    (error: unknown) => error instanceof DomainError && error.code === 'COMPLIANCE_EVIDENCE_REFERENCE_REQUIRED',
  );
  assert.throws(
    () => validateEvidence({ kind: 'TYPED_CONFIRMATION', reference: '', filedOn: isoDate('2026-08-18'), note: 'done' }),
    (error: unknown) => error instanceof DomainError && error.code === 'COMPLIANCE_EVIDENCE_NOTE_REQUIRED',
  );
});

test('a filing done on somebody else’s laptop is recorded by hand, and counts', async () => {
  const desk = makeDesk({ withSignals: false });
  const owner = ownerOf();
  const occurrence = await desk.service.complete(owner, {
    key: 'GSTR1:2026-07',
    evidence: {
      kind: 'TYPED_CONFIRMATION',
      reference: '',
      filedOn: isoDate('2026-08-10'),
      note: 'Filed by Meena on the portal; she read the acknowledgement out over the phone.',
    },
  });
  assert.equal(occurrence.status, 'COMPLETED');
  const run = await desk.service.run(owner, WINDOW);
  assert.equal(run.raised.filter((alert) => alert.occurrenceKey === 'GSTR1:2026-07').length, 0);
});

test('marking the same thing done twice is idempotent, and a different answer is a conflict', async () => {
  const desk = makeDesk({ withSignals: false });
  const owner = ownerOf();
  const evidence = { kind: 'ARN' as const, reference: 'AA2908260012345', filedOn: isoDate('2026-08-18'), note: '' };
  const first = await desk.service.complete(owner, { key: 'GSTR3B:2026-07', evidence });
  const again = await desk.service.complete(owner, { key: 'GSTR3B:2026-07', evidence });
  assert.equal(again.completion?.completedAt, first.completion?.completedAt);
  await assert.rejects(
    desk.service.complete(owner, { key: 'GSTR3B:2026-07', evidence: { ...evidence, reference: 'AA2908260099999' } }),
    (error: unknown) => error instanceof DomainError && error.code === 'COMPLIANCE_ALREADY_COMPLETED',
  );
});

test('an obligation another module reports done stops escalating too', async () => {
  const desk = makeDesk({ at: '2026-08-17T04:30:00.000Z', withSignals: false });
  desk.events.set(SUNRISE_COMPANY, [
    {
      code: 'IRN_REPORTING',
      key: 'SI-1042',
      occurredOn: isoDate('2026-07-14'),
      label: bilingual('invoice SI-1042 dated 14 July 2026', 'invoice SI-1042, 14 July 2026'),
      affected: [{ kind: 'sales_invoice', id: 'SI-1042', label: 'Invoice SI-1042' }],
      resolved: true,
    },
  ]);
  const run = await desk.service.run(ownerOf(), WINDOW);
  assert.equal(run.raised.filter((alert) => alert.code === 'IRN_REPORTING').length, 0);
  const occurrence = await entryFor(desk, 'IRN_REPORTING:SI-1042');
  assert.equal(occurrence.status, 'COMPLETED');
  assert.equal(occurrence.completion?.evidence.kind, 'SOURCE_MODULE');
});

test('an unresolved event deadline is dated from the event and warned about', async () => {
  const desk = makeDesk({ at: '2026-08-17T04:30:00.000Z', withSignals: false });
  desk.events.set(SUNRISE_COMPANY, [
    {
      code: 'IRN_REPORTING',
      key: 'SI-1051',
      occurredOn: isoDate('2026-07-25'),
      label: bilingual('invoice SI-1051 dated 25 July 2026', 'invoice SI-1051, 25 July 2026'),
      affected: [{ kind: 'sales_invoice', id: 'SI-1051', label: 'Invoice SI-1051' }],
      resolved: false,
    },
  ]);
  const occurrence = await entryFor(desk, 'IRN_REPORTING:SI-1051');
  assert.equal(occurrence.dueDate, '2026-08-24', 'thirty days after the invoice date');
  const later = makeDeskAt(desk, '2026-08-20T04:30:00.000Z');
  const run = await later.run(ownerOf(), WINDOW);
  const alert = run.raised.find((candidate) => candidate.occurrenceKey === 'IRN_REPORTING:SI-1051');
  assert.ok(alert !== undefined, 'an invoice running out of time must be announced');
  assert.equal(alert.affected.length, 0, 'the event carries its record through the owning module');
  assert.equal(alert.dueDate, '2026-08-24');
});

// ------------------------------------------------------------------- snooze, escalate, access

test('a snooze silences the early reminders and never the overdue ones', async () => {
  const desk = makeDesk({ at: '2026-08-13T04:30:00.000Z', withSignals: false });
  const owner = ownerOf();
  await desk.service.refresh(owner, WINDOW);
  await desk.service.snooze(owner, 'GSTR3B:2026-07', isoDate('2026-08-19'), 'The accountant is away until the 19th.');
  const quiet = await desk.service.run(owner, WINDOW);
  assert.equal(quiet.raised.filter((alert) => alert.occurrenceKey === 'GSTR3B:2026-07').length, 0);
  assert.ok(quiet.snoozed.some((key) => key.includes('GSTR3B:2026-07')));

  const later = makeDeskAt(desk, '2026-08-24T04:30:00.000Z');
  const loud = await later.run(owner, WINDOW);
  const alert = loud.raised.find((candidate) => candidate.occurrenceKey === 'GSTR3B:2026-07');
  assert.ok(alert !== undefined, 'an overdue return is announced whatever anybody snoozed');
  assert.equal(alert.level, 'OVERDUE');
});

test('a reminder cannot be pushed past the deadline it is about', async () => {
  const desk = makeDesk({ withSignals: false });
  const owner = ownerOf();
  await desk.service.refresh(owner, WINDOW);
  await assert.rejects(
    desk.service.snooze(owner, 'GSTR3B:2026-07', isoDate('2026-08-21'), 'Busy this week.'),
    (error: unknown) => error instanceof DomainError && error.code === 'COMPLIANCE_SNOOZE_PAST_DUE_DATE',
  );
  await assert.rejects(
    desk.service.snooze(owner, 'GSTR3B:2026-07', isoDate('2026-08-19'), ''),
    (error: unknown) => error instanceof DomainError && error.code === 'COMPLIANCE_SNOOZE_REASON_REQUIRED',
  );
});

test('escalating by hand puts the deadline in front of the owner and records why', async () => {
  const desk = makeDesk({ withSignals: false });
  const owner = ownerOf();
  await desk.service.refresh(owner, WINDOW);
  const alert = await desk.service.escalate(owner, 'GSTR3B:2026-07', 'The tax money is not arranged yet.');
  assert.equal(alert.level, 'ESCALATED');
  assert.deepEqual(alert.audiences, ['OWNER']);
  assert.equal(alert.manualReason, 'The tax money is not arranged yet.');
  await assert.rejects(
    desk.service.escalate(owner, 'GSTR3B:2026-07', 'Again.'),
    (error: unknown) => error instanceof DomainError && error.code === 'COMPLIANCE_ALREADY_ESCALATED',
  );
});

test('reading the calendar is not permission to silence it', async () => {
  const desk = makeDesk({ withSignals: false });
  const viewer = actorWith(SUNRISE_COMPANY, CALENDAR_PERMISSIONS.view, CALENDAR_PERMISSIONS.refresh);
  await desk.service.refresh(viewer, WINDOW);
  await assert.rejects(
    desk.service.snooze(viewer, 'GSTR3B:2026-07', isoDate('2026-08-19'), 'Later.'),
    (error: unknown) => error instanceof DomainError && error.kind === 'FORBIDDEN',
  );
  await assert.rejects(
    desk.service.complete(viewer, { key: 'GSTR3B:2026-07', evidence: { kind: 'ARN', reference: 'AA2908260012345', filedOn: isoDate('2026-08-18'), note: '' } }),
    (error: unknown) => error instanceof DomainError && error.kind === 'FORBIDDEN',
  );
  await assert.rejects(
    desk.service.escalate(viewer, 'GSTR3B:2026-07', 'Please look.'),
    (error: unknown) => error instanceof DomainError && error.kind === 'FORBIDDEN',
  );
});

test('one company can never see or answer another company’s deadlines', async () => {
  const desk = makeDesk({ withSignals: false });
  await desk.service.refresh(ownerOf(SUNRISE_COMPANY), WINDOW);
  const otherCompany = asId<'Company'>('99999999-9999-4999-8999-999999999999') as unknown as CompanyId;
  const intruder = actorWith(otherCompany, ...Object.values(CALENDAR_PERMISSIONS));
  await assert.rejects(
    desk.service.history(intruder, 'GSTR3B:2026-07'),
    (error: unknown) => error instanceof DomainError && error.kind === 'NOT_FOUND',
  );
  const konkan = await desk.service.calendar(ownerOf(KONKAN_COMPANY), WINDOW);
  assert.ok(konkan.entries.every((entry) => entry.occurrence.companyId === KONKAN_COMPANY));
});

test('every material action is written down with the actor and the reason', async () => {
  const desk = makeDesk({ withSignals: false });
  const owner = ownerOf();
  await desk.service.refresh(owner, WINDOW);
  await desk.service.snooze(owner, 'GSTR1:2026-08', isoDate('2026-08-25'), 'Waiting on two bills.');
  await desk.service.complete(owner, {
    key: 'GSTR3B:2026-07',
    evidence: { kind: 'ARN', reference: 'AA2908260012345', filedOn: isoDate('2026-08-18'), note: '' },
  });
  const actions = desk.audit.events.map((event) => event.action);
  assert.ok(actions.includes('compliance.calendar.snoozed'));
  assert.ok(actions.includes('compliance.calendar.completed'));
  const snooze = desk.audit.events.find((event) => event.action === 'compliance.calendar.snoozed');
  assert.equal(snooze?.overrideReason, 'Waiting on two bills.');
  assert.equal(snooze?.actorId, OWNER_USER);
  const completed = desk.audit.events.find((event) => event.action === 'compliance.calendar.completed');
  assert.equal(completed?.details.reference, 'AA2908260012345');
  assert.equal(completed?.details.late, 'false');
});

/**
 * The same stores, a later day.
 *
 * Time is the one thing these tests cannot fake with a fixture, so a second service is built over
 * the first one's stores with a later clock. What survives — completions, snoozes, rungs already
 * rung — is exactly what should survive a night.
 */
const makeDeskAt = (desk: Desk, at: string): ComplianceCalendarService => {
  const profiles = new InMemoryProfiles();
  profiles.set(SUNRISE_PROFILE);
  profiles.set(KONKAN_PROFILE);
  profiles.set(COMPOSITION_PROFILE);
  const contacts = new InMemoryContacts();
  contacts.set(SUNRISE_COMPANY, 'OWNER', [{ recipientId: OWNER_USER }]);
  contacts.set(SUNRISE_COMPANY, 'ACCOUNTANT', [{ recipientId: ACCOUNTANT_USER }]);
  return new ComplianceCalendarService({
    definitions: desk.definitions,
    profiles,
    occurrences: desk.occurrences,
    alerts: desk.alertsStore,
    exceptions: new InMemoryComplianceExceptions(),
    audit: desk.audit,
    clock: fixedClock(at),
    holidays: desk.holidays,
    events: desk.events,
    contacts,
    transport: desk.transport,
  });
};
