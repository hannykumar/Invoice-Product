import { Pool, type PoolClient } from "pg";

export interface SqlExecutor { query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>; }
export interface TransactionalExecutor extends SqlExecutor {
  transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T>;
  tenantTransaction<T>(companyId: string, work: (executor: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createDatabase(connectionString = process.env.DATABASE_URL ?? "postgresql://invoice:invoice@localhost:5432/invoice"): TransactionalExecutor {
  const pool = new Pool({ connectionString, max: 5 });
  const runTransaction = async <T>(work: (executor: SqlExecutor) => Promise<T>, companyId?: string): Promise<T> => {
    const client: PoolClient = await pool.connect();
    try {
      await client.query("BEGIN");
      if (companyId !== undefined) await client.query("SELECT set_config('app.company_id', $1, true)", [companyId]);
      const result = await work({ query: (sql, values) => client.query(sql, values as unknown[]) });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
  return {
    query: (sql, values) => pool.query(sql, values as unknown[]),
    transaction: (work) => runTransaction(work),
    tenantTransaction: (companyId, work) => runTransaction(work, companyId),
    close: () => pool.end(),
  };
}
