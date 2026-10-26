import { createDatabase, type SqlExecutor } from "./database.ts";
import type { Permission } from "./types.ts";
import { ROLES } from "./roles.ts";

/** The owner's permissions: everything (#343, `roles.ts`). */
export const PRODUCT_OWNER_PERMISSIONS: readonly Permission[] = ROLES.owner.permissions;

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

/** Read-only: the dashboard and nothing that changes anything. */
export const VIEWER_PERMISSIONS: readonly Permission[] = ROLES.viewer.permissions;
/** Issue #301 — someone at the counter: makes and issues bills, takes money, but approves nothing. */
export const COUNTER_PERMISSIONS: readonly Permission[] = ROLES.staff.permissions;
/** The books, bills and returns, but not who may sign in, the plan, or the shop's own particulars. */
export const ACCOUNTANT_PERMISSIONS: readonly Permission[] = ROLES.accountant.permissions;

/**
 * Issue #340 — three people in each synthetic company: the owner, an accountant and a viewer. Every
 * id, name and address is invented (`.example.invalid` cannot receive mail).
 */
export const SYNTHETIC_PLATFORM_USERS = [
  ...SYNTHETIC_PLATFORM_COMPANIES.map((company) => ({ companyId: company.companyId, branchId: company.branchId, userId: company.userId, email: company.email, displayName: company.displayName, role: "owner" as const, permissions: PRODUCT_OWNER_PERMISSIONS })),
  { companyId: SYNTHETIC_PLATFORM_COMPANIES[0].companyId, branchId: SYNTHETIC_PLATFORM_COMPANIES[0].branchId, userId: "00000000-0000-4000-8000-000000000005", email: "accounts@sampoorna.example.invalid", displayName: "Sampoorna Accountant", role: "accountant" as const, permissions: ACCOUNTANT_PERMISSIONS },
  { companyId: SYNTHETIC_PLATFORM_COMPANIES[0].companyId, branchId: SYNTHETIC_PLATFORM_COMPANIES[0].branchId, userId: "00000000-0000-4000-8000-000000000004", email: "viewer@sampoorna.example.invalid", displayName: "Sampoorna Viewer", role: "viewer" as const, permissions: VIEWER_PERMISSIONS },
  { companyId: SYNTHETIC_PLATFORM_COMPANIES[0].companyId, branchId: SYNTHETIC_PLATFORM_COMPANIES[0].branchId, userId: "00000000-0000-4000-8000-000000000007", email: "counter@sampoorna.example.invalid", displayName: "Sampoorna Counter", role: "staff" as const, permissions: COUNTER_PERMISSIONS },
  { companyId: SYNTHETIC_PLATFORM_COMPANIES[1].companyId, branchId: SYNTHETIC_PLATFORM_COMPANIES[1].branchId, userId: "00000000-0000-4000-8000-000000000015", email: "accounts@konkan.example.invalid", displayName: "Konkan Accountant", role: "accountant" as const, permissions: ACCOUNTANT_PERMISSIONS },
  { companyId: SYNTHETIC_PLATFORM_COMPANIES[1].companyId, branchId: SYNTHETIC_PLATFORM_COMPANIES[1].branchId, userId: "00000000-0000-4000-8000-000000000014", email: "viewer@konkan.example.invalid", displayName: "Konkan Viewer", role: "viewer" as const, permissions: VIEWER_PERMISSIONS },
  // Issue #343 — an admin, so every role is somebody in the demo (the counter person above is staff).
  { companyId: SYNTHETIC_PLATFORM_COMPANIES[0].companyId, branchId: SYNTHETIC_PLATFORM_COMPANIES[0].branchId, userId: "00000000-0000-4000-8000-000000000009", email: "admin@sampoorna.example.invalid", displayName: "Sampoorna Admin", role: "admin" as const, permissions: ROLES.admin.permissions },
  // Issue #342 — a chartered accountant who looks after both businesses: one person, two memberships,
  // switching between them without signing in again.
  ...SYNTHETIC_PLATFORM_COMPANIES.map((company) => ({ companyId: company.companyId, branchId: company.branchId, userId: "00000000-0000-4000-8000-000000000006", email: "ca@example.invalid", displayName: "Synthetic Chartered Accountant", role: "accountant" as const, permissions: ACCOUNTANT_PERMISSIONS })),
] as const;

/**
 * Issue #342 — the code the demo sign-in accepts, for every address. Development and tests only: the
 * mock identity provider that reads it refuses to start anywhere else (`identityProviderFor`).
 */
export const DEMO_SIGN_IN_CODE = "246810";

/** The synthetic companies and their people. Never in production: they are not anybody's books. */
export async function seed(executor: SqlExecutor, environment = process.env.NODE_ENV): Promise<void> {
  if (!["", "development", "test"].includes((environment ?? "").trim().toLowerCase())) throw new Error("The synthetic companies are for development and tests. They are never written to a production database.");
  for (const demo of SYNTHETIC_PLATFORM_COMPANIES) {
    await executor.query("INSERT INTO companies (id, legal_name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET legal_name = EXCLUDED.legal_name", [demo.companyId, demo.legalName]);
    await executor.query("INSERT INTO branches (id, company_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name", [demo.branchId, demo.companyId, demo.branchName]);
  }
  for (const user of SYNTHETIC_PLATFORM_USERS) {
    await executor.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name", [user.userId, user.email, user.displayName]);
    await executor.query("INSERT INTO memberships (company_id, user_id, permissions, role) VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (company_id, user_id) DO UPDATE SET permissions = EXCLUDED.permissions, role = EXCLUDED.role", [user.companyId, user.userId, JSON.stringify(user.permissions), user.role]);
    await executor.query("INSERT INTO user_branch_access (company_id, user_id, branch_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [user.companyId, user.userId, user.branchId]);
  }
}
if (process.argv[1]?.endsWith("seed.ts")) { const database = createDatabase(); try { await seed(database); console.log("Synthetic demo seed completed."); } finally { await database.close(); } }
