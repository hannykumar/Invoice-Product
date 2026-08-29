import { createDatabase, type SqlExecutor } from "./database.ts";
import type { Permission } from "./types.ts";

export const PRODUCT_OWNER_PERMISSIONS: readonly Permission[] = [
  "dashboard.read", "ledger.setup", "ledger.post.purchase", "ledger.post.sale", "ledger.post.receipt",
  "ledger.post.payment", "ledger.post.journal", "ledger.reverse", "inventory.move", "inventory.adjust",
  "inventory.override_negative", "sales.draft.write", "sales.finalise", "sales.approve", "sales.cancel",
  "payments.record", "payments.allocate", "payments.reverse", "payments.write_off", "approval.decide", "access.review",
];

export const SYNTHETIC_PLATFORM_COMPANIES = [
  {
    companyId: "00000000-0000-4000-8000-000000000001", branchId: "00000000-0000-4000-8000-000000000002",
    userId: "00000000-0000-4000-8000-000000000003", legalName: "Sampoorna Traders", branchName: "Bengaluru Main",
    email: "owner@sampoorna.example.invalid", displayName: "Sampoorna Owner",
  },
  {
    companyId: "00000000-0000-4000-8000-000000000011", branchId: "00000000-0000-4000-8000-000000000012",
    userId: "00000000-0000-4000-8000-000000000013", legalName: "Konkan Fresh Foods", branchName: "Panaji Main",
    email: "owner@konkan.example.invalid", displayName: "Konkan Owner",
  },
] as const;

export async function seed(executor: SqlExecutor): Promise<void> {
  for (const demo of SYNTHETIC_PLATFORM_COMPANIES) {
    await executor.query("INSERT INTO companies (id, legal_name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET legal_name = EXCLUDED.legal_name", [demo.companyId, demo.legalName]);
    await executor.query("INSERT INTO branches (id, company_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name", [demo.branchId, demo.companyId, demo.branchName]);
    await executor.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name", [demo.userId, demo.email, demo.displayName]);
    await executor.query("INSERT INTO memberships (company_id, user_id, permissions) VALUES ($1, $2, $3::jsonb) ON CONFLICT (company_id, user_id) DO UPDATE SET permissions = EXCLUDED.permissions", [demo.companyId, demo.userId, JSON.stringify(PRODUCT_OWNER_PERMISSIONS)]);
    await executor.query("INSERT INTO user_branch_access (company_id, user_id, branch_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [demo.companyId, demo.userId, demo.branchId]);
  }
}
if (process.argv[1]?.endsWith("seed.ts")) { const database = createDatabase(); try { await seed(database); console.log("Synthetic demo seed completed."); } finally { await database.close(); } }
