/**
 * Issue #366 — the master-data stores on a real PostgreSQL.
 *
 *  - The same contract suite the in-memory classes pass (masters-store-contract.ts).
 *  - What only a database can show: a rolled-back action leaves nothing, a write outside the
 *    action's transaction is refused, and row-level security holds for a query that forgot its
 *    company.
 *
 * The repositories connect as a login that is only a member of `invoice_app`, which is what the
 * server connects as, so row-level security is really in force. The owner connection only sets
 * the scene (companies, users, commands).
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";
import type { TransactionalExecutor } from "../../platform/src/database.ts";
import { mastersStoreContract, type MastersHarness } from "./masters-store-contract.ts";

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error("DATABASE_URL must be set in CI so the master-data database tests run.");
const skip = url === undefined && "DATABASE_URL is not set";

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let harness: MastersHarness;
let postgres: typeof import("../src/postgres-masters.ts");
const login = `invoice_app_masters_${randomBytes(6).toString("hex")}`;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import("../../platform/src/database.ts");
  const { migrate } = await import("../../platform/src/migrations.ts");
  postgres = await import("../src/postgres-masters.ts");
  owner = createDatabase(url);
  await migrate(owner);
  const password = randomBytes(18).toString("hex");
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const appUrl = new URL(url);
  appUrl.username = login;
  appUrl.password = password;
  app = createDatabase(appUrl.toString());
  const branches = new Map<string, string>();
  harness = {
    store: (kind) => new postgres.PostgresVersionedStore(app, kind),
    commandIndex: new postgres.PostgresCommandRecordIndex(app),
    units: (companyId) => new postgres.PostgresUnitRegistry(app, companyId),
    company: async () => {
      const [companyId, branchId] = [crypto.randomUUID(), crypto.randomUUID()];
      await owner.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Master Traders')", [companyId]);
      await owner.query("INSERT INTO branches (id, company_id, name) VALUES ($1, $2, 'Main shop')", [branchId, companyId]);
      branches.set(companyId, branchId);
      return companyId;
    },
    user: async () => {
      const id = crypto.randomUUID();
      await owner.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Synthetic person')", [id, `masters-${id}@example.invalid`]);
      return id;
    },
    command: async (companyId, userId) => {
      const id = crypto.randomUUID();
      await owner.query(
        "INSERT INTO command_records (id, company_id, branch_id, actor_id, action, risk, status, idempotency_key, payload) VALUES ($1, $2, $3, $4, 'masters.party.create', 'low', 'finalised', $5, '{}')",
        [id, companyId, branches.get(companyId), userId, `key-${id}`],
      );
      return id;
    },
    write: (companyId, work) => app.unitOfWork(companyId, async () => work()),
  };
});
after(async () => {
  await app?.close();
  if (owner !== undefined) { await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

mastersStoreContract("postgres", () => harness, skip);

const code = (...expected: string[]) => (error: unknown) => expected.includes((error as { code?: string }).code ?? "");
const shop = async () => {
  const companyId = await harness.company();
  const userId = await harness.user();
  return { companyId, userId, party: () => ({ id: crypto.randomUUID(), companyId, name: "Synthetic Traders", creditLimitPaise: 100n }) };
};
const count = async (table: string, companyId: string) => Number((await owner.query(`SELECT count(*)::int AS n FROM ${table} WHERE company_id = $1`, [companyId])).rows[0]?.n);

test("postgres: an action that fails part-way leaves no record, version, unit, conversion or command link behind", { skip }, async () => {
  const { companyId, userId, party } = await shop();
  const parties = harness.store("party");
  const kept = await harness.write(companyId, () => parties.append(party(), "2026-04-01", userId));
  const command = await harness.command(companyId, userId);
  const lost = party();
  await assert.rejects(app.unitOfWork(companyId, async () => {
    await parties.append(lost, "2026-04-01", userId);
    await parties.append({ ...party(), id: kept.recordId, name: "Changed" }, "2026-05-01", userId);
    await harness.commandIndex.set(companyId, command, lost.id);
    await harness.units(companyId).registerUnit({ code: "CRATE", name: "Crate", displayDecimals: 0 });
    await harness.units(companyId).registerConversion({ fromUnit: "CRATE", toUnit: "PCS", numerator: 12n, denominator: 1n });
    assert.equal((await parties.list(companyId, "9999-12-31")).length, 2, "inside the action its own writes are visible");
    throw new Error("the server stopped here");
  }), /the server stopped here/);
  assert.deepEqual(await parties.history(companyId, lost.id), []);
  assert.deepEqual(await parties.history(companyId, kept.recordId), [kept]);
  assert.equal(await harness.commandIndex.get(companyId, command), undefined);
  assert.deepEqual([await count("master_records", companyId), await count("master_versions", companyId), await count("master_command_records", companyId), await count("units_of_measure", companyId), await count("unit_conversions", companyId)], [1, 1, 0, 0, 0]);
});

test("postgres: a write outside the action's transaction is refused, not saved on its own", { skip }, async () => {
  const { companyId, userId, party } = await shop();
  const data = party();
  const attempt = (work: () => Promise<unknown>) => (async () => work())();
  await assert.rejects(attempt(() => harness.store("party").append(data, "2026-04-01", userId) as Promise<unknown>), code("NO_UNIT_OF_WORK"));
  await assert.rejects(attempt(() => harness.commandIndex.set(companyId, crypto.randomUUID(), data.id) as Promise<unknown>), code("NO_UNIT_OF_WORK"));
  await assert.rejects(attempt(() => harness.units(companyId).registerUnit({ code: "CRATE", name: "Crate", displayDecimals: 0 }) as Promise<unknown>), code("NO_UNIT_OF_WORK"));
  await assert.rejects(attempt(() => harness.units(companyId).registerConversion({ fromUnit: "BOX", toUnit: "PCS", numerator: 12n, denominator: 1n }) as Promise<unknown>), code("NO_UNIT_OF_WORK"));
  // An action open for one company cannot write another company's rows either.
  const other = await shop();
  await assert.rejects(app.unitOfWork(other.companyId, async () => harness.store("party").append(data, "2026-04-01", userId)), code("TENANT_ISOLATION"));
  assert.deepEqual([await count("master_records", companyId), await count("units_of_measure", companyId), await count("unit_conversions", companyId)], [0, 0, 0]);
});

test("postgres: the database itself keeps companies apart, even from a query that forgot its company", { skip }, async () => {
  const a = await shop();
  const b = await shop();
  const mine = await harness.write(a.companyId, () => harness.store("party").append(a.party(), "2026-04-01", a.userId));
  const command = await harness.command(a.companyId, a.userId);
  await harness.write(a.companyId, async () => {
    await harness.commandIndex.set(a.companyId, command, mine.recordId);
    await harness.units(a.companyId).registerUnit({ code: "CRATE", name: "Crate", displayDecimals: 0 });
    await harness.units(a.companyId).registerConversion({ fromUnit: "CRATE", toUnit: "PCS", numerator: 12n, denominator: 1n });
  });
  for (const table of ["master_records", "master_versions", "master_command_records", "units_of_measure", "unit_conversions"]) {
    const seen = await app.tenantTransaction(b.companyId, (sql) => sql.query(`SELECT count(*)::int AS n FROM ${table}`));
    assert.equal(seen.rows[0]?.n, 0, `${table} shows company B nothing of company A's`);
    assert.equal((await app.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n, 0, `${table} shows nothing when no company is set`);
    assert.ok(await count(table, a.companyId) >= 1);
  }
  // Company B cannot plant a row under company A's name, or hang its own version on company A's record.
  await assert.rejects(app.unitOfWork(b.companyId, ({ sql }) => sql.query("INSERT INTO master_records (id, company_id, kind) VALUES ($1, $2, 'party')", [crypto.randomUUID(), a.companyId])), code("42501"));
  await assert.rejects(app.unitOfWork(b.companyId, ({ sql }) => sql.query(
    "INSERT INTO master_versions (record_id, version, company_id, effective_from, data, recorded_by) VALUES ($1, 2, $2, '2026-04-01', '{}', $3)", [mine.recordId, b.companyId, b.userId],
  )), code("23503"));
  // An item of company A cannot carry a conversion of company B, nor a command link.
  await assert.rejects(harness.write(b.companyId, () => harness.units(b.companyId).registerConversion({ fromUnit: "BOX", toUnit: "PCS", numerator: 12n, denominator: 1n, itemId: mine.recordId })), code("NOT_FOUND"));
  const theirs = await harness.command(b.companyId, b.userId);
  await assert.rejects(harness.write(b.companyId, () => harness.commandIndex.set(b.companyId, theirs, mine.recordId)), code("NOT_FOUND"));
});

test("postgres: what the database refuses comes back as the module's own errors", { skip }, async () => {
  const { companyId, userId, party } = await shop();
  const parties = harness.store("party");
  const saved = await harness.write(companyId, () => parties.append(party(), "2026-04-01", userId));
  // A calendar date that does not exist passes the shape check and is refused by the database.
  await assert.rejects(harness.write(companyId, () => parties.append(party(), "2026-02-31", userId)), code("INVALID_TRANSITION"));
  // A reference that is not a UUID, and one already used by another kind of record.
  await assert.rejects(harness.write(companyId, () => parties.append({ ...party(), id: "party-1" }, "2026-04-01", userId)), code("VALIDATION_FAILED"));
  await assert.rejects(harness.write(companyId, () => harness.store("item").append({ ...party(), id: saved.recordId }, "2026-04-01", userId)), code("CONFLICT"));
  // A command can point at one record only, and both must exist.
  const command = await harness.command(companyId, userId);
  const second = await harness.write(companyId, () => parties.append(party(), "2026-04-01", userId));
  await harness.write(companyId, () => harness.commandIndex.set(companyId, command, saved.recordId));
  await assert.rejects(harness.write(companyId, () => harness.commandIndex.set(companyId, command, second.recordId)), code("CONFLICT"));
  await assert.rejects(harness.write(companyId, () => harness.commandIndex.set(companyId, crypto.randomUUID(), saved.recordId)), code("NOT_FOUND"));
  const unused = await harness.command(companyId, userId);
  await assert.rejects(harness.write(companyId, () => harness.commandIndex.set(companyId, unused, crypto.randomUUID())), code("NOT_FOUND"));
  assert.equal(await harness.commandIndex.get(companyId, command), saved.recordId);
  assert.deepEqual(await parties.history(companyId, saved.recordId), [saved], "every refusal left the saved record as it was");
  assert.equal(await parties.size(companyId), 2);
});

test("postgres: the link from a command to its record is final, and nothing of master data can be deleted by the server", { skip }, async () => {
  const { companyId, userId, party } = await shop();
  const saved = await harness.write(companyId, () => harness.store("party").append(party(), "2026-04-01", userId));
  const command = await harness.command(companyId, userId);
  await harness.write(companyId, () => harness.commandIndex.set(companyId, command, saved.recordId));
  const asApp = (sql: string) => app.unitOfWork(companyId, (uow) => uow.sql.query(sql, [companyId]));
  await assert.rejects(asApp("UPDATE master_command_records SET recorded_at = now() WHERE company_id = $1"), code("23001"));
  await assert.rejects(owner.query("DELETE FROM master_command_records WHERE company_id = $1", [companyId]), code("23001"));
  for (const table of ["master_command_records", "master_versions", "master_records", "units_of_measure", "unit_conversions"]) {
    await assert.rejects(asApp(`DELETE FROM ${table} WHERE company_id = $1`), code("42501"), `${table}: the application role has no DELETE`);
  }
});
