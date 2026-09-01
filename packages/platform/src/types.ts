export type Id = string;
export type Permission =
  | "sale.draft.create"
  | "dashboard.read"
  | "ledger.setup"
  | "ledger.post.purchase"
  | "ledger.post.sale"
  | "ledger.post.receipt"
  | "ledger.post.payment"
  | "ledger.post.journal"
  | "ledger.post.credit_note"
  | "ledger.post.debit_note"
  | "ledger.reverse"
  | "returns.create"
  | "inventory.move"
  | "inventory.adjust"
  | "inventory.override_negative"
  | "purchase.order.write"
  | "purchase.order.cancel"
  | "purchase.receipt.write"
  | "purchase.match.approve"
  | "supplier.risk.view"
  | "supplier.risk.acknowledge"
  | "einvoice.view"
  | "einvoice.generate"
  | "einvoice.cancel"
  | "eway.view"
  | "eway.generate"
  | "eway.update"
  | "eway.cancel"
  // Issue #30. Preparing a GST return, approving it and sending it are four separate acts, because
  // looking at what a month says is harmless and filing it on a business's behalf is not.
  | "gst_returns.view"
  | "gst_returns.prepare"
  | "gst_returns.approve"
  | "gst_returns.export"
  | "gst_returns.submit"
  | "gst_returns.reopen"
  // Issue #31. Comparing purchases with what the suppliers told the government. Claiming credit
  // the government's record does not carry is deliberately its own permission: it is the one act
  // in the comparison that can cost the business money if it turns out to be wrong.
  | "itc.view"
  | "itc.import"
  | "itc.decide"
  | "itc.claim_at_risk"
  // Issue #28. Checking a lorry against its load is an everyday act; sending a blocked movement
  // out anyway is deliberately a separate permission from checking it.
  | "transport.vehicle.view"
  | "transport.vehicle.check"
  | "transport.vehicle.override"
  | "sales.draft.write"
  | "sales.finalise"
  | "sales.approve"
  | "sales.cancel"
  | "payments.record"
  | "payments.allocate"
  | "payments.reverse"
  | "payments.write_off"
  | "bank.balance.read"
  | "bank.statement.import"
  | "bank.feed.manage"
  | "bank.feed.sync"
  | "gst.file"
  | "stock.negative.override"
  | "approval.decide"
  | "access.review"
  | "notification.send"
  | "notification.sensitive.send"
  | "collections.manage"
  | "collections.send"
  | "privacy.manage"
  | "privacy.export"
  | "privacy.delete"
  | "backup.manage"
  | "backup.restore"
  | "operations.read"
  | "operations.manage"
  | "support.access.grant"
  | "queue.replay"
  | "incident.manage"
  | "feature-flags.manage"
  // Approving a discount larger than the business allows (issue #11, GPT 1).
  | "sales.approve_discount"
  // Reports (issue #35, GPT 1). Added to the union so an owner's session can be granted them.
  | "reports.view.financial"
  | "reports.view.sales"
  | "reports.view.purchase"
  | "reports.view.stock"
  | "reports.view.dues"
  | "reports.view.gst"
  | "reports.view.exceptions"
  | "reports.export"
  // Chasing overdue money (issue #23 [E23]). Built by GPT 1 on GPT 2's notification service.
  | "collections.reminders.view"
  | "collections.reminders.send"
  | "collections.promise.record"
  | "collections.dispute.manage"
  // What a plan covers and what has been used (issue #42 [E42], GPT 1).
  | "subscription.view"
  | "subscription.manage"
  // Issue #34 [E34], GPT 1: asking questions about this company's own books.
  | "assistant.ask"
  // Issue #34 [E34], GPT 1: asking questions about this company's own books.
  | "assistant.ask"
  // Issue #47 [E47], GPT 1: letting the assistant do authorised work through typed tools.
  | "agent.plan"
  | "agent.approve"
  | "agent.execute"
  // Issue #32 [E32]. Reading the compliance calendar, marking an obligation done with evidence,
  // silencing a reminder and putting a deadline in front of the owner are four different acts.
  // Silencing a warning is separated from reading one on purpose: it is a decision with a
  // consequence, and the record of who made it is half the reason for having it.
  | "compliance.calendar.view"
  | "compliance.calendar.refresh"
  | "compliance.calendar.complete"
  | "compliance.calendar.snooze"
  | "compliance.calendar.escalate"
  | "compliance.calendar.declare";

export interface RequestContext {
  companyId: Id;
  branchId: Id;
  actorId: Id;
  permissions: ReadonlySet<Permission>;
  sessionId: Id;
}

export type CommandStatus = "draft" | "submitted" | "approved" | "rejected" | "finalised" | "failed" | "cancelled";

export interface CommandRecord {
  id: Id;
  companyId: Id;
  branchId: Id;
  actorId: Id;
  action: string;
  risk: "low" | "medium" | "high";
  amountPaise?: bigint;
  status: CommandStatus;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AuditEvent {
  id: Id;
  companyId: Id;
  actorId: Id;
  action: string;
  occurredAt: string;
  correlationId: Id;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason?: string;
}

export interface ApprovalPolicy {
  action: string;
  minimumRisk: CommandRecord["risk"];
  minimumAmountPaise?: bigint;
  requiredPermission: Permission;
}
export interface ExceptionItem { id: Id; companyId: Id; status: "open" | "resolved" | "dismissed"; summary: string; evidence: readonly string[]; comments: readonly { actorId: Id; body: string; createdAt: string }[]; }

export class PlatformError extends Error {
  public readonly code: "FORBIDDEN" | "TENANT_ISOLATION" | "INVALID_TRANSITION" | "APPROVAL_REQUIRED" | "IDEMPOTENCY_CONFLICT" | "NOT_FOUND" | "SESSION_REVOKED" | "SESSION_EXPIRED";
  constructor(
    code: "FORBIDDEN" | "TENANT_ISOLATION" | "INVALID_TRANSITION" | "APPROVAL_REQUIRED" | "IDEMPOTENCY_CONFLICT" | "NOT_FOUND" | "SESSION_REVOKED" | "SESSION_EXPIRED",
    message: string,
  ) { super(message); this.code = code; }
}
