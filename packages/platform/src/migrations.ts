import { createDatabase, type SqlExecutor } from "./database.ts";
import { migrations } from "./migration-definitions.ts";
import { validateMigrationRegistry } from "./migration-ids.ts";

export async function migrate(executor: SqlExecutor): Promise<string[]> {
  validateMigrationRegistry(migrations);
  await executor.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const applied = new Set((await executor.query("SELECT id FROM schema_migrations")).rows.map((row) => String(row.id)));
  const executed: string[] = [];
  for (const migration of migrations) if (!applied.has(migration.id)) { await executor.query(migration.up); await executor.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migration.id]); executed.push(migration.id); }
  return executed;
}
export async function rollback(executor: SqlExecutor): Promise<string | null> {
  validateMigrationRegistry(migrations);
  const rows = (await executor.query("SELECT id FROM schema_migrations ORDER BY applied_at DESC LIMIT 1")).rows;
  const id = rows[0]?.id; if (typeof id !== "string") return null;
  const migration = migrations.find((item) => item.id === id); if (!migration) throw new Error(`Unknown applied migration: ${id}`);
  await executor.query("DELETE FROM schema_migrations WHERE id = $1", [id]); await executor.query(migration.down); return id;
}
const direction = process.argv[2];
if (direction === "up" || direction === "down") { const database = createDatabase(); try { if (direction === "up") { const result = await migrate(database); console.log(`Applied: ${result.join(", ") || "none"}`); } else { console.log(`Rolled back: ${await rollback(database) ?? "none"}`); } } finally { await database.close(); } }
else if (process.argv[1]?.endsWith("migrations.ts")) throw new Error("Use: npm run db:migrate or npm run db:rollback");
