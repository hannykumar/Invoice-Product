/**
 * Issue #366 — the notification store on a real PostgreSQL, connected as the application role so
 * row-level security and the freeze rules of #368 are really in force.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import type { TransactionalExecutor } from "../src/database.ts";
import type { PostgresNotificationStore as Store } from "../src/postgres-notifications.ts";
import { notification, notificationStoreContract, type NotificationHarness } from "./notification-store-contract.ts";

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error("DATABASE_URL must be set in CI so the notification database tests run.");
const skip = url === undefined && "DATABASE_URL is not set";

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let PostgresNotificationStore: typeof Store;
const login = `invoice_app_test_${randomBytes(6).toString("hex")}`;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import("../src/database.ts");
  const { migrate } = await import("../src/migrations.ts");
  ({ PostgresNotificationStore } = await import("../src/postgres-notifications.ts"));
  owner = createDatabase(url);
  await migrate(owner);
  const password = randomBytes(18).toString("hex");
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const appUrl = new URL(url);
  appUrl.username = login;
  appUrl.password = password;
  app = createDatabase(appUrl.toString());
});
after(async () => {
  await app?.close();
  if (owner !== undefined) { await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

const company = async (): Promise<string> => {
  const companyId = randomUUID();
  await app.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Notification Traders')", [companyId]);
  return companyId;
};

const harness = (): NotificationHarness => ({
  store: new PostgresNotificationStore(app),
  company,
  write: (companyId, work) => app.unitOfWork(companyId, () => work()),
});

notificationStoreContract("postgres as the application role", harness, skip);

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

test("a write outside the action's transaction is refused, not committed on its own", { skip }, async () => {
  const { store } = harness();
  const a = await company();
  const item = notification(a);
  const writes: (() => Promise<void>)[] = [
    () => store.insert(item), () => store.update(item),
    () => store.appendEvent({ id: randomUUID(), notificationId: item.id, companyId: a, actorId: "owner", type: "scheduled", occurredAt: 0 }),
    () => store.savePreference({ companyId: a, recipientId: "owner", channel: "email", enabled: false }),
  ];
  for (const write of writes) await assert.rejects(write(), code("NO_UNIT_OF_WORK"));
  assert.equal(await store.find(a, item.id), null);
});

test("what a failed action scheduled is gone with it", { skip }, async () => {
  const { store } = harness();
  const a = await company();
  const item = notification(a);
  await assert.rejects(app.unitOfWork(a, async () => {
    await store.insert(item);
    await store.savePreference({ companyId: a, recipientId: "owner", channel: "email", enabled: false });
    throw new Error("abandoned");
  }), /abandoned/);
  assert.equal(await store.find(a, item.id), null);
  assert.equal(await store.preference(a, "owner", "email"), null);
});

test("every notification table is closed to other companies by the database itself", { skip }, async () => {
  const { rows } = await owner.query(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'notification%'
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`,
  );
  assert.deepEqual(rows, []);
  const [a, b] = [await company(), await company()];
  const theirs = notification(a);
  await app.unitOfWork(a, () => harness().store.insert(theirs));
  // A query that forgot its company filter still sees only its own company's rows.
  const seen = await app.tenantTransaction(b, (sql) => sql.query("SELECT count(*)::int AS n FROM notifications"));
  assert.equal(seen.rows[0]?.n, 0);
  // Nor can a company write an event into another company's timeline, under either company's name.
  await assert.rejects(app.unitOfWork(b, ({ sql }) => sql.query(
    "INSERT INTO notification_delivery_events (id, notification_id, company_id, event_type) VALUES ($1, $2, $3, 'opened')", [randomUUID(), theirs.id, a])), code("42501"));
  await assert.rejects(app.unitOfWork(b, ({ sql }) => sql.query(
    "INSERT INTO notification_delivery_events (id, notification_id, company_id, event_type) VALUES ($1, $2, $3, 'opened')", [randomUUID(), theirs.id, b])), code("23503"));
});

test("a delivered notification is finished, and the timeline cannot be rewritten or removed", { skip }, async () => {
  const { store } = harness();
  const a = await company();
  const item = notification(a);
  const delivered = { ...item, status: "delivered" as const, attempts: 1 };
  await app.unitOfWork(a, async () => {
    await store.insert(item);
    await store.appendEvent({ id: randomUUID(), notificationId: item.id, companyId: a, actorId: "owner", type: "scheduled", occurredAt: 0 });
    await store.update(delivered);
  });
  await assert.rejects(app.unitOfWork(a, () => store.update({ ...delivered, status: "scheduled" })), code("23001"));
  await assert.rejects(app.unitOfWork(a, () => store.update({ ...delivered, recipientId: "someone-else" })), code("23001"));
  await assert.rejects(app.unitOfWork(a, ({ sql }) => sql.query("UPDATE notification_delivery_events SET detail = 'rewritten' WHERE company_id = $1", [a])), code("23001"));
  await assert.rejects(app.unitOfWork(a, ({ sql }) => sql.query("DELETE FROM notification_delivery_events WHERE company_id = $1", [a])), code("42501"));
  await assert.rejects(app.unitOfWork(a, ({ sql }) => sql.query("DELETE FROM notifications WHERE company_id = $1", [a])), code("42501"));
  assert.deepEqual(await store.find(a, item.id), delivered);
});

test("the migration runs down and up again", { skip }, async () => {
  const { notificationMigrations } = await import("../src/notification-migrations.ts");
  const mine = notificationMigrations.at(-1)!;
  const { migrate } = await import("../src/migrations.ts");
  const { withScratchDatabase } = await import("./scratch-database.ts");
  await withScratchDatabase(owner, url as string, "notif_updown", async (scratch) => {
    await migrate(scratch);
    await scratch.query(mine.down);
    await scratch.query(mine.up);
    await scratch.query(mine.down);
    await scratch.query(mine.up);
  });
});
