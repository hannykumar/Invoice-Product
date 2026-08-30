/**
 * Issue #23 [E23] — the tests that matter.
 *
 * Every one of these runs against the real receivables service, the real ledger beneath it and
 * GPT 2's real notification service. When a bill is paid in a test, the payment is posted; the
 * reminder stops because the books say it is settled, not because a test double said so.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { asId, type CompanyId } from '@invoice/kernel';
import { DomainError } from '@invoice/kernel';
import { ABC, bill, inr, makeCollectionsDesk, on } from './fixtures.ts';
import { DEFAULT_REMINDER_POLICY, reminderKeyOf, safeReminder, reminderMessage, stepFor } from '../src/index.ts';

const OTHER: CompanyId = asId<'Company'>('rec-other');

/** One bill, ten days past its due date. The ordinary case everything else varies from. */
const lateDesk = async (options: Parameters<typeof makeCollectionsDesk>[0] = {}) => {
  const desk = await makeCollectionsDesk(options);
  desk.documents.set([bill('INV/2026/0041', inr(50_000), '2026-07-20', '2026-08-19')]);
  return desk;
};

const candidateFor = (plan: { candidates: readonly { documentId: string }[] }, documentId: string) =>
  plan.candidates.find((c) => c.documentId === documentId) as (typeof plan.candidates)[number] & Record<string, unknown>;

describe('planning who gets reminded', () => {
  it('proposes the rung the bill has actually reached, and says what it would say', async () => {
    const desk = await lateDesk();
    const plan = await desk.collections.plan(desk.actor, on('2026-08-29'));

    assert.equal(plan.toSend, 1);
    const candidate = candidateFor(plan, 'INV/2026/0041');
    assert.equal(candidate.decision, 'SEND');
    assert.equal((candidate.step as { code: string }).code, 'WEEK_LATE');
    assert.equal(candidate.level, 'GENTLE');
    assert.equal(candidate.channel, 'whatsapp');
    assert.match(String((candidate.explanation as Record<string, string>)['en-IN']), /INV\/2026\/0041/);
    assert.match(String((candidate.explanation as Record<string, string>)['en-IN']), /₹50,000\.00/);
    // The snapshot is the bill as it stands now, not a number carried from anywhere.
    assert.equal((candidate.snapshot as { outstanding: { minor: bigint } }).outstanding.minor, 5_000_000n);
    assert.equal((candidate.snapshot as { daysOverdue: number }).daysOverdue, 10);
  });

  it('leaves a bill that is not due yet alone, and explains that in words', async () => {
    const desk = await makeCollectionsDesk();
    desk.documents.set([bill('INV/2026/0050', inr(9_000), '2026-08-25', '2026-09-25')]);

    const plan = await desk.collections.plan(desk.actor, on('2026-08-29'));
    const candidate = candidateFor(plan, 'INV/2026/0050');
    assert.equal(candidate.decision, 'SKIP');
    assert.equal(candidate.reason, 'NOT_YET_DUE');
    assert.match(String((candidate.explanation as Record<string, string>)['hi-IN']), /samay abhi nahi aaya/);
  });

  it('sends the advance note three days before the due date, and no earlier', async () => {
    const desk = await makeCollectionsDesk();
    desk.documents.set([bill('INV/2026/0051', inr(9_000), '2026-08-01', '2026-09-01')]);

    const early = await desk.collections.plan(desk.actor, on('2026-08-27'));
    assert.equal(candidateFor(early, 'INV/2026/0051').reason, 'NOT_YET_DUE');

    const due = await desk.collections.plan(desk.actor, on('2026-08-29'));
    const candidate = candidateFor(due, 'INV/2026/0051');
    assert.equal(candidate.decision, 'SEND');
    assert.equal(candidate.level, 'ADVANCE');
  });

  it('chases the oldest bill first and lets the rest wait their turn', async () => {
    const desk = await lateDesk();
    desk.documents.set([
      bill('INV/2026/0041', inr(50_000), '2026-07-20', '2026-08-19'),
      bill('INV/2026/0042', inr(12_000), '2026-06-01', '2026-07-01'),
    ]);

    const plan = await desk.collections.plan(desk.actor, on('2026-08-29'));
    assert.equal(plan.toSend, 1);
    assert.equal(candidateFor(plan, 'INV/2026/0042').decision, 'SEND');
    assert.equal(candidateFor(plan, 'INV/2026/0041').reason, 'TOO_SOON');
  });

  it('does not chase an amount too small to be worth a message', async () => {
    const desk = await makeCollectionsDesk();
    desk.documents.set([bill('INV/2026/0060', inr(40), '2026-07-01', '2026-07-31')]);

    const plan = await desk.collections.plan(desk.actor, on('2026-08-29'));
    assert.equal(candidateFor(plan, 'INV/2026/0060').reason, 'BELOW_MINIMUM');
  });
});

describe('a bill that has been paid', () => {
  it('stops being chased the moment the money is applied to it', async () => {
    const desk = await lateDesk();
    // A real receipt, posted to the real ledger, allocated to the bill.
    await desk.receivables.recordPayment(desk.actor, {
      idempotencyKey: 'receipt-1',
      direction: 'RECEIPT',
      partyId: ABC,
      mode: 'BANK_TRANSFER',
      amount: inr(50_000),
      date: on('2026-08-28'),
      bankAccountCode: '1121',
      allocations: [{ documentId: 'INV/2026/0041', documentNumber: 'INV/2026/0041', amount: inr(50_000) }],
    });

    const plan = await desk.collections.plan(desk.actor, on('2026-08-29'));
    assert.equal(plan.toSend, 0);
    assert.equal(candidateFor(plan, 'INV/2026/0041').reason, 'SETTLED');

    await assert.rejects(
      () => desk.collections.send(desk.actor, { documentId: 'INV/2026/0041', today: on('2026-08-29') }),
      (error: unknown) => error instanceof DomainError && error.code === 'REMINDER_NOT_APPLICABLE',
    );
    assert.equal(desk.provider.sent.length, 0);
  });

  it('refuses to send even when the payment lands between the preview and the send', async () => {
    const desk = await lateDesk();
    const plan = await desk.collections.plan(desk.actor, on('2026-08-29'));
    assert.equal(plan.toSend, 1);

    await desk.receivables.recordPayment(desk.actor, {
      idempotencyKey: 'receipt-race',
      direction: 'RECEIPT',
      partyId: ABC,
      mode: 'UPI',
      amount: inr(50_000),
      date: on('2026-08-29'),
      bankAccountCode: '1121',
      allocations: [{ documentId: 'INV/2026/0041', documentNumber: 'INV/2026/0041', amount: inr(50_000) }],
    });

    await assert.rejects(
      () => desk.collections.send(desk.actor, { documentId: 'INV/2026/0041', today: on('2026-08-29') }),
      (error: unknown) => error instanceof DomainError && error.details.reason === 'SETTLED',
    );
  });

  it('chases only what is left after a part payment, and says the smaller amount', async () => {
    const desk = await lateDesk();
    await desk.receivables.recordPayment(desk.actor, {
      idempotencyKey: 'receipt-half',
      direction: 'RECEIPT',
      partyId: ABC,
      mode: 'CASH',
      amount: inr(20_000),
      date: on('2026-08-28'),
      allocations: [{ documentId: 'INV/2026/0041', documentNumber: 'INV/2026/0041', amount: inr(20_000) }],
    });

    const reminder = await desk.collections.send(desk.actor, { documentId: 'INV/2026/0041', today: on('2026-08-29') });
    assert.equal(reminder.state, 'SENT');
    assert.equal(reminder.snapshot.outstanding.minor, 3_000_000n);
    assert.match(reminder.message['en-IN'], /₹30,000\.00/);
    assert.doesNotMatch(reminder.message['en-IN'], /50,000/);
  });
});

describe('never twice', () => {
  it('returns the same reminder rather than sending a second message', async () => {
    const desk = await lateDesk();
    const first = await desk.collections.send(desk.actor, { documentId: 'INV/2026/0041', today: on('2026-08-29') });
    const second = await desk.collections.send(desk.actor, { documentId: 'INV/2026/0041', today: on('2026-08-29') });

    assert.equal(second.id, first.id);
    assert.equal(desk.provider.sent.length, 1);
    assert.equal(first.reminderKey, reminderKeyOf('INV/2026/0041', 'WEEK_LATE'));
  });

  it('shows the rung as already sent on the next day rather than repeating it', async () => {
    const desk = await lateDesk();
    await desk.collections.send(desk.actor, { documentId: 'INV/2026/0041', today: on('2026-08-29') });

    const plan = await desk.collections.plan(desk.actor, on('2026-08-30'));
    const candidate = candidateFor(plan, 'INV/2026/0041');
    assert.equal(candidate.reason, 'ALREADY_SENT');
    assert.match(String((candidate.explanation as Record<string, string>)['en-IN']), /29 August 2026/);
  });

  it('sends the next rung when the bill ages into it', async () => {
    const desk = await lateDesk();
    await desk.collections.send(desk.actor, { documentId: 'INV/2026/0041', today: on('2026-08-29') });

    desk.setNow('2026-09-05T10:00:00.000Z');
    const later = await desk.collections.plan(desk.actor, on('2026-09-05'));
    const candidate = candidateFor(later, 'INV/2026/0041');
    assert.equal(candidate.decision, 'SEND');
    assert.equal((candidate.step as { code: string }).code, 'FORTNIGHT_LATE');
    assert.equal(candidate.level, 'FIRM');
  });
});

describe('what the customer has told us', () => {
  it('does not chase a disputed bill, and chases it again once the dispute is closed', async () => {
    const desk = await lateDesk();
    const dispute = await desk.collections.raiseDispute(desk.actor, {
      partyId: ABC,
      documentId: 'INV/2026/0041',
      reason: 'They say two crates never arrived.',
    });

    const held = await desk.collections.plan(desk.actor, on('2026-08-29'));
    assert.equal(candidateFor(held, 'INV/2026/0041').reason, 'DISPUTED');
    await assert.rejects(
      () => desk.collections.send(desk.actor, { documentId: 'INV/2026/0041', today: on('2026-08-29') }),
      (error: unknown) => error instanceof DomainError && error.details.reason === 'DISPUTED',
    );

    await desk.collections.resolveDispute(desk.actor, dispute.id, 'The crates were found and delivered.');
    const resumed = await desk.collections.plan(desk.actor, on('2026-08-29'));
    assert.equal(candidateFor(resumed, 'INV/2026/0041').decision, 'SEND');
  });

  it('a dispute on the whole account silences every bill on it', async () => {
    const desk = await lateDesk();
    await desk.collections.raiseDispute(desk.actor, { partyId: ABC, documentId: null, reason: 'A rate disagreement across the account.' });
    const plan = await desk.collections.plan(desk.actor, on('2026-08-29'));
    assert.equal(plan.toSend, 0);
    assert.equal(candidateFor(plan, 'INV/2026/0041').reason, 'DISPUTED');
  });

  it('waits for a promised date, then asks once more one rung firmer', async () => {
    const desk = await lateDesk();
    await desk.collections.recordPromise(desk.actor, {
      partyId: ABC,
      documentId: 'INV/2026/0041',
      amount: inr(50_000),
      promisedOn: on('2026-09-02'),
      note: 'Said the cheque goes out on Tuesday.',
    });

    const waiting = await desk.collections.plan(desk.actor, on('2026-08-29'));
    assert.equal(candidateFor(waiting, 'INV/2026/0041').reason, 'PROMISED');

    desk.setNow('2026-09-06T10:00:00.000Z');
    const broken = await desk.collections.plan(desk.actor, on('2026-09-06'));
    const candidate = candidateFor(broken, 'INV/2026/0041');
    assert.equal(candidate.decision, 'SEND');
    // FORTNIGHT_LATE is normally FIRM; a promise that passed raises it one rung.
    assert.equal((candidate.step as { code: string }).code, 'FORTNIGHT_LATE');
    assert.equal(candidate.level, 'FINAL');
  });

  it('marks a promise kept when the bill is actually paid, and broken when it is not', async () => {
    const desk = await lateDesk();
    await desk.collections.recordPromise(desk.actor, {
      partyId: ABC, documentId: 'INV/2026/0041', amount: inr(50_000), promisedOn: on('2026-09-02'),
    });

    const awaited = await desk.collections.promises(desk.actor, on('2026-08-29'));
    assert.equal(awaited[0]?.outcome, 'AWAITED');

    const late = await desk.collections.promises(desk.actor, on('2026-09-10'));
    assert.equal(late[0]?.outcome, 'BROKEN');

    await desk.receivables.recordPayment(desk.actor, {
      idempotencyKey: 'receipt-kept', direction: 'RECEIPT', partyId: ABC, mode: 'UPI', amount: inr(50_000),
      date: on('2026-09-01'), bankAccountCode: '1121',
      allocations: [{ documentId: 'INV/2026/0041', documentNumber: 'INV/2026/0041', amount: inr(50_000) }],
    });
    const kept = await desk.collections.promises(desk.actor, on('2026-09-10'));
    assert.equal(kept[0]?.outcome, 'KEPT');
  });

  it('honours an opt-out, and starts again when the customer asks', async () => {
    const desk = await lateDesk();
    await desk.collections.optOut(desk.actor, ABC, 'They asked us to stop messaging and to call instead.');

    const silent = await desk.collections.plan(desk.actor, on('2026-08-29'));
    assert.equal(candidateFor(silent, 'INV/2026/0041').reason, 'OPTED_OUT');
    await assert.rejects(() => desk.collections.send(desk.actor, { documentId: 'INV/2026/0041', today: on('2026-08-29') }));
    assert.equal(desk.provider.sent.length, 0);

    await desk.collections.resumeReminders(desk.actor, ABC);
    const resumed = await desk.collections.plan(desk.actor, on('2026-08-29'));
    assert.equal(candidateFor(resumed, 'INV/2026/0041').decision, 'SEND');
  });

  it('an opt-out must say why', async () => {
    const desk = await lateDesk();
    await assert.rejects(
      () => desk.collections.optOut(desk.actor, ABC, '   '),
      (error: unknown) => error instanceof DomainError && error.code === 'OPT_OUT_REASON_REQUIRED',
    );
  });

  it('moves to the next channel when one is turned off, and stops when none is left', async () => {
    const desk = await lateDesk();
    await desk.collections.setChannelPreference(desk.actor, { partyId: ABC, channel: 'whatsapp', enabled: false });
    const email = await desk.collections.plan(desk.actor, on('2026-08-29'));
    assert.equal(candidateFor(email, 'INV/2026/0041').channel, 'email');

    await desk.collections.setChannelPreference(desk.actor, { partyId: ABC, channel: 'email', enabled: false });
    await desk.collections.setChannelPreference(desk.actor, { partyId: ABC, channel: 'in_app', enabled: false });
    const none = await desk.collections.plan(desk.actor, on('2026-08-29'));
    assert.equal(candidateFor(none, 'INV/2026/0041').reason, 'NO_CHANNEL');
  });

  it('says so plainly when there is no way to reach the customer at all', async () => {
    const desk = await lateDesk({ channels: new Map() });
    const plan = await desk.collections.plan(desk.actor, on('2026-08-29'));
    assert.equal(candidateFor(plan, 'INV/2026/0041').reason, 'NO_CHANNEL');
  });
});

describe('when not to write', () => {
  it('holds a reminder overnight and sends it in the morning', async () => {
    // 18:00 UTC is 23:30 in Kolkata.
    const desk = await lateDesk({ now: '2026-08-29T18:00:00.000Z' });
    const night = await desk.collections.plan(desk.actor, on('2026-08-29'));
    assert.equal(candidateFor(night, 'INV/2026/0041').reason, 'QUIET_PERIOD');

    desk.setNow('2026-08-30T05:00:00.000Z');
    const morning = await desk.collections.plan(desk.actor, on('2026-08-30'));
    assert.equal(candidateFor(morning, 'INV/2026/0041').decision, 'SEND');
  });

  it('leaves a gap between two messages to the same customer', async () => {
    const desk = await lateDesk();
    desk.documents.set([
      bill('INV/2026/0041', inr(50_000), '2026-07-20', '2026-08-19'),
      bill('INV/2026/0042', inr(30_000), '2026-06-01', '2026-07-01'),
    ]);
    await desk.collections.send(desk.actor, { documentId: 'INV/2026/0042', today: on('2026-08-29') });

    desk.setNow('2026-08-30T10:00:00.000Z');
    const next = await desk.collections.plan(desk.actor, on('2026-08-30'));
    const candidate = candidateFor(next, 'INV/2026/0041');
    assert.equal(candidate.reason, 'TOO_SOON');

    desk.setNow('2026-09-02T10:00:00.000Z');
    const later = await desk.collections.plan(desk.actor, on('2026-09-02'));
    assert.equal(candidateFor(later, 'INV/2026/0041').decision, 'SEND');
  });
});

describe('when delivery goes wrong', () => {
  it('records the failure against the reminder and changes nothing about the bill', async () => {
    const desk = await lateDesk();
    desk.provider.failNext = true;

    const failed = await desk.collections.send(desk.actor, { documentId: 'INV/2026/0041', today: on('2026-08-29') });
    assert.equal(failed.state, 'FAILED');
    assert.match(failed.failureReason ?? '', /try again/i);

    // The bill is untouched: still open, still the same amount.
    const position = await desk.receivables.position(desk.actor, ABC, on('2026-08-29'));
    assert.equal(position.totalOutstanding.minor, 5_000_000n);

    const retried = await desk.collections.retry(desk.actor, failed.id, on('2026-08-29'));
    assert.equal(retried.state, 'SENT');
    assert.equal(retried.id, failed.id);
    assert.equal(desk.provider.sent.length, 1);
  });

  it('will not retry a reminder for a bill that has since been paid', async () => {
    const desk = await lateDesk();
    desk.provider.failNext = true;
    const failed = await desk.collections.send(desk.actor, { documentId: 'INV/2026/0041', today: on('2026-08-29') });

    await desk.receivables.recordPayment(desk.actor, {
      idempotencyKey: 'receipt-after-failure', direction: 'RECEIPT', partyId: ABC, mode: 'CASH',
      amount: inr(50_000), date: on('2026-08-29'),
      allocations: [{ documentId: 'INV/2026/0041', documentNumber: 'INV/2026/0041', amount: inr(50_000) }],
    });

    await assert.rejects(
      () => desk.collections.retry(desk.actor, failed.id, on('2026-08-29')),
      (error: unknown) => error instanceof DomainError && error.code === 'REMINDER_NOT_APPLICABLE',
    );
  });

  it('records a suppression as a fact when the recipient has silenced the channel', async () => {
    const desk = await lateDesk({ channels: new Map([[ABC as string, ['email'] as const]]) });
    desk.notifications.setPreference(desk.contextFor(desk.actor), {
      recipientId: 'abc-traders@example.invalid',
      channel: 'email',
      enabled: false,
    });

    const reminder = await desk.collections.send(desk.actor, { documentId: 'INV/2026/0041', today: on('2026-08-29') });
    assert.equal(reminder.state, 'SUPPRESSED');
    assert.equal(reminder.sentAt, null);
    assert.equal(desk.provider.sent.length, 0);
  });
});

describe('when the ladder runs out', () => {
  it('stops writing to the customer and hands the bill to the owner', async () => {
    const desk = await lateDesk();
    desk.documents.set([bill('INV/2026/0041', inr(50_000), '2026-05-01', '2026-06-01')]);
    desk.setNow('2026-07-05T10:00:00.000Z');

    const last = await desk.collections.send(desk.actor, { documentId: 'INV/2026/0041', today: on('2026-07-05') });
    assert.equal(last.stepCode, 'MONTH_LATE');
    assert.equal(last.level, 'FINAL');

    // Not the same afternoon: the last message is given time to work before the owner is troubled.
    const sameDay = await desk.collections.plan(desk.actor, on('2026-07-06'));
    assert.equal(candidateFor(sameDay, 'INV/2026/0041').reason, 'ALREADY_SENT');

    desk.setNow('2026-07-20T10:00:00.000Z');
    const escalation = await desk.collections.send(desk.actor, { documentId: 'INV/2026/0041', today: on('2026-07-20') });
    assert.equal(escalation.audience, 'OWNER');
    assert.equal(escalation.level, 'ESCALATE');
    assert.equal(escalation.channel, 'in_app');

    const exhausted = await desk.collections.plan(desk.actor, on('2026-07-25'));
    assert.equal(candidateFor(exhausted, 'INV/2026/0041').reason, 'LADDER_EXHAUSTED');
  });

  it('never lets a broken promise push a customer message into the owner’s wording', async () => {
    const desk = await lateDesk();
    desk.documents.set([bill('INV/2026/0044', inr(22_000), '2026-06-20', '2026-07-20')]);
    await desk.collections.recordPromise(desk.actor, {
      partyId: ABC, documentId: 'INV/2026/0044', amount: inr(22_000), promisedOn: on('2026-08-01'),
    });

    const plan = await desk.collections.plan(desk.actor, on('2026-08-29'));
    const candidate = candidateFor(plan, 'INV/2026/0044');
    // MONTH_LATE is already FINAL; the broken promise cannot raise it into the owner's voice.
    assert.equal(candidate.decision, 'SEND');
    assert.equal(candidate.level, 'FINAL');
    assert.doesNotMatch(String((candidate.explanation as Record<string, string>)['en-IN']), /needs you to decide/);
  });

  it('takes a very large bill to the owner instead of messaging the customer about it', async () => {
    const desk = await lateDesk();
    desk.documents.set([bill('INV/2026/0099', inr(900_000), '2026-07-20', '2026-08-19')]);

    const plan = await desk.collections.plan(desk.actor, on('2026-08-29'));
    const candidate = candidateFor(plan, 'INV/2026/0099');
    assert.equal(candidate.decision, 'ESCALATE');
    assert.equal(plan.toEscalate, 1);
  });
});

describe('the guarantees that do not depend on anyone being careful', () => {
  it('refuses to put an accusation or a threat in a reminder', () => {
    assert.throws(() => safeReminder('ABC Traders is a defaulter.'), /never what the customer is/);
    assert.throws(() => safeReminder('Pay or we will take legal action.'), /cannot carry out/);
    assert.equal(safeReminder('Bill INV/1 for ₹100 is 3 days late.'), 'Bill INV/1 for ₹100 is 3 days late.');
  });

  it('writes every rung without tripping its own guard', () => {
    const snapshot = {
      asOf: on('2026-08-29'), documentNumber: 'INV/2026/0041', documentValue: inr(50_000),
      outstanding: inr(50_000), partyOutstanding: inr(50_000), daysOverdue: 10,
    };
    for (const level of ['ADVANCE', 'GENTLE', 'FIRM', 'FINAL', 'ESCALATE'] as const) {
      const message = reminderMessage({ businessName: 'Sampoorna Traders', partyName: 'ABC Traders', level, snapshot });
      assert.ok(message['en-IN'].length > 0 && message['hi-IN'].length > 0);
    }
  });

  it('keeps the balance the message quoted, so the record explains itself later', async () => {
    const desk = await lateDesk();
    const reminder = await desk.collections.send(desk.actor, { documentId: 'INV/2026/0041', today: on('2026-08-29') });
    assert.deepEqual(reminder.snapshot, {
      asOf: '2026-08-29',
      documentNumber: 'INV/2026/0041',
      documentValue: inr(50_000),
      outstanding: inr(50_000),
      partyOutstanding: inr(50_000),
      daysOverdue: 10,
    });
    assert.ok(reminder.notificationId !== null);
    const events = desk.notifications.eventsFor(desk.contextFor(desk.actor), reminder.notificationId as string);
    assert.deepEqual(events.map((e) => e.type), ['scheduled', 'delivered']);
  });

  it('records the reminder in the audit trail with the amount and the rung', async () => {
    const desk = await lateDesk();
    await desk.collections.send(desk.actor, { documentId: 'INV/2026/0041', today: on('2026-08-29') });
    const entries = desk.audit.events.filter((e) => e.action === 'collections.reminder_sent');
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.details.step, 'WEEK_LATE');
    assert.equal(entries[0]?.details.outstanding, '₹50,000.00');
  });

  it('will not let one business see or send another business’s reminders', async () => {
    const desk = await lateDesk();
    await desk.collections.send(desk.actor, { documentId: 'INV/2026/0041', today: on('2026-08-29') });

    const mine = (await desk.collections.history(desk.actor))[0];
    assert.ok(mine !== undefined);

    // Tenancy comes from the actor, never from an argument, so a second company sees nothing —
    // not in the list, not by id, and not by asking for the same reminder again.
    const intruder = { ...desk.actor, companyId: OTHER };
    assert.deepEqual(await desk.collections.history(intruder), []);
    assert.equal(await desk.repository.findById(OTHER, mine.id), null);
    assert.equal(await desk.repository.findByKey(OTHER, mine.reminderKey), null);
    await assert.rejects(
      () => desk.collections.retry(intruder, mine.id, on('2026-08-29')),
      (error: unknown) => error instanceof DomainError && error.code === 'REMINDER_NOT_FOUND',
    );
  });

  it('needs the right permission for each thing it does', async () => {
    const desk = await lateDesk();
    const viewer = { ...desk.actor, permissions: ['collections.reminders.view'] };
    await desk.collections.plan(viewer, on('2026-08-29'));
    await assert.rejects(
      () => desk.collections.send(viewer, { documentId: 'INV/2026/0041', today: on('2026-08-29') }),
      (error: unknown) => error instanceof DomainError && error.kind === 'FORBIDDEN',
    );
    await assert.rejects(
      () => desk.collections.raiseDispute(viewer, { partyId: ABC, documentId: null, reason: 'x' }),
      (error: unknown) => error instanceof DomainError && error.kind === 'FORBIDDEN',
    );
  });

  it('sends everything the plan agreed to, and only that', async () => {
    const desk = await lateDesk();
    desk.documents.set([
      bill('INV/2026/0041', inr(50_000), '2026-07-20', '2026-08-19'),
      bill('INV/2026/0043', inr(7_000), '2026-08-25', '2026-09-30'),
    ]);
    const sent = await desk.collections.sendPlanned(desk.actor, on('2026-08-29'));
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.documentId, 'INV/2026/0041');
    assert.equal((await desk.collections.history(desk.actor)).length, 1);
  });

  it('picks the rung from the ladder rather than sending every earlier one', () => {
    assert.equal(stepFor(DEFAULT_REMINDER_POLICY, 40)?.code, 'MONTH_LATE');
    assert.equal(stepFor(DEFAULT_REMINDER_POLICY, 0)?.code, 'DUE_TODAY');
    assert.equal(stepFor(DEFAULT_REMINDER_POLICY, -10), null);
  });
});
