import assert from "node:assert/strict";
import test from "node:test";
import { migrate, rollback } from "../src/migrations.ts";
import { migrations } from "../src/migration-definitions.ts";
import { createMigrationId, validateMigrationRegistry } from "../src/migration-ids.ts";
import { seed } from "../src/seed.ts";

class FakeSql {
  readonly statements: string[] = []; applied: string[] = [];
  async query(sql: string, values?: readonly unknown[]) { this.statements.push(sql); if (sql.startsWith("SELECT id FROM schema_migrations")) return { rows: (sql.includes("DESC") ? [...this.applied].reverse() : this.applied).map((id) => ({ id })) }; if (sql.startsWith("INSERT INTO schema_migrations")) this.applied.push(String(values?.[0])); if (sql.startsWith("DELETE FROM schema_migrations")) this.applied = this.applied.filter((id) => id !== values?.[0]); return { rows: [] }; }
}
test("migrations are repeatable and roll back the latest revision", async () => { const db = new FakeSql(); const expected = migrations.map((migration) => migration.id); assert.deepEqual(await migrate(db), expected); assert.deepEqual(await migrate(db), []); assert.equal(await rollback(db), expected.at(-1)); assert.deepEqual(db.applied, expected.slice(0, -1)); });
test("parallel modules generate collision-resistant migration ids without a shared counter", () => {
  const at = new Date("2026-08-28T12:34:56.789Z");
  const platform = createMigrationId("platform", "add outbox", at, "0123456789ab");
  const masters = createMigrationId("masters", "add outbox", at, "abcdef012345");
  assert.equal(platform, "20260828T123456789Z_platform_0123456789ab_add_outbox");
  assert.equal(masters, "20260828T123456789Z_masters_abcdef012345_add_outbox");
  assert.notEqual(platform, masters);
});
test("the registry rejects duplicate, malformed and new numeric migration ids", () => {
  const valid = { id: createMigrationId("platform", "outbox", new Date("2099-12-31T23:59:59.999Z"), "0123456789ab"), up: "SELECT 1", down: "SELECT 1" };
  assert.doesNotThrow(() => validateMigrationRegistry([...migrations, valid]));
  assert.throws(() => validateMigrationRegistry([...migrations, valid, valid]), /Duplicate migration id/);
  const numericInsertion = migrations.findIndex((migration) => migration.id > "0009_outbox");
  const withNumeric = [...migrations.slice(0, numericInsertion), { ...valid, id: "0009_outbox" }, ...migrations.slice(numericInsertion)];
  assert.throws(() => validateMigrationRegistry(withNumeric), /New numeric migration ids are not allowed/);
  assert.throws(() => validateMigrationRegistry([...migrations, { ...valid, id: "tomorrow_outbox" }]), /Invalid migration id/);
  assert.throws(() => validateMigrationRegistry([...migrations].reverse()), /Migration registry is out of order/);
});
test("synthetic seed is deterministic, multi-company and uses no production identifiers", async () => { const db = new FakeSql(); await seed(db); await seed(db); assert.equal(db.statements.filter((sql) => sql.startsWith("INSERT INTO companies")).length, 4); assert.ok(db.statements.every((sql) => !sql.includes("password"))); });
