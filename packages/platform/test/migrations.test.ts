import assert from "node:assert/strict";
import test from "node:test";
import { migrate, rollback } from "../src/migrations.ts";
import { seed } from "../src/seed.ts";

class FakeSql {
  readonly statements: string[] = []; applied: string[] = [];
  async query(sql: string, values?: readonly unknown[]) { this.statements.push(sql); if (sql.startsWith("SELECT id FROM schema_migrations")) return { rows: (sql.includes("DESC") ? [...this.applied].reverse() : this.applied).map((id) => ({ id })) }; if (sql.startsWith("INSERT INTO schema_migrations")) this.applied.push(String(values?.[0])); if (sql.startsWith("DELETE FROM schema_migrations")) this.applied = this.applied.filter((id) => id !== values?.[0]); return { rows: [] }; }
}
test("migrations are repeatable and roll back the latest revision", async () => { const db = new FakeSql(); assert.deepEqual(await migrate(db), ["0001_platform_foundation", "0002_authentication_sessions_and_invitations"]); assert.deepEqual(await migrate(db), []); assert.equal(await rollback(db), "0002_authentication_sessions_and_invitations"); assert.deepEqual(db.applied, ["0001_platform_foundation"]); });
test("synthetic seed is deterministic and uses no production identifiers", async () => { const db = new FakeSql(); await seed(db); await seed(db); assert.equal(db.statements.filter((sql) => sql.startsWith("INSERT INTO companies")).length, 2); assert.ok(db.statements.every((sql) => !sql.includes("password"))); });
