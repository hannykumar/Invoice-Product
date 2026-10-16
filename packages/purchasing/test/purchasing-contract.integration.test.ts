/**
 * Issue #366 — the purchasing contract on a real PostgreSQL, connected as the application role so
 * row-level security and #368's rules are really in force. The owner connection only sets the scene.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";
import type { CompanyId } from "@invoice/kernel";
import type { TransactionalExecutor } from "../../platform/src/database.ts";
import { assessmentFor, billFor, orderFor, purchasingContract, receiptFor, type PurchasingHarness, type Scene } from "./purchasing-contract.ts";
import { DEFAULT_MATCH_TOLERANCE } from "../src/matching-types.ts";
import { DEFAULT_RISK_POLICY } from "../src/supplier-risk-types.ts";

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error("DATABASE_URL must be set in CI so the purchasing database tests run.");
const skip = url === undefined && "DATABASE_URL is not set";

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let harness: PurchasingHarness;
const login = `invoice_app_purchasing_${randomBytes(6).toString("hex")}`;
const GSTIN = "29SYNTH0001Q1Z5";

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import("../../platform/src/database.ts");
  const { migrate } = await import("../../platform/src/migrations.ts");
  const pg = await import("../src/postgres-repositories.ts");
  owner = createDatabase(url);
  await migrate(owner);
  // What a deployment does once: a login for the server, with nothing but membership of invoice_app.
  const password = randomBytes(18).toString("hex");
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const appUrl = new URL(url);
  appUrl.username = login;
  appUrl.password = password;
  app = createDatabase(appUrl.toString());
  harness = {
    bills: new pg.PostgresPurchaseBillRepository(app), orders: new pg.PostgresPurchaseOrderRepository(app),
    receipts: new pg.PostgresGoodsReceiptRepository(app), approvals: new pg.PostgresMatchApprovalRepository(app),
    tolerances: new pg.PostgresMatchTolerances(app), assessments: new pg.PostgresRiskAssessmentRepository(app),
    acknowledgements: new pg.PostgresRiskAcknowledgementRepository(app), policies: new pg.PostgresRiskPolicies(app),
    cache: new pg.PostgresGstinCache(app), requiresUnitOfWork: true,
    scene: async (): Promise<Scene> => {
      const s = { companyId: crypto.randomUUID() as CompanyId, userId: crypto.randomUUID(), partyId: crypto.randomUUID(), itemId: crypto.randomUUID(), warehouseId: crypto.randomUUID(), batchId: crypto.randomUUID() };
      await owner.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Purchase Traders')", [s.companyId]);
      await owner.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Synthetic buyer')", [s.userId, `buyer-${s.userId}@example.invalid`]);
      await owner.query(
        "INSERT INTO master_records (id, company_id, kind) VALUES ($1, $5, 'party'), ($2, $5, 'item'), ($3, $5, 'warehouse'), ($4, $5, 'batch')",
        [s.partyId, s.itemId, s.warehouseId, s.batchId, s.companyId]);
      return s;
    },
    write: (companyId, work) => app.unitOfWork(companyId, () => work()),
  };
});
after(async () => {
  await app?.close();
  if (owner !== undefined) { await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

purchasingContract("postgres", () => harness, skip);

const code = (...expected: string[]) => (error: unknown) => expected.includes((error as { code?: string }).code ?? "");

test("postgres: no write is saved outside the action's transaction", { skip }, async () => {
  const h = harness;
  const s = await h.scene();
  const now = new Date().toISOString();
  const attempts: [string, () => Promise<unknown>][] = [
    ["bills.insert", () => h.bills.insert(billFor(s, 1))], ["bills.update", () => h.bills.update(billFor(s, 1))],
    ["orders.insert", () => h.orders.insert(orderFor(s, 1))], ["orders.update", () => h.orders.update(orderFor(s, 1))],
    ["receipts.insert", () => h.receipts.insert(receiptFor(s, 1))], ["receipts.update", () => h.receipts.update(receiptFor(s, 1))],
    ["approvals.insert", () => h.approvals.insert(s.companyId, { matchFingerprint: "m", approvedBy: s.userId, approvedAt: now, reason: "ok", accepted: [] }, { purchaseId: "p", invoiceNumber: "n" })],
    ["tolerances.set", async () => h.tolerances.set(s.companyId, DEFAULT_MATCH_TOLERANCE, s.userId)],
    ["assessments.insert", () => h.assessments.insert(assessmentFor(s, 1), s.userId)],
    ["acknowledgements.insert", () => h.acknowledgements.insert(s.companyId, { assessmentFingerprint: "f", supplierPartyId: s.partyId, acknowledgedBy: s.userId, acknowledgedAt: now, reason: "ok", accepted: [] })],
    ["policies.set", async () => h.policies.set(s.companyId, DEFAULT_RISK_POLICY, s.userId)],
    ["cache.put", () => h.cache.put(s.companyId, { kind: "FOUND", record: { gstin: GSTIN, status: "ACTIVE", filings: [], observedAt: now } })],
  ];
  for (const [name, attempt] of attempts) await assert.rejects(attempt(), code("NO_UNIT_OF_WORK"), name);
  assert.deepEqual(await h.bills.list(s.companyId), []);
  assert.deepEqual(await h.orders.list(s.companyId), []);
});

test("postgres: settings and readings roll back with a failed action too", { skip }, async () => {
  const h = harness;
  const s = await h.scene();
  await assert.rejects(app.unitOfWork(s.companyId, async () => {
    await h.tolerances.set(s.companyId, { ...DEFAULT_MATCH_TOLERANCE, priceBasisPoints: 999, effectiveFrom: "2026-01-01" }, s.userId);
    await h.policies.set(s.companyId, { ...DEFAULT_RISK_POLICY, missedReturnPeriods: 9, effectiveFrom: "2026-01-01" }, s.userId);
    await h.cache.put(s.companyId, { kind: "FOUND", record: { gstin: GSTIN, status: "ACTIVE", filings: [], observedAt: new Date().toISOString() } });
    throw new Error("stop");
  }), /stop/);
  assert.deepEqual(await h.tolerances.policyFor(s.companyId, "2026-07-01"), DEFAULT_MATCH_TOLERANCE);
  assert.deepEqual(await h.policies.policyFor(s.companyId, "2026-07-01"), DEFAULT_RISK_POLICY);
  assert.equal(await h.cache.get(s.companyId, GSTIN), null);
});

test("postgres: a confirmed delivery cannot be sent back to a draft through the repository", { skip }, async () => {
  const h = harness;
  const s = await h.scene();
  const receipt = receiptFor(s, 1);
  await app.unitOfWork(s.companyId, () => h.receipts.insert(receipt));
  const confirmed = { ...receipt, state: "CONFIRMED" as const, confirmedBy: s.userId, confirmedAt: new Date().toISOString() };
  await app.unitOfWork(s.companyId, () => h.receipts.update(confirmed));
  await assert.rejects(app.unitOfWork(s.companyId, () => h.receipts.update({ ...confirmed, state: "DRAFT" })), code("23001"));
  assert.equal((await h.receipts.findById(s.companyId, receipt.id))?.state, "CONFIRMED");
});

test("postgres: every purchasing table enforces row-level security", { skip }, async () => {
  const tables = ["purchase_bills", "purchase_bill_lines", "purchase_bill_receipts", "purchase_orders", "purchase_order_lines", "goods_receipts",
    "goods_receipt_lines", "goods_receipt_movements", "purchase_match_tolerances", "purchase_match_approvals", "supplier_gstin_readings",
    "supplier_risk_assessments", "supplier_risk_acknowledgements", "supplier_risk_policies"];
  const { rows } = await owner.query(
    "SELECT relname FROM pg_class WHERE relname = ANY($1) AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity", [tables]);
  assert.deepEqual(rows.map((r) => String(r.relname)).sort(), [...tables].sort());
});
