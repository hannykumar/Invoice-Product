export type Id = string;
export type Permission =
  | "sale.draft.create"
  | "bank.balance.read"
  | "gst.file"
  | "stock.negative.override"
  | "approval.decide"
  | "access.review";

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
  public readonly code: "FORBIDDEN" | "TENANT_ISOLATION" | "INVALID_TRANSITION" | "APPROVAL_REQUIRED" | "IDEMPOTENCY_CONFLICT" | "NOT_FOUND" | "SESSION_REVOKED";
  constructor(
    code: "FORBIDDEN" | "TENANT_ISOLATION" | "INVALID_TRANSITION" | "APPROVAL_REQUIRED" | "IDEMPOTENCY_CONFLICT" | "NOT_FOUND" | "SESSION_REVOKED",
    message: string,
  ) { super(message); this.code = code; }
}
