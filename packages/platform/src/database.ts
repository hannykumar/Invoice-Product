import { Pool, type PoolClient } from "pg";

export interface SqlExecutor { query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>; }
export interface TransactionalExecutor extends SqlExecutor { transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T>; close(): Promise<void>; }

export function createDatabase(connectionString = process.env.DATABASE_URL): TransactionalExecutor {
  if (!connectionString) throw new Error("DATABASE_URL is required for database commands.");
  const pool = new Pool({ connectionString, max: 5 });
  return {
    query: (sql, values) => pool.query(sql, values as unknown[]),
    async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
      const client: PoolClient = await pool.connect();
      try { await client.query("BEGIN"); const result = await work({ query: (sql, values) => client.query(sql, values as unknown[]) }); await client.query("COMMIT"); return result; }
      catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    },
    close: () => pool.end(),
  };
}

