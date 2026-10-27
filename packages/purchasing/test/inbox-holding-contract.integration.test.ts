/**
 * Issue #488 — the purchase inbox holding on a real PostgreSQL, connected as the application role
 * so row-level security and the function grants are really in force. The owner connection only
 * sets the scene and looks behind the wall.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import type { TransactionalExecutor } from "../../platform/src/database.ts";
import type { PostgresInboxHolding as Holding } from "../src/inbox-holding-postgres.ts";
import type { PostgresInboxStore as Store } from "../src/inbox-postgres.ts";
import { inboxHoldingContract, type HoldingHarness } from "./inbox-holding-contract.ts";

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error("DATABASE_URL must be set in CI so the purchase inbox holding tests run.");
const skip = url === undefined && "DATABASE_URL is not set";

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let PostgresInboxHolding: typeof Holding;
let PostgresInboxStore: typeof Store;
const login = `invoice_app_holding_${randomBytes(6).toString("hex")}`;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import("../../platform/src/database.ts");
  const { migrate } = await import("../../platform/src/migrations.ts");
  ({ PostgresInboxHolding } = await import("../src/inbox-holding-postgres.ts"));
  ({ PostgresInboxStore } = await import("../src/inbox-postgres.ts"));
  owner = createDatabase(url);
  await migrate(owner);
  // What a deployment does once: a login for the server, with nothing but membership of invoice_app.
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

// Each call is a new handle on the same database: a restarted process.
const harness = (): HoldingHarness => ({
  holding: () => new PostgresInboxHolding(app),
  store: () => new PostgresInboxStore(app),
  transactional: true,
  company: async () => {
    const id = randomUUID();
    await owner.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Holding Traders')", [id]);
    return id;
  },
  write: (companyId, work) => app.unitOfWork(companyId, () => work()),
});

inboxHoldingContract("postgres", harness, skip);

const asApp = (text: string, values: unknown[] = []) => app.query(text, values);

test("postgres: the application role has no privilege on the holding's tables, only on its functions", { skip }, async () => {
  for (const table of ["purchase_inbox_holding", "purchase_inbox_holding_trail"]) {
    await assert.rejects(asApp(`SELECT * FROM ${table}`), /permission denied/);
    await assert.rejects(asApp(`DELETE FROM ${table}`), /permission denied/);
    await assert.rejects(asApp(`INSERT INTO ${table} DEFAULT VALUES`), /permission denied/);
  }
  const { rows } = await owner.query(
    `SELECT p.proname, p.prosecdef, r.rolname AS owner FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.proname LIKE 'purchase_holding_%' ORDER BY 1`);
  assert.equal(rows.length, 10);
  for (const row of rows) { assert.equal(row.prosecdef, true, String(row.proname)); assert.equal(row.owner, "invoice_inbox_holder", String(row.proname)); }
});

test("postgres: row-level security is forced on the holding, and no policy lets a company or the application role in", { skip }, async () => {
  const { rows } = await owner.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
            (SELECT array_agg(pol.polroles::regrole[]::text) FROM pg_policy pol WHERE pol.polrelid = c.oid) AS roles
       FROM pg_class c WHERE c.relname IN ('purchase_inbox_holding', 'purchase_inbox_holding_trail') ORDER BY 1`);
  for (const row of rows) {
    assert.equal(row.relrowsecurity, true);
    assert.equal(row.relforcerowsecurity, true);
    assert.deepEqual(row.roles, ["{invoice_inbox_holder}"], `${row.relname} is open to someone it should not be`);
  }
});

test("postgres: the holding has no column that could carry a document's contents", { skip }, async () => {
  const { rows } = await owner.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'purchase_inbox_holding' ORDER BY ordinal_position");
  assert.deepEqual(rows.map((row) => row.column_name), ["id", "channel", "message_key", "intake_key", "received_at", "status", "quarantine_reason", "status_message", "storage_key", "owners", "metadata"]);
  assert.equal(rows.some((row) => row.data_type === "bytea"), false);
});

test("postgres: a company's functions read the company from the session, so a stranger's session finds nothing", { skip }, async () => {
  const h = harness();
  const [a, stranger] = [await h.company(), await h.company()];
  const id = randomUUID();
  await asApp("SELECT purchase_holding_put($1, 'email', NULL, 'k', now(), 'quarantined', 'COMPANY_NOT_IDENTIFIED', 'm', 'held/x', $2::uuid[], $3::jsonb)",
    [id, [a], JSON.stringify({ sender: { channel: "email", address: "x@y.example" }, attachment: { id: "1", fileName: "bill.pdf", declaredMimeType: "application/pdf", sizeBytes: 5, sha256: "0".repeat(64) }, delivery: {} })]);
  // Called with no company at all, or with somebody else's, the lookups give nothing.
  assert.deepEqual((await asApp("SELECT * FROM purchase_holding_waiting()")).rows, []);
  const asStranger = await app.tenantTransaction(stranger, (sql) => sql.query("SELECT id FROM purchase_holding_waiting() UNION ALL SELECT id FROM purchase_holding_peek($1)", [id]));
  assert.deepEqual(asStranger.rows, []);
  const asOwner = await app.tenantTransaction(a, (sql) => sql.query("SELECT id FROM purchase_holding_waiting()"));
  assert.deepEqual(asOwner.rows.map((row) => row.id), [id]);
});

test("postgres: a claim that is rolled back leaves the document in the holding", { skip }, async () => {
  const h = harness();
  const a = await h.company();
  const holding = h.holding();
  const id = randomUUID();
  await asApp("SELECT purchase_holding_put($1, 'email', NULL, 'k2', now(), 'quarantined', 'COMPANY_NOT_IDENTIFIED', 'm', 'held/y', $2::uuid[], $3::jsonb)",
    [id, [a], JSON.stringify({ sender: { channel: "email", address: "x@y.example" }, attachment: { id: "1", fileName: "bill.pdf", declaredMimeType: "application/pdf", sizeBytes: 5, sha256: "0".repeat(64) }, delivery: {} })]);
  await assert.rejects(h.write(a, async () => {
    assert.ok(await holding.claim(a, id));
    throw new Error("the move into the books failed");
  }), /failed/);
  assert.ok(await holding.get(id));
  assert.equal((await holding.waitingFor(a)).length, 1);
});

test("postgres: every lookup of owners, claim and expiry is on the trail, by id and verb only", { skip }, async () => {
  const h = harness();
  const a = await h.company();
  const id = randomUUID();
  const meta = JSON.stringify({ sender: { channel: "email", address: "x@y.example" }, attachment: { id: "1", fileName: "bill.pdf", declaredMimeType: "application/pdf", sizeBytes: 5, sha256: "0".repeat(64) }, delivery: {} });
  await asApp("SELECT purchase_holding_put($1, 'email', NULL, 'k3', '2019-01-01', 'quarantined', 'COMPANY_NOT_IDENTIFIED', 'm', 'held/z', $2::uuid[], $3::jsonb)", [id, [a], meta]);
  await h.holding().channelOwners(id);
  await h.holding().expire(new Date("2020-01-01"));
  const { rows } = await owner.query("SELECT action, company_id, storage_key FROM purchase_inbox_holding_trail WHERE held_id = $1 ORDER BY at, action", [id]);
  assert.deepEqual(rows.map((row) => row.action).sort(), ["expired", "owners_looked_up", "received"]);
  assert.equal(rows.find((row) => row.action === "expired")?.storage_key, "held/z");
  // The trail outlives the row, and an application cannot rewrite it.
  await assert.rejects(asApp("DELETE FROM purchase_inbox_holding_trail"), /permission denied/);
});
