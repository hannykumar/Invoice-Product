import type { Id } from "../../../packages/platform/src/index.ts";

export type OperationState = "draft" | "processing" | "success" | "failure";
export type DiagnosticScope = "external-failures" | "queue-state" | "health";

export interface ExternalFailure {
  readonly id: Id;
  readonly companyId: Id;
  readonly correlationId: string;
  readonly connector: string;
  readonly operation: string;
  readonly errorCode: string;
  readonly state: "failure";
  readonly occurredAt: string;
}

export interface TraceSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly companyId: Id;
  readonly correlationId: string;
  readonly name: string;
  readonly state: OperationState;
  readonly startedAt: string;
  readonly completedAt?: string;
}

export interface QueueJob {
  readonly id: Id;
  readonly companyId: Id;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly idempotent: boolean;
  readonly state: OperationState;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly correlationId: string;
  readonly lastErrorCode?: string;
  readonly createdAt: string;
  readonly completedAt?: string;
}

export type RecurringRunOutcome = "never" | "running" | "success" | "failure" | "dead_lettered";

/** Operator-facing state for one code-registered job in one company. */
export interface RecurringWorkStatus {
  readonly companyId: Id;
  readonly jobKey: string;
  readonly name: string;
  readonly everyMs: number;
  readonly nextRunAt: string;
  readonly outcome: RecurringRunOutcome;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastScheduledFor?: string | undefined;
  readonly lastStartedAt?: string | undefined;
  readonly lastCompletedAt?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly lastErrorCode?: string | undefined;
  readonly queueJobId?: Id | undefined;
  readonly summary?: string | undefined;
}

export interface SupportGrant {
  readonly id: Id;
  readonly companyId: Id;
  readonly supportActorId: Id;
  readonly grantedBy: Id;
  readonly reason: string;
  readonly scopes: ReadonlySet<DiagnosticScope>;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export interface IncidentUpdate { readonly at: string; readonly state: "investigating" | "identified" | "monitoring" | "resolved"; readonly message: string; }
export interface Incident { readonly id: Id; readonly title: string; readonly affectedService: string; readonly state: IncidentUpdate["state"]; readonly startedAt: string; readonly resolvedAt?: string; readonly timeline: readonly IncidentUpdate[]; }
export interface FeatureFlag { readonly key: string; readonly description: string; readonly enabled: boolean; readonly allowedCompanyIds: ReadonlySet<Id>; readonly updatedAt: string; }
