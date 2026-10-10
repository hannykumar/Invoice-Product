/**
 * Issue #368 — "posted records never change" enforced by PostgreSQL, and the application's
 * least-privilege role. Contract: docs/contracts/database-immutability-v1.md.
 *
 * "Done when": a test connecting as the application role tries to edit a posted bill's amount,
 * delete a voucher, and delete an audit row — all three are refused by the database.
 *
 * Two connections are used throughout: `owner` (what migrations run as) and `app` (a login that is
 * only a member of `invoice_app`, which is what the server connects as). The same rules are shown
 * to hold for the owner too, so they do not depend on who is asking.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";
import type { TransactionalExecutor } from "../src/database.ts";
import { CONTRACT_POLICIES, platformContract, type PlatformHarness } from "./platform-contract.ts";

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error("DATABASE_URL must be set in CI so the immutability database tests run.");
const skip = url === undefined && "DATABASE_URL is not set";

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let appHarness: PlatformHarness;
let pilot: typeof import("../../sales/test/record-sale-pilot.ts");
const login = `invoice_app_test_${randomBytes(6).toString("hex")}`;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import("../src/database.ts");
  const { migrate } = await import("../src/migrations.ts");
  const { PostgresAuditLog } = await import("../src/postgres-audit.ts");
  const { PostgresAccessControl, PostgresAuthenticationService, PostgresCommandService, PostgresExceptionQueue } = await import("../src/postgres-platform.ts");
  pilot = await import("../../sales/test/record-sale-pilot.ts");
  owner = createDatabase(url);
  await migrate(owner);
  await owner.query(pilot.PILOT_TABLES);
  // What a deployment does once: a login for the server, with nothing but membership of invoice_app.
  const password = randomBytes(18).toString("hex");
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const appUrl = new URL(url);
  appUrl.username = login;
  appUrl.password = password;
  app = createDatabase(appUrl.toString());
  const audit = new PostgresAuditLog(app);
  const access = new PostgresAccessControl(app);
  appHarness = {
    audit, access,
    commands: new PostgresCommandService(app, audit, CONTRACT_POLICIES),
    exceptions: new PostgresExceptionQueue(app, audit),
    auth: (now) => new PostgresAuthenticationService(app, access, now),
    company: async () => {
      const ids = { companyId: crypto.randomUUID(), branchId: crypto.randomUUID() };
      await app.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Immutable Traders')", [ids.companyId]);
      await app.query("INSERT INTO branches (id, company_id, name) VALUES ($1, $2, 'Main shop')", [ids.branchId, ids.companyId]);
      return ids;
    },
    user: async () => {
      const id = crypto.randomUUID();
      await app.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Synthetic person')", [id, `immutable-${id}@example.invalid`]);
      return id;
    },
  };
});
after(async () => {
  await app?.close();
  if (owner !== undefined) { await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

const refused = (...codes: string[]) => (error: unknown) => codes.includes((error as { code?: string }).code ?? "");
/** Refused because the role may not do it at all. */
const NO_PRIVILEGE = "42501";
/** Refused by an immutability trigger of this issue. */
const FROZEN = "23001";

/** A shop that has sold one bill (a real posted voucher and its audit trail) and has one posted purchase bill. */
const shopWithPostedRecords = async () => {
  const ids = { companyId: crypto.randomUUID(), userId: crypto.randomUUID(), partyId: crypto.randomUUID() };
  const shop = pilot.makePilot(app, ids);
  await shop.setUp();
  const sale = await shop.recordSale("r1"); // recorded as the application role: its ordinary work is not in the way
  await owner.query("INSERT INTO master_records (id, company_id, kind) VALUES ($1, $2, 'party')", [ids.partyId, ids.companyId]);
  const billId = crypto.randomUUID();
  await app.tenantTransaction(ids.companyId, (sql) => sql.query(
    `INSERT INTO purchase_bills (id, company_id, purchase_id, source_document_id, supplier_party_id, supplier_name, invoice_number, invoice_date, due_date,
       total_paise, taxable_value_paise, intra_state, reverse_charge, state, voucher_id, summary, posted_by, idempotency_key)
     VALUES ($1, $2, 'P-1', 'doc-1', $3, 'Synthetic Supplier', 'SUP/001', '2026-04-10', '2026-05-10', 118000, 100000, true, false, 'POSTED', $4, 'Bill SUP/001 posted.', $5, $6)`,
    [billId, ids.companyId, ids.partyId, sale.voucherId, ids.userId, `purchase:${billId}`],
  ));
  const itemId = crypto.randomUUID();
  await owner.query("INSERT INTO master_records (id, company_id, kind) VALUES ($1, $2, 'item')", [itemId, ids.companyId]);
  await app.tenantTransaction(ids.companyId, (sql) => sql.query(
    `INSERT INTO purchase_bill_lines (bill_id, line_number, company_id, item_id, description, hsn_sac, supply_kind, quantity_micro, quantity_unit, rate_paise, taxable_value_paise, gst_rate_basis_points, itc_eligibility)
     VALUES ($1, 1, $2, $3, 'Plastic crates', '3923', 'GOODS', 10000000, 'PCS', 10000, 100000, 1800, 'ELIGIBLE')`,
    [billId, ids.companyId, itemId],
  ));
  return { ids, shop, sale, billId };
};
const inCompany = <T>(db: TransactionalExecutor, companyId: string, text: string, values: unknown[] = []) => db.tenantTransaction(companyId, (sql) => sql.query(text, values)) as Promise<T>;

test("the application role is not an owner, not a superuser, and cannot bypass row-level security", { skip }, async () => {
  const role = (await owner.query("SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname = 'invoice_app'")).rows[0];
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: false });
  const me = (await app.query("SELECT current_user AS name, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS privileged")).rows[0];
  assert.deepEqual(me, { name: login, privileged: false });
  const owned = (await owner.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname IN ('invoice_app', $1)", [login])).rows[0];
  assert.equal(owned?.n, 0, "it owns nothing");
  const dangerous = (await owner.query(
    "SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = 'invoice_app' AND privilege_type IN ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER') ORDER BY 1, 2",
  )).rows;
  assert.deepEqual(dangerous, [{ table_name: "user_branch_access", privilege_type: "DELETE" }], "it may delete from exactly one table, which holds no financial or audit record");
});

test("Done when: as the application role, editing a posted bill's amount, deleting a voucher and deleting an audit row are all refused", { skip }, async () => {
  const { ids, sale, billId } = await shopWithPostedRecords();
  const audit = (await inCompany<{ rows: { id: string }[] }>(app, ids.companyId, "SELECT id FROM audit_events WHERE company_id = $1 LIMIT 1", [ids.companyId])).rows[0];
  assert.ok(audit !== undefined, "the sale left an audit trail");

  // 1. Edit a posted bill's amount.
  await assert.rejects(inCompany(app, ids.companyId, "UPDATE purchase_bills SET total_paise = 1 WHERE id = $1", [billId]), refused(FROZEN));
  await assert.rejects(inCompany(app, ids.companyId, "UPDATE purchase_bill_lines SET taxable_value_paise = 1 WHERE bill_id = $1", [billId]), refused(FROZEN));
  // 2. Delete a voucher (and edit one).
  await assert.rejects(inCompany(app, ids.companyId, "DELETE FROM voucher WHERE id = $1", [sale.voucherId]), refused(NO_PRIVILEGE));
  await assert.rejects(inCompany(app, ids.companyId, "DELETE FROM journal_line WHERE voucher_id = $1", [sale.voucherId]), refused(NO_PRIVILEGE));
  await assert.rejects(inCompany(app, ids.companyId, "UPDATE voucher SET total_debit_minor = 1, total_credit_minor = 1 WHERE id = $1", [sale.voucherId]), /cannot be changed/);
  // 3. Delete an audit row (and edit one).
  await assert.rejects(inCompany(app, ids.companyId, "DELETE FROM audit_events WHERE id = $1", [audit.id]), refused(NO_PRIVILEGE));
  await assert.rejects(inCompany(app, ids.companyId, "UPDATE audit_events SET action = 'nothing.happened' WHERE id = $1", [audit.id]), refused(NO_PRIVILEGE));

  // And the bill, the voucher and the audit row are exactly as they were.
  const now = (await owner.query(
    "SELECT (SELECT total_paise::text FROM purchase_bills WHERE id = $1) AS bill, (SELECT count(*)::int FROM voucher WHERE id = $2) AS vouchers, (SELECT count(*)::int FROM journal_line WHERE voucher_id = $2) AS lines, (SELECT action FROM audit_events WHERE id = $3) IS NOT NULL AS audit",
    [billId, sale.voucherId, audit.id],
  )).rows[0];
  assert.deepEqual(now, { bill: "118000", vouchers: 1, lines: 5, audit: true });
});

test("the application role cannot get around the rules: no emptying tables, no switching triggers or security off, no new tables", { skip }, async () => {
  const { ids } = await shopWithPostedRecords();
  for (const table of ["audit_events", "voucher", "journal_line", "purchase_bills", "command_records", "outbox_messages"]) {
    await assert.rejects(app.query(`TRUNCATE ${table} CASCADE`), refused(NO_PRIVILEGE), `TRUNCATE ${table}`);
  }
  await assert.rejects(app.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_frozen"), refused(NO_PRIVILEGE));
  await assert.rejects(app.query("DROP TRIGGER voucher_no_delete ON voucher"), refused(NO_PRIVILEGE));
  await assert.rejects(app.query("ALTER TABLE audit_events DISABLE ROW LEVEL SECURITY"), refused(NO_PRIVILEGE));
  await assert.rejects(app.query("DROP TABLE audit_events"), refused(NO_PRIVILEGE));
  await assert.rejects(app.query("CREATE TABLE smuggled (id int)"), refused(NO_PRIVILEGE));
  await assert.rejects(app.query("CREATE OR REPLACE FUNCTION platform_freeze_posted() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$"), refused(NO_PRIVILEGE));
  await assert.rejects(app.query("SET ROLE invoice"), refused(NO_PRIVILEGE, "22023"));
  await assert.rejects(app.query("SET session_replication_role = replica"), refused(NO_PRIVILEGE), "the switch that silences triggers is for superusers only");
  await assert.rejects(app.query("INSERT INTO schema_migrations (id) VALUES ('forged')"), refused(NO_PRIVILEGE));
  // Asking PostgreSQL to skip row-level security does not skip it: the query is refused instead.
  await assert.rejects(app.transaction(async (sql) => { await sql.query("SET LOCAL row_security = off"); await sql.query("SELECT count(*) FROM audit_events"); }), refused(NO_PRIVILEGE));
  assert.ok(Number((await inCompany<{ rows: { n: number }[] }>(owner, ids.companyId, "SELECT count(*)::int AS n FROM audit_events WHERE company_id = $1", [ids.companyId])).rows[0]?.n) > 0);
});

test("the rules do not depend on who is asking: the owner is refused too", { skip }, async () => {
  const { ids, sale, billId } = await shopWithPostedRecords();
  const audit = (await owner.query("SELECT id FROM audit_events WHERE company_id = $1 LIMIT 1", [ids.companyId])).rows[0] as { id: string };
  await assert.rejects(owner.query("UPDATE purchase_bills SET total_paise = 1 WHERE id = $1", [billId]), refused(FROZEN));
  await assert.rejects(owner.query("DELETE FROM purchase_bills WHERE id = $1", [billId]), refused(FROZEN));
  await assert.rejects(owner.query("DELETE FROM purchase_bill_lines WHERE bill_id = $1", [billId]), refused(FROZEN));
  await assert.rejects(owner.query("DELETE FROM voucher WHERE id = $1", [sale.voucherId]), /never deleted/);
  await assert.rejects(owner.query("DELETE FROM audit_events WHERE id = $1", [audit.id]), refused(FROZEN));
  await assert.rejects(owner.query("UPDATE audit_events SET reason = 'edited' WHERE id = $1", [audit.id]), refused(FROZEN));
  for (const table of ["audit_events", "voucher", "journal_line", "purchase_bills"]) await assert.rejects(owner.query(`TRUNCATE ${table} CASCADE`), refused(FROZEN), `TRUNCATE ${table}`);
  await assert.rejects(owner.query("DELETE FROM idempotency_record WHERE company_id = $1", [ids.companyId]), refused(FROZEN));
});

test("row-level security: the application role sees one company's audit trail and commands, and nothing without a company", { skip }, async () => {
  const a = await shopWithPostedRecords();
  const b = await shopWithPostedRecords();
  const seen = async (companyId: string | null, table: string) => {
    const query = `SELECT count(*)::int AS n, count(DISTINCT company_id)::int AS companies FROM ${table}`;
    return (companyId === null ? await app.query(query) : await inCompany<{ rows: Record<string, number>[] }>(app, companyId, query)).rows[0];
  };
  for (const table of ["audit_events", "outbox_messages"]) {
    assert.deepEqual(await seen(null, table), { n: 0, companies: 0 }, `${table}: nothing without a company`);
    assert.equal((await seen(a.ids.companyId, table))?.companies, 1, `${table}: one company only`);
  }
  // Company A's session cannot read, or write into, company B's trail even by naming it.
  assert.equal((await inCompany<{ rows: { n: number }[] }>(app, a.ids.companyId, "SELECT count(*)::int AS n FROM audit_events WHERE company_id = $1", [b.ids.companyId])).rows[0]?.n, 0);
  await assert.rejects(inCompany(app, a.ids.companyId, "INSERT INTO audit_events (id, company_id, actor_id, action, correlation_id) VALUES (gen_random_uuid(), $1, $2, 'forged', 'x')", [b.ids.companyId, b.ids.userId]), refused(NO_PRIVILEGE));
});

test("the lifecycle still works: status moves, reversals and cancellations are allowed, and only those", { skip }, async () => {
  const { ids, sale, billId } = await shopWithPostedRecords();
  const run = (text: string, values: unknown[] = []) => inCompany(app, ids.companyId, text, values);

  // A purchase bill is reversed — and then cannot be un-reversed into different figures.
  await run("UPDATE purchase_bills SET state = 'REVERSED', reversed_by_voucher_id = $2, reversal_reason = 'entered twice', summary = 'Bill SUP/001 reversed.' WHERE id = $1", [billId, sale.voucherId]);
  await assert.rejects(run("UPDATE purchase_bills SET invoice_number = 'SUP/002' WHERE id = $1", [billId]), refused(FROZEN));
  // A statement that sets every column back to the value it already has is not a change.
  await run("UPDATE purchase_bills SET total_paise = total_paise, supplier_name = supplier_name WHERE id = $1", [billId]);

  // An e-invoice: free to change while pending; once registered its IRN and QR code are fixed, but it can be cancelled.
  const einvoice = crypto.randomUUID();
  await run(
    `INSERT INTO e_invoices (id, company_id, document_id, document_number, document_date, document_type, supplier_gstin, financial_year, status, applicability, message, created_by, idempotency_key)
     VALUES ($1, $2, $3, 'INV/26-27/000001', '2026-04-10', 'INVOICE', '07AAAAA0000A1Z4', '2026-27', 'PENDING', '{}', 'Waiting for the portal.', $4, $5)`,
    [einvoice, ids.companyId, sale.invoice.id, ids.userId, `einvoice:${einvoice}`],
  );
  await run("UPDATE e_invoices SET status = 'FAILED', failure_code = 'TIMEOUT', message = 'The portal did not answer.' WHERE id = $1", [einvoice]);
  await run("UPDATE e_invoices SET status = 'REGISTERED', irn = $2, ack_number = '112010000001', ack_date = '2026-04-10 11:04:00', signed_qr_code = 'signed-qr', message = 'Registered.' WHERE id = $1", [einvoice, "a".repeat(64)]);
  await assert.rejects(run("UPDATE e_invoices SET irn = $2 WHERE id = $1", [einvoice, "b".repeat(64)]), refused(FROZEN));
  await assert.rejects(run("UPDATE e_invoices SET signed_qr_code = 'another' WHERE id = $1", [einvoice]), refused(FROZEN));
  await assert.rejects(run("UPDATE e_invoices SET document_number = 'INV/26-27/000009' WHERE id = $1", [einvoice]), refused(FROZEN));
  await assert.rejects(run("DELETE FROM e_invoices WHERE id = $1", [einvoice]), refused(NO_PRIVILEGE));
  await assert.rejects(owner.query("DELETE FROM e_invoices WHERE id = $1", [einvoice]), refused(FROZEN));
  await run("UPDATE e_invoices SET status = 'CANCELLED', cancelled_at = now(), cancel_reason_code = 'ORDER_CANCELLED', cancel_reason = 'The customer cancelled the order.', irn = irn, updated_at = now() WHERE id = $1", [einvoice]);

  // A goods receipt: its lines can be corrected while it is a draft, not once it is confirmed; a confirmed receipt can still be cancelled.
  const [receipt, item, warehouse] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  await owner.query("INSERT INTO master_records (id, company_id, kind) VALUES ($1, $3, 'item'), ($2, $3, 'warehouse')", [item, warehouse, ids.companyId]);
  await run("INSERT INTO goods_receipts (id, company_id, receipt_number, supplier_party_id, supplier_name, receipt_date, state, summary, created_by) VALUES ($1, $2, 'GRN/001', $3, 'Synthetic Supplier', '2026-04-10', 'DRAFT', 'Received.', $4)", [receipt, ids.companyId, ids.partyId, ids.userId]);
  await run("INSERT INTO goods_receipt_lines (receipt_id, line_number, company_id, item_id, description, warehouse_id, received_quantity_micro, accepted_quantity_micro, quantity_unit, rate_paise) VALUES ($1, 1, $2, $3, 'Plastic crates', $4, 10000000, 10000000, 'PCS', 10000)", [receipt, ids.companyId, item, warehouse]);
  await run("UPDATE goods_receipt_lines SET rate_paise = 11000 WHERE receipt_id = $1", [receipt]);
  await run("UPDATE goods_receipts SET state = 'CONFIRMED', confirmed_by = $2, confirmed_at = now(), summary = 'Confirmed.' WHERE id = $1", [receipt, ids.userId]);
  await assert.rejects(run("UPDATE goods_receipt_lines SET rate_paise = 1 WHERE receipt_id = $1", [receipt]), refused(FROZEN));
  await assert.rejects(owner.query("DELETE FROM goods_receipt_lines WHERE receipt_id = $1", [receipt]), refused(FROZEN));
  await assert.rejects(run("UPDATE goods_receipts SET receipt_date = '2026-04-11' WHERE id = $1", [receipt]), refused(FROZEN));
  await run("UPDATE goods_receipts SET state = 'CANCELLED', cancelled_reason = 'Wrong supplier.', summary = 'Cancelled.' WHERE id = $1", [receipt]);
});

// Everything #364's platform core does, done as the application role under row-level security.
platformContract("postgres as the application role", () => appHarness, skip);

test("every table that holds a company's rows enforces row-level security, except the ones still listed here", { skip }, async () => {
  // Tables whose repositories do not read through tenantTransaction yet. Each lane removes its tables
  // from this list in the change that moves its repository over (#366). Nothing may be added.
  const PENDING = new Set([
    "account", "voucher", "journal_line", "fiscal_period", "ledger_sequence", "ledger_settings", "idempotency_record",
    "bank_statement_imports", "bank_statement_transactions", "branches", "invitations", "sessions",
    "compliance_alerts", "compliance_calendar_exceptions", "compliance_completions", "compliance_deadline_revisions", "compliance_obligation_definitions", "compliance_occurrences",
    "e_invoice_policies", "e_invoice_supplier_facts", "e_invoices", "eway_bill_policies", "eway_bills", "eway_consolidated_trips",
    "goods_receipt_lines", "goods_receipt_movements", "goods_receipts", "government_calls", "government_webhook_events", "gsp_credentials", "gsp_otp_challenges",
    "gst_return_declared_thresholds", "gst_return_preparations", "gstin_authorisations", "gstin_consents",
    "itc_claims", "itc_decisions", "itc_import_batches", "itc_portal_documents",
    "master_identity_keys", "master_merges", "master_name_index", "master_records", "master_snapshots", "master_versions",
    "notification_delivery_events", "notification_preferences", "notifications",
    "purchase_bill_lines", "purchase_bill_receipts", "purchase_bills", "purchase_match_approvals", "purchase_match_tolerances", "purchase_order_lines", "purchase_orders",
    "supplier_gstin_readings", "supplier_risk_acknowledgements", "supplier_risk_assessments", "supplier_risk_policies",
    "unit_conversions", "units_of_measure", "vehicle_record_consents", "vehicle_records", "vehicle_suitability_checks", "vehicle_suitability_overrides", "vehicle_suitability_policies",
    "uow_pilot_sales_invoices", "uow_pilot_stock_movements",
  ]);
  const { rows } = await owner.query(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
        AND EXISTS (SELECT FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped)`,
  );
  assert.deepEqual(rows.map((r) => String(r.name)).filter((name) => !PENDING.has(name)).sort(), [], "a tenant table without forced row-level security");
});

test("a production server refuses to start without its database instead of falling back to the development one", async () => {
  const { createDatabase } = await import("../src/database.ts");
  const saved = { url: process.env.DATABASE_URL, env: process.env.NODE_ENV };
  try {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = "production";
    assert.throws(() => createDatabase(), /DATABASE_URL is not set/);
    process.env.DATABASE_URL = "  ";
    assert.throws(() => createDatabase(), /DATABASE_URL is not set/);
    process.env.NODE_ENV = "development";
    delete process.env.DATABASE_URL;
    await createDatabase().close(); // development keeps its local default; no connection is opened until first use
  } finally {
    if (saved.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.url;
    if (saved.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.env;
  }
});
