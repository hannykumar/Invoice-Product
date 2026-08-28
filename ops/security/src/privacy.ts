import { randomUUID } from "node:crypto";
import { AuditLog, PlatformError } from "../../../packages/platform/src/index.ts";
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

export class PrivacyService {
  readonly #audit: AuditLog;
  readonly #store: PrivacyDataStore;
  readonly #now: () => Date;
  readonly #consents: ConsentRecord[] = [];
  readonly #notices = new Map<string, PrivacyNotice>();
  readonly #requests = new Map<Id, PrivacyRequest>();
  readonly #requestKeys = new Map<string, { readonly requestId: Id; readonly subjectId: Id }>();
  readonly #holds = new Map<Id, LegalHold>();
  readonly #retention = new Map<string, string>();

  constructor(audit: AuditLog, store: PrivacyDataStore, now: () => Date = () => new Date()) {
    this.#audit = audit;
    this.#store = store;
    this.#now = now;
  }

  publishNotice(context: RequestContext, notice: PrivacyNotice): PrivacyNotice {
    requirePermission(context, "privacy.manage");
    if (!notice.version.trim() || Number.isNaN(Date.parse(notice.effectiveAt)) || notice.purposes.length === 0) throw new Error("INVALID_PRIVACY_NOTICE");
    const key = `${context.companyId}:${notice.version}`;
    const existing = this.#notices.get(key);
    if (existing) {
      if (existing.effectiveAt !== notice.effectiveAt || JSON.stringify(existing.purposes) !== JSON.stringify(notice.purposes)) throw new Error("PRIVACY_NOTICE_VERSION_CONFLICT");
      return existing;
    }
    const stored = Object.freeze({ ...notice, purposes: [...notice.purposes] });
    this.#notices.set(key, stored);
    this.#audit.append({ companyId: context.companyId, actorId: context.actorId, action: "privacy.notice.published", correlationId: randomUUID(), before: null, after: { version: notice.version, effectiveAt: notice.effectiveAt, purposes: notice.purposes } });
    return stored;
  }

  recordConsent(context: RequestContext, subjectId: Id, noticeVersion: string, decision: ConsentRecord["decision"], purposes: readonly string[]): ConsentRecord {
    requirePermission(context, "privacy.manage");
    const notice = this.#notices.get(`${context.companyId}:${noticeVersion}`);
    if (!notice) throw new Error("PRIVACY_NOTICE_NOT_PUBLISHED");
    if (Date.parse(notice.effectiveAt) > this.#now().getTime()) throw new Error("PRIVACY_NOTICE_NOT_EFFECTIVE");
    if (purposes.length === 0 || purposes.some((purpose) => !notice.purposes.includes(purpose))) throw new Error("INVALID_CONSENT_PURPOSE");
    const consent = Object.freeze({ id: randomUUID(), companyId: context.companyId, subjectId, noticeVersion: notice.version, purposes: [...purposes], decision, decidedAt: this.#now().toISOString() });
    this.#consents.push(consent);
    this.#audit.append({ companyId: context.companyId, actorId: context.actorId, action: `privacy.consent.${decision}`, correlationId: consent.id, before: null, after: { subjectId, noticeVersion: notice.version, purposes } });
    return consent;
  }

  placeLegalHold(context: RequestContext, subjectId: Id, reason: string): LegalHold {
    requirePermission(context, "privacy.manage");
    if (!reason.trim()) throw new Error("LEGAL_HOLD_REASON_REQUIRED");
    const hold = Object.freeze({ id: randomUUID(), companyId: context.companyId, subjectId, reason, active: true });
    this.#holds.set(hold.id, hold);
    this.#audit.append({ companyId: context.companyId, actorId: context.actorId, action: "privacy.legal_hold.placed", correlationId: hold.id, before: null, after: { subjectId, reason } });
    return hold;
  }

  releaseLegalHold(context: RequestContext, holdId: Id, reason: string): LegalHold {
    requirePermission(context, "privacy.manage");
    if (!reason.trim()) throw new Error("LEGAL_HOLD_RELEASE_REASON_REQUIRED");
    const hold = this.#holds.get(holdId);
    if (!hold) throw new PlatformError("NOT_FOUND", "Legal hold was not found.");
    if (hold.companyId !== context.companyId) throw new PlatformError("TENANT_ISOLATION", "This legal hold belongs to another company.");
    const released = Object.freeze({ ...hold, active: false });
    this.#holds.set(hold.id, released);
    this.#audit.append({ companyId: context.companyId, actorId: context.actorId, action: "privacy.legal_hold.released", correlationId: hold.id, before: { active: true }, after: { active: false, reason } });
    return released;
  }

  setRetention(context: RequestContext, subjectId: Id, retainUntil: string): void {
    requirePermission(context, "privacy.manage");
    if (Number.isNaN(Date.parse(retainUntil))) throw new Error("INVALID_RETENTION_DATE");
    this.#retention.set(`${context.companyId}:${subjectId}`, retainUntil);
    this.#audit.append({ companyId: context.companyId, actorId: context.actorId, action: "privacy.retention.set", correlationId: randomUUID(), before: null, after: { subjectId, retainUntil } });
  }

  request(context: RequestContext, subjectId: Id, kind: PrivacyRequestKind, idempotencyKey: string): PrivacyRequest {
    requirePermission(context, kind === "export" ? "privacy.export" : "privacy.delete");
    if (!idempotencyKey.trim()) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
    const key = `${context.companyId}:${kind}:${idempotencyKey}`;
    const prior = this.#requestKeys.get(key);
    if (prior) {
      if (prior.subjectId !== subjectId) throw new PlatformError("IDEMPOTENCY_CONFLICT", "This privacy idempotency key was already used for another person.");
      return this.#requests.get(prior.requestId)!;
    }
    const request = Object.freeze({ id: randomUUID(), companyId: context.companyId, subjectId, kind, status: "requested" as const, requestedAt: this.#now().toISOString(), blockers: [] });
    this.#requests.set(request.id, request);
    this.#requestKeys.set(key, { requestId: request.id, subjectId });
    this.#audit.append({ companyId: context.companyId, actorId: context.actorId, action: `privacy.${kind}.requested`, correlationId: request.id, before: null, after: { subjectId, status: request.status } });
    return request;
  }

  get(context: RequestContext, requestId: Id): PrivacyRequest {
    const request = this.#requests.get(requestId);
    if (!request) throw new PlatformError("NOT_FOUND", "Privacy request was not found.");
    if (request.companyId !== context.companyId) throw new PlatformError("TENANT_ISOLATION", "This privacy request belongs to another company.");
    return request;
  }

  async executeExport(context: RequestContext, requestId: Id): Promise<Readonly<Record<string, unknown>>> {
    requirePermission(context, "privacy.export");
    const request = this.get(context, requestId);
    if (request.kind !== "export" || request.status !== "requested") throw new Error("PRIVACY_REQUEST_NOT_EXECUTABLE");
    const exported = await this.#store.exportSubject(context.companyId, request.subjectId);
    this.#complete(context, request);
    return Object.freeze({ notice: "This export contains the data held for the requested person.", generatedAt: this.#now().toISOString(), subjectId: request.subjectId, data: exported });
  }

  async executeDeletion(context: RequestContext, requestId: Id): Promise<{ readonly request: PrivacyRequest; readonly result?: SubjectDeletionResult }> {
    requirePermission(context, "privacy.delete");
    const request = this.get(context, requestId);
    if (request.kind !== "deletion" || request.status !== "requested") throw new Error("PRIVACY_REQUEST_NOT_EXECUTABLE");
    const activeHolds = [...this.#holds.values()].filter((hold) => hold.companyId === context.companyId && hold.subjectId === request.subjectId && hold.active);
    const retainUntil = this.#retention.get(`${context.companyId}:${request.subjectId}`);
    const blockers = activeHolds.map((hold) => `Legal hold: ${hold.reason}`);
    if (retainUntil && Date.parse(retainUntil) > this.#now().getTime()) blockers.push(`Records must be retained until ${retainUntil}`);
    if (blockers.length > 0) {
      const blocked = Object.freeze({ ...request, status: "blocked" as const, blockers });
      this.#requests.set(request.id, blocked);
      this.#audit.append({ companyId: context.companyId, actorId: context.actorId, action: "privacy.deletion.blocked", correlationId: request.id, before: { status: request.status }, after: { status: blocked.status, blockers } });
      return { request: blocked };
    }
    const result = await this.#store.deleteSubject(context.companyId, request.subjectId, retainUntil);
    return { request: this.#complete(context, request, result), result };
  }

  consents(context: RequestContext, subjectId: Id): readonly ConsentRecord[] {
    requirePermission(context, "privacy.manage");
    return this.#consents.filter((record) => record.companyId === context.companyId && record.subjectId === subjectId);
  }

  #complete(context: RequestContext, request: PrivacyRequest, result?: SubjectDeletionResult): PrivacyRequest {
    const completed = Object.freeze({ ...request, status: "completed" as const, completedAt: this.#now().toISOString() });
    this.#requests.set(request.id, completed);
    this.#audit.append({ companyId: context.companyId, actorId: context.actorId, action: `privacy.${request.kind}.completed`, correlationId: request.id, before: { status: request.status }, after: { status: completed.status, ...(result ? { deletedRecords: result.deletedRecords, retainedRecords: result.retainedRecords } : {}) } });
    return completed;
  }
}

function requirePermission(context: RequestContext, permission: "privacy.manage" | "privacy.export" | "privacy.delete"): void {
  if (!context.permissions.has(permission)) throw new PlatformError("FORBIDDEN", `Permission ${permission} is required.`);
}
