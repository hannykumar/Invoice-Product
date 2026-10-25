/**
 * Issue #366 — the purchase inbox store contract on a real PostgreSQL, connected as the
 * application role so row-level security and #368's rules are really in force. The owner
 * connection only sets the scene.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";
import type { TransactionalExecutor } from "../../platform/src/database.ts";
import type { PostgresInboxStore as Store } from "../src/inbox-postgres.ts";
import { documentFor, inboxStoreContract, type InboxHarness } from "./inbox-store-contract.ts";

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error("DATABASE_URL must be set in CI so the purchase inbox database tests run.");
const skip = url === undefined && "DATABASE_URL is not set";

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let PostgresInboxStore: typeof Store;
const login = `invoice_app_inbox_${randomBytes(6).toString("hex")}`;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import("../../platform/src/database.ts");
  const { migrate } = await import("../../platform/src/migrations.ts");
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

const harness = (): InboxHarness => ({
  store: new PostgresInboxStore(app),
  requiresUnitOfWork: true,
  company: async () => {
    const id = crypto.randomUUID();
    await owner.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Inbox Traders')", [id]);
    return id;
  },
  write: (companyId, work) => app.unitOfWork(companyId, () => work()),
});

inboxStoreContract("postgres", harness, skip);

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const inCompany = (companyId: string, text: string, values: unknown[] = []) => app.unitOfWork(companyId, ({ sql }) => sql.query(text, values));

test("postgres: a document is frozen once it is draft-ready or discarded, and nothing is ever deleted", { skip }, async () => {
  const h = harness();
  const a = await h.company();
  const [ready, open] = [documentFor(a, 1), documentFor(a, 2)];
  await h.write(a, async () => {
    await h.store.insertDocument(ready, { messageKey: null, intakeKey: "k1" });
    await h.store.insertDocument(open, { messageKey: null, intakeKey: "k2" });
  });
  await h.write(a, () => h.store.updateDocument({ ...ready, status: "draft_ready", statusMessage: "Read." }));
  await assert.rejects(h.write(a, () => h.store.updateDocument({ ...ready, status: "extracting" })), code("23001"));
  await assert.rejects(inCompany(a, "UPDATE purchase_inbox_documents SET status_message = 'x' WHERE id = $1", [ready.id]), code("23001"));
  // What arrived is not the application's to change, even while the document is still moving.
  await assert.rejects(inCompany(a, "UPDATE purchase_inbox_documents SET storage_key = 'elsewhere' WHERE id = $1", [open.id]), code("42501"));
  await assert.rejects(inCompany(a, "DELETE FROM purchase_inbox_documents WHERE id = $1", [open.id]), code("42501"));
  await assert.rejects(owner.query("DELETE FROM purchase_inbox_documents WHERE id = $1", [ready.id]), code("23001"));
  await assert.rejects(owner.query("TRUNCATE purchase_inbox_drafts"), code("23001"));
  assert.equal((await h.store.document(a, ready.id))?.status, "draft_ready");
});

test("postgres: row-level security keeps each company to its own rows", { skip }, async () => {
  const h = harness();
  const [a, b] = [await h.company(), await h.company()];
  await h.write(a, () => h.store.insertDocument(documentFor(a, 1), { messageKey: null, intakeKey: "k" }));
  const seen = await app.tenantTransaction(b, (sql) => sql.query("SELECT count(*)::int AS n FROM purchase_inbox_documents"));
  assert.equal(seen.rows[0]?.n, 0);
  await assert.rejects(inCompany(b, "INSERT INTO purchase_inbox_contents (company_id, sha256, document_id) VALUES ($1, $2, $3)", [a, "0".repeat(64), crypto.randomUUID()]), code("42501"));
  const tables = ["purchase_inbox_documents", "purchase_inbox_contents", "purchase_inbox_drafts"];
  const { rows } = await owner.query("SELECT relname FROM pg_class WHERE relname = ANY($1) AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity", [tables]);
  assert.deepEqual(rows.map((r) => String(r.relname)).sort(), [...tables].sort());
});
