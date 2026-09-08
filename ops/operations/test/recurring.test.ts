import assert from "node:assert/strict";
import test from "node:test";
import { AuditLog, type Permission, type RequestContext } from "../../../packages/platform/src/index.ts";
import { OperationalQueue } from "../src/operations.ts";
import { RECURRING_JOB_KEYS, standardRecurringJobs } from "../src/recurring-adapters.ts";
import { RecurringWorkRunner, type RecurringJobDefinition } from "../src/recurring.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const allPermissions = new Set<Permission>([
  "operations.read", "queue.replay", "compliance.calendar.refresh", "gsp.calls.reconcile",
  "notification.send", "eway.view", "collections.reminders.send",
]);
const actor = (companyId: string): RequestContext => ({
  companyId,
  branchId: `${companyId}-branch`,
  actorId: `${companyId}-recurring-service`,
  sessionId: `${companyId}-recurring-session`,
  permissions: allPermissions,
});

test("daily and hourly work run on a virtual clock and missed slots coalesce into one catch-up", async () => {
  let now = new Date("2026-09-01T00:00:00.000Z");
  const queue = new OperationalQueue(new AuditLog(), () => now);
  const runner = new RecurringWorkRunner(queue, () => now);
  const ran: string[] = [];
  const definition = (key: string, everyMs: number): RecurringJobDefinition => ({
    key, name: key, everyMs, requiredPermissions: [],
    async run(_context, scheduledFor) { ran.push(`${key}:${scheduledFor.toISOString()}`); },
  });
  runner.register(actor("company-a"), definition("daily", DAY));
  runner.register(actor("company-a"), definition("hourly", HOUR));

  assert.equal((await runner.runDue()).length, 2);
  now = new Date("2026-09-01T03:05:00.000Z");
  assert.equal((await runner.runDue()).length, 1);
  now = new Date("2026-09-03T04:00:00.000Z");
  assert.equal((await runner.runDue()).length, 2);
  assert.deepEqual(ran.filter((entry) => entry.startsWith("daily:")), [
    "daily:2026-09-01T00:00:00.000Z",
    "daily:2026-09-03T00:00:00.000Z",
  ]);
  assert.equal(runner.status(actor("company-a")).every((status) => status.outcome === "success"), true);
});

test("tenant schedules and operator visibility stay inside their company", async () => {
  const now = new Date("2026-09-01T00:00:00.000Z");
  const queue = new OperationalQueue(new AuditLog(), () => now);
  const runner = new RecurringWorkRunner(queue, () => now);
  const seen: string[] = [];
  const job: RecurringJobDefinition = {
    key: "same-key", name: "Same job, separate businesses", everyMs: HOUR, requiredPermissions: [],
    async run(context) { seen.push(context.companyId); },
  };
  runner.register(actor("company-a"), job);
  runner.register(actor("company-b"), job);
  await runner.runDue();
  assert.deepEqual(seen.sort(), ["company-a", "company-b"]);
  assert.deepEqual(runner.status(actor("company-a")).map((status) => status.companyId), ["company-a"]);
  assert.deepEqual(queue.list(actor("company-b")).map((item) => item.companyId), ["company-b"]);
});

test("failures retry through OperationalQueue and dead-letter at the declared attempt limit", async () => {
  let now = new Date("2026-09-01T00:00:00.000Z");
  const audit = new AuditLog();
  const queue = new OperationalQueue(audit, () => now);
  const runner = new RecurringWorkRunner(queue, () => now);
  let providerDown = true;
  runner.register(actor("company-a"), {
    key: "broken", name: "Broken job", everyMs: HOUR, requiredPermissions: [], maxAttempts: 2, retryDelayMs: MINUTE,
    async run() { if (providerDown) throw Object.assign(new Error("provider details stay private"), { code: "PROVIDER_DOWN" }); },
  });
  assert.equal((await runner.runDue())[0]?.outcome, "failure");
  now = new Date("2026-09-01T00:01:00.000Z");
  const dead = (await runner.runDue())[0];
  assert.equal(dead?.outcome, "dead_lettered");
  assert.equal(dead?.attempts, 2);
  assert.equal(dead?.lastErrorCode, "PROVIDER_DOWN");
  assert.equal(queue.list(actor("company-a")).length, 1, "a retry reuses the schedule-slot queue job");
  assert.equal(audit.forCompany(actor("company-a")).some((event) => event.action === "queue.dead_lettered"), true);

  providerDown = false;
  queue.replay(actor("company-a"), dead!.queueJobId!);
  assert.equal((await runner.runDue())[0]?.outcome, "success", "an operator replay is picked up on the next tick");
});

test("a hung job times out without blocking another job and remains overlap-protected", async () => {
  let now = new Date("2026-09-01T00:00:00.000Z");
  const queue = new OperationalQueue(new AuditLog(), () => now);
  const runner = new RecurringWorkRunner(queue, () => now);
  let release!: () => void;
  const hanging = new Promise<void>((resolve) => { release = resolve; });
  let fastRuns = 0;
  runner.register(actor("company-a"), {
    key: "hung", name: "Hung job", everyMs: MINUTE, requiredPermissions: [], timeoutMs: 10,
    async run() { await hanging; },
  });
  runner.register(actor("company-a"), {
    key: "fast", name: "Fast job", everyMs: MINUTE, requiredPermissions: [],
    async run() { fastRuns += 1; },
  });
  const first = await runner.runDue();
  assert.equal(first.find((status) => status.jobKey === "hung")?.lastErrorCode, "RECURRING_JOB_TIMED_OUT");
  assert.equal(first.find((status) => status.jobKey === "fast")?.outcome, "success");

  now = new Date("2026-09-01T00:01:00.000Z");
  const second = await runner.runDue();
  assert.deepEqual(second.map((status) => status.jobKey), ["fast"], "the still-running copy prevents overlap only for itself");
  assert.equal(fastRuns, 2);
  release();
  await hanging;
});

test("the standard catalogue calls all five existing periodic entry points with a service actor", async () => {
  const calls: string[] = [];
  const jobs = standardRecurringJobs({
    complianceCalendar: { async run(serviceActor) { calls.push(`calendar:${serviceActor.userId}`); return { raised: [] }; } },
    governmentReconciler: { async run(serviceActor) { calls.push(`government:${serviceActor.userId}`); return { checked: 0, conflicts: [] }; } },
    notifications: { async deliverDue(context) { calls.push(`notifications:${context.actorId}`); return []; } },
    ewayBills: { async expiringWithin(serviceActor, hours) { calls.push(`eway:${serviceActor.userId}:${hours}`); return []; } },
    collections: { async sendPlanned(serviceActor, today) { calls.push(`collections:${serviceActor.userId}:${today}`); return []; } },
  });
  assert.deepEqual(jobs.map((job) => job.key).sort(), Object.values(RECURRING_JOB_KEYS).sort());
  const now = new Date("2026-09-01T00:00:00.000Z");
  const runner = new RecurringWorkRunner(new OperationalQueue(new AuditLog(), () => now), () => now);
  for (const recurringJob of jobs) runner.register(actor("company-a"), recurringJob);
  assert.equal((await runner.runDue()).length, 5);
  assert.equal(calls.length, 5);
  assert.equal(calls.every((entry) => entry.includes("company-a-recurring-service")), true);
});

test("registration refuses implicit trust or a service actor missing a job permission", () => {
  const now = new Date("2026-09-01T00:00:00.000Z");
  const runner = new RecurringWorkRunner(new OperationalQueue(new AuditLog(), () => now), () => now);
  const job: RecurringJobDefinition = { key: "secure", name: "Secure", everyMs: MINUTE, requiredPermissions: ["notification.send"], async run() {} };
  assert.throws(() => runner.register({ ...actor("company-a"), actorId: "" }, job), /SERVICE_ACTOR/);
  assert.throws(() => runner.register({ ...actor("company-a"), permissions: new Set<Permission>(["queue.replay"]) }, job), /NOTIFICATION_SEND/);
});
