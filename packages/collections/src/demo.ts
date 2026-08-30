/**
 * Issue #23 [E23] — five customers, five reasons, on a terminal with no database.
 *
 *   npm run demo:reminders
 *
 * The ledger, the receivables service and the notification service are real. The one payment in
 * this story is a real posted receipt, which is why the reminder for that bill disappears.
 */
import { formatINR } from '@invoice/kernel';
import type { ReminderCandidate, ReminderPlan } from './model.ts';
import { CUSTOMERS, day, invoice, makeDemoDesk, rupee } from './demo-fixtures.ts';

const [abc, mapusa, deccan, konkan, sunrise] = CUSTOMERS.map((c) => c.partyId) as [
  (typeof CUSTOMERS)[number]['partyId'],
  (typeof CUSTOMERS)[number]['partyId'],
  (typeof CUSTOMERS)[number]['partyId'],
  (typeof CUSTOMERS)[number]['partyId'],
  (typeof CUSTOMERS)[number]['partyId'],
];

const heading = (text: string): void => console.log(`\n${text}\n${'─'.repeat(text.length)}`);

const line = (candidate: ReminderCandidate): void => {
  const mark = candidate.decision === 'SEND' ? '→' : candidate.decision === 'ESCALATE' ? '!' : '·';
  const what = candidate.decision === 'SKIP' ? (candidate.reason as string) : `${candidate.decision} ${candidate.level ?? ''}`;
  console.log(
    `  ${mark} ${candidate.partyName.padEnd(22)} ${candidate.snapshot.documentNumber.padEnd(15)} ` +
      `${formatINR(candidate.snapshot.outstanding).padStart(12)}  ${String(candidate.snapshot.daysOverdue).padStart(4)}d  ${what}`,
  );
  console.log(`      ${candidate.explanation['en-IN']}`);
};

const show = (plan: ReminderPlan): void => {
  console.log(`  ${plan.summary['en-IN']}\n`);
  for (const candidate of plan.candidates) line(candidate);
};

const desk = await makeDemoDesk();

desk.documents.set([
  invoice('INV/2026/0041', abc, rupee(50_000), '2026-07-20', '2026-08-19'),
  invoice('INV/2026/0042', mapusa, rupee(8_400), '2026-07-15', '2026-08-14'),
  invoice('INV/2026/0043', deccan, rupee(75_000), '2026-07-05', '2026-08-04'),
  invoice('INV/2026/0044', konkan, rupee(22_000), '2026-06-20', '2026-07-20'),
  invoice('INV/2026/0045', sunrise, rupee(900_000), '2026-07-18', '2026-08-17'),
]);

heading('1. What would go out today, and what would not — nothing has been sent yet');
show(await desk.collections.plan(desk.actor, day('2026-08-29')));

heading('2. Mapusa paid this morning. The receipt is posted to the ledger, so the chase stops.');
await desk.receivables.recordPayment(desk.actor, {
  idempotencyKey: 'demo-receipt-mapusa',
  direction: 'RECEIPT',
  partyId: mapusa,
  mode: 'UPI',
  amount: rupee(8_400),
  date: day('2026-08-29'),
  reference: 'UPI/429911',
  bankAccountCode: '1121',
  allocations: [{ documentId: 'INV/2026/0042', documentNumber: 'INV/2026/0042', amount: rupee(8_400) }],
});
console.log('  Receipt posted. Nothing about the reminder was told to stop; it reads the books.\n');

heading('3. Deccan says two crates never arrived, and Konkan promised Tuesday');
await desk.collections.raiseDispute(desk.actor, {
  partyId: deccan, documentId: 'INV/2026/0043', reason: 'They say two crates never arrived.',
});
await desk.collections.recordPromise(desk.actor, {
  partyId: konkan, documentId: 'INV/2026/0044', amount: rupee(22_000), promisedOn: day('2026-09-02'),
  note: 'Owner said the cheque goes out on Tuesday.',
});
show(await desk.collections.plan(desk.actor, day('2026-08-29')));

heading('4. Sending what was agreed — including the one the provider drops');
desk.provider.failNext = true;
for (const reminder of await desk.collections.sendPlanned(desk.actor, day('2026-08-29'))) {
  console.log(
    `  ${reminder.state.padEnd(10)} ${reminder.audience.padEnd(8)} ${reminder.channel.padEnd(9)} ` +
      `${reminder.snapshot.documentNumber}  ${reminder.failureReason ?? ''}`,
  );
  console.log(`      "${reminder.message['en-IN']}"`);
}

heading('5. The failed one, tried again. One message, not two.');
const failed = (await desk.collections.history(desk.actor)).find((r) => r.state === 'FAILED');
if (failed !== undefined) {
  const retried = await desk.collections.retry(desk.actor, failed.id, day('2026-08-29'));
  console.log(`  ${retried.state} — same reminder ${retried.id === failed.id ? '(same record)' : '(NEW RECORD — wrong)'}`);
}
console.log(`  Messages the provider actually accepted: ${desk.provider.sent.length}`);

heading('6. Asked to send the same reminder again');
const again = await desk.collections.send(desk.actor, { documentId: 'INV/2026/0041', today: day('2026-08-29') });
console.log(`  Returned the message from ${again.snapshot.asOf} instead of writing a second one.`);
console.log(`  Messages the provider accepted: still ${desk.provider.sent.length}`);

heading('7. Tuesday came and went. Konkan hears one rung firmer, and nobody was accused.');
desk.setNow('2026-09-06T10:00:00.000Z');
const later = await desk.collections.plan(desk.actor, day('2026-09-06'));
for (const candidate of later.candidates.filter((c) => c.partyId === konkan)) line(candidate);
for (const view of await desk.collections.promises(desk.actor, day('2026-09-06'))) {
  console.log(`  Promise: ${view.outcome} — ${view.explanation['en-IN']}`);
}

heading('8. What the owner can read back');
for (const reminder of await desk.collections.history(desk.actor)) {
  console.log(
    `  ${reminder.snapshot.asOf}  ${reminder.state.padEnd(10)} ${reminder.level.padEnd(9)} ` +
      `${reminder.snapshot.documentNumber.padEnd(15)} ${formatINR(reminder.snapshot.outstanding).padStart(12)} via ${reminder.channel}`,
  );
}
console.log('');
