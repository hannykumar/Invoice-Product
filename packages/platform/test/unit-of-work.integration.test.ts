/**
 * Issue #363 — the contract tests for docs/contracts/unit-of-work-v1.md, on a real PostgreSQL.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import type { TransactionalExecutor, UnitOfWork } from "../src/database.ts";
import type { OutboxMessage } from "../src/outbox.ts";

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error("DATABASE_URL must be set in CI so the unit-of-work contract tests run.");
const skip = url === undefined && "DATABASE_URL is not set";

let db: TransactionalExecutor;
let other: TransactionalExecutor;
let OutboxRelay: typeof import("../src/outbox.ts").OutboxRelay;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import("../src/database.ts");
  const { migrate } = await import("../src/migrations.ts");
  ({ OutboxRelay } = await import("../src/outbox.ts"));
  db = createDatabase(url);
  other = createDatabase(url); // stands in for a second server process
  await migrate(db);
});
after(async () => { await db?.close(); await other?.close(); });

const company = async (): Promise<string> => {
  const id = randomUUID();
  await db.query("INSERT INTO companies (id, legal_name) VALUES ($1, $2)", [id, "Synthetic Unit Of Work Traders"]);
  return id;
};
const message = (key: string) => ({ topic: "test.send", dedupeKey: key, payload: { key, amountPaise: 12345n } });
const rows = async (companyId: string) =>
  (await db.tenantTransaction(companyId, (sql) => sql.query("SELECT * FROM outbox_messages WHERE company_id = $1 ORDER BY created_at, dedupe_key", [companyId]))).rows;
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

test("an action that succeeds is saved whole; one that fails leaves nothing", { skip }, async () => {
  const id = await company();
  assert.equal(await db.unitOfWork(id, async (uow) => { await uow.enqueue(message("kept")); return "done"; }), "done");
  await assert.rejects(db.unitOfWork(id, async (uow) => {
    await uow.enqueue(message("lost"));
    throw new Error("the stock was not there");
  }), /the stock was not there/);
  assert.deepEqual((await rows(id)).map((r) => r.dedupe_key), ["kept"]);
});

test("a nested action joins the open transaction; if it fails, only its own part is undone", { skip }, async () => {
  const id = await company();
  let outerPid: unknown;
  await db.unitOfWork(id, async (uow) => {
    outerPid = (await uow.sql.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
    await uow.enqueue(message("outer"));
    await db.unitOfWork(id, async (inner) => {
      assert.equal((await inner.sql.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid, outerPid, "the nested action is on the same connection");
      await inner.enqueue(message("inner-kept"));
    });
    await assert.rejects(db.unitOfWork(id, async (inner) => {
      await inner.enqueue(message("inner-lost"));
      throw new Error("the receipt was refused");
    }), /the receipt was refused/);
  });
  assert.deepEqual((await rows(id)).map((r) => r.dedupe_key).sort(), ["inner-kept", "outer"]);
});

test("reads inside an action use its connection and see what it has written so far", { skip }, async () => {
  const id = await company();
  await db.unitOfWork(id, async (uow) => {
    const pid = (await uow.sql.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
    await uow.enqueue(message("draft"));
    const viaTenant = await db.tenantTransaction(id, (sql) => sql.query("SELECT pg_backend_pid() AS pid, (SELECT count(*)::int FROM outbox_messages WHERE company_id = $1) AS seen", [id]));
    const viaQuery = await db.query("SELECT pg_backend_pid() AS pid, (SELECT count(*)::int FROM outbox_messages WHERE company_id = $1) AS seen", [id]);
    assert.deepEqual(viaTenant.rows[0], { pid, seen: 1 });
    assert.deepEqual(viaQuery.rows[0], { pid, seen: 1 });
    // Many reads at once must not ask the pool for a connection each: the pool has five.
    const many = await Promise.all(Array.from({ length: 12 }, () => db.tenantTransaction(id, (sql) => sql.query("SELECT pg_backend_pid() AS pid"))));
    assert.ok(many.every((r) => r.rows[0]?.pid === pid));
  });
});

test("one action cannot touch two companies", { skip }, async () => {
  const [a, b] = [await company(), await company()];
  await assert.rejects(db.unitOfWork(a, async () => { await db.unitOfWork(b, async (uow) => uow.enqueue(message("b"))); }), code("TENANT_ISOLATION"));
  await assert.rejects(db.unitOfWork(a, async () => { await db.tenantTransaction(b, (sql) => sql.query("SELECT 1")); }), code("TENANT_ISOLATION"));
  await assert.rejects(db.unitOfWork(a, async () => { db.requireUnitOfWork(b); }), code("TENANT_ISOLATION"));
  assert.equal((await rows(b)).length, 0);
});

test("row-level security: an action sees and writes only its own company's rows", { skip }, async () => {
  const [a, b] = [await company(), await company()];
  await db.unitOfWork(a, (uow) => uow.enqueue(message("a-only")));
  // The policy is enforced for roles that are not superusers; the application role of #368 is one.
  await db.query("DROP ROLE IF EXISTS uow_contract_reader");
  await db.query("CREATE ROLE uow_contract_reader");
  await db.query("GRANT SELECT, INSERT ON outbox_messages TO uow_contract_reader");
  try {
    await db.unitOfWork(b, async (uow) => {
      await uow.sql.query("SET LOCAL ROLE uow_contract_reader");
      assert.equal((await uow.sql.query("SELECT count(*)::int AS n FROM outbox_messages")).rows[0]?.n, 0, "company B cannot read company A's row");
      await uow.sql.query("SAVEPOINT attempt");
      await assert.rejects(
        uow.sql.query("INSERT INTO outbox_messages (id, company_id, topic, dedupe_key, payload) VALUES ($1, $2, 't', 'k', '{}')", [randomUUID(), a]),
        code("42501"),
        "company B cannot write a row for company A",
      );
      await uow.sql.query("ROLLBACK TO SAVEPOINT attempt");
    });
  } finally {
    await db.query("REVOKE ALL ON outbox_messages FROM uow_contract_reader");
    await db.query("DROP ROLE uow_contract_reader");
  }
});

test("a write outside an action is refused instead of being saved on its own", { skip }, async () => {
  const id = await company();
  assert.throws(() => db.requireUnitOfWork(id), code("NO_UNIT_OF_WORK"));
});

test("a database error that was swallowed cannot turn into a half-saved action", { skip }, async () => {
  const id = await company();
  await assert.rejects(db.unitOfWork(id, async (uow) => {
    await uow.enqueue(message("before"));
    try { await uow.sql.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'duplicate')", [id]); } catch { /* swallowed on purpose */ }
  }), code("UNIT_OF_WORK_ABORTED"));
  assert.equal((await rows(id)).length, 0);
});

test("a finished action's connection cannot be used again", { skip }, async () => {
  const id = await company();
  let kept: UnitOfWork | undefined;
  let late: Promise<unknown> | undefined;
  await db.unitOfWork(id, async (uow) => {
    kept = uow;
    // A fire-and-forget task started inside the action, running after it has finished.
    late = new Promise((resolve) => setTimeout(resolve, 50)).then(() => db.requireUnitOfWork(id));
  });
  await assert.rejects((kept as UnitOfWork).sql.query("SELECT 1"), code("UNIT_OF_WORK_ABORTED"));
  await assert.rejects((kept as UnitOfWork).enqueue(message("late")), code("UNIT_OF_WORK_ABORTED"));
  await assert.rejects(late as Promise<unknown>, code("NO_UNIT_OF_WORK"));
  assert.equal((await rows(id)).length, 0);
});

test("two servers never run two actions for one company at the same time", { skip }, async () => {
  const id = await company();
  const events: string[] = [];
  const action = (database: TransactionalExecutor, name: string) => database.unitOfWork(id, async (uow) => {
    events.push(`${name}:start`);
    await uow.sql.query("SELECT pg_sleep(0.2)");
    events.push(`${name}:end`);
  });
  await Promise.all([action(db, "first"), action(other, "second")]);
  assert.equal(events.length, 4);
  assert.equal(events[0]?.split(":")[0], events[1]?.split(":")[0], `actions overlapped: ${events.join(", ")}`);
});

test("outbox: queuing the same message twice keeps one row", { skip }, async () => {
  const id = await company();
  await db.unitOfWork(id, async (uow) => { await uow.enqueue(message("irn-1")); await uow.enqueue(message("irn-1")); });
  await db.unitOfWork(id, (uow) => uow.enqueue(message("irn-1")));
  const stored = await rows(id);
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0]?.payload, { key: "irn-1", amountPaise: "12345" });
});

test("outbox: nothing is sent before the action commits, and nothing at all if it rolls back", { skip }, async () => {
  const id = await company();
  const sent: string[] = [];
  const handlers = { "test.send": async (m: OutboxMessage) => { sent.push(m.dedupeKey); } };
  const relay = new OutboxRelay(db);
  await db.unitOfWork(id, async (uow) => {
    await uow.enqueue(message("committed"));
    assert.deepEqual(await relay.drain(id, handlers), { sent: 0, failed: 0 }, "the relay ran inside the action and still saw nothing");
  });
  await assert.rejects(db.unitOfWork(id, async (uow) => { await uow.enqueue(message("rolled-back")); throw new Error("no"); }));
  assert.deepEqual(await relay.drain(id, handlers), { sent: 1, failed: 0 });
  assert.deepEqual(await relay.drain(id, handlers), { sent: 0, failed: 0 }, "a sent message is not sent again");
  assert.deepEqual(sent, ["committed"]);
});

test("outbox: two relays draining at once send each message exactly once", { skip }, async () => {
  const id = await company();
  await db.unitOfWork(id, async (uow) => { for (let i = 0; i < 10; i += 1) await uow.enqueue(message(`m-${i}`)); });
  const sent: string[] = [];
  const handlers = { "test.send": async (m: OutboxMessage) => { await new Promise((r) => setTimeout(r, 5)); sent.push(m.dedupeKey); } };
  const results = await Promise.all([new OutboxRelay(db).drain(id, handlers), new OutboxRelay(other).drain(id, handlers)]);
  assert.equal(results[0].sent + results[1].sent, 10);
  assert.equal(new Set(sent).size, 10);
  assert.equal(sent.length, 10);
});

test("outbox: a failed send is kept with its error, retried later, and marked dead after the last attempt", { skip }, async () => {
  const id = await company();
  await db.unitOfWork(id, (uow) => uow.enqueue(message("poison")));
  const relay = new OutboxRelay(db, { maxAttempts: 2 });
  const failing = { "test.send": async () => { throw new Error("the portal is down"); } };
  assert.deepEqual(await relay.drain(id, failing), { sent: 0, failed: 1 });
  let [row] = await rows(id);
  assert.equal(row?.last_error, "the portal is down");
  assert.equal(row?.attempts, 1);
  assert.equal(row?.dead_at, null);
  assert.ok((row?.available_at as Date).getTime() > Date.now() + 20_000, "the retry waits");
  assert.deepEqual(await relay.drain(id, failing), { sent: 0, failed: 0 }, "not due yet");
  await db.tenantTransaction(id, (sql) => sql.query("UPDATE outbox_messages SET available_at = now() WHERE company_id = $1", [id]));
  assert.deepEqual(await relay.drain(id, failing), { sent: 0, failed: 1 });
  [row] = await rows(id);
  assert.ok(row?.dead_at instanceof Date, "given up, and still there for a person to see");
  await db.tenantTransaction(id, (sql) => sql.query("UPDATE outbox_messages SET available_at = now() WHERE company_id = $1", [id]));
  assert.deepEqual(await relay.drain(id, failing), { sent: 0, failed: 0 }, "a dead message is not retried");
});

test("outbox: what the handler saves commits with the sent mark, and a relay that lost its lease saves nothing", { skip }, async () => {
  const id = await company();
  await db.unitOfWork(id, (uow) => uow.enqueue(message("first")));
  const relay = new OutboxRelay(db);
  // The handler's save step queues the follow-up message (an e-way bill after its IRN).
  assert.deepEqual(await relay.drain(id, { "test.send": async () => (uow) => uow.enqueue({ topic: "test.followup", dedupeKey: "second", payload: {} }) }), { sent: 1, failed: 0 });
  assert.deepEqual((await rows(id)).map((r) => [r.dedupe_key, r.sent_at !== null]), [["first", true], ["second", false]]);

  // Another relay takes the message over while this one's handler is still running.
  await db.unitOfWork(id, (uow) => uow.enqueue(message("contested")));
  const result = await relay.drain(id, {
    "test.send": async () => {
      await db.tenantTransaction(id, (sql) => sql.query("UPDATE outbox_messages SET claim_token = gen_random_uuid() WHERE company_id = $1 AND dedupe_key = 'contested'", [id]));
      return (uow) => uow.enqueue({ topic: "test.followup", dedupeKey: "must-not-exist", payload: {} });
    },
  });
  assert.deepEqual(result, { sent: 0, failed: 1 });
  const after = await rows(id);
  assert.ok(!after.some((r) => r.dedupe_key === "must-not-exist"));
  assert.equal(after.find((r) => r.dedupe_key === "contested")?.sent_at, null);
});

test("outbox: a handler that outlives its lease is abandoned before another relay may take the message", { skip }, async () => {
  const id = await company();
  await db.unitOfWork(id, (uow) => uow.enqueue(message("slow")));
  let aborted = false;
  const relay = new OutboxRelay(db, { leaseSeconds: 1 });
  const started = Date.now();
  const result = await relay.drain(id, {
    "test.send": (_m, signal) => new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => { aborted = true; });
      setTimeout(resolve, 3000).unref();
    }),
  });
  assert.deepEqual(result, { sent: 0, failed: 1 });
  assert.ok(aborted);
  assert.ok(Date.now() - started < 1000, "gave up at half the lease");
});
