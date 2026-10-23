import { randomUUID } from "node:crypto";
import { PlatformError } from "../../../packages/platform/src/index.ts";
import { InMemoryPrivacyStore, type Page, type PrivacyStore, type SecurityAudit } from "./store.ts";
import type { Id, RequestContext } from "../../../packages/platform/src/index.ts";

export type PrivacyRequestKind = "export" | "deletion";
export type PrivacyRequestStatus = "requested" | "blocked" | "completed";

export interface PrivacyNotice { readonly version: string; readonly effectiveAt: string; readonly purposes: readonly string[]; }
export interface ConsentRecord { readonly id: Id; readonly companyId: Id; readonly subjectId: Id; readonly noticeVersion: string; readonly purposes: readonly string[]; readonly decision: "granted" | "withdrawn"; readonly decidedAt: string; }
export interface PrivacyRequest { readonly id: Id; readonly companyId: Id; readonly subjectId: Id; readonly kind: PrivacyRequestKind; readonly status: PrivacyRequestStatus; readonly requestedAt: string; readonly blockers: readonly string[]; readonly completedAt?: string; }
export interface LegalHold { readonly id: Id; readonly companyId: Id; readonly subjectId: Id; readonly reason: string; readonly active: boolean; }
export interface SubjectDeletionResult { readonly deletedRecords: number; readonly retainedRecords: number; }

export interface PrivacyDataStore {
  exportSubject(companyId: Id, subjectId: Id): Promise<Readonly<Record<string, unknown>>>;
  deleteSubject(companyId: Id, subjectId: Id, retainUntil: string | undefined): Promise<SubjectDeletionResult>;
}

/**
 * Each command checks its input, then writes and audits inside one `records.action(...)`: on
 * PostgreSQL (#366) that is one unit of work, so a request without its audit event is never kept.
 * Another company's hold or request id is simply not found: row-level security never reads it.
 */
export class PrivacyService {
  readonly #audit: SecurityAudit;
  readonly #store: PrivacyDataStore;
  readonly #now: () => Date;
  readonly #records: PrivacyStore;

  constructor(audit: SecurityAudit, store: PrivacyDataStore, now: () => Date = () => new Date(), records: PrivacyStore = new InMemoryPrivacyStore()) {
    this.#audit = audit;
    this.#store = store;
    this.#now = now;
    this.#records = records;
  }

  async publishNotice(context: RequestContext, notice: PrivacyNotice): Promise<PrivacyNotice> {
    requirePermission(context, "privacy.manage");
    if (!notice.version?.trim() || Number.isNaN(Date.parse(notice.effectiveAt)) || !Array.isArray(notice.purposes) || notice.purposes.length === 0
      || notice.purposes.some((purpose) => typeof purpose !== "string" || !purpose.trim())) throw new Error("INVALID_PRIVACY_NOTICE");
    const stored: PrivacyNotice = Object.freeze({ version: notice.version, effectiveAt: notice.effectiveAt, purposes: Object.freeze([...notice.purposes]) });
    return this.#records.action(context.companyId, async () => {
      const kept = await this.#records.addNotice(context.companyId, stored);
      if (kept !== stored) {
        if (Date.parse(kept.effectiveAt) !== Date.parse(stored.effectiveAt) || JSON.stringify(kept.purposes) !== JSON.stringify(stored.purposes)) throw new Error("PRIVACY_NOTICE_VERSION_CONFLICT");
        return kept;
      }
      await this.#audit.append({ companyId: context.companyId, actorId: context.actorId, action: "privacy.notice.published", correlationId: randomUUID(), before: null, after: { version: notice.version, effectiveAt: notice.effectiveAt, purposes: notice.purposes } });
      return kept;
    });
  }

  async recordConsent(context: RequestContext, subjectId: Id, noticeVersion: string, decision: ConsentRecord["decision"], purposes: readonly string[]): Promise<ConsentRecord> {
    requirePermission(context, "privacy.manage");
    if (!subjectId?.trim()) throw new Error("PRIVACY_SUBJECT_REQUIRED");
    if (decision !== "granted" && decision !== "withdrawn") throw new Error("INVALID_CONSENT_DECISION");
    const notice = await this.#records.notice(context.companyId, noticeVersion);
    if (!notice) throw new Error("PRIVACY_NOTICE_NOT_PUBLISHED");
    if (Date.parse(notice.effectiveAt) > this.#now().getTime()) throw new Error("PRIVACY_NOTICE_NOT_EFFECTIVE");
    if (purposes.length === 0 || purposes.some((purpose) => !notice.purposes.includes(purpose))) throw new Error("INVALID_CONSENT_PURPOSE");
    const consent = Object.freeze({ id: randomUUID(), companyId: context.companyId, subjectId, noticeVersion: notice.version, purposes: Object.freeze([...purposes]), decision, decidedAt: this.#now().toISOString() });
    await this.#records.action(context.companyId, async () => {
      await this.#records.addConsent(consent);
      await this.#audit.append({ companyId: context.companyId, actorId: context.actorId, action: `privacy.consent.${decision}`, correlationId: consent.id, before: null, after: { subjectId, noticeVersion: notice.version, purposes } });
    });
    return consent;
  }

  async placeLegalHold(context: RequestContext, subjectId: Id, reason: string): Promise<LegalHold> {
    requirePermission(context, "privacy.manage");
    if (!subjectId?.trim()) throw new Error("PRIVACY_SUBJECT_REQUIRED");
    if (!reason?.trim()) throw new Error("LEGAL_HOLD_REASON_REQUIRED");
    const hold = Object.freeze({ id: randomUUID(), companyId: context.companyId, subjectId, reason, active: true });
    await this.#records.action(context.companyId, async () => {
      await this.#records.addHold(hold, this.#now().toISOString());
      await this.#audit.append({ companyId: context.companyId, actorId: context.actorId, action: "privacy.legal_hold.placed", correlationId: hold.id, before: null, after: { subjectId, reason } });
    });
    return hold;
  }

  /** Releasing a hold twice (a retry, or two people at once) keeps the first release and audits it once. */
  async releaseLegalHold(context: RequestContext, holdId: Id, reason: string): Promise<LegalHold> {
    requirePermission(context, "privacy.manage");
    if (!reason?.trim()) throw new Error("LEGAL_HOLD_RELEASE_REASON_REQUIRED");
    return this.#records.action(context.companyId, async () => {
      const released = await this.#records.releaseHold(context.companyId, holdId, this.#now().toISOString());
      if (released === null) throw new PlatformError("NOT_FOUND", "Legal hold was not found.");
      if (released.changed) await this.#audit.append({ companyId: context.companyId, actorId: context.actorId, action: "privacy.legal_hold.released", correlationId: holdId, before: { active: true }, after: { active: false, reason } });
      return released.hold;
    });
  }

  async setRetention(context: RequestContext, subjectId: Id, retainUntil: string): Promise<void> {
    requirePermission(context, "privacy.manage");
    if (!subjectId?.trim()) throw new Error("PRIVACY_SUBJECT_REQUIRED");
    if (typeof retainUntil !== "string" || Number.isNaN(Date.parse(retainUntil))) throw new Error("INVALID_RETENTION_DATE");
    await this.#records.action(context.companyId, async () => {
      await this.#records.setRetention(context.companyId, subjectId, retainUntil, this.#now().toISOString());
      await this.#audit.append({ companyId: context.companyId, actorId: context.actorId, action: "privacy.retention.set", correlationId: randomUUID(), before: null, after: { subjectId, retainUntil } });
    });
  }

  async request(context: RequestContext, subjectId: Id, kind: PrivacyRequestKind, idempotencyKey: string): Promise<PrivacyRequest> {
    if (kind !== "export" && kind !== "deletion") throw new Error("INVALID_PRIVACY_REQUEST_KIND");
    requirePermission(context, kind === "export" ? "privacy.export" : "privacy.delete");
    if (!subjectId?.trim()) throw new Error("PRIVACY_SUBJECT_REQUIRED");
    if (!idempotencyKey?.trim()) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
    const fresh = Object.freeze({ id: randomUUID(), companyId: context.companyId, subjectId, kind, status: "requested" as const, requestedAt: this.#now().toISOString(), blockers: Object.freeze([]) });
    return this.#records.action(context.companyId, async () => {
      const kept = await this.#records.addRequest(fresh, idempotencyKey);
      if (kept.id !== fresh.id) {
        if (kept.subjectId !== subjectId) throw new PlatformError("IDEMPOTENCY_CONFLICT", "This privacy idempotency key was already used for another person.");
        return kept;
      }
      await this.#audit.append({ companyId: context.companyId, actorId: context.actorId, action: `privacy.${kind}.requested`, correlationId: kept.id, before: null, after: { subjectId, status: kept.status } });
      return kept;
    });
  }

  async get(context: RequestContext, requestId: Id): Promise<PrivacyRequest> {
    const request = await this.#records.request(context.companyId, requestId);
    if (!request) throw new PlatformError("NOT_FOUND", "Privacy request was not found.");
    return request;
  }

  async executeExport(context: RequestContext, requestId: Id): Promise<Readonly<Record<string, unknown>>> {
    requirePermission(context, "privacy.export");
    return this.#records.action(context.companyId, async () => {
      const request = await this.get(context, requestId);
      if (request.kind !== "export" || request.status !== "requested") throw new Error("PRIVACY_REQUEST_NOT_EXECUTABLE");
      const { result: exported } = await this.#complete(context, request, () => this.#store.exportSubject(context.companyId, request.subjectId));
      return Object.freeze({ notice: "This export contains the data held for the requested person.", generatedAt: this.#now().toISOString(), subjectId: request.subjectId, data: exported });
    });
  }

  async executeDeletion(context: RequestContext, requestId: Id): Promise<{ readonly request: PrivacyRequest; readonly result?: SubjectDeletionResult }> {
    requirePermission(context, "privacy.delete");
    return this.#records.action(context.companyId, async () => {
      const request = await this.get(context, requestId);
      if (request.kind !== "deletion" || request.status !== "requested") throw new Error("PRIVACY_REQUEST_NOT_EXECUTABLE");
      const activeHolds = await this.#records.activeHolds(context.companyId, request.subjectId);
      const retainUntil = await this.#records.retention(context.companyId, request.subjectId);
      const blockers = activeHolds.map((hold) => `Legal hold: ${hold.reason}`);
      if (retainUntil && Date.parse(retainUntil) > this.#now().getTime()) blockers.push(`Records must be retained until ${retainUntil}`);
      if (blockers.length > 0) {
        const blocked = Object.freeze({ ...request, status: "blocked" as const, blockers: Object.freeze(blockers) });
        if (!(await this.#records.settleRequest(blocked))) throw new Error("PRIVACY_REQUEST_NOT_EXECUTABLE");
        await this.#audit.append({ companyId: context.companyId, actorId: context.actorId, action: "privacy.deletion.blocked", correlationId: request.id, before: { status: request.status }, after: { status: blocked.status, blockers } });
        return { request: blocked };
      }
      return this.#complete(context, request, () => this.#store.deleteSubject(context.companyId, request.subjectId, retainUntil),
        (result) => ({ deletedRecords: result.deletedRecords, retainedRecords: result.retainedRecords }));
    });
  }

  async consents(context: RequestContext, subjectId: Id, page?: Page): Promise<readonly ConsentRecord[]> {
    requirePermission(context, "privacy.manage");
    return this.#records.consents(context.companyId, subjectId, page);
  }

  /**
   * Claims the request first, so two executions at once cannot both export or delete; audits it
   * only after `run` succeeds, so a failed export or deletion is never recorded as done.
   */
  async #complete<R>(context: RequestContext, request: PrivacyRequest, run: () => Promise<R>, summary: (result: R) => Readonly<Record<string, unknown>> = () => ({})): Promise<{ readonly request: PrivacyRequest; readonly result: R }> {
    const completed = Object.freeze({ ...request, status: "completed" as const, completedAt: this.#now().toISOString() });
    if (!(await this.#records.settleRequest(completed))) throw new Error("PRIVACY_REQUEST_NOT_EXECUTABLE");
    const result = await run();
    await this.#audit.append({ companyId: context.companyId, actorId: context.actorId, action: `privacy.${request.kind}.completed`, correlationId: request.id, before: { status: request.status }, after: { status: completed.status, ...summary(result) } });
    return { request: completed, result };
  }
}

function requirePermission(context: RequestContext, permission: "privacy.manage" | "privacy.export" | "privacy.delete"): void {
  if (!context.permissions.has(permission)) throw new PlatformError("FORBIDDEN", `Permission ${permission} is required.`);
}
