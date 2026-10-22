import assert from "node:assert/strict";
import test from "node:test";
import {
  AccessControl,
  ChannelNotificationTransport,
  EmailNotificationAdapter,
  InAppNotificationAdapter,
  NotificationService,
  NotificationTemplateRegistry,
  PlatformError,
  type NotificationTransport,
} from "../src/index.ts";
import type { RequestContext } from "../src/types.ts";

const permissions = new Set(["notification.send", "notification.sensitive.send"] as const);
const context = () => {
  const access = new AccessControl();
  access.grant({ companyId: "a", userId: "owner", branchIds: new Set(["b"]), active: true, permissions });
  access.grant({ companyId: "other", userId: "owner", branchIds: new Set(["b"]), active: true, permissions });
  return { a: access.context("a", "b", "owner", "s"), other: access.context("other", "b", "owner", "s") };
};
const input = (overrides: Record<string, unknown> = {}) => ({
  recipientId: "customer",
  recipientRole: "customer" as const,
  channel: "email" as const,
  template: "invoice_ready",
  locale: "en-IN" as const,
  sensitivity: "public" as const,
  payload: {},
  deduplicationKey: "invoice:1",
  scheduledAt: 0,
  ...overrides,
});

test("notifications deduplicate business events, redact nested secrets and respect opt-outs", async () => {
  const { a } = context();
  const service = new NotificationService({ async send() {} });
  await service.setPreference(a, { recipientId: "customer", channel: "email", enabled: false });
  const first = await service.schedule(a, input({ payload: { auth: { token: "secret" }, invoice: "INV-1" } }));
  assert.equal(first.status, "suppressed");
  assert.deepEqual(first.payload.auth, { token: "[REDACTED]" });
  assert.equal((await service.schedule(a, input())).id, first.id);
});

test("failed delivery is visible, retryable and isolated", async () => {
  const { a, other } = context();
  let fail = true;
  const transport: NotificationTransport = { async send() { if (fail) throw new Error("outage"); } };
  const service = new NotificationService(transport, () => 10);
  const item = await service.schedule(a, input({ recipientId: "owner", recipientRole: "owner", channel: "in_app", template: "deadline", deduplicationKey: "deadline:1" }));
  assert.equal((await service.deliverDue(a))[0]!.status, "failed");
  await assert.rejects(() => service.get(other, item.id), (error: unknown) => error instanceof PlatformError && error.code === "NOT_FOUND");
  fail = false;
  await service.retry(a, item.id);
  assert.equal((await service.deliverDue(a))[0]!.status, "delivered");
});

test("delivery and open events form a tenant-scoped actor timeline", async () => {
  const { a, other } = context();
  const service = new NotificationService({ async send() {} }, () => 100);
  const item = await service.schedule(a, input({ recipientId: "owner", recipientRole: "owner", channel: "in_app", template: "approval", locale: "hi-IN", deduplicationKey: "approval:1" }));
  await service.deliverDue(a);
  await service.markOpened(a, item.id);
  assert.deepEqual((await service.eventsFor(a, item.id)).map((event) => event.type), ["scheduled", "delivered", "opened"]);
  assert.ok((await service.eventsFor(a, item.id)).every((event) => event.actorId === "owner"));
  await assert.rejects(() => service.eventsFor(other, item.id), /not found/);
});

test("rate limiting leaves excess notifications scheduled for a later window", async () => {
  const { a } = context();
  let now = 1_000;
  let sent = 0;
  const service = new NotificationService({ async send() { sent += 1; } }, () => now, { maxPerWindow: 1, windowMs: 1_000 });
  const first = await service.schedule(a, input({ recipientId: "one", deduplicationKey: "alert:1" }));
  const second = await service.schedule(a, input({ recipientId: "two", deduplicationKey: "alert:2" }));
  await service.deliverDue(a);
  assert.equal(sent, 1);
  assert.equal((await service.get(a, first.id)).status, "delivered");
  assert.equal((await service.get(a, second.id)).status, "scheduled");
  now = 2_001;
  await service.deliverDue(a);
  assert.equal((await service.get(a, second.id)).status, "delivered");
});

test("quiet hours use the recipient time zone", async () => {
  const { a } = context();
  const at = Date.parse("2026-08-28T17:00:00Z"); // 22:30 in India
  const service = new NotificationService({ async send() {} }, () => at);
  await service.setPreference(a, { recipientId: "customer", channel: "email", enabled: true, quietFromHour: 22, quietToHour: 7, timeZone: "Asia/Kolkata" });
  assert.equal((await service.schedule(a, input({ scheduledAt: at }))).status, "suppressed");
});

test("restricted content requires permission and stays in-app for trusted roles", async () => {
  const { a } = context();
  const service = new NotificationService({ async send() {} });
  await assert.rejects(() => service.schedule(a, input({ sensitivity: "restricted", recipientRole: "owner", recipientId: "owner" })), /cannot be sent/);
  const withoutSensitivePermission: RequestContext = { ...a, permissions: new Set(["notification.send"]) };
  await assert.rejects(() => service.schedule(withoutSensitivePermission, input({ sensitivity: "restricted", recipientRole: "owner", recipientId: "owner", channel: "in_app" })), /permission/);
  const accepted = await service.schedule(a, input({ sensitivity: "restricted", recipientRole: "owner", recipientId: "owner", channel: "in_app" }));
  assert.equal(accepted.status, "scheduled");
});

test("notification management requires an explicit platform permission", async () => {
  const { a } = context();
  const service = new NotificationService({ async send() {} });
  const forbidden: RequestContext = { ...a, permissions: new Set() };
  await assert.rejects(() => service.schedule(forbidden, input()), (error: unknown) => error instanceof PlatformError && error.code === "FORBIDDEN");
});

test("channel adapters route localized email and tenant-scoped in-app delivery", async () => {
  const { a } = context();
  const templates = new NotificationTemplateRegistry();
  templates.register("invoice_ready", "hi-IN", (payload) => ({ subject: `इनवॉइस ${String(payload.invoice)}`, body: "आपका इनवॉइस तैयार है।" }));
  const email: { to: string; subject: string; body: string }[] = [];
  const inApp = new InAppNotificationAdapter();
  const transport = new ChannelNotificationTransport({
    email: new EmailNotificationAdapter({ async send(message) { email.push(message); } }, templates),
    in_app: inApp,
  });
  const service = new NotificationService(transport);
  await service.schedule(a, input({ locale: "hi-IN", payload: { invoice: "INV-1" } }));
  const inAppItem = await service.schedule(a, input({ recipientId: "owner", recipientRole: "owner", channel: "in_app", deduplicationKey: "invoice:2" }));
  await service.deliverDue(a);
  assert.deepEqual(email, [{ to: "customer", subject: "इनवॉइस INV-1", body: "आपका इनवॉइस तैयार है।" }]);
  assert.equal(inApp.forRecipient(a, "owner")[0]!.id, inAppItem.id);
});
