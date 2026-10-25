/**
 * Issue #289, part 2b — the reverse-charge register on a real PostgreSQL, connected as the
 * application role so row-level security and the append-only rule are really in force.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";
import type { CompanyId } from "@invoice/kernel";
import type { TransactionalExecutor } from "../../platform/src/database.ts";
import { billFor } from "./purchasing-contract.ts";
import { purchaseFor, reverseChargeRegisterContract, selfInvoiceFor, type RegisterHarness, type RegisterScene } from "./reverse-charge-register-contract.ts";

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error("DATABASE_URL must be set in CI so the reverse-charge register tests run.");
const skip = url === undefined && "DATABASE_URL is not set";

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let harness: RegisterHarness;
const login = `invoice_app_rcm_${randomBytes(6).toString("hex")}`;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import("../../platform/src/database.ts");
  const { migrate } = await import("../../platform/src/migrations.ts");
  const { PostgresPurchaseBillRepository } = await import("../src/postgres-repositories.ts");
  const { PostgresReverseChargeRegister } = await import("../src/reverse-charge-postgres.ts");
  owner = createDatabase(url);
  await migrate(owner);
  const password = randomBytes(18).toString("hex");
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const appUrl = new URL(url);
  appUrl.username = login;
  appUrl.password = password;
  app = createDatabase(appUrl.toString());
  const bills = new PostgresPurchaseBillRepository(app);
  const masters = new Map<string, { itemId: string; warehouseId: string; batchId: string }>();
  harness = {
    register: new PostgresReverseChargeRegister(app),
    scene: async (): Promise<RegisterScene> => {
      const s = { companyId: crypto.randomUUID() as CompanyId, userId: crypto.randomUUID(), partyId: crypto.randomUUID() };
      const more = { itemId: crypto.randomUUID(), warehouseId: crypto.randomUUID(), batchId: crypto.randomUUID() };
      masters.set(s.companyId, more);
      await owner.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Reverse Charge Traders')", [s.companyId]);
      await owner.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Synthetic buyer')", [s.userId, `rcm-${s.userId}@example.invalid`]);
      await owner.query(
        "INSERT INTO master_records (id, company_id, kind) VALUES ($1, $5, 'party'), ($2, $5, 'item'), ($3, $5, 'warehouse'), ($4, $5, 'batch')",
        [s.partyId, more.itemId, more.warehouseId, more.batchId, s.companyId]);
      return s;
    },
    bill: async (s, n) => {
      const bill = billFor({ ...s, ...(masters.get(s.companyId) as { itemId: string; warehouseId: string; batchId: string }) }, n);
      await app.unitOfWork(s.companyId, () => bills.insert(bill));
      return bill.id;
    },
    write: (companyId, work) => app.unitOfWork(companyId, () => work()),
  };
});
after(async () => {
  await app?.close();
  if (owner !== undefined) { await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

reverseChargeRegisterContract("postgres", () => harness, skip);

const code = (...expected: string[]) => (error: unknown) => expected.includes((error as { code?: string }).code ?? "");

test("postgres: nothing is written outside the action's transaction", { skip }, async () => {
  const s = await harness.scene();
  const purchase = purchaseFor(s, await harness.bill(s, 1));
  await assert.rejects(harness.register.insertPurchase(purchase), code("NO_UNIT_OF_WORK"));
  await assert.rejects(harness.register.insertSelfInvoice(selfInvoiceFor(s, purchase, 1)), code("NO_UNIT_OF_WORK"));
});

test("postgres: an issued self-invoice cannot be changed or deleted, and both tables enforce row-level security", { skip }, async () => {
  const s = await harness.scene();
  const purchase = purchaseFor(s, await harness.bill(s, 2));
  await harness.write(s.companyId, async () => {
    await harness.register.insertPurchase(purchase);
    await harness.register.insertSelfInvoice(selfInvoiceFor(s, purchase, 1));
  });
  await assert.rejects(app.unitOfWork(s.companyId, (uow) => uow.sql.query("UPDATE purchase_self_invoices SET issued_on = '2026-09-30' WHERE company_id = $1", [s.companyId])));
  await assert.rejects(owner.query("DELETE FROM purchase_self_invoices WHERE company_id = $1", [s.companyId]));
  await assert.rejects(owner.query("UPDATE purchase_reverse_charge SET received_on = '2026-08-01' WHERE company_id = $1", [s.companyId]));
  // Dated before the goods arrived: refused by the database too.
  const early = purchaseFor(s, await harness.bill(s, 3));
  await harness.write(s.companyId, () => harness.register.insertPurchase(early));
  await assert.rejects(harness.write(s.companyId, () => harness.register.insertSelfInvoice(selfInvoiceFor(s, early, 2, { issuedOn: "2026-09-01" as never }))));
  const { rows } = await owner.query(
    "SELECT relname FROM pg_class WHERE relname = ANY($1) AND relkind = 'r' AND relrowsecurity AND relforcerowsecurity",
    [["purchase_reverse_charge", "purchase_self_invoices"]]);
  assert.deepEqual(rows.map((r) => String(r.relname)).sort(), ["purchase_reverse_charge", "purchase_self_invoices"]);
});
