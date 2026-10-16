import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AccessControl, type Member } from "./platform.ts";
import { PlatformError } from "./types.ts";
import type { Id, Permission, RequestContext } from "./types.ts";
import type { VerifiedIdentity } from "./identity.ts";

export interface Session { id: Id; userId: Id; companyId: Id; branchId: Id; expiresAt: number; revokedAt?: number; lastSeenAt?: number; }
export interface Invitation { id: Id; companyId: Id; branchId: Id; email: string; permissions: ReadonlySet<Permission>; expiresAt: number; acceptedAt?: number; revokedAt?: number; }
/** A company a person belongs to, and the branches of it they may work in. */
export interface Membership { companyId: Id; branchIds: readonly Id[]; }
export interface User { id: Id; subject?: string; email?: string; phone?: string; }

/**
 * Issue #342 — how long a session lasts. A working day in the shop without signing in again; a
 * stolen session dies within a week however busily it is used.
 */
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
/** `last_seen_at` is written at most this often, so reading a page is not a database write each time. */
export const SESSION_TOUCH_MS = 5 * 60 * 1000;

const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");
/** 256 random bits: a session token is a bearer secret, so it is as long as a key, not an id. */
export const newSessionToken = (): string => randomBytes(32).toString("base64url");
export const sessionExpired = (session: Session, now: number): boolean =>
  session.revokedAt !== undefined || session.expiresAt <= now || (session.lastSeenAt !== undefined && session.lastSeenAt + SESSION_IDLE_MS <= now);

export class AuthenticationService {
  /** Keyed by the token's hash, as the database is: the token itself is handed out once and kept nowhere. */
  #sessions = new Map<string, Session>(); #invitations = new Map<string, Invitation>(); #users = new Map<Id, User>();
  private readonly access: AccessControl; private readonly now: () => number;
  constructor(access: AccessControl, now: () => number = Date.now) { this.access = access; this.now = now; }
  invite(actor: RequestContext, email: string, permissions: ReadonlySet<Permission>, expiresInMs = 7 * 24 * 60 * 60 * 1000): { invitation: Invitation; token: string } {
    if (!actor.permissions.has("access.review")) throw new PlatformError("FORBIDDEN", "You do not have permission to review access.");
    const token = randomUUID(); const invitation: Invitation = { id: randomUUID(), companyId: actor.companyId, branchId: actor.branchId, email: email.toLowerCase(), permissions, expiresAt: this.now() + expiresInMs };
    this.#invitations.set(digest(token), invitation); return { invitation, token };
  }
  acceptInvitation(token: string, userId: Id): Invitation {
    const invitation = this.#invitations.get(digest(token)); if (!invitation || invitation.revokedAt || invitation.acceptedAt || invitation.expiresAt <= this.now()) throw new Error("INVALID_INVITATION");
    const accepted = { ...invitation, acceptedAt: this.now() }; this.#invitations.set(digest(token), accepted);
    this.access.grant({ userId, companyId: accepted.companyId, branchIds: new Set([accepted.branchId]), active: true, permissions: accepted.permissions }); return accepted;
  }
  /** The returned `id` is the token. The context of a request carries the stored id, which cannot open the session. */
  createSession(companyId: Id, branchId: Id, userId: Id, ttlMs = SESSION_ABSOLUTE_MS): Session {
    const token = newSessionToken(); const session: Session = { id: randomUUID(), companyId, branchId, userId, expiresAt: this.now() + ttlMs, lastSeenAt: this.now() };
    this.#sessions.set(digest(token), session); return { ...session, id: token };
  }
  authenticate(sessionId: Id): RequestContext {
    const session = this.#sessions.get(digest(sessionId));
    if (!session || sessionExpired(session, this.now())) throw new PlatformError("SESSION_EXPIRED", "SESSION_EXPIRED: Sign in again.");
    const context = this.access.context(session.companyId, session.branchId, session.userId, session.id);
    this.#sessions.set(digest(sessionId), { ...session, lastSeenAt: this.now() });
    return context;
  }
  /** Ends a session, named either by its token or by the `sessionId` a request context carries. */
  revokeSession(sessionId: Id): void {
    for (const [key, session] of this.#sessions) if ((key === digest(sessionId) || session.id === sessionId) && session.revokedAt === undefined) this.#sessions.set(key, { ...session, revokedAt: this.now() });
  }
  revokeMember(companyId: Id, userId: Id): void { this.access.revoke(companyId, userId); for (const [key, session] of this.#sessions) if (session.companyId === companyId && session.userId === userId && session.revokedAt === undefined) this.#sessions.set(key, { ...session, revokedAt: this.now() }); }
  review(companyId: Id): readonly Member[] { return this.access.members(companyId); }

  /** A person known before the provider ever saw them (the seed, or an invitation): found later by the address they prove. */
  addUser(user: User): void { this.#users.set(user.id, user); }
  /**
   * Issue #342 — the person a provider has just checked. Found by the provider's id for them; a person
   * added before they first signed in is found by the address they just proved, and linked once; anyone
   * else is a new person, with no company yet.
   */
  userFor(identity: VerifiedIdentity): Id {
    const users = [...this.#users.values()];
    const known = users.find((user) => user.subject === identity.subject);
    if (known) return known.id;
    const added = users.find((user) => user.subject === undefined && ((identity.email !== undefined && user.email === identity.email) || (identity.phone !== undefined && user.phone === identity.phone)));
    if (added) { this.#users.set(added.id, { ...added, subject: identity.subject }); return added.id; }
    const id = randomUUID();
    this.#users.set(id, { id, subject: identity.subject, ...(identity.email === undefined ? {} : { email: identity.email }), ...(identity.phone === undefined ? {} : { phone: identity.phone }) });
    return id;
  }
  companiesOf(userId: Id): readonly Membership[] { return this.access.companiesOf(userId); }
}
