/**
 * Issue #366 — one contract for the reminder repository, run against the in-memory store
 * (reminder-repository-contract.test.ts) and PostgreSQL (reminder-repository-contract.integration.test.ts).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { money, type BranchId, type CompanyId, type IsoDate, type PartyId, type UserId } from '@invoice/kernel';
import type { ContactPreference, Dispute, PromiseToPay, Reminder, ReminderChannel } from '../src/model.ts';
import type { ReminderRepository } from '../src/ports.ts';

export interface ReminderHarness {
  readonly repository: ReminderRepository;
  /** A company (and one of its branches) that exists wherever the store keeps its rows. */
  company(): Promise<{ companyId: CompanyId; branchId: BranchId }>;
  /** Runs `work` the way a command handler would: inside the company's unit of work. */
  write<T>(companyId: CompanyId, work: () => Promise<T>): Promise<T>;
  /** False for the in-memory store, which has no transaction to roll back or require. */
  readonly transactional: boolean;
}

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const party = (n = 1) => `party-${n}` as PartyId;
const user = 'user-priya' as UserId;
let clock = Date.parse('2026-10-01T09:00:00.000Z');
/** Distinct, increasing instants, so every list has one right order. */
const tick = (): string => new Date((clock += 1000)).toISOString();

const reminder = (companyId: CompanyId, branchId: BranchId | null, over: Partial<Reminder> = {}): Reminder => {
  const documentId = `bill-${crypto.randomUUID()}`;
  return {
    id: crypto.randomUUID(), companyId, branchId, partyId: party(), documentId,
    reminderKey: `reminder:${documentId}:D+7`, stepCode: 'D+7', level: 'GENTLE', channel: 'whatsapp', audience: 'CUSTOMER',
    message: { 'en-IN': 'A gentle reminder about INV/26-27/000123.', 'hi-IN': 'INV/26-27/000123 ke baare mein ek yaad dilana.' },
    snapshot: {
      asOf: '2026-10-08' as IsoDate, documentNumber: 'INV/26-27/000123',
      // Larger than a double can hold exactly: bigint paise must survive the trip.
      documentValue: money(9_007_199_254_740_993n), outstanding: money(123_456n), partyOutstanding: money(0n), daysOverdue: 7,
    },
    state: 'SCHEDULED', failureReason: null, notificationId: null, scheduledBy: user, scheduledAt: tick(), sentAt: null,
    ...over,
  };
};
const promise = (companyId: CompanyId, over: Partial<PromiseToPay> = {}): PromiseToPay => ({
  id: crypto.randomUUID(), companyId, partyId: party(), documentId: 'bill-1', amount: money(5_000_00n),
  promisedOn: '2026-10-20' as IsoDate, note: null, state: 'OPEN', recordedBy: user, recordedAt: tick(), ...over,
});
const dispute = (companyId: CompanyId, over: Partial<Dispute> = {}): Dispute => ({
  id: crypto.randomUUID(), companyId, partyId: party(), documentId: null, reason: 'Two cartons arrived damaged.',
  state: 'OPEN', resolution: null, raisedBy: user, raisedAt: tick(), resolvedBy: null, resolvedAt: null, ...over,
});
const preference = (companyId: CompanyId, channel: ReminderChannel, over: Partial<ContactPreference> = {}): ContactPreference => ({
  companyId, partyId: party(), channel, state: 'DISABLED', reason: null, recordedBy: user, recordedAt: tick(), ...over,
});

/** Reads every page of `size` and checks each row came exactly once, in the order of the whole list. */
const allPages = async <T>(read: (page?: { limit: number; after?: string }) => Promise<readonly T[]>, keyOf: (item: T) => string, size: number) => {
  const whole = (await read()).map(keyOf);
  const seen: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await read(after === undefined ? { limit: size } : { limit: size, after });
    assert.ok(page.length <= size);
    if (page.length === 0) break;
    seen.push(...page.map(keyOf));
    after = keyOf(page.at(-1) as T);
  }
  assert.deepEqual(seen, whole, 'every row exactly once, in the same order as the unpaged list');
  return whole;
};

export function reminderRepositoryContract(label: string, harness: () => ReminderHarness, skip: false | string = false): void {
  test(`${label}: a reminder round-trips exactly, by id and by key, and an update replaces it`, { skip }, async () => {
    const h = harness();
    const { companyId, branchId } = await h.company();
    const r = reminder(companyId, branchId);
    await h.write(companyId, () => h.repository.insert(r));
    assert.deepEqual(await h.repository.findById(companyId, r.id), r);
    assert.deepEqual(await h.repository.findByKey(companyId, r.reminderKey), r);

    const sent: Reminder = { ...r, state: 'SENT', notificationId: 'ntf-1', sentAt: tick(), level: 'FIRM', channel: 'sms' };
    await h.write(companyId, () => h.repository.update(sent));
    assert.deepEqual(await h.repository.findById(companyId, r.id), sent);

    const unbranched = reminder(companyId, null, { state: 'FAILED', failureReason: 'The provider is unavailable.' });
    await h.write(companyId, () => h.repository.insert(unbranched));
    assert.deepEqual(await h.repository.findById(companyId, unbranched.id), unbranched, 'nulls come back as nulls');
  });

  test(`${label}: a second reminder for the same bill and rung, or with the same id, is refused`, { skip }, async () => {
    const h = harness();
    const { companyId, branchId } = await h.company();
    const r = reminder(companyId, branchId);
    await h.write(companyId, () => h.repository.insert(r));
    await assert.rejects(h.write(companyId, () => h.repository.insert({ ...r, id: crypto.randomUUID() })), code('REMINDER_DUPLICATE'));
    await assert.rejects(h.write(companyId, () => h.repository.insert({ ...r, reminderKey: 'reminder:other:D+7' })), code('REMINDER_DUPLICATE'));
    const other = reminder(companyId, branchId);
    await h.write(companyId, () => h.repository.insert(other));
    await assert.rejects(h.write(companyId, () => h.repository.update({ ...other, reminderKey: r.reminderKey })), code('REMINDER_DUPLICATE'));
    assert.equal((await h.repository.list(companyId)).length, 2);
  });

  test(`${label}: what is not there is not found`, { skip }, async () => {
    const h = harness();
    const { companyId, branchId } = await h.company();
    assert.equal(await h.repository.findById(companyId, crypto.randomUUID()), null);
    assert.equal(await h.repository.findById(companyId, 'not-an-id'), null);
    assert.equal(await h.repository.findByKey(companyId, 'reminder:nothing:D+7'), null);
    assert.equal(await h.repository.optOut(companyId, party()), null);
    await assert.rejects(h.write(companyId, () => h.repository.update(reminder(companyId, branchId))), code('REMINDER_NOT_FOUND'));
    assert.deepEqual(await h.repository.list(companyId, { limit: 5, after: crypto.randomUUID() }), []);
  });

  test(`${label}: one company cannot read or change another company's rows`, { skip }, async () => {
    const h = harness();
    const a = await h.company();
    const b = await h.company();
    const r = reminder(a.companyId, a.branchId);
    const p = promise(a.companyId);
    const d = dispute(a.companyId);
    await h.write(a.companyId, async () => {
      await h.repository.insert(r);
      await h.repository.savePromise(p);
      await h.repository.saveDispute(d);
      await h.repository.savePreference(preference(a.companyId, 'email'));
      await h.repository.saveOptOut({ companyId: a.companyId, partyId: party(), reason: 'Asked not to be messaged.', recordedBy: user, recordedAt: tick() });
    });
    assert.equal(await h.repository.findById(b.companyId, r.id), null);
    assert.equal(await h.repository.findByKey(b.companyId, r.reminderKey), null);
    assert.deepEqual(await h.repository.list(b.companyId), []);
    assert.deepEqual(await h.repository.promises(b.companyId), []);
    assert.deepEqual(await h.repository.disputes(b.companyId), []);
    assert.deepEqual(await h.repository.preferences(b.companyId, party()), []);
    assert.equal(await h.repository.optOut(b.companyId, party()), null);

    await assert.rejects(h.write(b.companyId, () => h.repository.update({ ...r, companyId: b.companyId, state: 'CANCELLED' })), code('REMINDER_NOT_FOUND'));
    // Company B saving under A's ids may fail or may create B's own row; it must never touch A's.
    await h.write(b.companyId, () => h.repository.savePromise({ ...p, companyId: b.companyId, state: 'CANCELLED' })).catch(() => undefined);
    await h.write(b.companyId, () => h.repository.saveDispute({ ...d, companyId: b.companyId, state: 'RESOLVED' })).catch(() => undefined);
    await h.write(b.companyId, () => h.repository.removeOptOut(b.companyId, party()));
    assert.deepEqual(await h.repository.findById(a.companyId, r.id), r);
    assert.deepEqual(await h.repository.promises(a.companyId), [p]);
    assert.deepEqual(await h.repository.disputes(a.companyId), [d]);
    assert.notEqual(await h.repository.optOut(a.companyId, party()), null);
  });

  test(`${label}: channel preferences are one per channel, and the latest one wins`, { skip }, async () => {
    const h = harness();
    const { companyId } = await h.company();
    const off = preference(companyId, 'whatsapp', { reason: 'Prefers email.' });
    const on = preference(companyId, 'whatsapp', { state: 'ENABLED' });
    const email = preference(companyId, 'email', { partyId: party(2) });
    await h.write(companyId, async () => { await h.repository.savePreference(off); await h.repository.savePreference(email); });
    assert.deepEqual(await h.repository.preferences(companyId, party()), [off]);
    await h.write(companyId, () => h.repository.savePreference(on));
    assert.deepEqual(await h.repository.preferences(companyId, party()), [on]);
    assert.deepEqual(await h.repository.preferences(companyId, party(2)), [email]);
  });

  test(`${label}: an opt-out holds until reminders are resumed, and can be given again`, { skip }, async () => {
    const h = harness();
    const { companyId } = await h.company();
    const first = { companyId, partyId: party(), reason: 'Asked not to be messaged.', recordedBy: user, recordedAt: tick() };
    await h.write(companyId, () => h.repository.saveOptOut(first));
    assert.deepEqual(await h.repository.optOut(companyId, party()), first);
    await h.write(companyId, () => h.repository.removeOptOut(companyId, party()));
    assert.equal(await h.repository.optOut(companyId, party()), null);
    await h.write(companyId, () => h.repository.removeOptOut(companyId, party()));
    const again = { ...first, reason: 'Asked again.', recordedAt: tick() };
    await h.write(companyId, () => h.repository.saveOptOut(again));
    assert.deepEqual(await h.repository.optOut(companyId, party()), again);
  });

  test(`${label}: promises and disputes are saved, changed in place, and keep their order`, { skip }, async () => {
    const h = harness();
    const { companyId } = await h.company();
    const p1 = promise(companyId, { note: 'Will pay after Diwali.' });
    const p2 = promise(companyId, { documentId: 'bill-2' });
    const d1 = dispute(companyId, { documentId: 'bill-1' });
    const d2 = dispute(companyId);
    await h.write(companyId, async () => {
      await h.repository.savePromise(p1); await h.repository.savePromise(p2);
      await h.repository.saveDispute(d1); await h.repository.saveDispute(d2);
    });
    const cancelled = { ...p1, state: 'CANCELLED' as const };
    const resolved: Dispute = { ...d1, state: 'RESOLVED', resolution: 'Credit note issued.', resolvedBy: user, resolvedAt: tick() };
    await h.write(companyId, async () => { await h.repository.savePromise(cancelled); await h.repository.saveDispute(resolved); });
    assert.deepEqual(await h.repository.promises(companyId), [cancelled, p2]);
    assert.deepEqual(await h.repository.disputes(companyId), [resolved, d2]);
  });

  test(`${label}: every list pages through each row exactly once`, { skip }, async () => {
    const h = harness();
    const { companyId, branchId } = await h.company();
    const at = tick();
    await h.write(companyId, async () => {
      // Three share one instant, so the id decides between them.
      for (let i = 0; i < 7; i += 1) await h.repository.insert(reminder(companyId, branchId, i < 3 ? { scheduledAt: at } : {}));
      for (let i = 0; i < 5; i += 1) await h.repository.savePromise(promise(companyId, i < 2 ? { recordedAt: at } : {}));
      for (let i = 0; i < 5; i += 1) await h.repository.saveDispute(dispute(companyId, i < 2 ? { raisedAt: at } : {}));
      for (const channel of ['whatsapp', 'sms', 'in_app', 'email'] as const) await h.repository.savePreference(preference(companyId, channel));
    });
    const reminders = await h.repository.list(companyId);
    assert.deepEqual(reminders.map((r) => r.scheduledAt), [...reminders.map((r) => r.scheduledAt)].sort().reverse(), 'newest first');
    assert.equal((await allPages((page) => h.repository.list(companyId, page), (r) => r.id, 3)).length, 7);
    assert.equal((await allPages((page) => h.repository.promises(companyId, page), (p) => p.id, 2)).length, 5);
    assert.equal((await allPages((page) => h.repository.disputes(companyId, page), (d) => d.id, 4)).length, 5);
    assert.deepEqual(await allPages((page) => h.repository.preferences(companyId, party(), page), (p) => p.channel, 3), ['email', 'in_app', 'sms', 'whatsapp']);
  });

  const db = (name: string) => `${label}: ${name}`;

  test(db('a unit of work that fails leaves nothing behind'), { skip }, async (t) => {
    const h = harness();
    if (!h.transactional) return t.skip('the in-memory store has no transaction');
    const { companyId, branchId } = await h.company();
    const r = reminder(companyId, branchId);
    await assert.rejects(h.write(companyId, async () => {
      await h.repository.insert(r);
      await h.repository.savePromise(promise(companyId));
      await h.repository.saveOptOut({ companyId, partyId: party(), reason: 'x', recordedBy: user, recordedAt: tick() });
      throw new Error('the provider call that came next failed');
    }), /provider call/);
    assert.equal(await h.repository.findById(companyId, r.id), null);
    assert.deepEqual(await h.repository.promises(companyId), []);
    assert.equal(await h.repository.optOut(companyId, party()), null);
  });

  test(db('a write outside a unit of work is refused, not committed on its own'), { skip }, async (t) => {
    const h = harness();
    if (!h.transactional) return t.skip('the in-memory store has no unit of work');
    const { companyId, branchId } = await h.company();
    const r = reminder(companyId, branchId);
    await assert.rejects(h.repository.insert(r), code('NO_UNIT_OF_WORK'));
    await assert.rejects(h.repository.savePromise(promise(companyId)), code('NO_UNIT_OF_WORK'));
    await assert.rejects(h.repository.removeOptOut(companyId, party()), code('NO_UNIT_OF_WORK'));
    assert.equal(await h.repository.findById(companyId, r.id), null);
  });
}
