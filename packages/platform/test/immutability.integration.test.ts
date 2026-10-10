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

// The independent review of this change found each of the following routes open. Each is now a test.

test("a finished ledger entry cannot be taken back to a draft and rewritten, nor its lines moved to another entry", { skip }, async () => {
  const { ids, shop, sale } = await shopWithPostedRecords();
  const run = (text: string, values: unknown[] = []) => inCompany(app, ids.companyId, text, values);
  await assert.rejects(run("UPDATE voucher SET state = 'DRAFT' WHERE id = $1", [sale.voucherId]), refused(FROZEN));
  for (const column of ["narration = 'rewritten'", "document_date = '2025-01-01'", "idempotency_key = 'another'", "source_number = 'INV/0'", "created_at = now() - interval '1 year'", "branch_id = gen_random_uuid()"]) {
    await assert.rejects(run(`UPDATE voucher SET ${column} WHERE id = $1`, [sale.voucherId]), (error: unknown) => refused(FROZEN)(error) || /cannot be changed/.test(String(error)), column);
  }
  // A second finished entry to try to swap lines with.
  const second = await shop.recordSale("r2");
  await assert.rejects(run("UPDATE journal_line SET voucher_id = $2 WHERE voucher_id = $1", [sale.voucherId, second.voucherId]), (error: unknown) => refused(FROZEN)(error) || /cannot be changed/.test(String(error)));
  await assert.rejects(run("UPDATE journal_line SET debit_minor = debit_minor + 1 WHERE voucher_id = $1 AND debit_minor > 0", [sale.voucherId]), (error: unknown) => refused(FROZEN)(error) || /cannot be changed/.test(String(error)));
  // Adding lines to a finished entry is caught when the transaction ends: its totals cannot change, so it no longer balances.
  await assert.rejects(app.unitOfWork(ids.companyId, async ({ sql }) => {
    await sql.query(
      `INSERT INTO journal_line (id, company_id, voucher_id, line_no, account_id, debit_minor, credit_minor)
       SELECT gen_random_uuid(), company_id, voucher_id, line_no + 100, account_id, credit_minor, debit_minor FROM journal_line WHERE voucher_id = $1`, [sale.voucherId]);
  }), /does not balance/);
  // The one legitimate change still works: marking it reversed, with the entry that reversed it.
  await run("UPDATE voucher SET state = 'REVERSED', reversed_by_voucher_id = $2, reason = 'entered twice' WHERE id = $1", [sale.voucherId, second.voucherId]);
  await assert.rejects(run("UPDATE voucher SET state = 'FINAL' WHERE id = $1", [sale.voucherId]), refused(FROZEN, "23514"));
  const lines = (await owner.query("SELECT count(*)::int AS n, sum(debit_minor)::text AS debit FROM journal_line WHERE voucher_id = $1", [sale.voucherId])).rows[0];
  assert.deepEqual(lines, { n: 5, debit: "118000" });
});

test("a finished record cannot be moved back to an earlier status to be edited there", { skip }, async () => {
  const { ids, sale, billId } = await shopWithPostedRecords();
  const run = (text: string, values: unknown[] = []) => inCompany(app, ids.companyId, text, values);
  const backwards = async (table: string, id: string, column: string, from: string, to: string) =>
    assert.rejects(run(`UPDATE ${table} SET ${column} = '${to}' WHERE id = $1 AND ${column} = '${from}'`, [id]).then((result) => { assert.equal((result as { rowCount?: number }).rowCount, 1, `${table} was not ${from}`); }), refused(FROZEN), `${table}: ${from} to ${to}`);

  // Purchase bill: a reversal is not undone.
  await run("UPDATE purchase_bills SET state = 'REVERSED', reversed_by_voucher_id = $2, reversal_reason = 'entered twice' WHERE id = $1", [billId, sale.voucherId]);
  await backwards("purchase_bills", billId, "state", "REVERSED", "POSTED");

  // E-invoice: registered or cancelled never goes back to pending or failed.
  const einvoice = crypto.randomUUID();
  await run(
    `INSERT INTO e_invoices (id, company_id, document_id, document_number, document_date, document_type, supplier_gstin, financial_year, status, applicability, message, created_by, idempotency_key, irn, ack_number, ack_date, signed_qr_code)
     VALUES ($1, $2, $3, 'INV/26-27/000001', '2026-04-10', 'INVOICE', '07AAAAA0000A1Z4', '2026-27', 'REGISTERED', '{}', 'Registered.', $4, $5, $6, '112010000001', '2026-04-10 11:04:00', 'signed-qr')`,
    [einvoice, ids.companyId, sale.invoice.id, ids.userId, `einvoice:${einvoice}`, "a".repeat(64)],
  );
  for (const to of ["PENDING", "FAILED", "NOT_APPLICABLE"]) await backwards("e_invoices", einvoice, "status", "REGISTERED", to);

  // E-way bill: once it has a government number it never goes back to pending or "not required".
  const eway = crypto.randomUUID();
  await run(
    `INSERT INTO eway_bills (id, company_id, movement_id, document_number, document_date, status, applicability, consignment_value_paise, from_state_code, to_state_code, message, created_by, idempotency_key, eway_bill_number, valid_until)
     VALUES ($1, $2, $3, 'INV/26-27/000001', '2026-04-10', 'ACTIVE', '{}', 118000, '07', '06', 'Active.', $4, $5, '331001234567', now() + interval '1 day')`,
    [eway, ids.companyId, sale.invoice.id, ids.userId, `eway:${eway}`],
  );
  for (const to of ["PENDING", "NOT_REQUIRED"]) await backwards("eway_bills", eway, "status", "ACTIVE", to);
  await assert.rejects(run("UPDATE eway_bills SET eway_bill_number = '999999999999', consignment_value_paise = 1 WHERE id = $1", [eway]), refused(FROZEN));
  await run("UPDATE eway_bills SET vehicle_legs = '[{\"vehicle\":\"DL01AB1234\"}]', valid_until = now() + interval '2 days', updated_at = now() WHERE id = $1", [eway]);

  // Goods receipt: confirmed never goes back to draft, and its lines cannot be moved to a draft receipt to be edited.
  const [receipt, draft, item, warehouse] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  await owner.query("INSERT INTO master_records (id, company_id, kind) VALUES ($1, $3, 'item'), ($2, $3, 'warehouse')", [item, warehouse, ids.companyId]);
  for (const [id, number, state] of [[receipt, "GRN/001", "DRAFT"], [draft, "GRN/002", "DRAFT"]]) {
    await run("INSERT INTO goods_receipts (id, company_id, receipt_number, supplier_party_id, supplier_name, receipt_date, state, summary, created_by) VALUES ($1, $2, $3, $4, 'Synthetic Supplier', '2026-04-10', $5, 'Received.', $6)", [id, ids.companyId, number, ids.partyId, state, ids.userId]);
  }
  await run("INSERT INTO goods_receipt_lines (receipt_id, line_number, company_id, item_id, description, warehouse_id, received_quantity_micro, accepted_quantity_micro, quantity_unit, rate_paise) VALUES ($1, 1, $2, $3, 'Plastic crates', $4, 10000000, 10000000, 'PCS', 10000)", [receipt, ids.companyId, item, warehouse]);
  await run("UPDATE goods_receipts SET state = 'CONFIRMED', confirmed_by = $2, confirmed_at = now() WHERE id = $1", [receipt, ids.userId]);
  await backwards("goods_receipts", receipt, "state", "CONFIRMED", "DRAFT");
  await assert.rejects(run("UPDATE goods_receipt_lines SET receipt_id = $2 WHERE receipt_id = $1", [receipt, draft]), refused(FROZEN), "a line cannot leave a confirmed receipt");
  await run("INSERT INTO goods_receipt_lines (receipt_id, line_number, company_id, item_id, description, warehouse_id, received_quantity_micro, accepted_quantity_micro, quantity_unit, rate_paise) VALUES ($1, 7, $2, $3, 'Extra crates', $4, 1000000, 1000000, 'PCS', 10000)", [draft, ids.companyId, item, warehouse]);
  await assert.rejects(run("UPDATE goods_receipt_lines SET receipt_id = $2 WHERE receipt_id = $1", [draft, receipt]), refused(FROZEN), "a line cannot be moved into a confirmed receipt");

  // GST return: an approved return can be reopened; a filed one cannot, and its figures are fixed.
  const [reopened, filed] = [crypto.randomUUID(), crypto.randomUUID()];
  for (const [id, period, state] of [[reopened, "2026-04", "APPROVED"], [filed, "2026-05", "FILED"]]) {
    await run("INSERT INTO gst_return_preparations (id, company_id, gstin, period, return_type, state, snapshot, fingerprint, document_count, created_by, idempotency_key, version) VALUES ($1, $2, '07AAAAA0000A1Z4', $3, 'GSTR1', $4, '{\"total\":118000}', 'f1', 1, $5, $6, 1)", [id, ids.companyId, period, state, ids.userId, `gst:${id}`]);
  }
  await assert.rejects(run("UPDATE gst_return_preparations SET snapshot = '{\"total\":1}' WHERE id = $1", [reopened]), refused(FROZEN));
  await run("UPDATE gst_return_preparations SET state = 'DRAFT', exported_at = NULL, version = version + 1 WHERE id = $1", [reopened]);
  await run("UPDATE gst_return_preparations SET snapshot = '{\"total\":120000}', fingerprint = 'f2' WHERE id = $1", [reopened]);
  for (const to of ["DRAFT", "NEEDS_ATTENTION", "APPROVED", "SUBMITTING"]) await backwards("gst_return_preparations", filed, "state", "FILED", to);
  await assert.rejects(run("UPDATE gst_return_preparations SET snapshot = '{\"total\":1}' WHERE id = $1", [filed]), refused(FROZEN));

  // Our own invoice for the plan: never back to a draft; paying a failed one is allowed.
  const invoice = crypto.randomUUID();
  await run("INSERT INTO subscription_service_invoices (id, company_id, plan_id, period, net_paise, gst_paise, total_paise, state, issued_on, due_on) VALUES ($1, $2, 'starter', '2026-04', 100000, 18000, 118000, 'ISSUED', '2026-04-01', '2026-04-15')", [invoice, ids.companyId]);
  await backwards("subscription_service_invoices", invoice, "state", "ISSUED", "DRAFT");
  await run("UPDATE subscription_service_invoices SET state = 'FAILED', failure_reason = 'The bank declined it.' WHERE id = $1", [invoice]);
  await assert.rejects(run("UPDATE subscription_service_invoices SET total_paise = 1 WHERE id = $1", [invoice]), refused(FROZEN));
  await run("UPDATE subscription_service_invoices SET state = 'PAID', paid_on = '2026-04-03', failure_reason = NULL WHERE id = $1", [invoice]);
  await backwards("subscription_service_invoices", invoice, "state", "PAID", "DRAFT");
});

test("a command's status only moves the way the approval flow allows, in the database too", { skip }, async () => {
  const { companyId, branchId } = await appHarness.company();
  const userId = await appHarness.user();
  await appHarness.access.grant({ companyId, userId, branchIds: new Set([branchId]), active: true, permissions: new Set(["approval.decide"]) });
  const context = await appHarness.access.context(companyId, branchId, userId, crypto.randomUUID());
  const command = await appHarness.commands.create(context, { action: "sale.finalise", risk: "medium", idempotencyKey: "k", payload: {} });
  await appHarness.commands.transition(context, command.id, "submitted");
  await appHarness.commands.transition(context, command.id, "rejected");
  for (const status of ["approved", "finalised", "draft"]) {
    await assert.rejects(inCompany(app, companyId, "UPDATE command_records SET status = $2 WHERE id = $1", [command.id, status]), refused(FROZEN), `rejected to ${status}`);
  }
  await assert.rejects(inCompany(app, companyId, "UPDATE command_records SET amount_paise = 1, payload = '{}' WHERE id = $1", [command.id]), refused(FROZEN));
});

test("a temporary table with a real table's name cannot stand in for it", { skip }, async () => {
  const { ids, sale } = await shopWithPostedRecords();
  await assert.rejects(app.query("CREATE TEMP TABLE voucher (id uuid, state text)"), refused(NO_PRIVILEGE), "the application role cannot create temporary tables at all");
  // Even for a role that can (the owner), the triggers look at the real tables.
  await assert.rejects(owner.transaction(async (sql) => {
    await sql.query("CREATE TEMP TABLE voucher (id uuid, state text) ON COMMIT DROP");
    await sql.query("CREATE TEMP TABLE journal_line (voucher_id uuid, debit_minor bigint, credit_minor bigint) ON COMMIT DROP");
    await sql.query("INSERT INTO pg_temp.voucher VALUES ($1, 'DRAFT')", [sale.voucherId]);
    await sql.query("UPDATE public.journal_line SET debit_minor = debit_minor + 1 WHERE voucher_id = $1 AND debit_minor > 0", [sale.voucherId]);
  }), (error: unknown) => refused(FROZEN)(error) || /cannot be changed/.test(String(error)));
  assert.equal((await owner.query("SELECT sum(debit_minor)::text AS debit FROM journal_line WHERE voucher_id = $1", [sale.voucherId])).rows[0]?.debit, "118000");
  assert.ok(ids.companyId);
});

test("the audit trail cannot be re-ordered or back-dated by the application, and its arrival time is the database's", { skip }, async () => {
  const { ids } = await shopWithPostedRecords();
  const insert = (columns: string, values: string) => inCompany(app, ids.companyId, `INSERT INTO audit_events (id, company_id, actor_id, action, correlation_id${columns}) ${values}`, [ids.companyId, ids.userId]);
  await assert.rejects(insert(", seq", "OVERRIDING SYSTEM VALUE VALUES (gen_random_uuid(), $1, $2, 'forged', 'x', -5)"), refused(NO_PRIVILEGE));
  await assert.rejects(insert(", recorded_at", "VALUES (gen_random_uuid(), $1, $2, 'forged', 'x', '2020-01-01')"), refused(NO_PRIVILEGE));
  // An event may carry the time the action happened (a module's own clock); the database also keeps when it arrived.
  await insert(", occurred_at", "VALUES (gen_random_uuid(), $1, $2, 'test.event', 'x', '2020-01-01')");
  const row = (await owner.query("SELECT recorded_at > now() - interval '1 minute' AS fresh, seq > 0 AS ordered FROM audit_events WHERE company_id = $1 AND action = 'test.event'", [ids.companyId])).rows[0];
  assert.deepEqual(row, { fresh: true, ordered: true });
});

test("the database holds no usable session, and the application cannot extend one or change who a person signs in as", { skip }, async () => {
  const { companyId, branchId } = await appHarness.company();
  const userId = await appHarness.user();
  await appHarness.access.grant({ companyId, userId, branchIds: new Set([branchId]), active: true, permissions: new Set() });
  const auth = appHarness.auth();
  const session = await auth.createSession(companyId, branchId, userId, 1000);
  const stored = (await owner.query("SELECT id::text AS id, token_hash FROM sessions WHERE user_id = $1", [userId])).rows[0] as { id: string; token_hash: string };
  assert.notEqual(stored.id, session.id, "the token is not the row's id");
  assert.notEqual(stored.token_hash, session.id);
  await assert.rejects(Promise.resolve(auth.authenticate(stored.id)), refused("SESSION_EXPIRED"), "what is in the table does not open a session");
  assert.equal((await auth.authenticate(session.id)).actorId, userId);
  await assert.rejects(app.query("UPDATE sessions SET expires_at = now() + interval '10 years' WHERE user_id = $1", [userId]), refused(NO_PRIVILEGE));
  await assert.rejects(app.query("UPDATE sessions SET token_hash = 'known' WHERE user_id = $1", [userId]), refused(NO_PRIVILEGE));
  await assert.rejects(app.query("UPDATE users SET email = 'attacker@example.invalid' WHERE id = $1", [userId]), refused(NO_PRIVILEGE));
  await assert.rejects(app.query("UPDATE invitations SET expires_at = now() + interval '10 years', token_hash = 'known'"), refused(NO_PRIVILEGE));
  // Signing out with what the request context carries (the stored id, not the token) ends the session, for good.
  const second = await auth.createSession(companyId, branchId, userId);
  await auth.revokeSession((await auth.authenticate(second.id)).sessionId);
  await assert.rejects(Promise.resolve().then(() => auth.authenticate(second.id)), refused("SESSION_EXPIRED"));
  await auth.revokeSession(session.id);
  await assert.rejects(app.query("UPDATE sessions SET revoked_at = NULL WHERE user_id = $1", [userId]), refused(FROZEN), "an ended session cannot be brought back");
  await assert.rejects(app.query("UPDATE sessions SET revoked_at = now() + interval '1 day' WHERE user_id = $1", [userId]), refused(FROZEN));
});

test("row-level security covers every platform table: nothing without a company, one company with one", { skip }, async () => {
  const a = await shopWithPostedRecords();
  const { companyId, branchId } = await appHarness.company();
  const userId = await appHarness.user();
  await appHarness.access.grant({ companyId, userId, branchIds: new Set([branchId]), active: true, permissions: new Set(["approval.decide"]) });
  const context = await appHarness.access.context(companyId, branchId, userId, crypto.randomUUID());
  await appHarness.commands.create(context, { action: "sale.finalise", risk: "low", idempotencyKey: "k", payload: {} });
  const held = await appHarness.exceptions.create(context, "Missing GST rate", ["page-1"]);
  await appHarness.exceptions.comment(context, held.id, "Asked the supplier.");
  for (const table of ["audit_events", "command_records", "idempotency_keys", "exception_items", "exception_comments", "memberships", "user_branch_access", "outbox_messages", "approval_policies"]) {
    assert.equal((await app.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n, 0, `${table}: nothing without a company`);
    assert.equal((await inCompany<{ rows: { n: number }[] }>(app, a.ids.companyId, `SELECT count(*)::int AS n FROM ${table} t WHERE NOT EXISTS (SELECT FROM (SELECT $1::uuid AS id) me WHERE to_jsonb(t) ->> 'company_id' IS NULL OR to_jsonb(t) ->> 'company_id' = me.id::text)`, [a.ids.companyId])).rows[0]?.n, 0, `${table}: only this company's rows`);
    if (table !== "approval_policies") assert.ok(Number((await inCompany<{ rows: { n: number }[] }>(app, table === "outbox_messages" ? a.ids.companyId : companyId, `SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n) > 0, `${table}: its own rows are visible`);
  }
  // A comment cannot be attached to another company's exception.
  await assert.rejects(inCompany(app, a.ids.companyId, "INSERT INTO exception_comments (id, exception_id, actor_id, body) VALUES (gen_random_uuid(), $1, $2, 'forged')", [held.id, a.ids.userId]), refused(NO_PRIVILEGE));
});

test("a server outside development refuses to run as a database account that could override the rules", { skip }, async () => {
  const { assertLeastPrivilege } = await import("../src/database.ts");
  await assert.rejects(assertLeastPrivilege(owner, "production"), /can override its safety rules/);
  await assert.rejects(assertLeastPrivilege(owner, "staging"), /can override its safety rules/);
  await assertLeastPrivilege(app, "production");
  await assertLeastPrivilege(owner, "development");
  await assertLeastPrivilege(owner, undefined);
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
    for (const environment of ["Production", "prod", "production ", "staging", "PRODUCTION"]) {
      process.env.NODE_ENV = environment;
      delete process.env.DATABASE_URL;
      assert.throws(() => createDatabase(), /DATABASE_URL is not set/, environment);
      assert.throws(() => createDatabase(""), /DATABASE_URL is not set/, environment);
    }
    process.env.NODE_ENV = "development";
    delete process.env.DATABASE_URL;
    await createDatabase().close(); // development keeps its local default; no connection is opened until first use
  } finally {
    if (saved.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.url;
    if (saved.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.env;
  }
});
