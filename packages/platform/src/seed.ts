import { createDatabase, type SqlExecutor } from "./database.ts";

const demo = { companyId: "00000000-0000-4000-8000-000000000001", branchId: "00000000-0000-4000-8000-000000000002", userId: "00000000-0000-4000-8000-000000000003" };
export async function seed(executor: SqlExecutor): Promise<void> {
  await executor.query("INSERT INTO companies (id, legal_name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET legal_name = EXCLUDED.legal_name", [demo.companyId, "Sampoorna Traders (Demo)"]);
  await executor.query("INSERT INTO branches (id, company_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name", [demo.branchId, demo.companyId, "Bengaluru Main"]);
  await executor.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name", [demo.userId, "owner@example.invalid", "Demo Owner"]);
  await executor.query("INSERT INTO memberships (company_id, user_id, permissions) VALUES ($1, $2, $3::jsonb) ON CONFLICT (company_id, user_id) DO UPDATE SET permissions = EXCLUDED.permissions", [demo.companyId, demo.userId, JSON.stringify(["approval.decide", "access.review"])]);
}
if (process.argv[1]?.endsWith("seed.ts")) { const database = createDatabase(); try { await seed(database); console.log("Synthetic demo seed completed."); } finally { await database.close(); } }
