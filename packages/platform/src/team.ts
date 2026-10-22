/**
 * Issue #343 — the people in a business: invite, change a role, remove someone, hand the business
 * over, and leave. Handbook #3: "Owner can review and revoke access."
 *
 * The rules that keep a business from locking itself out or being taken over:
 *  - the owner role is only ever handed over (`transfer`), never given by an invitation or a role change;
 *  - only an owner may change or remove an owner or an admin;
 *  - nobody changes or removes themselves (they `leave`), and the last owner cannot leave or be removed;
 *  - removing someone ends every session they have in this business at once (#342).
 * Invitations expire after 7 days and can only be taken up by the address they were sent to.
 */
import type { Invitation, Person } from "./auth.ts";
import type { Member } from "./platform.ts";
import { ROLES, type RoleName } from "./roles.ts";
import { PlatformError } from "./types.ts";
import type { Id, Permission, RequestContext } from "./types.ts";

type Maybe<T> = T | Promise<T>;
/** What the team needs from the platform: methods both session services (memory and PostgreSQL) have. */
export interface TeamStore {
  review(companyId: Id): Maybe<readonly Member[]>;
  grantMember(member: Member): Maybe<void>;
  revokeMember(companyId: Id, userId: Id): Maybe<void>;
  invite(actor: RequestContext, address: string, permissions: ReadonlySet<Permission>, expiresInMs: number, role: RoleName): Maybe<{ invitation: Invitation; token: string }>;
  describeUsers(ids: readonly Id[]): Maybe<readonly Person[]>;
}

export const INVITATION_DAYS = 7;
const INVITABLE: readonly RoleName[] = ["admin", "accountant", "staff", "viewer"];

export interface TeamMember { userId: Id; name: string; role: RoleName | "custom"; you: boolean; }

export class Team {
  readonly #store: TeamStore;
  constructor(store: TeamStore) { this.#store = store; }

  async list(context: RequestContext): Promise<{ members: TeamMember[] }> {
    const members = (await this.#store.review(context.companyId)).filter((member) => member.active);
    const names = new Map((await this.#store.describeUsers(members.map((member) => member.userId))).map((person) => [person.id, person.label]));
    return {
      members: members.map((member) => ({ userId: member.userId, name: names.get(member.userId) ?? member.userId, role: member.role ?? "custom", you: member.userId === context.actorId })),
    };
  }

  async invite(context: RequestContext, address: string, role: string): Promise<{ invitation: { address: string; role: RoleName; expiresAt: string }; token: string }> {
    const wanted = this.#invitable(role);
    await this.#mayManage(context, wanted);
    const { invitation, token } = await this.#store.invite(context, address, new Set(ROLES[wanted].permissions), INVITATION_DAYS * 24 * 60 * 60 * 1000, wanted);
    return { invitation: { address: invitation.email, role: wanted, expiresAt: new Date(invitation.expiresAt).toISOString() }, token };
  }

  async changeRole(context: RequestContext, userId: Id, role: string): Promise<void> {
    const wanted = this.#invitable(role);
    const target = await this.#other(context, userId);
    await this.#mayManage(context, target.role, wanted);
    await this.#store.grantMember({ ...target, role: wanted, permissions: new Set(ROLES[wanted].permissions) });
  }

  async remove(context: RequestContext, userId: Id): Promise<void> {
    const target = await this.#other(context, userId);
    await this.#mayManage(context, target.role);
    await this.#store.revokeMember(context.companyId, userId);
  }

  /** The owner hands the business to another member, who becomes an owner; the old owner stays on as an admin. */
  async transfer(context: RequestContext, userId: Id): Promise<void> {
    const me = await this.#me(context);
    if (me.role !== "owner") throw new PlatformError("FORBIDDEN", "Only an owner can hand the business over.");
    const target = await this.#other(context, userId);
    await this.#store.grantMember({ ...target, role: "owner", permissions: new Set(ROLES.owner.permissions) });
    await this.#store.grantMember({ ...me, role: "admin", permissions: new Set(ROLES.admin.permissions) });
  }

  async leave(context: RequestContext): Promise<void> {
    const me = await this.#me(context);
    if (me.role === "owner" && (await this.#owners(context)).length <= 1) {
      throw new Error("You are the only owner, so you cannot leave. Hand the business over to someone else first.");
    }
    await this.#store.revokeMember(context.companyId, context.actorId);
  }

  #invitable(role: string): RoleName {
    if (role === "owner") throw new Error("Nobody is made an owner directly. The owner hands the business over instead.");
    if (!(INVITABLE as readonly string[]).includes(role)) throw new Error("Choose admin, accountant, staff or viewer.");
    return role as RoleName;
  }

  /** Only an owner may touch an owner or an admin, or make someone an admin. */
  async #mayManage(context: RequestContext, ...roles: readonly (RoleName | "custom" | undefined)[]): Promise<void> {
    if (!roles.some((role) => role === "owner" || role === "admin")) return;
    if ((await this.#me(context)).role !== "owner") throw new PlatformError("FORBIDDEN", "Only an owner can add, change or remove an owner or an admin.");
  }

  async #active(context: RequestContext): Promise<readonly Member[]> { return (await this.#store.review(context.companyId)).filter((member) => member.active); }
  async #owners(context: RequestContext): Promise<readonly Member[]> { return (await this.#active(context)).filter((member) => member.role === "owner"); }
  async #me(context: RequestContext): Promise<Member> {
    const me = (await this.#active(context)).find((member) => member.userId === context.actorId);
    if (me === undefined) throw new PlatformError("SESSION_REVOKED", "Your access is no longer active.");
    return me;
  }
  /** Another active member of this business; never yourself (that is `leave`), never someone outside it. */
  async #other(context: RequestContext, userId: Id): Promise<Member> {
    if (userId === context.actorId) throw new Error("You cannot change or remove yourself. To go, choose Leave this business.");
    const target = (await this.#active(context)).find((member) => member.userId === userId);
    if (target === undefined) throw new PlatformError("NOT_FOUND", "That person is not in this business.");
    return target;
  }
}
