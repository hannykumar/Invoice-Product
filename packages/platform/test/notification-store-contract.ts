/**
 * Issue #366 — one contract suite for `NotificationStore`, run against the in-memory store
 * (notification-store-contract.test.ts) and PostgreSQL (notification-store-contract.integration.test.ts).
 * Everything is synthetic: random company ids and invented recipients.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { NotificationService } from "../src/notifications.ts";
import type { Notification, NotificationDeliveryEvent, NotificationPage, NotificationStore } from "../src/notifications.ts";
import type { Permission, RequestContext } from "../src/types.ts";

export interface NotificationHarness {
  store: NotificationStore;
  /** A company, wherever the implementation keeps them. */
  company(): Promise<string>;
  /** One business action: everything `work` writes is kept together, or nothing is when it throws. */
  write<T>(companyId: string, work: () => Promise<T>): Promise<T>;
}

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

export const notification = (companyId: string, over: Partial<Notification> = {}): Notification => ({
  id: randomUUID(), companyId, recipientId: "owner@example.invalid", recipientRole: "owner", channel: "email", template: "gst_deadline",
  locale: "en-IN", sensitivity: "internal", payload: { period: "2026-08", nested: { amountPaise: 1_250_000n, lines: [1, "two"] } },
  deduplicationKey: `gst-deadline:${randomUUID()}`, scheduledAt: Date.parse("2026-08-20T04:30:00.000Z"), status: "scheduled", attempts: 0,
  ...over,
});

const event = (n: Notification, over: Partial<NotificationDeliveryEvent> = {}): NotificationDeliveryEvent => ({
  id: randomUUID(), notificationId: n.id, companyId: n.companyId, actorId: "owner", type: "scheduled", occurredAt: Date.parse("2026-08-20T04:30:00.123Z"), ...over,
});

/** Walks a list page by page and returns every row it was given. */
const walk = async <T extends { id: string }>(fetch: (page: NotificationPage) => Promise<readonly T[]>, limit = 2): Promise<T[]> => {
  const seen: T[] = [];
  for (let page = await fetch({ limit }); page.length > 0; page = await fetch({ limit, after: page.at(-1)!.id })) {
    assert.ok(page.length <= limit);
    seen.push(...page);
  }
  return seen;
};

const contextFor = (companyId: string, permissions: readonly Permission[] = ["notification.send", "notification.sensitive.send"]): RequestContext =>
  ({ companyId, branchId: "main", actorId: "owner", sessionId: "s", permissions: new Set(permissions) });

export const notificationStoreContract = (name: string, make: () => NotificationHarness, skip: string | false = false): void => {
  test(`${name}: a notification is kept exactly, and only its own company can find it`, { skip }, async () => {
    const { store, company, write } = make();
    const [a, b] = [await company(), await company()];
    const first = notification(a);
    const failed = notification(a, { status: "failed", attempts: 2, lastError: "Delivery could not be completed. Retry is available.", channel: "in_app", locale: "hi-IN", sensitivity: "restricted" });
    await write(a, async () => { await store.insert(first); await store.insert(failed); });
    assert.deepEqual(await store.find(a, first.id), first);
    assert.deepEqual(await store.find(a, failed.id), failed);
    assert.deepEqual(await store.findByDeduplicationKey(a, first.deduplicationKey), first);
    assert.equal(await store.find(b, first.id), null);
    assert.equal(await store.findByDeduplicationKey(b, first.deduplicationKey), null);
    assert.equal(await store.find(a, randomUUID()), null);
    assert.equal(await store.find(a, "not-an-id"), null);
  });

  test(`${name}: the same business event cannot be recorded twice in one company, but may be in another`, { skip }, async () => {
    const { store, company, write } = make();
    const [a, b] = [await company(), await company()];
    const first = notification(a);
    await write(a, () => store.insert(first));
    await assert.rejects(write(a, () => store.insert({ ...first, id: randomUUID() })), code("IDEMPOTENCY_CONFLICT"));
    await assert.rejects(write(a, () => store.insert({ ...first, deduplicationKey: "another" })), code("IDEMPOTENCY_CONFLICT"));
    const theirs = notification(b, { deduplicationKey: first.deduplicationKey });
    await write(b, () => store.insert(theirs));
    assert.deepEqual(await store.findByDeduplicationKey(b, first.deduplicationKey), theirs);
  });

  test(`${name}: an update replaces the record; one never inserted, or another company's, is not found`, { skip }, async () => {
    const { store, company, write } = make();
    const [a, b] = [await company(), await company()];
    const item = notification(a);
    const other = notification(a);
    await write(a, async () => { await store.insert(item); await store.insert(other); });
    const failed = { ...item, status: "failed" as const, attempts: 1, lastError: "Delivery could not be completed. Retry is available." };
    await write(a, () => store.update(failed));
    assert.deepEqual(await store.find(a, item.id), failed);
    const { lastError: _gone, ...retried } = { ...failed, status: "scheduled" as const, scheduledAt: failed.scheduledAt + 60_000 };
    await write(a, () => store.update(retried));
    assert.deepEqual(await store.find(a, item.id), retried);
    await assert.rejects(write(a, () => store.update(notification(a))), code("NOT_FOUND"));
    await assert.rejects(write(b, () => store.update({ ...retried, companyId: b })), code("NOT_FOUND"));
    await assert.rejects(write(a, () => store.update({ ...retried, deduplicationKey: other.deduplicationKey })), code("IDEMPOTENCY_CONFLICT"));
    assert.deepEqual(await store.find(a, item.id), retried);
  });

  test(`${name}: due work is the scheduled notifications whose time has come, in the order scheduled, page by page`, { skip }, async () => {
    const { store, company, write } = make();
    const [a, b] = [await company(), await company()];
    const at = Date.parse("2026-08-20T04:30:00.000Z");
    const rows = [
      notification(a, { scheduledAt: at }), notification(a, { scheduledAt: at - 1 }), notification(a, { scheduledAt: at + 1 }),
      notification(a, { status: "failed", attempts: 1 }), notification(a, { status: "suppressed" }), notification(a, { status: "delivered", attempts: 1 }),
      notification(a, { scheduledAt: 0 }), notification(a, { scheduledAt: at - 3_600_000 }),
    ];
    await write(a, async () => { for (const row of rows) await store.insert(row); });
    await write(b, () => store.insert(notification(b)));
    const expected = [rows[0], rows[1], rows[6], rows[7]].map((row) => row!.id);
    assert.deepEqual((await store.due(a, at)).map((row) => row.id), expected);
    assert.deepEqual((await walk((page) => store.due(a, at, page))).map((row) => row.id), expected);
    // The place is kept even when the row that marked it has since been delivered.
    const firstPage = await store.due(a, at, { limit: 1 });
    await write(a, () => store.update({ ...firstPage[0]!, status: "delivered", attempts: 1 }));
    assert.deepEqual((await store.due(a, at, { limit: 10, after: firstPage[0]!.id })).map((row) => row.id), expected.slice(1));
    assert.deepEqual(await store.due(a, at, { limit: 10, after: randomUUID() }), []);
    assert.deepEqual(await store.due(b, at - 1), []);
  });

  test(`${name}: the delivery timeline is append-only, in order, and closed to other companies`, { skip }, async () => {
    const { store, company, write } = make();
    const [a, b] = [await company(), await company()];
    const item = notification(a);
    const events = [event(item), event(item, { type: "delivered" }), event(item, { type: "failed", detail: "Delivery could not be completed." }), event(item, { type: "opened", actorId: "customer" })];
    await write(a, async () => { await store.insert(item); for (const e of events) await store.appendEvent(e); });
    assert.deepEqual(await store.events(a, item.id), events);
    assert.deepEqual(await walk((page) => store.events(a, item.id, page), 3), events);
    assert.deepEqual(await store.events(a, item.id, { limit: 5, after: randomUUID() }), []);
    assert.deepEqual(await store.events(b, item.id), []);
    await assert.rejects(write(a, () => store.appendEvent(events[0]!)), code("IDEMPOTENCY_CONFLICT"));
    await assert.rejects(write(b, () => store.appendEvent(event({ ...item, companyId: b }))), code("NOT_FOUND"));
    await assert.rejects(write(a, () => store.appendEvent(event(notification(a)))), code("NOT_FOUND"));
    assert.equal((await store.events(a, item.id)).length, events.length);
  });

  test(`${name}: a preference is kept per recipient and channel, and replaced when set again`, { skip }, async () => {
    const { store, company, write } = make();
    const [a, b] = [await company(), await company()];
    const off = { companyId: a, recipientId: "customer@example.invalid", channel: "email" as const, enabled: false };
    const quiet = { companyId: a, recipientId: "customer@example.invalid", channel: "sms" as const, enabled: true, quietFromHour: 22, quietToHour: 7, timeZone: "Asia/Kolkata" };
    await write(a, async () => { await store.savePreference(off); await store.savePreference(quiet); });
    assert.deepEqual(await store.preference(a, off.recipientId, "email"), off);
    assert.deepEqual(await store.preference(a, off.recipientId, "sms"), quiet);
    const { quietFromHour: _f, quietToHour: _t, timeZone: _z, ...plain } = quiet;
    await write(a, () => store.savePreference(plain));
    assert.deepEqual(await store.preference(a, off.recipientId, "sms"), plain);
    assert.equal(await store.preference(a, off.recipientId, "whatsapp"), null);
    assert.equal(await store.preference(b, off.recipientId, "email"), null);
  });

  test(`${name}: the notification service runs on this store — deduplication, opt-out, failure, retry, delivery, open`, { skip }, async () => {
    const { store, company, write } = make();
    const a = await company();
    let fail = true;
    let sent = 0;
    const service = new NotificationService({ async send() { sent += 1; if (fail) throw new Error("outage"); } }, () => 1_000, { maxPerWindow: 10, windowMs: 60_000 }, store);
    const context = contextFor(a);
    const input = { recipientId: "owner", recipientRole: "owner" as const, channel: "in_app" as const, template: "gst_deadline", locale: "en-IN" as const, sensitivity: "internal" as const, payload: { auth: { token: "secret" } }, deduplicationKey: "gst-deadline:2026-08-20", scheduledAt: 0 };
    await write(a, () => service.setPreference(context, { recipientId: "owner", channel: "email", enabled: false }));
    const item = await write(a, () => service.schedule(context, input));
    assert.deepEqual(item.payload, { auth: { token: "[REDACTED]" } });
    assert.equal((await write(a, () => service.schedule(context, input))).id, item.id);
    assert.equal((await write(a, () => service.schedule(context, { ...input, channel: "email", deduplicationKey: "muted" }))).status, "suppressed");
    assert.equal((await write(a, () => service.deliverDue(context)))[0]?.status, "failed");
    fail = false;
    await write(a, () => service.retry(context, item.id));
    assert.equal((await write(a, () => service.deliverDue(context)))[0]?.status, "delivered");
    await write(a, () => service.markOpened(context, item.id));
    assert.deepEqual((await service.eventsFor(context, item.id)).map((e) => e.type), ["scheduled", "failed", "scheduled", "delivered", "opened"]);
    assert.equal((await service.get(context, item.id)).attempts, 2);
    assert.equal(sent, 2);
    await assert.rejects(service.get(contextFor(await company()), item.id), code("NOT_FOUND"));
  });
};
