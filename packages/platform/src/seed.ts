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

/**
 * Issue #342 — the code the demo sign-in accepts, for every address. Development and tests only: the
 * mock identity provider that reads it refuses to start anywhere else (`identityProviderFor`).
 */
export const DEMO_SIGN_IN_CODE = "246810";

/**
 * The people who can sign in to the demo: each company's owner, a read-only viewer, and an
 * accountant (a CA) who looks after both businesses and switches between them. Invented; nobody's.
 * The CA holds the owner's permissions until #343 gives each role its own list.
 */
export const DEMO_PEOPLE: readonly { userId: string; email: string; displayName: string; memberships: readonly { companyId: string; branchId: string; permissions: readonly Permission[] }[] }[] = [
  ...SYNTHETIC_PLATFORM_COMPANIES.map((company) => ({
    userId: company.userId, email: company.email, displayName: company.displayName,
    memberships: [{ companyId: company.companyId, branchId: company.branchId, permissions: PRODUCT_OWNER_PERMISSIONS }],
  })),
  {
    userId: "00000000-0000-4000-8000-000000000004", email: "viewer@sampoorna.example.invalid", displayName: "Sampoorna Viewer",
    memberships: [{ companyId: SYNTHETIC_PLATFORM_COMPANIES[0].companyId, branchId: SYNTHETIC_PLATFORM_COMPANIES[0].branchId, permissions: ["dashboard.read"] }],
  },
  {
    userId: "00000000-0000-4000-8000-000000000005", email: "ca@example.invalid", displayName: "Synthetic Chartered Accountant",
    memberships: SYNTHETIC_PLATFORM_COMPANIES.map((company) => ({ companyId: company.companyId, branchId: company.branchId, permissions: PRODUCT_OWNER_PERMISSIONS })),
  },
];

export async function seed(executor: SqlExecutor): Promise<void> {
  for (const demo of SYNTHETIC_PLATFORM_COMPANIES) {
    await executor.query("INSERT INTO companies (id, legal_name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET legal_name = EXCLUDED.legal_name", [demo.companyId, demo.legalName]);
    await executor.query("INSERT INTO branches (id, company_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name", [demo.branchId, demo.companyId, demo.branchName]);
  }
  for (const person of DEMO_PEOPLE) {
    await executor.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name", [person.userId, person.email, person.displayName]);
    for (const membership of person.memberships) {
      await executor.query("INSERT INTO memberships (company_id, user_id, permissions) VALUES ($1, $2, $3::jsonb) ON CONFLICT (company_id, user_id) DO UPDATE SET permissions = EXCLUDED.permissions", [membership.companyId, person.userId, JSON.stringify(membership.permissions)]);
      await executor.query("INSERT INTO user_branch_access (company_id, user_id, branch_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [membership.companyId, person.userId, membership.branchId]);
    }
  }
}
if (process.argv[1]?.endsWith("seed.ts")) { const database = createDatabase(); try { await seed(database); console.log("Synthetic demo seed completed."); } finally { await database.close(); } }
