/**
 * Issue #366 — one contract suite for the compliance calendar's stores, run on the in-memory ones
 * (calendar-store-contract.test.ts) and on PostgreSQL (calendar-store-contract.integration.test.ts).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixedClock, isoDate, money, type CompanyId, type IsoDate, type UserId } from '@invoice/kernel';
import { InMemoryAuditPort } from '@invoice/ledger';
import { CatalogueDefinitions, InMemoryProfiles, purchaseMismatchSignals } from '../src/adapters.ts';
import { SUNRISE_PROFILE, julyMismatches, ownerOf } from '../src/fixtures.ts';
import type { AlertRepository, ComplianceExceptionRepository, OccurrenceRepository } from '../src/ports.ts';
import { ComplianceCalendarService } from '../src/service.ts';
import { bilingual, type ComplianceAlert, type ComplianceException, type ObligationOccurrence } from '../src/types.ts';

export interface CalendarStoreHarness {
  readonly occurrences: OccurrenceRepository;
  readonly alerts: AlertRepository;
  readonly exceptions: ComplianceExceptionRepository;
  /** Runs a command: a unit of work on PostgreSQL, a plain call in memory. */
  write<T>(companyId: CompanyId, work: () => Promise<T>): Promise<T>;
  company(): Promise<CompanyId>;
  user(): Promise<UserId>;
}

const uuid = (): string => crypto.randomUUID();
const at = '2026-08-17T04:30:00.000Z';

export const occurrenceFor = (companyId: CompanyId, userId: UserId, month: string, over: Partial<ObligationOccurrence> = {}): ObligationOccurrence => ({
  id: uuid(), companyId, key: `GSTR3B:${month}`, code: 'GSTR3B', obligationKind: 'STATUTORY', title: bilingual('GSTR-3B', 'GSTR-3B'),
  version: 1, reviewState: 'DRAFT', sourceRef: null,
  period: { kind: 'MONTH', key: month, from: isoDate(`${month}-01`), to: isoDate(`${month}-28`) },
  dueDate: isoDate('2026-08-20'), actionableBy: isoDate('2026-08-20'), status: 'OPEN', notApplicableReason: null,
  snooze: { until: isoDate('2026-08-15'), reason: 'Accountant on leave', snoozedBy: userId, snoozedAt: at },
  completion: null, revisions: [], highestAlertLevel: null, createdAt: at, updatedAt: at, ...over,
});

const alertFor = (occurrence: ObligationOccurrence, userId: UserId, level: ComplianceAlert['level'], over: Partial<ComplianceAlert> = {}): ComplianceAlert => ({
  id: uuid(), companyId: occurrence.companyId, occurrenceKey: occurrence.key, code: occurrence.code, obligationKind: occurrence.obligationKind,
  version: 1, reviewState: 'DRAFT', sourceRef: 'Notification 12/2026-CT (synthetic)', level, audiences: ['ACCOUNTANT', 'OWNER'],
  dueDate: occurrence.dueDate, daysRemaining: -3, period: occurrence.period, headline: bilingual('Due', 'Due'), detail: bilingual('d', 'd'),
  nextAction: bilingual('File', 'File'), actionCode: 'OPEN_GSTR3B_WORKSPACE', consequence: bilingual('Interest', 'Interest'),
  signals: [{
    code: 'TAX_UNPAID', severity: 'WARNING', count: 1, headline: bilingual('h', 'h'), consequence: bilingual('c', 'c'), nextAction: bilingual('n', 'n'),
    actionCode: 'PAY', affected: [], amount: money(123456789012345678n), source: 'gst-returns',
  }],
  affected: [{ kind: 'purchase_bill', id: 'PB-1', label: 'PB-1', amount: money(-1n) }],
  deduplicationKey: `compliance:${occurrence.key}:${level}:${occurrence.dueDate}`, raisedAt: at, raisedBy: userId, ...over,
});

const exceptionFor = (companyId: CompanyId, periodKey: string): ComplianceException => ({
  companyId, code: 'GSTR1', periodKey,
  missing: [{ fact: 'gstFilingFrequency', question: bilingual('Monthly or quarterly?', 'Mahina ya timahi?') }],
  question: bilingual('We cannot tell yet.', 'Abhi pata nahin.'), raisedAt: at,
});

const ids = (rows: readonly { readonly id: string }[]): string[] => rows.map((row) => row.id).sort();

export function calendarStoreContract(label: string, harness: () => CalendarStoreHarness, skip: false | string = false): void {
  const setup = async () => {
    const h = harness();
    return { h, companyId: await h.company(), userId: await h.user() };
  };

  test(`${label}: an occurrence round-trips exactly, revisions append and the completion sticks`, { skip }, async () => {
    const { h, companyId, userId } = await setup();
    const event = occurrenceFor(companyId, userId, '2026-08', {
      key: 'IRN_REPORTING:SI-1:2026-08-03', code: 'IRN_REPORTING', obligationKind: 'POLICY', sourceRef: 'Notification 10/2023-CT (synthetic)',
      period: { kind: 'EVENT', key: 'SI-1:2026-08-03', from: isoDate('2026-08-03'), to: isoDate('2026-08-03'), label: bilingual('invoice SI-1', 'invoice SI-1') },
      snooze: null, notApplicableReason: bilingual('Exports only', 'Exports only'), highestAlertLevel: 'DUE_SOON',
    });
    await h.write(companyId, () => h.occurrences.put(event));
    assert.deepEqual(await h.occurrences.find(companyId, event.key), event);

    const plain = occurrenceFor(companyId, userId, '2026-07');
    await h.write(companyId, () => h.occurrences.put(plain));
    assert.deepEqual(await h.occurrences.find(companyId, plain.key), plain);

    const revision = { at: '2026-08-18T00:00:00.000Z', previousDueDate: isoDate('2026-08-20'), dueDate: isoDate('2026-08-25'), previousVersion: 1, version: 2, reason: bilingual('moved', 'moved'), sourceRef: null };
    const moved = { ...plain, dueDate: isoDate('2026-08-25'), version: 2, revisions: [revision], highestAlertLevel: null, updatedAt: revision.at };
    await h.write(companyId, () => h.occurrences.put(moved));
    await h.write(companyId, () => h.occurrences.put(moved)); // a repeat adds nothing
    const again = { ...moved, revisions: [revision, { ...revision, at: '2026-08-19T00:00:00.000Z', previousDueDate: isoDate('2026-08-25'), dueDate: isoDate('2026-08-27'), previousVersion: 2, version: 3 }], dueDate: isoDate('2026-08-27'), version: 3 };
    await h.write(companyId, () => h.occurrences.put(again));
    assert.deepEqual(await h.occurrences.find(companyId, plain.key), again);

    const completed: ObligationOccurrence = {
      ...again, status: 'COMPLETED', snooze: null,
      completion: { evidence: { kind: 'ARN', reference: 'AA2907261234567', filedOn: isoDate('2026-08-19'), note: '' }, completedBy: userId, completedAt: '2026-08-19T10:00:00.000Z' },
    };
    await h.write(companyId, () => h.occurrences.put(completed));
    assert.deepEqual(await h.occurrences.find(companyId, plain.key), completed);
  });

  test(`${label}: an unknown occurrence is not found, and another company sees nothing`, { skip }, async () => {
    const { h, companyId, userId } = await setup();
    const other = await h.company();
    const occurrence = occurrenceFor(companyId, userId, '2026-07');
    await h.write(companyId, () => h.occurrences.put(occurrence));
    assert.equal(await h.occurrences.find(companyId, 'GSTR3B:1999-01'), null);
    assert.equal(await h.occurrences.find(other, occurrence.key), null);
    assert.deepEqual(await h.occurrences.list(other, isoDate('2000-01-01'), isoDate('2100-01-01')), []);
    assert.deepEqual(await h.alerts.listForCompany(other), []);
    assert.deepEqual(await h.exceptions.list(other), []);
  });

  test(`${label}: the window is judged on the period, and pages return every occurrence exactly once`, { skip }, async () => {
    const { h, companyId, userId } = await setup();
    const months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'];
    const rows = months.map((month) => occurrenceFor(companyId, userId, month));
    for (const row of rows) await h.write(companyId, () => h.occurrences.put(row));
    const window = await h.occurrences.list(companyId, isoDate('2026-02-15') as IsoDate, isoDate('2026-04-01'));
    assert.deepEqual(window.map((row) => row.period.key).sort(), ['2026-02', '2026-03', '2026-04']);
    const seen: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await h.occurrences.list(companyId, isoDate('2000-01-01'), isoDate('2100-01-01'), { limit: 2, ...(after === undefined ? {} : { after }) });
      if (page.length === 0) break;
      assert.ok(page.length <= 2);
      seen.push(...page.map((row) => row.id));
      after = page[page.length - 1]?.id;
    }
    assert.deepEqual(seen, ids(rows), 'in id order, each once');
    await assert.rejects(h.occurrences.list(companyId, isoDate('2026-01-01'), isoDate('2026-12-31'), { limit: 0 }), { code: 'COMPLIANCE_PAGE_INVALID' });
  });

  test(`${label}: alerts are append-only, deduplicated, keep paise exactly and page once each`, { skip }, async () => {
    const { h, companyId, userId } = await setup();
    const occurrence = occurrenceFor(companyId, userId, '2026-07');
    await h.write(companyId, () => h.occurrences.put(occurrence));
    const early = alertFor(occurrence, userId, 'EARLY');
    const manual = alertFor(occurrence, userId, 'ESCALATED', { manualReason: 'Owner must see this', raisedAt: '2026-08-17T05:00:00.000Z' });
    await h.write(companyId, async () => { await h.alerts.insert(early); await h.alerts.insert(manual); });
    await h.write(companyId, () => h.alerts.insert({ ...early, id: uuid() })); // the same rung again
    assert.deepEqual(await h.alerts.listForCompany(companyId), [early, manual]);
    assert.deepEqual(await h.alerts.raisedKeys(companyId, occurrence.key), new Set([early.deduplicationKey, manual.deduplicationKey]));
    assert.deepEqual(await h.alerts.raisedKeys(companyId, 'GSTR1:2026-07'), new Set());

    const more = (['DUE_SOON', 'DUE_TODAY', 'OVERDUE'] as const).map((level) => alertFor(occurrence, userId, level));
    for (const alert of more) await h.write(companyId, () => h.alerts.insert(alert));
    const first = await h.alerts.listForCompany(companyId, { limit: 3 });
    const rest = await h.alerts.listForCompany(companyId, { limit: 3, after: first[2]?.id ?? '' });
    assert.deepEqual([...first, ...rest].map((row) => row.id), ids([early, manual, ...more]));
    assert.deepEqual(await h.alerts.listForCompany(companyId, { limit: 3, after: rest[rest.length - 1]?.id ?? '' }), []);
  });

  test(`${label}: an exception is replaced, cleared and raised again, and pages once each`, { skip }, async () => {
    const { h, companyId } = await setup();
    const july = exceptionFor(companyId, '2026-07');
    await h.write(companyId, () => h.exceptions.put(july));
    const july2 = { ...july, raisedAt: '2026-08-18T04:30:00.000Z' };
    await h.write(companyId, () => h.exceptions.put(july2));
    assert.deepEqual(await h.exceptions.list(companyId), [july2]);
    await h.write(companyId, () => h.exceptions.clear(companyId, 'GSTR1', '2026-07'));
    assert.deepEqual(await h.exceptions.list(companyId), []);
    await h.write(companyId, () => h.exceptions.put(july));
    assert.deepEqual(await h.exceptions.list(companyId), [july]);

    for (const key of ['2026-08', '2026-09', '2026-10']) await h.write(companyId, () => h.exceptions.put(exceptionFor(companyId, key)));
    const first = await h.exceptions.list(companyId, { limit: 3 });
    const rest = await h.exceptions.list(companyId, { limit: 3, after: 'GSTR1:2026-09' });
    assert.deepEqual(first.map((row) => row.periodKey), ['2026-07', '2026-08', '2026-09']);
    assert.deepEqual(rest.map((row) => row.periodKey), ['2026-10']);
  });

  test(`${label}: the calendar service runs on these stores — warns once, and a completed return goes quiet`, { skip }, async () => {
    const { h, companyId, userId } = await setup();
    const profiles = new InMemoryProfiles();
    profiles.set({ ...SUNRISE_PROFILE, companyId });
    const service = new ComplianceCalendarService({
      definitions: new CatalogueDefinitions(), profiles, occurrences: h.occurrences, alerts: h.alerts, exceptions: h.exceptions,
      audit: new InMemoryAuditPort(), clock: fixedClock('2026-08-17T04:30:00.000Z'), signals: [purchaseMismatchSignals(julyMismatches)],
    });
    const actor = { ...ownerOf(companyId), userId };
    const first = await h.write(companyId, () => service.run(actor));
    assert.ok(first.raised.length > 0);
    const gstr3b = first.raised.find((alert) => alert.occurrenceKey === 'GSTR3B:2026-07');
    assert.ok(gstr3b !== undefined && gstr3b.signals.some((signal) => typeof signal.amount?.minor === 'bigint'));
    const second = await h.write(companyId, () => service.run(actor));
    assert.equal(second.raised.length, 0, 'a repeated run raises nothing');

    await h.write(companyId, () => service.complete(actor, { key: 'GSTR3B:2026-07', evidence: { kind: 'ARN', reference: 'AA2907261234567', filedOn: isoDate('2026-08-17'), note: '' } }));
    const history = await service.history(actor, 'GSTR3B:2026-07');
    assert.equal(history.occurrence.status, 'COMPLETED');
    assert.equal(history.occurrence.completion?.evidence.reference, 'AA2907261234567');
    assert.deepEqual(history.alerts, (await h.alerts.listForCompany(companyId)).filter((alert) => alert.occurrenceKey === 'GSTR3B:2026-07'));
  });
}
