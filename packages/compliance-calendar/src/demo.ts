/**
 * Issue #32 [E32] — a filing season at one shop, warned about before it goes wrong.
 *
 *   npm run demo:calendar
 *
 * It is the morning of 17 August 2026 at Sunrise Hardware in Bengaluru. July's summary return is
 * due on the 20th, three purchase bills still do not match what the suppliers told the government,
 * and two invoices have never reached the e-invoice portal. Nobody in the shop is thinking about
 * any of that, which is the entire reason this module exists.
 *
 * Everything below runs the real rules, the real ladder and the real audit trail. There is no
 * network, no portal and no credential: the unresolved work is read through the same narrow
 * interfaces the live modules implement.
 */
import { fixedClock } from '@invoice/kernel';
import { InMemoryAuditPort } from '@invoice/ledger';
import {
  CatalogueDefinitions,
  InMemoryAlerts,
  InMemoryComplianceExceptions,
  InMemoryContacts,
  InMemoryOccurrences,
  InMemoryProfiles,
  RecordingAlertTransport,
  SuppliedHolidays,
  eInvoiceBacklogSignals,
  purchaseMismatchSignals,
  returnReadinessSignals,
} from './adapters.ts';
import {
  ACCOUNTANT_USER,
  KARNATAKA_HOLIDAYS_2026,
  KONKAN_COMPANY,
  KONKAN_PROFILE,
  OWNER_USER,
  SUNRISE_COMPANY,
  SUNRISE_PROFILE,
  julyEInvoiceBacklog,
  julyMismatches,
  julyReturnReadiness,
  ownerOf,
} from './fixtures.ts';
import { ComplianceCalendarService } from './service.ts';
import { describePeriod } from './schedule.ts';
import { isoDate } from '@invoice/kernel';

const heading = (text: string): void => console.log(`\n${text}\n${'─'.repeat(text.length)}`);

const clock = fixedClock('2026-08-17T04:30:00.000Z'); // 10:00 in Bengaluru.
const profiles = new InMemoryProfiles();
profiles.set(SUNRISE_PROFILE);
profiles.set(KONKAN_PROFILE);
const holidays = new SuppliedHolidays();
holidays.add(SUNRISE_COMPANY, ...KARNATAKA_HOLIDAYS_2026);
const contacts = new InMemoryContacts();
contacts.set(SUNRISE_COMPANY, 'OWNER', [{ recipientId: OWNER_USER, locale: 'en-IN' }]);
contacts.set(SUNRISE_COMPANY, 'ACCOUNTANT', [{ recipientId: ACCOUNTANT_USER, locale: 'en-IN' }]);
const transport = new RecordingAlertTransport();
const audit = new InMemoryAuditPort();

const service = new ComplianceCalendarService({
  definitions: new CatalogueDefinitions(),
  profiles,
  occurrences: new InMemoryOccurrences(),
  alerts: new InMemoryAlerts(),
  exceptions: new InMemoryComplianceExceptions(),
  audit,
  clock,
  holidays,
  contacts,
  transport,
  signals: [
    purchaseMismatchSignals(julyMismatches),
    returnReadinessSignals(julyReturnReadiness),
    eInvoiceBacklogSignals(julyEInvoiceBacklog),
  ],
});

const owner = ownerOf(SUNRISE_COMPANY);
const window = { from: isoDate('2026-07-01'), to: isoDate('2026-09-30') };

heading('What is coming up at Sunrise Hardware');
const view = await service.calendar(owner, window);
console.log(`Today is ${view.today}.\n`);
for (const entry of view.entries) {
  const days = entry.daysRemaining;
  const when = days === 0 ? 'today' : days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
  console.log(`${entry.occurrence.dueDate}  ${entry.state.padEnd(10)} ${entry.occurrence.title['en-IN']} — ${describePeriod(entry.occurrence.period)['en-IN']} (${when})`);
  for (const signal of entry.signals) console.log(`             ↳ ${signal.headline['en-IN']}`);
}

heading('The morning sweep');
const run = await service.run(owner, window);
for (const alert of run.raised) {
  console.log(`[${alert.level}] ${alert.headline['en-IN']}`);
  console.log(`   ${alert.detail['en-IN']}`);
  console.log(`   Do this next: ${alert.nextAction['en-IN']}`);
  if (alert.affected.length > 0) {
    console.log(`   Affected: ${alert.affected.map((record) => record.label).join('; ')}`);
  }
  console.log(`   Rule ${alert.code} v${alert.version}, source ${alert.sourceRef ?? 'not linked yet'}, due ${alert.dueDate}`);
}

heading('Running it again five minutes later');
const second = await service.run(owner, window);
console.log(`Alerts raised the second time: ${second.raised.length}`);
console.log(`Rungs already rung, so left alone: ${second.alreadyRaised.length}`);

heading('The owner files the return and records the acknowledgement');
const filed = await service.complete(owner, {
  key: 'GSTR3B:2026-07',
  evidence: { kind: 'ARN', reference: 'AA2908260012345', filedOn: isoDate('2026-08-19'), note: '' },
});
console.log(`${filed.title['en-IN']} is now ${filed.status}, filed on ${filed.completion?.evidence.filedOn}.`);
const afterFiling = await service.run(owner, window);
console.log(`Alerts about it after filing: ${afterFiling.raised.filter((alert) => alert.occurrenceKey === 'GSTR3B:2026-07').length}`);

heading('The shop next door, whose filing frequency nobody recorded');
const konkan = await service.calendar(ownerOf(KONKAN_COMPANY), window);
console.log(`Deadlines shown: ${konkan.entries.filter((entry) => entry.occurrence.code === 'GSTR3B').length}`);
for (const exception of konkan.exceptions.slice(0, 1)) {
  console.log(`Question waiting: ${exception.question['en-IN']}`);
}

heading('What was written down');
for (const entry of audit.events.slice(0, 6)) console.log(`${entry.action} — ${entry.summary}`);
console.log(`\n${audit.events.length} audit entries in total; ${transport.sent.length} messages sent.`);
