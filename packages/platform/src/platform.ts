import { randomUUID } from "node:crypto";
import { PlatformError } from "./types.ts";
import type { AuditEvent, ApprovalPolicy, CommandRecord, CommandStatus, ExceptionItem, Id, Permission, RequestContext } from "./types.ts";

const riskRank = { low: 0, medium: 1, high: 2 } as const;
const transitions: Readonly<Record<CommandStatus, readonly CommandStatus[]>> = {
  draft: ["submitted", "cancelled"], submitted: ["approved", "rejected", "cancelled"],
  approved: ["finalised", "failed", "cancelled"], rejected: [], finalised: [], failed: ["submitted", "cancelled"], cancelled: [],
};
const redactValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, /credential|authorization|cookie|secret|password|token|pin|private.?key|session|raw|content|document|attachment|pdf|bank.?statement/i.test(key) ? "[REDACTED]" : redactValue(item)]));
  return value;
};
const redact = (value: Record<string, unknown>): Record<string, unknown> => redactValue(value) as Record<string, unknown>;
const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? { $bigint: item.toString() } : item);
const clone = <T>(value: T): T => structuredClone(value);
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) freeze(item);
    Object.freeze(value);
  }
  return value;
};

export class AuditLog {
  #events: AuditEvent[] = [];
  append(event: Omit<AuditEvent, "id" | "occurredAt">): AuditEvent {
    const stored = freeze({ ...event, id: randomUUID(), occurredAt: new Date().toISOString(), before: event.before && redact(clone(event.before)), after: event.after && redact(clone(event.after)) });
    this.#events.push(stored);
    return stored;
  }
  forCompany(context: RequestContext): readonly AuditEvent[] { return Object.freeze(this.#events.filter((event) => event.companyId === context.companyId)); }
  count(): number { return this.#events.length; }
}

export class PlatformCommandService {
  #commands = new Map<Id, CommandRecord>();
  #idempotency = new Map<string, { commandId: Id; payload: string }>();
  public readonly audit: AuditLog;
  private readonly policies: readonly ApprovalPolicy[];
  constructor(audit: AuditLog, policies: readonly ApprovalPolicy[] = []) { this.audit = audit; this.policies = policies; }
  create(context: RequestContext, input: Omit<CommandRecord, "id" | "companyId" | "branchId" | "actorId" | "status" | "createdAt">): CommandRecord {
    if (!input.idempotencyKey.trim()) throw new PlatformError("IDEMPOTENCY_CONFLICT", "An idempotency key is required.");
    const key = `${context.companyId}:${input.action}:${input.idempotencyKey}`;
    const payload = canonicalJson(input.payload);
    const existing = this.#idempotency.get(key);
    if (existing) {
      if (existing.payload !== payload) throw new PlatformError("IDEMPOTENCY_CONFLICT", "This idempotency key was already used with different input.");
      return this.#commands.get(existing.commandId)!;
    }
    const record = freeze({ ...input, payload: clone(input.payload), id: randomUUID(), companyId: context.companyId, branchId: context.branchId, actorId: context.actorId, status: "draft" as const, createdAt: new Date().toISOString() });
    this.#commands.set(record.id, record); this.#idempotency.set(key, { commandId: record.id, payload });
    this.audit.append({ companyId: context.companyId, actorId: context.actorId, action: `${record.action}.created`, correlationId: record.id, before: null, after: { status: record.status, payload: record.payload } });
    return record;
  }
  get(context: RequestContext, id: Id): CommandRecord { const record = this.#commands.get(id); if (!record) throw new PlatformError("NOT_FOUND", "Command was not found."); if (record.companyId !== context.companyId) throw new PlatformError("TENANT_ISOLATION", "This command belongs to another company."); return record; }
  transition(context: RequestContext, id: Id, next: CommandStatus, reason?: string): CommandRecord {
    const current = this.get(context, id);
    if (!transitions[current.status].includes(next)) throw new PlatformError("INVALID_TRANSITION", `Cannot move ${current.status} to ${next}.`);
    if (next === "approved") this.requireApproval(context, current);
    if (next === "finalised" && this.needsApproval(current) && current.status !== "approved") throw new PlatformError("APPROVAL_REQUIRED", "This action requires approval before it can be finalised.");
    const updated = freeze({ ...current, status: next }); this.#commands.set(id, updated);
    this.audit.append({ companyId: context.companyId, actorId: context.actorId, action: `${current.action}.${next}`, correlationId: id, before: { status: current.status }, after: { status: next }, ...(reason ? { reason } : {}) });
    return updated;
  }
  private needsApproval(command: CommandRecord): boolean { return this.policies.some((policy) => policy.action === command.action && riskRank[command.risk] >= riskRank[policy.minimumRisk] && (policy.minimumAmountPaise === undefined || (command.amountPaise ?? 0n) >= policy.minimumAmountPaise)); }
  private requireApproval(context: RequestContext, command: CommandRecord): void { const matching = this.policies.filter((policy) => policy.action === command.action && riskRank[command.risk] >= riskRank[policy.minimumRisk] && (policy.minimumAmountPaise === undefined || (command.amountPaise ?? 0n) >= policy.minimumAmountPaise)); for (const policy of matching) if (!context.permissions.has(policy.requiredPermission)) throw new PlatformError("FORBIDDEN", "You do not have permission to approve this action."); }
}

export class ExceptionQueue {
  #items = new Map<Id, ExceptionItem>();
  private readonly audit: AuditLog | undefined;
  constructor(audit?: AuditLog) { this.audit = audit; }
  create(context: RequestContext, summary: string, evidence: readonly string[]): ExceptionItem { if (!summary.trim() || evidence.length === 0) throw new Error("Exceptions need a summary and supporting evidence."); const item: ExceptionItem = freeze({ id: randomUUID(), companyId: context.companyId, status: "open" as const, summary, evidence: [...evidence], comments: [] }); this.#items.set(item.id, item); this.audit?.append({ companyId: context.companyId, actorId: context.actorId, action: "exception.created", correlationId: item.id, before: null, after: { status: item.status, summary: item.summary, evidence: item.evidence } }); return item; }
  get(context: RequestContext, id: Id): ExceptionItem { const item = this.#items.get(id); if (!item) throw new PlatformError("NOT_FOUND", "Exception was not found."); if (item.companyId !== context.companyId) throw new PlatformError("TENANT_ISOLATION", "This exception belongs to another company."); return item; }
  comment(context: RequestContext, id: Id, body: string): ExceptionItem { const current = this.get(context, id); if (!body.trim()) throw new Error("Exception comments cannot be empty."); const next = freeze({ ...current, comments: [...current.comments, { actorId: context.actorId, body, createdAt: new Date().toISOString() }] }); this.#items.set(id, next); this.audit?.append({ companyId: context.companyId, actorId: context.actorId, action: "exception.commented", correlationId: id, before: null, after: { comment: body } }); return next; }
  resolve(context: RequestContext, id: Id): ExceptionItem { const current = this.get(context, id); const next = freeze({ ...current, status: "resolved" as const }); this.#items.set(id, next); this.audit?.append({ companyId: context.companyId, actorId: context.actorId, action: "exception.resolved", correlationId: id, before: { status: current.status }, after: { status: next.status } }); return next; }
}

export interface Member { userId: Id; companyId: Id; branchIds: ReadonlySet<Id>; active: boolean; permissions: ReadonlySet<Permission>; }
export class AccessControl {
  #members = new Map<string, Member>();
  grant(member: Member): void { this.#members.set(`${member.companyId}:${member.userId}`, member); }
  revoke(companyId: Id, userId: Id): void { const key = `${companyId}:${userId}`; const member = this.#members.get(key); if (member) this.#members.set(key, { ...member, active: false }); }
  members(companyId: Id): readonly Member[] { return [...this.#members.values()].filter((member) => member.companyId === companyId); }
  context(companyId: Id, branchId: Id, userId: Id, sessionId: Id): RequestContext { const member = this.#members.get(`${companyId}:${userId}`); if (!member || !member.active || !member.branchIds.has(branchId)) throw new PlatformError("SESSION_REVOKED", "Your access is no longer active."); return { companyId, branchId, actorId: userId, sessionId, permissions: member.permissions }; }
}
