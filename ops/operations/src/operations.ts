import { randomUUID } from "node:crypto";
import { AuditLog, PlatformError, type Id, type Permission, type RequestContext } from "../../../packages/platform/src/index.ts";
import { SecureLogger, type SafeLogEvent } from "../../security/src/index.ts";
import type { DiagnosticScope, ExternalFailure, FeatureFlag, Incident, IncidentUpdate, OperationState, QueueJob, SupportGrant, TraceSpan } from "./types.ts";

const HOUR = 60 * 60 * 1000;
const requirePermission = (context: RequestContext, permission: Permission): void => {
  if (!context.permissions.has(permission)) throw new PlatformError("FORBIDDEN", "You do not have permission to perform this operational action.");
};
const freeze = <T>(value: T): T => Object.freeze(value);

export class OperationsTelemetry {
  readonly #failures: ExternalFailure[] = [];
  readonly #spans = new Map<string, TraceSpan>();
  readonly #metrics = new Map<string, number>();
  readonly #checks = new Map<string, () => Promise<boolean> | boolean>();
  readonly #logger: SecureLogger;
  readonly #now: () => Date;

  constructor(sink: (event: SafeLogEvent) => void = () => {}, now: () => Date = () => new Date()) {
    this.#logger = new SecureLogger(sink);
    this.#now = now;
  }

  startSpan(context: RequestContext, name: string, correlationId: string): TraceSpan {
    if (!correlationId.trim()) throw new Error("CORRELATION_ID_REQUIRED");
    const span = freeze({ traceId: correlationId, spanId: randomUUID(), companyId: context.companyId, correlationId, name, state: "processing" as const, startedAt: this.#now().toISOString() });
    this.#spans.set(span.spanId, span);
    this.increment(context.companyId, `${name}.started`);
    return span;
  }

  finishSpan(context: RequestContext, spanId: string, state: Extract<OperationState, "success" | "failure">): TraceSpan {
    const span = this.#spans.get(spanId);
    if (!span) throw new PlatformError("NOT_FOUND", "Trace span was not found.");
    if (span.companyId !== context.companyId) throw new PlatformError("TENANT_ISOLATION", "Trace span belongs to another company.");
    const completed = freeze({ ...span, state, completedAt: this.#now().toISOString() });
    this.#spans.set(spanId, completed);
    this.increment(context.companyId, `${span.name}.${state}`);
    return completed;
  }

  externalFailure(context: RequestContext, input: { correlationId: string; connector: string; operation: string; errorCode: string; details?: Record<string, unknown> }): ExternalFailure {
    if (!input.correlationId.trim()) throw new Error("CORRELATION_ID_REQUIRED");
    if (![input.connector, input.operation, input.errorCode].every((value) => value.trim())) throw new Error("EXTERNAL_FAILURE_FIELDS_REQUIRED");
    const failure = freeze({ id: randomUUID(), companyId: context.companyId, correlationId: input.correlationId, connector: input.connector, operation: input.operation, errorCode: input.errorCode, state: "failure" as const, occurredAt: this.#now().toISOString() });
    this.#failures.push(failure);
    this.increment(context.companyId, `external.${input.connector}.failure`);
    this.#logger.write("error", "External operation failed", { ...input, companyId: context.companyId });
    return failure;
  }

  failures(context: RequestContext): readonly ExternalFailure[] {
    requirePermission(context, "operations.read");
    return this.#failures.filter((failure) => failure.companyId === context.companyId);
  }

  failuresForSupport(access: SupportAccessService, input: { grantId: Id; supportActorId: Id; companyId: Id }): readonly ExternalFailure[] {
    access.authorize(input.grantId, input.supportActorId, input.companyId, "external-failures");
    return this.#failures.filter((failure) => failure.companyId === input.companyId);
  }

  metric(context: RequestContext, name: string): number {
    requirePermission(context, "operations.read");
    return this.#metrics.get(`${context.companyId}:${name}`) ?? 0;
  }

  registerHealthCheck(name: string, check: () => Promise<boolean> | boolean): void { this.#checks.set(name, check); }
  async health(): Promise<{ state: "healthy" | "degraded"; checks: Readonly<Record<string, "up" | "down">> }> {
    const results = await Promise.all([...this.#checks].map(async ([name, check]) => [name, await check() ? "up" : "down"] as const));
    const checks = Object.fromEntries(results);
    return { state: results.every(([, value]) => value === "up") ? "healthy" : "degraded", checks };
  }

  private increment(companyId: string, name: string): void { const key = `${companyId}:${name}`; this.#metrics.set(key, (this.#metrics.get(key) ?? 0) + 1); }
}

export class SupportAccessService {
  readonly #grants = new Map<Id, SupportGrant>();
  readonly audit: AuditLog;
  readonly now: () => Date;
  constructor(audit: AuditLog, now: () => Date = () => new Date()) { this.audit = audit; this.now = now; }

  grant(context: RequestContext, input: { supportActorId: Id; reason: string; scopes: readonly DiagnosticScope[]; durationMs: number }): SupportGrant {
    requirePermission(context, "support.access.grant");
    if (!input.reason.trim() || input.scopes.length === 0) throw new Error("CONSENT_REASON_AND_SCOPE_REQUIRED");
    if (input.durationMs <= 0 || input.durationMs > 24 * HOUR) throw new Error("SUPPORT_ACCESS_DURATION_INVALID");
    const grant = freeze({ id: randomUUID(), companyId: context.companyId, supportActorId: input.supportActorId, grantedBy: context.actorId, reason: input.reason, scopes: new Set(input.scopes), createdAt: this.now().toISOString(), expiresAt: new Date(this.now().getTime() + input.durationMs).toISOString() });
    this.#grants.set(grant.id, grant);
    this.audit.append({ companyId: context.companyId, actorId: context.actorId, action: "support.access.granted", correlationId: grant.id, before: null, after: { supportActorId: grant.supportActorId, scopes: [...grant.scopes], expiresAt: grant.expiresAt, reason: grant.reason } });
    return grant;
  }

  revoke(context: RequestContext, grantId: Id): SupportGrant {
    requirePermission(context, "support.access.grant");
    const current = this.tenantGrant(context.companyId, grantId);
    const revoked = freeze({ ...current, revokedAt: this.now().toISOString() });
    this.#grants.set(grantId, revoked);
    this.audit.append({ companyId: context.companyId, actorId: context.actorId, action: "support.access.revoked", correlationId: grantId, before: { expiresAt: current.expiresAt }, after: { revokedAt: revoked.revokedAt } });
    return revoked;
  }

  authorize(grantId: Id, supportActorId: Id, companyId: Id, scope: DiagnosticScope): SupportGrant {
    const grant = this.tenantGrant(companyId, grantId);
    if (grant.supportActorId !== supportActorId || grant.revokedAt || Date.parse(grant.expiresAt) <= this.now().getTime() || !grant.scopes.has(scope)) throw new PlatformError("FORBIDDEN", "Support access is missing, expired, revoked, or outside the approved diagnostic scope.");
    this.audit.append({ companyId, actorId: supportActorId, action: "support.diagnostic.viewed", correlationId: grant.id, before: null, after: { scope } });
    return grant;
  }

  private tenantGrant(companyId: Id, grantId: Id): SupportGrant {
    const grant = this.#grants.get(grantId);
    if (!grant) throw new PlatformError("NOT_FOUND", "Support grant was not found.");
    if (grant.companyId !== companyId) throw new PlatformError("TENANT_ISOLATION", "Support grant belongs to another company.");
    return grant;
  }
}

export class OperationalQueue {
  readonly #jobs = new Map<Id, QueueJob>();
  readonly #keys = new Map<string, Id>();
  readonly audit: AuditLog;
  readonly now: () => Date;
  constructor(audit: AuditLog, now: () => Date = () => new Date()) { this.audit = audit; this.now = now; }

  enqueue(context: RequestContext, input: { kind: string; idempotencyKey: string; idempotent: boolean; maxAttempts?: number; correlationId: string }): QueueJob {
    if (!input.idempotencyKey.trim() || !input.correlationId.trim()) throw new Error("IDEMPOTENCY_AND_CORRELATION_REQUIRED");
    const key = `${context.companyId}:${input.kind}:${input.idempotencyKey}`;
    const existingId = this.#keys.get(key);
    if (existingId) return this.#jobs.get(existingId)!;
    const job = freeze({ id: randomUUID(), companyId: context.companyId, kind: input.kind, idempotencyKey: input.idempotencyKey, idempotent: input.idempotent, state: "draft" as const, attempts: 0, maxAttempts: input.maxAttempts ?? 3, correlationId: input.correlationId, createdAt: this.now().toISOString() });
    this.#jobs.set(job.id, job); this.#keys.set(key, job.id);
    return job;
  }

  begin(context: RequestContext, id: Id): QueueJob { const current = this.get(context, id); if (current.state !== "draft") throw new Error("JOB_NOT_READY"); return this.save({ ...current, state: "processing", attempts: current.attempts + 1 }); }
  succeed(context: RequestContext, id: Id): QueueJob { const current = this.get(context, id); if (current.state !== "processing") throw new Error("JOB_NOT_PROCESSING"); return this.save({ ...current, state: "success", completedAt: this.now().toISOString() }); }
  fail(context: RequestContext, id: Id, errorCode: string): QueueJob {
    const current = this.get(context, id); if (current.state !== "processing") throw new Error("JOB_NOT_PROCESSING");
    const failed = this.save({ ...current, state: "failure", lastErrorCode: errorCode, completedAt: this.now().toISOString() });
    this.audit.append({ companyId: context.companyId, actorId: context.actorId, action: current.attempts >= current.maxAttempts ? "queue.dead_lettered" : "queue.failed", correlationId: current.correlationId, before: { state: current.state }, after: { state: failed.state, errorCode, attempts: failed.attempts } });
    return failed;
  }
  replay(context: RequestContext, id: Id): QueueJob {
    requirePermission(context, "queue.replay");
    const current = this.get(context, id);
    if (!current.idempotent) throw new PlatformError("FORBIDDEN", "Only jobs declared safe and idempotent can be replayed.");
    if (current.state !== "failure") throw new Error("ONLY_FAILED_JOBS_CAN_BE_REPLAYED");
    const { completedAt: _completedAt, ...withoutCompletion } = current;
    const replayed = this.save({ ...withoutCompletion, state: "draft" });
    this.audit.append({ companyId: context.companyId, actorId: context.actorId, action: "queue.replayed", correlationId: current.correlationId, before: { state: current.state, attempts: current.attempts }, after: { state: replayed.state, attempts: replayed.attempts } });
    return replayed;
  }
  list(context: RequestContext): readonly QueueJob[] { requirePermission(context, "operations.read"); return [...this.#jobs.values()].filter((job) => job.companyId === context.companyId); }
  get(context: RequestContext, id: Id): QueueJob { const job = this.#jobs.get(id); if (!job) throw new PlatformError("NOT_FOUND", "Queue job was not found."); if (job.companyId !== context.companyId) throw new PlatformError("TENANT_ISOLATION", "Queue job belongs to another company."); return job; }
  private save(job: QueueJob): QueueJob { const stored = freeze(job); this.#jobs.set(stored.id, stored); return stored; }
}

export class StatusService {
  readonly #incidents = new Map<Id, Incident>();
  readonly #flags = new Map<string, FeatureFlag>();
  readonly audit: AuditLog;
  readonly now: () => Date;
  constructor(audit: AuditLog, now: () => Date = () => new Date()) { this.audit = audit; this.now = now; }
  openIncident(context: RequestContext, title: string, affectedService: string, message: string): Incident { requirePermission(context, "incident.manage"); const at = this.now().toISOString(); const update = freeze({ at, state: "investigating" as const, message }); const incident = freeze({ id: randomUUID(), title, affectedService, state: update.state, startedAt: at, timeline: [update] }); this.#incidents.set(incident.id, incident); this.audit.append({ companyId: context.companyId, actorId: context.actorId, action: "incident.opened", correlationId: incident.id, before: null, after: { title, affectedService } }); return incident; }
  updateIncident(context: RequestContext, id: Id, state: IncidentUpdate["state"], message: string): Incident { requirePermission(context, "incident.manage"); const current = this.#incidents.get(id); if (!current) throw new PlatformError("NOT_FOUND", "Incident was not found."); const at = this.now().toISOString(); const updated = freeze({ ...current, state, timeline: [...current.timeline, freeze({ at, state, message })], ...(state === "resolved" ? { resolvedAt: at } : {}) }); this.#incidents.set(id, updated); this.audit.append({ companyId: context.companyId, actorId: context.actorId, action: "incident.updated", correlationId: id, before: { state: current.state }, after: { state } }); return updated; }
  publicStatus(): readonly Incident[] { return [...this.#incidents.values()].map((incident) => ({ ...incident, timeline: [...incident.timeline] })); }
  defineFlag(key: string, description: string): FeatureFlag { const existing = this.#flags.get(key); if (existing) return existing; const flag = freeze({ key, description, enabled: false, allowedCompanyIds: new Set<Id>(), updatedAt: this.now().toISOString() }); this.#flags.set(key, flag); return flag; }
  setFlag(context: RequestContext, key: string, enabled: boolean, allowedCompanyIds: readonly Id[] = []): FeatureFlag { requirePermission(context, "feature-flags.manage"); const current = this.#flags.get(key); if (!current) throw new PlatformError("NOT_FOUND", "Feature flag was not found."); if (allowedCompanyIds.length > 100) throw new Error("FEATURE_FLAG_ROLLOUT_TOO_LARGE"); const updated = freeze({ ...current, enabled, allowedCompanyIds: new Set(allowedCompanyIds), updatedAt: this.now().toISOString() }); this.#flags.set(key, updated); this.audit.append({ companyId: context.companyId, actorId: context.actorId, action: "feature_flag.changed", correlationId: key, before: { enabled: current.enabled, allowedCompanyIds: [...current.allowedCompanyIds] }, after: { enabled, allowedCompanyIds } }); return updated; }
  enabled(key: string, companyId: Id): boolean { const flag = this.#flags.get(key); return flag?.enabled === true && (flag.allowedCompanyIds.size === 0 || flag.allowedCompanyIds.has(companyId)); }
}

export function createOperations(now: () => Date = () => new Date(), sink: (event: SafeLogEvent) => void = () => {}) {
  const audit = new AuditLog();
  return { audit, telemetry: new OperationsTelemetry(sink, now), support: new SupportAccessService(audit, now), queue: new OperationalQueue(audit, now), status: new StatusService(audit, now) };
}
