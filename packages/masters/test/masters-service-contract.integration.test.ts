/**
 * Issue #366 — the master-data service on a real PostgreSQL.
 *
 *  - The contract suite the in-memory service passes (masters-service-contract.ts).
 *  - What only a shared database can show: a second service ("another API process") sees a record the
 *    moment it is saved, a restart loses nothing, simultaneous writers to one record are serialised
 *    and none is lost, the same retry arriving twice at once makes one record, a write that fails
 *    part-way leaves nothing, and one company's rows are invisible to another even by id.
 *
 * Every service connects as a login that is only a member of `invoice_app`, which is what the server
 * connects as, so row-level security is really in force. The owner connection only sets the scene.
 * Needs DATABASE_URL: skipped locally without it, and a failure in CI so it cannot pass by not running.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before } from "node:test";
import type { TransactionalExecutor } from "../../platform/src/database.ts";
import type { Permission, RequestContext } from "../../platform/src/types.ts";
import type { MasterDataService } from "../src/masters.ts";
import { syntheticGstin } from "../src/fixtures.ts";
import { mastersServiceContract, type ServiceHarness, type Shop } from "./masters-service-contract.ts";

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error("DATABASE_URL must be set in CI so the master-data service database tests run.");
const skip = url === undefined && "DATABASE_URL is not set";

let owner: TransactionalExecutor;
const logins: string[] = [];
const pools: TransactionalExecutor[] = [];
let appUrl: string;
let postgres: typeof import("../src/postgres-masters.ts");
let database: typeof import("../../platform/src/database.ts");
const branches = new Map<string, string>();
const users = new Map<string, string>();

before(async () => {
  if (url === undefined) return;
  database = await import("../../platform/src/database.ts");
  const { migrate } = await import("../../platform/src/migrations.ts");
  postgres = await import("../src/postgres-masters.ts");
  owner = database.createDatabase(url);
  await migrate(owner);
  const [login, password] = [`invoice_app_masters_svc_${randomBytes(6).toString("hex")}`, randomBytes(18).toString("hex")];
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  logins.push(login);
  const parsed = new URL(url);
  parsed.username = login;
  parsed.password = password;
  appUrl = parsed.toString();
});
after(async () => {
  for (const pool of pools) await pool.close();
  if (owner !== undefined) { for (const login of logins) await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

/** A new connection pool and a new service on it: another API process, or the same one after a restart. */
const processOnTheDatabase = (): MasterDataService => {
  const db = database.createDatabase(appUrl);
  pools.push(db);
  return postgres.postgresMasterData(db);
};

const newShop = async (): Promise<Shop> => {
  const [companyId, branchId, userId] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  await owner.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Master Traders')", [companyId]);
  await owner.query("INSERT INTO branches (id, company_id, name) VALUES ($1, $2, 'Main shop')", [branchId, companyId]);
  await owner.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Synthetic person')", [userId, `masters-svc-${userId}@example.invalid`]);
  branches.set(companyId, branchId);
  users.set(companyId, userId);
  return { companyId, context: (permissions?: readonly Permission[]) => contextOf(companyId, permissions ?? []) };
};
const contextOf = (companyId: string, permissions: readonly Permission[] = []): RequestContext =>
  ({ companyId, branchId: branches.get(companyId) as string, actorId: users.get(companyId) as string, permissions: new Set(permissions), sessionId: "session" });

// One service for the whole contract run: the suite makes a shop per test.
let shared: MasterDataService | undefined;
const harness: ServiceHarness = {
  shared: true,
  service: () => (shared ??= processOnTheDatabase()),
  shop: newShop,
};
mastersServiceContract("postgres", () => harness, skip);

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected || (error as { cause?: { code?: string } }).cause?.code === expected;
const party = (legalName: string, extra: Record<string, unknown> = {}) => ({ legalName, role: "customer", gstRegistrationType: "regular", ...extra }) as never;
const count = async (table: string, companyId: string) => Number((await owner.query(`SELECT count(*)::int AS n FROM ${table} WHERE company_id = $1`, [companyId])).rows[0]?.n);

test("postgres: a customer saved by one process is seen by another at once, items and addresses too", { skip }, async () => {
  const [first, second, shop] = [processOnTheDatabase(), processOnTheDatabase(), await newShop()];
  const ctx = shop.context();
  const saved = await first.createParty(ctx, party("Seen Everywhere Traders", { pan: "AABCS1234C" }), { idempotencyKey: crypto.randomUUID(), effectiveFrom: "2026-04-01" });
  await first.addAddress(ctx, { partyId: saved.record.id, label: "Main", line1: "1 MG Road", city: "Bengaluru", stateCode: "29", pincode: "560001", gstin: syntheticGstin("29", "AABCS1234C"), use: "both", isPrimary: true } as never, { idempotencyKey: crypto.randomUUID() });
  const item = await first.createItem(ctx, { name: "Seen Everywhere Widget", kind: "goods", hsnSac: "72142090", baseUnit: "KGS", trackBatches: false, trackSerials: false } as never, { idempotencyKey: crypto.randomUUID(), effectiveFrom: "2026-04-01" });

  assert.equal((await second.party(ctx, saved.record.id)).legalName, "Seen Everywhere Traders");
  assert.deepEqual((await second.parties(ctx)).map((p) => p.id), [saved.record.id]);
  assert.equal((await second.addressesOfParty(shop.companyId, saved.record.id)).length, 1);
  assert.equal((await second.item(ctx, item.record.id)).name, "Seen Everywhere Widget");
  assert.equal((await second.resolveParty(ctx, "seen everywhere traders")).status, "resolved");

  // And back: the second process writes, the first reads straight away.
  await second.updateParty(ctx, saved.record.id, { legalName: "Seen Everywhere Traders and Sons" }, { idempotencyKey: crypto.randomUUID(), effectiveFrom: "2026-07-01" });
  assert.equal((await first.party(ctx, saved.record.id, "2026-08-01")).legalName, "Seen Everywhere Traders and Sons");
  assert.equal((await first.party(ctx, saved.record.id, "2026-05-01")).legalName, "Seen Everywhere Traders", "the older bill's view is untouched");
  assert.deepEqual((await first.history(ctx, "party", saved.record.id)).map((v) => v.version), [1, 2]);

  // A duplicate is caught across processes, not only inside the one that saw the original.
  await assert.rejects(second.createParty(ctx, party("Seen Everywhere Traders and Sons"), { idempotencyKey: crypto.randomUUID() }), code("DUPLICATE_BLOCKED"));
});

test("postgres: a restart loses nothing — the records, their history, their retries and a merge's redirect are all still there", { skip }, async () => {
  const [before, shop] = [processOnTheDatabase(), await newShop()];
  const ctx = shop.context();
  const approver = shop.context(["approval.decide"]);
  const reference = crypto.randomUUID();
  const a = await before.createParty(ctx, party("Restart Traders"), { idempotencyKey: reference, effectiveFrom: "2026-04-01" });
  const b = await before.createParty(ctx, party("Restarted Trading Co"), { idempotencyKey: crypto.randomUUID(), effectiveFrom: "2026-04-01", acknowledgeSimilar: true });
  await before.mergeParties(approver, a.record.id, b.record.id, { idempotencyKey: crypto.randomUUID() });
  await before.registerItemConversion(ctx, (await before.createItem(ctx, { name: "Restart Soap", kind: "goods", hsnSac: "34011190", baseUnit: "PCS", trackBatches: false, trackSerials: false } as never, { idempotencyKey: crypto.randomUUID() })).record.id, "BOX", "PCS", 24n);

  const after = processOnTheDatabase();
  assert.deepEqual((await after.parties(ctx)).map((p) => p.id), [a.record.id]);
  assert.equal((await after.party(ctx, b.record.id)).id, a.record.id, "the merged-away id still resolves");
  assert.equal((await after.history(ctx, "party", b.record.id)).length, 2, "and keeps its own history");
  const retried = await after.createParty(ctx, party("Restart Traders"), { idempotencyKey: reference, effectiveFrom: "2026-04-01" });
  assert.equal(retried.record.id, a.record.id, "a retry after the restart is still a retry");
  assert.equal((await after.parties(ctx)).length, 1);
  assert.equal((await owner.query("SELECT count(*)::int AS n FROM unit_conversions WHERE company_id = $1", [shop.companyId])).rows[0]?.n, 1);
});

test("postgres: ten processes changing different fields of one customer at once lose none of the changes", { skip }, async () => {
  const [seed, shop] = [processOnTheDatabase(), await newShop()];
  const ctx = shop.context();
  const created = await seed.createParty(ctx, party("Contended Traders"), { idempotencyKey: crypto.randomUUID(), effectiveFrom: "2026-04-01" });
  const fields = ["creditDays", "tradeName", "code", "pan", "aliases", "phones", "emails", "notes", "creditLimitPaise", "unregisteredBasis"];
  const values: Record<string, unknown> = { creditDays: 30, tradeName: "Contended", code: "CONT", pan: "AABCC1234C", aliases: ["CT"], phones: ["9845012345"], emails: ["a@example.invalid"], notes: "n", creditLimitPaise: 500000n, unregisteredBasis: undefined };
  const writers = Array.from({ length: 10 }, () => processOnTheDatabase());
  const results = await Promise.allSettled(writers.map((writer, index) =>
    writer.updateParty(ctx, created.record.id, { [fields[index] as string]: values[fields[index] as string] } as never, { idempotencyKey: crypto.randomUUID(), effectiveFrom: "2026-04-02" })));
  assert.deepEqual(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason)), [], "every writer got its turn");
  const history = await seed.history(ctx, "party", created.record.id);
  assert.deepEqual(history.map((v) => v.version), Array.from({ length: 11 }, (_, i) => i + 1), "versions are numbered without gaps or repeats");
  const final = (await seed.party(ctx, created.record.id)) as unknown as Record<string, unknown>;
  for (const field of fields) if (values[field] !== undefined) assert.deepEqual(final[field], values[field], `${field} was not lost`);
});

test("postgres: the same save arriving at two processes at once makes one record, and one GST number is claimed by one party only", { skip }, async () => {
  const [seed, shop] = [processOnTheDatabase(), await newShop()];
  const ctx = shop.context();
  const reference = crypto.randomUUID();
  const racers = await Promise.all(Array.from({ length: 6 }, () => processOnTheDatabase().createParty(ctx, party("Double Tap Traders"), { idempotencyKey: reference, effectiveFrom: "2026-04-01" })));
  assert.equal(new Set(racers.map((r) => r.record.id)).size, 1, "all six got the same record");
  assert.equal((await seed.parties(ctx)).length, 1);
  assert.equal((await seed.history(ctx, "party", racers[0]!.record.id)).length, 1);

  const [p, q] = [
    await seed.createParty(ctx, party("Gst Claimant One", { pan: "AABCG1234C" }), { idempotencyKey: crypto.randomUUID(), effectiveFrom: "2026-04-01" }),
    await seed.createParty(ctx, party("Quite Another Firm Ltd"), { idempotencyKey: crypto.randomUUID(), effectiveFrom: "2026-04-01" }),
  ];
  const gstin = syntheticGstin("29", "AABCG1234C");
  const claim = (service: MasterDataService, partyId: string) => service.addAddress(ctx, { partyId, label: "Main", line1: "1 MG Road", city: "Bengaluru", stateCode: "29", pincode: "560001", gstin, use: "both", isPrimary: true } as never, { idempotencyKey: crypto.randomUUID() });
  const outcomes = await Promise.allSettled([claim(processOnTheDatabase(), p.record.id), claim(processOnTheDatabase(), q.record.id)]);
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1, "exactly one party got the GST number");
  const loser = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
  assert.ok(["DUPLICATE_BLOCKED", "VALIDATION_FAILED"].includes(loser.reason.code), `refused plainly, got ${String(loser.reason)}`);
});

test("postgres: a write that fails part-way leaves nothing behind, and its reference can be used again", { skip }, async () => {
  const [svc, shop] = [processOnTheDatabase(), await newShop()];
  const ctx = shop.context();
  const reference = crypto.randomUUID();
  await assert.rejects(svc.createParty(ctx, party("Bad Pan Traders", { pan: "NOT-A-PAN" }), { idempotencyKey: reference }), code("VALIDATION_FAILED"));
  assert.deepEqual([await count("master_records", shop.companyId), await count("master_versions", shop.companyId), await count("command_records", shop.companyId), await count("master_command_records", shop.companyId)], [0, 0, 0, 0]);
  const fixed = await svc.createParty(ctx, party("Bad Pan Traders", { pan: "AABCB1234C" }), { idempotencyKey: reference });
  assert.equal(fixed.record.legalName, "Bad Pan Traders");

  // A whole action that fails after the service wrote takes the service's writes with it.
  const db = database.createDatabase(appUrl);
  pools.push(db);
  const inside = postgres.postgresMasterData(db);
  await assert.rejects(db.unitOfWork(shop.companyId, async () => {
    await inside.createParty(ctx, party("Rolled Back Traders"), { idempotencyKey: crypto.randomUUID(), effectiveFrom: "2026-04-01" });
    assert.equal((await inside.parties(ctx)).length, 2, "inside the action its own write is visible");
    throw new Error("the server stopped here");
  }), /the server stopped here/);
  assert.deepEqual((await svc.parties(ctx)).map((p) => p.legalName), ["Bad Pan Traders"]);
});

test("postgres: another company's records are unreachable by id, by name and by a query that forgot its company", { skip }, async () => {
  const [svc, a, b] = [processOnTheDatabase(), await newShop(), await newShop()];
  const mine = await svc.createParty(a.context(), party("Company A Only"), { idempotencyKey: crypto.randomUUID(), effectiveFrom: "2026-04-01" });
  await assert.rejects(svc.party(b.context(), mine.record.id), code("NOT_FOUND"));
  await assert.rejects(svc.updateParty(b.context(), mine.record.id, { legalName: "Hijacked" }, { idempotencyKey: crypto.randomUUID() }), code("NOT_FOUND"));
  assert.deepEqual(await svc.parties(b.context()), []);
  assert.equal((await svc.resolveParty(b.context(), "Company A Only")).status, "not_found");
  // Even a connection that sets no company sees no rows at all.
  const raw = database.createDatabase(appUrl);
  pools.push(raw);
  assert.equal((await raw.query("SELECT count(*)::int AS n FROM master_versions")).rows[0]?.n, 0);
  assert.equal((await svc.party(a.context(), mine.record.id)).legalName, "Company A Only");
});
