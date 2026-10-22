/**
 * Issue #343 — the roles a person can hold in a business, and exactly what each may do. The one
 * source: `docs/permissions.md` is generated from this file (`npm run permissions:docs`), and the
 * route-matrix tests check every API route against it.
 *
 * A membership keeps its own list of permissions (a business may tailor one); a role is the named
 * starting point it was given, and what "change role" sets it back to. A chartered accountant who
 * looks after several businesses is an `accountant` in each of them: one sign-in, one membership per
 * business, and they switch between them without signing in again (#342).
 */
import type { Permission } from "./types.ts";

export const ROLE_NAMES = ["owner", "admin", "accountant", "staff", "viewer"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

/** Everything the product can do. The owner holds all of it; nobody else holds more. */
const EVERYTHING: readonly Permission[] = [
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
  "agent.plan", "agent.approve", "agent.execute",
  "business.settings.write", "branding.write", "payments.upi.write",
  "masters.party.write", "masters.item.write", "masters.item.rate.declare",
  "onboarding.run", "onboarding.finish", "migration.run", "migration.commit", "migration.rollback",
  "sales.view", "purchases.view", "masters.read", "business.settings.read", "business.transfer",
];

const without = (base: readonly Permission[], ...removed: Permission[]): readonly Permission[] => base.filter((permission) => !removed.includes(permission));

export const ROLES: Readonly<Record<RoleName, { readonly title: string; readonly sentence: string; readonly permissions: readonly Permission[] }>> = {
  owner: {
    title: "Owner",
    sentence: "Everything, including the plan and handing the business over. A business always has at least one.",
    permissions: EVERYTHING,
  },
  admin: {
    title: "Admin",
    sentence: "Runs the business day to day and manages the team, but cannot change the plan or hand the business over.",
    permissions: without(EVERYTHING, "subscription.manage", "feature-flags.manage", "support.access.grant", "business.transfer"),
  },
  accountant: {
    title: "Accountant (or CA)",
    sentence: "The books, bills, GST returns and payments. Not who may sign in, the plan, or the business's own particulars.",
    permissions: without(EVERYTHING,
      "access.review", "subscription.manage", "business.settings.write", "branding.write", "payments.upi.write",
      "support.access.grant", "feature-flags.manage", "incident.manage", "operations.manage", "migration.commit", "migration.rollback", "business.transfer"),
  },
  staff: {
    // The handbook's cashier (#3): may make a sale, but not see bank balances, file GST or override negative stock.
    title: "Staff",
    sentence: "Makes bills, quotations and challans, takes payments and adds customers. Cannot see bank balances, file GST or override stock.",
    permissions: [
      "dashboard.read", "sales.view", "masters.read",
      "sales.draft.write", "sales.finalise", "ledger.post.sale", "ledger.post.receipt", "inventory.move",
      "payments.record", "quotation.issue", "proforma.issue", "challan.issue",
      "masters.party.write", "einvoice.view", "eway.view", "eway.generate", "transport.vehicle.view", "assistant.ask",
    ],
  },
  viewer: {
    title: "Viewer",
    sentence: "Sees the Home page. Changes nothing, and sees no bank, tax-number or customer details.",
    permissions: ["dashboard.read"],
  },
};

export const isRoleName = (value: unknown): value is RoleName => typeof value === "string" && (ROLE_NAMES as readonly string[]).includes(value);
