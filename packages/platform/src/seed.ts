import { createDatabase, type SqlExecutor } from "./database.ts";
import type { Permission } from "./types.ts";

export const PRODUCT_OWNER_PERMISSIONS: readonly Permission[] = [
  "dashboard.read", "ledger.setup", "ledger.post.purchase", "ledger.post.sale", "ledger.post.receipt",
  "ledger.post.payment", "ledger.post.journal", "ledger.reverse", "inventory.move", "inventory.adjust",
  "ledger.post.credit_note", "ledger.post.debit_note", "returns.create",
  "purchase.order.write", "purchase.order.cancel", "purchase.receipt.write", "purchase.match.approve",
  "supplier.risk.view", "supplier.risk.acknowledge",
  "einvoice.view", "einvoice.generate", "einvoice.cancel",
  "eway.view", "eway.generate", "eway.update", "eway.cancel",
  "challan.issue", "challan.cancel",
  "quotation.issue", "quotation.cancel", "proforma.issue", "proforma.cancel",
  "gst_returns.view", "gst_returns.prepare", "gst_returns.approve", "gst_returns.export",
  "gst_returns.submit", "gst_returns.reopen",
  "itc.view", "itc.import", "itc.decide", "itc.claim_at_risk",
  "transport.vehicle.view", "transport.vehicle.check", "transport.vehicle.override",
  "sales.draft.write", "sales.finalise", "sales.approve", "sales.cancel",
  "payments.record", "payments.allocate", "payments.reverse", "payments.write_off", "approval.decide", "access.review",
  "notification.send", "collections.manage", "collections.send",
  "bank.balance.read", "bank.feed.manage", "bank.feed.sync",
  "sales.approve_discount",
  "reports.view.financial", "reports.view.sales", "reports.view.purchase", "reports.view.stock",
  "reports.view.dues", "reports.view.gst", "reports.view.exceptions", "reports.export",
  "collections.reminders.view", "collections.reminders.send", "collections.promise.record", "collections.dispute.manage",
  "subscription.view", "subscription.manage",
  "operations.read", "operations.manage", "support.access.grant", "queue.replay", "incident.manage", "feature-flags.manage",
  "assistant.ask",
  "assistant.ask",
  "agent.plan", "agent.approve", "agent.execute",
  "business.settings.write", "branding.write", "payments.upi.write",
  "masters.party.write", "masters.item.write", "masters.item.rate.declare",
  "onboarding.run", "onboarding.finish", "migration.run", "migration.commit", "migration.rollback",
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

/** Read-only: the dashboard and nothing that changes anything. */
export const VIEWER_PERMISSIONS: readonly Permission[] = ["dashboard.read"];
/** The books, bills and returns, but not who may sign in, the plan, or the shop's own particulars. */
export const ACCOUNTANT_PERMISSIONS: readonly Permission[] = PRODUCT_OWNER_PERMISSIONS.filter((permission) => ![
  "access.review", "subscription.manage", "business.settings.write", "branding.write", "payments.upi.write",
  "support.access.grant", "feature-flags.manage", "incident.manage", "operations.manage", "migration.commit", "migration.rollback",
].includes(permission));

/**
 * Issue #340 — three people in each synthetic company: the owner, an accountant and a viewer. Every
 * id, name and address is invented (`.example.invalid` cannot receive mail).
 */
export const SYNTHETIC_PLATFORM_USERS = [
  ...SYNTHETIC_PLATFORM_COMPANIES.map((company) => ({ companyId: company.companyId, branchId: company.branchId, userId: company.userId, email: company.email, displayName: company.displayName, role: "owner" as const, permissions: PRODUCT_OWNER_PERMISSIONS })),
  { companyId: SYNTHETIC_PLATFORM_COMPANIES[0].companyId, branchId: SYNTHETIC_PLATFORM_COMPANIES[0].branchId, userId: "00000000-0000-4000-8000-000000000005", email: "accounts@sampoorna.example.invalid", displayName: "Sampoorna Accountant", role: "accountant" as const, permissions: ACCOUNTANT_PERMISSIONS },
  { companyId: SYNTHETIC_PLATFORM_COMPANIES[0].companyId, branchId: SYNTHETIC_PLATFORM_COMPANIES[0].branchId, userId: "00000000-0000-4000-8000-000000000004", email: "viewer@sampoorna.example.invalid", displayName: "Sampoorna Viewer", role: "viewer" as const, permissions: VIEWER_PERMISSIONS },
  { companyId: SYNTHETIC_PLATFORM_COMPANIES[1].companyId, branchId: SYNTHETIC_PLATFORM_COMPANIES[1].branchId, userId: "00000000-0000-4000-8000-000000000015", email: "accounts@konkan.example.invalid", displayName: "Konkan Accountant", role: "accountant" as const, permissions: ACCOUNTANT_PERMISSIONS },
  { companyId: SYNTHETIC_PLATFORM_COMPANIES[1].companyId, branchId: SYNTHETIC_PLATFORM_COMPANIES[1].branchId, userId: "00000000-0000-4000-8000-000000000014", email: "viewer@konkan.example.invalid", displayName: "Konkan Viewer", role: "viewer" as const, permissions: VIEWER_PERMISSIONS },
] as const;

/** The synthetic companies and their people. Never in production: they are not anybody's books. */
export async function seed(executor: SqlExecutor, environment = process.env.NODE_ENV): Promise<void> {
  if (!["", "development", "test"].includes((environment ?? "").trim().toLowerCase())) throw new Error("The synthetic companies are for development and tests. They are never written to a production database.");
  for (const demo of SYNTHETIC_PLATFORM_COMPANIES) {
    await executor.query("INSERT INTO companies (id, legal_name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET legal_name = EXCLUDED.legal_name", [demo.companyId, demo.legalName]);
    await executor.query("INSERT INTO branches (id, company_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name", [demo.branchId, demo.companyId, demo.branchName]);
  }
  for (const user of SYNTHETIC_PLATFORM_USERS) {
    await executor.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name", [user.userId, user.email, user.displayName]);
    await executor.query("INSERT INTO memberships (company_id, user_id, permissions) VALUES ($1, $2, $3::jsonb) ON CONFLICT (company_id, user_id) DO UPDATE SET permissions = EXCLUDED.permissions", [user.companyId, user.userId, JSON.stringify(user.permissions)]);
    await executor.query("INSERT INTO user_branch_access (company_id, user_id, branch_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [user.companyId, user.userId, user.branchId]);
  }
}
if (process.argv[1]?.endsWith("seed.ts")) { const database = createDatabase(); try { await seed(database); console.log("Synthetic demo seed completed."); } finally { await database.close(); } }
