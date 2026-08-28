import { createHash, randomUUID } from "node:crypto";
import { AccessControl, type Member } from "./platform.ts";
import type { Id, Permission, RequestContext } from "./types.ts";

export interface Session { id: Id; userId: Id; companyId: Id; branchId: Id; expiresAt: number; revokedAt?: number; }
export interface Invitation { id: Id; companyId: Id; branchId: Id; email: string; permissions: ReadonlySet<Permission>; expiresAt: number; acceptedAt?: number; revokedAt?: number; }
const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");

export class AuthenticationService {
  #sessions = new Map<Id, Session>(); #invitations = new Map<string, Invitation>();
  private readonly access: AccessControl; private readonly now: () => number;
  constructor(access: AccessControl, now: () => number = Date.now) { this.access = access; this.now = now; }
  invite(actor: RequestContext, email: string, permissions: ReadonlySet<Permission>, expiresInMs = 7 * 24 * 60 * 60 * 1000): { invitation: Invitation; token: string } {
    if (!actor.permissions.has("access.review")) throw new Error("FORBIDDEN");
    const token = randomUUID(); const invitation: Invitation = { id: randomUUID(), companyId: actor.companyId, branchId: actor.branchId, email: email.toLowerCase(), permissions, expiresAt: this.now() + expiresInMs };
    this.#invitations.set(digest(token), invitation); return { invitation, token };
  }
  acceptInvitation(token: string, userId: Id): Invitation {
    const invitation = this.#invitations.get(digest(token)); if (!invitation || invitation.revokedAt || invitation.acceptedAt || invitation.expiresAt <= this.now()) throw new Error("INVALID_INVITATION");
    const accepted = { ...invitation, acceptedAt: this.now() }; this.#invitations.set(digest(token), accepted);
    this.access.grant({ userId, companyId: accepted.companyId, branchIds: new Set([accepted.branchId]), active: true, permissions: accepted.permissions }); return accepted;
  }
  createSession(companyId: Id, branchId: Id, userId: Id, ttlMs = 8 * 60 * 60 * 1000): Session { const session = { id: randomUUID(), companyId, branchId, userId, expiresAt: this.now() + ttlMs }; this.#sessions.set(session.id, session); return session; }
  authenticate(sessionId: Id): RequestContext { const session = this.#sessions.get(sessionId); if (!session || session.revokedAt || session.expiresAt <= this.now()) throw new Error("SESSION_EXPIRED"); return this.access.context(session.companyId, session.branchId, session.userId, session.id); }
  revokeSession(sessionId: Id): void { const session = this.#sessions.get(sessionId); if (session) this.#sessions.set(sessionId, { ...session, revokedAt: this.now() }); }
  revokeMember(companyId: Id, userId: Id): void { this.access.revoke(companyId, userId); for (const session of this.#sessions.values()) if (session.companyId === companyId && session.userId === userId) this.revokeSession(session.id); }
  review(companyId: Id): readonly Member[] { return this.access.members(companyId); }
}
