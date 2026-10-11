/**
 * Issue #364 — the platform core on a real PostgreSQL.
 *
 *  - The same contract suite the in-memory classes pass (platform-contract.ts).
 *  - "Done when" 1: after a restart the audit trail is intact, a retried "record sale" with the same
 *    key returns the original bill, and open exceptions are still open.
 *  - "Done when" 2: two simultaneous requests with one idempotency key, on two server processes,
 *    produce exactly one command.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { after, before } from "node:test";
import type { TransactionalExecutor } from "../src/database.ts";
import { CONTRACT_POLICIES, platformContract, type PlatformHarness } from "./platform-contract.ts";

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error("DATABASE_URL must be set in CI so the platform core database tests run.");
const skip = url === undefined && "DATABASE_URL is not set";

let db: TransactionalExecutor;
let harness: PlatformHarness;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import("../src/database.ts");
  const { migrate } = await import("../src/migrations.ts");
  const { PostgresAuditLog } = await import("../src/postgres-audit.ts");
  const { PostgresAccessControl, PostgresAuthenticationService, PostgresCommandService, PostgresExceptionQueue } = await import("../src/postgres-platform.ts");
  const { PILOT_TABLES } = await import("../../sales/test/record-sale-pilot.ts");
  db = createDatabase(url);
  await migrate(db);
  await db.query(PILOT_TABLES);
  const audit = new PostgresAuditLog(db);
  const access = new PostgresAccessControl(db);
  harness = {
    audit, access,
    commands: new PostgresCommandService(db, audit, CONTRACT_POLICIES),
    exceptions: new PostgresExceptionQueue(db, audit),
    auth: (now) => new PostgresAuthenticationService(db, access, now),
    company: async () => {
      const ids = { companyId: crypto.randomUUID(), branchId: crypto.randomUUID() };
      await db.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Platform Traders')", [ids.companyId]);
      await db.query("INSERT INTO branches (id, company_id, name) VALUES ($1, $2, 'Main shop')", [ids.branchId, ids.companyId]);
      return ids;
    },
    user: async () => {
      const id = crypto.randomUUID();
      await db.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Synthetic person')", [id, `platform-${id}@example.invalid`]);
      return id;
    },
  };
});
after(async () => { await db?.close(); });

platformContract("postgres", () => harness, skip);

/** Starts a separate server process and returns what it printed. */
const server = async <T>(phase: string, args: Record<string, unknown>): Promise<T> => {
  const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./platform-core-child.ts", import.meta.url)), phase, JSON.stringify(args)], { env: { ...process.env, DATABASE_URL: url } });
  return JSON.parse(stdout.trim().split("\n").at(-1) as string) as T;
};
interface Sale { commandId: string; billId: string; billNumber: string; deduplicated: boolean }
type Rows = Record<string, number>;

test("after a restart: yesterday's audit trail is intact, a retried sale returns the original bill, held exceptions are still open", { skip }, async () => {
  const ids = { companyId: crypto.randomUUID(), branchId: crypto.randomUUID(), userId: crypto.randomUUID(), partyId: crypto.randomUUID() };
  const yesterday = await server<{ sessionId: string; exceptionId: string; sale: Sale; rows: Rows }>("sell", ids);
  assert.equal(yesterday.sale.billNumber, "INV/26-27/000001");
  assert.equal(yesterday.sale.deduplicated, false);

  // That process has exited. Nothing it knew is in memory anywhere.
  const today = await server<{ trailBefore: string[]; trailAfter: string[]; sale: Sale; open: { id: string; status: string; summary: string; evidence: string[] }[]; rows: Rows }>("after-restart", { ...ids, sessionId: yesterday.sessionId });

  assert.deepEqual(today.trailBefore.slice(-5), ["exception.created", "sale.record.created", "sales.draft_created", "ledger.voucher_posted", "sales.invoice_finalised"], "the trail for yesterday's bill is all there, in order");
  assert.deepEqual(today.sale, { ...yesterday.sale, deduplicated: true }, "the retry returned the original command and the original bill");
  assert.deepEqual(today.trailAfter, today.trailBefore, "the retry recorded nothing new");
  assert.deepEqual(today.rows, yesterday.rows, "and saved nothing new: one bill, one entry, one stock movement");
  assert.deepEqual(today.open, [{ id: yesterday.exceptionId, status: "open", summary: "The supplier's GST number on this bill does not match our records", evidence: ["bill-photo-1"] }]);
});

test("two servers receiving the same request at the same moment create exactly one command", { skip }, async () => {
  for (let round = 0; round < 3; round += 1) {
    const { companyId, branchId } = await harness.company();
    const userId = await harness.user();
    await harness.access.grant({ companyId, userId, branchIds: new Set([branchId]), active: true, permissions: new Set(["sale.draft.create"]) });
    const startAt = Date.now() + 1500; // both processes are up and waiting before the gun
    const results = await Promise.all([1, 2, 3, 4].map(() => server<{ commandId: string }>("race", { companyId, branchId, userId, startAt })));
    assert.equal(new Set(results.map((result) => result.commandId)).size, 1, "every server answered with the same command");
    const count = async (table: string) => Number((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE company_id = $1`, [companyId])).rows[0]?.n);
    assert.equal(await count("command_records"), 1);
    assert.equal(await count("idempotency_keys"), 1);
    assert.equal(await count("audit_events"), 1);
  }
});
