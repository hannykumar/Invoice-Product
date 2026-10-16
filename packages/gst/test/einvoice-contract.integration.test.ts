/**
 * Issue #366 — the e-invoice stores on a real PostgreSQL, connected as the application role so
 * row-level security and the freeze of #368 are really in force.
 *
 *  - The same contract suite the in-memory stores pass (einvoice-contract.ts).
 *  - What only a database can show: a write outside a unit of work is refused, a registered
 *    e-invoice cannot be rewritten, and the tables themselves keep companies apart.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import type { CompanyId } from "@invoice/kernel";
import type { TransactionalExecutor } from "../../platform/src/database.ts";
import type { PostgresEInvoicePolicies, PostgresEInvoiceRepository } from "../src/einvoice-postgres.ts";
import { eInvoiceContract, pendingRecord, registeredRecord, type EInvoiceHarness } from "./einvoice-contract.ts";

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error("DATABASE_URL must be set in CI so the e-invoice database tests run.");
const skip = url === undefined && "DATABASE_URL is not set";

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let records: PostgresEInvoiceRepository;
let policies: PostgresEInvoicePolicies;
let harness: EInvoiceHarness;
const login = `invoice_app_test_${randomBytes(6).toString("hex")}`;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import("../../platform/src/database.ts");
  const { migrate } = await import("../../platform/src/migrations.ts");
  const postgres = await import("../src/einvoice-postgres.ts");
  owner = createDatabase(url);
  await migrate(owner);
  // What a deployment does once: a login for the server, with nothing but membership of invoice_app.
  const password = randomBytes(18).toString("hex");
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const appUrl = new URL(url);
  appUrl.username = login;
  appUrl.password = password;
  app = createDatabase(appUrl.toString());
  records = new postgres.PostgresEInvoiceRepository(app);
  policies = new postgres.PostgresEInvoicePolicies(app);
  harness = {
    records, policies,
    setPolicy: (companyId, policy, userId) => policies.set(companyId, policy, userId),
    run: (companyId, work) => app.unitOfWork(companyId, () => work()),
    // The owner only sets the scene; everything under test runs as the application role.
    company: async () => {
      const ids = { companyId: randomUUID() as CompanyId, userId: randomUUID() };
      await owner.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic E-invoice Traders')", [ids.companyId]);
      await owner.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Synthetic person')", [ids.userId, `einvoice-${ids.userId}@example.invalid`]);
      return ids;
    },
  };
});
after(async () => {
  await app?.close();
  if (owner !== undefined) { await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

eInvoiceContract("postgres", () => harness, skip);

const code = (...expected: string[]) => (error: unknown) => expected.includes((error as { code?: string }).code ?? "");

test("postgres: a write outside a unit of work is refused and saves nothing", { skip }, async () => {
  const { companyId, userId } = await harness.company();
  const record = pendingRecord(companyId, userId);
  await assert.rejects(records.insert(record), code("NO_UNIT_OF_WORK"));
  await assert.rejects(records.update(record), code("NO_UNIT_OF_WORK"));
  await assert.rejects(policies.set(companyId, { cancellationWindowHours: 12, verifyIrnHash: true, effectiveFrom: "2026-04-01" }, userId), code("NO_UNIT_OF_WORK"));
  // A plain transaction is not a unit of work either.
  await assert.rejects(app.tenantTransaction(companyId, () => records.insert(record)), code("NO_UNIT_OF_WORK"));
  assert.equal(await records.findById(companyId, record.id), null);
  assert.equal((await policies.policyFor(companyId, "2026-08-21")).cancellationWindowHours, 24);
});

test("postgres: a policy set in an action that fails is not kept", { skip }, async () => {
  const { companyId, userId } = await harness.company();
  await assert.rejects(app.unitOfWork(companyId, async () => {
    await policies.set(companyId, { cancellationWindowHours: 12, verifyIrnHash: false, effectiveFrom: "2026-04-01" }, userId);
    throw new Error("the action failed after writing");
  }), /the action failed/);
  assert.equal((await policies.policyFor(companyId, "2026-08-21")).cancellationWindowHours, 24);
});

test("postgres: a registered e-invoice keeps its number and particulars, and never goes back to pending", { skip }, async () => {
  const { companyId, userId } = await harness.company();
  const registered = registeredRecord(companyId, userId);
  await app.unitOfWork(companyId, () => records.insert(registered));
  const refused = (changed: Partial<typeof registered>) =>
    assert.rejects(app.unitOfWork(companyId, () => records.update({ ...registered, ...changed })), code("EINVOICE_FROZEN"));
  await refused({ acknowledgement: { ...registered.acknowledgement!, irn: "b".repeat(64) } });
  await refused({ acknowledgement: { ...registered.acknowledgement!, signedQrCode: "another" } });
  await refused({ documentNumber: "SAM/2026/9999" });
  await refused({ status: "PENDING" });
  await refused({ status: "FAILED" });
  assert.deepEqual(await records.findById(companyId, registered.id), registered);
  // The application role cannot delete one at all.
  await assert.rejects(app.tenantTransaction(companyId, (sql) => sql.query("DELETE FROM e_invoices WHERE company_id = $1 AND id = $2", [companyId, registered.id])), code("42501"));
});

test("postgres: the portal's Indian wall-clock cancellation time is kept as the right instant", { skip }, async () => {
  const { companyId, userId } = await harness.company();
  // What the live portal sends: no zone, Indian time. 16:00 in India is 10:30 UTC.
  const cancelled = registeredRecord(companyId, userId, { status: "CANCELLED", cancelledAt: "2026-08-21 16:00:00", cancelReasonCode: "OTHER", cancelReason: "Raised twice." });
  await app.unitOfWork(companyId, () => records.insert(cancelled));
  assert.equal((await records.findById(companyId, cancelled.id))?.cancelledAt, "2026-08-21T10:30:00.000Z");
});

test("postgres: the tables themselves keep companies apart, even for a query with no company filter", { skip }, async () => {
  const a = await harness.company();
  const b = await harness.company();
  const mine = registeredRecord(a.companyId, a.userId);
  await app.unitOfWork(a.companyId, async () => {
    await records.insert(mine);
    await policies.set(a.companyId, { cancellationWindowHours: 12, verifyIrnHash: true, effectiveFrom: "2026-04-01" }, a.userId);
  });
  for (const table of ["e_invoices", "e_invoice_policies", "e_invoice_supplier_facts"]) {
    const count = async (companyId: CompanyId) => Number((await app.tenantTransaction(companyId, (sql) => sql.query(`SELECT count(*)::int AS n FROM ${table}`))).rows[0]?.n);
    assert.equal(await count(b.companyId), 0, `${table} as seen by another company`);
    assert.equal(Number((await app.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n), 0, `${table} with no company at all`);
    if (table !== "e_invoice_supplier_facts") assert.equal(await count(a.companyId), 1, `${table} as seen by its own company`);
  }
  // B cannot change A's row, nor write a row in A's name.
  const changed = await app.tenantTransaction(b.companyId, (sql) => sql.query("UPDATE e_invoices SET message = 'Taken over.' WHERE id = $1 RETURNING id", [mine.id]));
  assert.equal(changed.rows.length, 0);
  const forged = pendingRecord(a.companyId, a.userId);
  await assert.rejects(app.tenantTransaction(b.companyId, (sql) => sql.query(
    `INSERT INTO e_invoices (id, company_id, document_id, document_number, document_date, document_type, supplier_gstin, financial_year, status, applicability, message, created_by, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, 'INVOICE', $6, '2026-27', 'PENDING', '{}', 'Forged.', $7, $8)`,
    [forged.id, a.companyId, forged.documentId, forged.documentNumber, forged.documentDate, forged.supplierGstin, a.userId, forged.idempotencyKey],
  )), code("42501"));
  await assert.rejects(app.tenantTransaction(b.companyId, (sql) => sql.query(
    "INSERT INTO e_invoice_supplier_facts (company_id, financial_year, stated_by) VALUES ($1, '2025-2026', $2)", [a.companyId, a.userId],
  )), code("42501"));
  assert.deepEqual(await records.findById(a.companyId, mine.id), mine);
});
