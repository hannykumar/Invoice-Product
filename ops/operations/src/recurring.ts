import type { Permission, RequestContext } from "../../../packages/platform/src/index.ts";
import type { OperationalQueue } from "./operations.ts";
import type { QueueJob, RecurringRunOutcome, RecurringWorkStatus } from "./types.ts";

const MINUTE = 60_000;

export interface RecurringJobResult { readonly summary?: string; }

export interface RecurringJobDefinition {
  readonly key: string;
  readonly name: string;
  readonly everyMs: number;
  readonly requiredPermissions: readonly Permission[];
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly timeoutMs?: number;
  readonly run: (context: RequestContext, scheduledFor: Date, signal: AbortSignal) => Promise<void | RecurringJobResult>;
}

interface Registration {
  readonly context: RequestContext;
  readonly definition: RecurringJobDefinition;
}

const errorCodeOf = (error: unknown): string => {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_.-]+$/.test(error.code)) return error.code;
  if (error instanceof Error && /^[A-Za-z0-9_.-]+$/.test(error.name)) return error.name.toUpperCase();
  return "RECURRING_JOB_FAILED";
};

const iso = (value: number): string => new Date(value).toISOString();
const freeze = <T>(value: T): T => Object.freeze(value);

/**
 * Issue #122 — a small host-controlled scheduler over the existing operational queue.
 *
 * `runDue` is the production tick and the virtual-clock test seam. Definitions stay in code; only
 * their per-company progress is state. Missed slots are coalesced to the latest due slot, because
 * replaying ninety historical morning sweeps after downtime would send stale warnings.
 */
export class RecurringWorkRunner {
  readonly #queue: OperationalQueue;
  readonly #now: () => Date;
  readonly #registrations = new Map<string, Registration>();
  readonly #statuses = new Map<string, RecurringWorkStatus>();
  readonly #running = new Map<string, Promise<RecurringWorkStatus>>();

  constructor(queue: OperationalQueue, now: () => Date = () => new Date()) {
    this.#queue = queue;
    this.#now = now;
  }

  register(context: RequestContext, definition: RecurringJobDefinition, firstRunAt = this.#now()): RecurringWorkStatus {
    if (!definition.key.trim() || !definition.name.trim()) throw new Error("RECURRING_JOB_NAME_REQUIRED");
    if (!Number.isSafeInteger(definition.everyMs) || definition.everyMs < MINUTE) throw new Error("RECURRING_INTERVAL_INVALID");
    if (!context.actorId.trim() || !context.sessionId.trim()) throw new Error("RECURRING_SERVICE_ACTOR_REQUIRED");
    if (!context.permissions.has("queue.replay")) throw new Error("RECURRING_SERVICE_ACTOR_NEEDS_QUEUE_REPLAY");
    for (const permission of definition.requiredPermissions) {
      if (!context.permissions.has(permission)) throw new Error(`RECURRING_SERVICE_ACTOR_NEEDS_${permission.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`);
    }
    const key = this.#key(context.companyId, definition.key);
    const existing = this.#statuses.get(key);
    if (existing !== undefined) return existing;
    const status = freeze<RecurringWorkStatus>({
      companyId: context.companyId,
      jobKey: definition.key,
      name: definition.name,
      everyMs: definition.everyMs,
      nextRunAt: firstRunAt.toISOString(),
      outcome: "never",
      attempts: 0,
      maxAttempts: definition.maxAttempts ?? 3,
    });
    this.#registrations.set(key, { context, definition });
    this.#statuses.set(key, status);
    return status;
  }

  /** Run every due tenant/job independently; one slow or broken job cannot hold the others. */
  async runDue(companyId?: string): Promise<readonly RecurringWorkStatus[]> {
    const at = this.#now().getTime();
    const work: Promise<RecurringWorkStatus>[] = [];
    for (const [key, registration] of this.#registrations) {
      if (companyId !== undefined && registration.context.companyId !== companyId) continue;
      const status = this.#statuses.get(key)!;
      const replayed = status.outcome === "dead_lettered" && status.queueJobId !== undefined
        && this.#queue.get(registration.context, status.queueJobId).state === "draft";
      if ((!replayed && Date.parse(status.nextRunAt) > at) || this.#running.has(key)) continue;
      const scheduledFor = (status.outcome === "failure" || replayed) && status.lastScheduledFor !== undefined
        ? Date.parse(status.lastScheduledFor)
        : this.#latestSlot(Date.parse(status.nextRunAt), registration.definition.everyMs, at);
      const execution = this.#execute(key, registration, status, scheduledFor);
      this.#running.set(key, execution);
      work.push(execution);
    }
    return Promise.all(work);
  }

  status(context: RequestContext): readonly RecurringWorkStatus[] {
    if (!context.permissions.has("operations.read")) throw new Error("RECURRING_STATUS_FORBIDDEN");
    return [...this.#statuses.values()]
      .filter((status) => status.companyId === context.companyId)
      .sort((left, right) => left.jobKey.localeCompare(right.jobKey));
  }

  async #execute(key: string, registration: Registration, previous: RecurringWorkStatus, scheduledFor: number): Promise<RecurringWorkStatus> {
    const { context, definition } = registration;
    const started = this.#now().getTime();
    let job = this.#jobFor(context, definition, previous, scheduledFor);
    if (job.state === "failure") job = this.#queue.replay(context, job.id);
    if (job.state !== "draft") {
      this.#running.delete(key);
      return previous;
    }
    job = this.#queue.begin(context, job.id);
    this.#save(key, {
      ...previous,
      outcome: "running",
      attempts: job.attempts,
      lastScheduledFor: iso(scheduledFor),
      lastStartedAt: iso(started),
      queueJobId: job.id,
      lastErrorCode: undefined,
      summary: undefined,
    });

    const controller = new AbortController();
    const handled = Promise.resolve()
      .then(() => definition.run(context, new Date(scheduledFor), controller.signal))
      .then((result) => ({ kind: "success" as const, result }))
      .catch((error: unknown) => ({ kind: "failure" as const, error }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = definition.timeoutMs ?? 30_000;
    const timeout = new Promise<{ readonly kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve({ kind: "timeout" }); }, timeoutMs);
    });
    const outcome = await Promise.race([handled, timeout]);
    if (timer !== undefined) clearTimeout(timer);

    const completed = this.#now().getTime();
    if (outcome.kind === "success") {
      this.#queue.succeed(context, job.id);
      this.#running.delete(key);
      return this.#save(key, {
        ...previous,
        outcome: "success",
        attempts: job.attempts,
        lastScheduledFor: iso(scheduledFor),
        lastStartedAt: iso(started),
        lastCompletedAt: iso(completed),
        durationMs: Math.max(0, completed - started),
        nextRunAt: iso(scheduledFor + definition.everyMs),
        queueJobId: job.id,
        ...(outcome.result?.summary === undefined ? {} : { summary: outcome.result.summary }),
      });
    }

    const code = outcome.kind === "timeout" ? "RECURRING_JOB_TIMED_OUT" : errorCodeOf(outcome.error);
    const failed = this.#queue.fail(context, job.id, code);
    const dead = failed.attempts >= failed.maxAttempts;
    const status = this.#save(key, {
      ...previous,
      outcome: (dead ? "dead_lettered" : "failure") as RecurringRunOutcome,
      attempts: failed.attempts,
      lastScheduledFor: iso(scheduledFor),
      lastStartedAt: iso(started),
      lastCompletedAt: iso(completed),
      durationMs: Math.max(0, completed - started),
      lastErrorCode: code,
      nextRunAt: dead ? iso(scheduledFor + definition.everyMs) : iso(completed + (definition.retryDelayMs ?? MINUTE)),
      queueJobId: failed.id,
    });
    if (outcome.kind === "timeout") {
      // A JavaScript promise cannot be killed. Keep the overlap lock until it really settles, but
      // do not await it here: other tenants and jobs have already completed independently.
      void handled.finally(() => this.#running.delete(key));
    } else {
      this.#running.delete(key);
    }
    return status;
  }

  #jobFor(context: RequestContext, definition: RecurringJobDefinition, previous: RecurringWorkStatus, scheduledFor: number): QueueJob {
    if (previous.queueJobId !== undefined) {
      const existing = this.#queue.get(context, previous.queueJobId);
      if (previous.outcome === "failure" || existing.state === "draft") return existing;
    }
    return this.#queue.enqueue(context, {
      kind: `recurring:${definition.key}`,
      idempotencyKey: iso(scheduledFor),
      idempotent: true,
      maxAttempts: definition.maxAttempts ?? 3,
      correlationId: `recurring:${context.companyId}:${definition.key}:${iso(scheduledFor)}`,
    });
  }

  #save(key: string, value: RecurringWorkStatus): RecurringWorkStatus {
    const withoutUndefined = Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as unknown as RecurringWorkStatus;
    const stored = freeze(withoutUndefined);
    this.#statuses.set(key, stored);
    return stored;
  }

  #latestSlot(first: number, everyMs: number, now: number): number {
    return first + Math.floor(Math.max(0, now - first) / everyMs) * everyMs;
  }

  #key(companyId: string, jobKey: string): string { return `${companyId}:${jobKey}`; }
}
