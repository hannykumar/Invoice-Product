/**
 * Issue #364 — one contract suite for the platform core, run against the in-memory classes
 * (platform-contract.test.ts) and against PostgreSQL (platform-core.integration.test.ts).
 *
 * The in-memory classes answer directly and the PostgreSQL ones answer with promises; every call
 * here is awaited, so the same assertions hold for both.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Invitation, Session } from "../src/auth.ts";
import type { Member } from "../src/platform.ts";
import type { ApprovalPolicy, AuditEvent, CommandRecord, CommandStatus, ExceptionItem, Id, Permission, RequestContext } from "../src/types.ts";

type Maybe<T> = T | Promise<T>;
export interface PlatformHarness {
  audit: { forCompany(context: RequestContext): Maybe<readonly AuditEvent[]> };
  commands: {
    create(context: RequestContext, input: Omit<CommandRecord, "id" | "companyId" | "branchId" | "actorId" | "status" | "createdAt">): Maybe<CommandRecord>;
    get(context: RequestContext, id: Id): Maybe<CommandRecord>;
    transition(context: RequestContext, id: Id, next: CommandStatus, reason?: string): Maybe<CommandRecord>;
  };
  exceptions: {
    create(context: RequestContext, summary: string, evidence: readonly string[]): Maybe<ExceptionItem>;
    get(context: RequestContext, id: Id): Maybe<ExceptionItem>;
    comment(context: RequestContext, id: Id, body: string): Maybe<ExceptionItem>;
    resolve(context: RequestContext, id: Id): Maybe<ExceptionItem>;
  };
  access: {
    grant(member: Member): Maybe<void>;
    revoke(companyId: Id, userId: Id): Maybe<void>;
    context(companyId: Id, branchId: Id, userId: Id, sessionId: Id): Maybe<RequestContext>;
  };
  auth(now?: () => number): {
    invite(actor: RequestContext, email: string, permissions: ReadonlySet<Permission>, expiresInMs?: number): Maybe<{ invitation: Invitation; token: string }>;
    acceptInvitation(token: string, userId: Id): Maybe<Invitation>;
    createSession(companyId: Id, branchId: Id, userId: Id, ttlMs?: number): Maybe<Session>;
    authenticate(sessionId: Id): Maybe<RequestContext>;
    revokeSession(sessionId: Id): Maybe<void>;
    revokeMember(companyId: Id, userId: Id): Maybe<void>;
    review(companyId: Id): Maybe<readonly Member[]>;
  };
  /** A company with one branch, and a user: rows that exist wherever the implementation keeps them. */
  company(): Promise<{ companyId: Id; branchId: Id }>;
  user(): Promise<Id>;
}

/** The approval policy every harness builds its command service with. */
export const CONTRACT_POLICIES: readonly ApprovalPolicy[] = [{ action: "sale.finalise", minimumRisk: "medium", requiredPermission: "approval.decide" }];

const attempt = async <T>(work: () => Maybe<T>): Promise<T> => work();
const code = (...expected: string[]) => (error: unknown) => expected.includes((error as { code?: string }).code ?? "");

export function platformContract(label: string, harness: () => PlatformHarness, skip: false | string = false): void {
  const member = async (permissions: readonly Permission[] = ["sale.draft.create", "approval.decide"]) => {
    const h = harness();
    const { companyId, branchId } = await h.company();
    const userId = await h.user();
    await h.access.grant({ companyId, userId, branchIds: new Set([branchId]), active: true, permissions: new Set(permissions) });
    return { h, companyId, branchId, userId, context: await h.access.context(companyId, branchId, userId, crypto.randomUUID()) };
  };
  const sale = (key: string, payload: Record<string, unknown> = { partyId: "party-a" }) => ({ action: "sale.finalise", risk: "medium" as const, idempotencyKey: key, payload });

  test(`${label}: one company cannot read another company's command`, { skip }, async () => {
    const a = await member();
    const b = await member();
    const record = await a.h.commands.create(a.context, sale("sale-1"));
    assert.equal((await a.h.commands.get(a.context, record.id)).id, record.id);
    await assert.rejects(attempt(() => a.h.commands.get(b.context, record.id)), code("TENANT_ISOLATION", "NOT_FOUND"));
    await assert.rejects(attempt(() => a.h.commands.transition(b.context, record.id, "submitted")), code("TENANT_ISOLATION", "NOT_FOUND"));
    assert.equal((await a.h.commands.get(a.context, record.id)).status, "draft");
  });

  test(`${label}: a retry with the same key returns the first command; different input under that key is refused`, { skip }, async () => {
    const { h, context } = await member();
    const first = await h.commands.create(context, { ...sale("sale-1", { totalPaise: 100n }), amountPaise: 100n });
    const retry = await h.commands.create(context, { ...sale("sale-1", { totalPaise: 100n }), amountPaise: 100n });
    assert.equal(retry.id, first.id);
    assert.equal(retry.payload.totalPaise, 100n, "money comes back as exact paise");
    assert.equal(retry.amountPaise, 100n);
    await assert.rejects(attempt(() => h.commands.create(context, sale("sale-1", { totalPaise: 200n }))), code("IDEMPOTENCY_CONFLICT"));
    await assert.rejects(attempt(() => h.commands.create(context, sale("  "))), code("IDEMPOTENCY_CONFLICT"));
    // The same key under another action, or in another company, is a different command.
    assert.notEqual((await h.commands.create(context, { ...sale("sale-1"), action: "purchase.post" })).id, first.id);
    const elsewhere = await member();
    assert.notEqual((await h.commands.create(elsewhere.context, sale("sale-1", { totalPaise: 100n }))).id, first.id);
    assert.equal((await h.audit.forCompany(context)).filter((event) => event.action === "sale.finalise.created").length, 1, "the retry wrote no second audit event");
  });

  test(`${label}: the same request arriving many times at once creates one command`, { skip }, async () => {
    const { h, context } = await member();
    const records = await Promise.all(Array.from({ length: 8 }, () => attempt(() => h.commands.create(context, sale("double-press")))));
    assert.equal(new Set(records.map((record) => record.id)).size, 1);
    assert.equal((await h.audit.forCompany(context)).filter((event) => event.action === "sale.finalise.created").length, 1);
  });

  test(`${label}: approval cannot be skipped, and the audit trail is redacted and cannot be altered`, { skip }, async () => {
    const { h, context } = await member();
    const record = await h.commands.create(context, sale("sale-2", { overrideReason: "manager approved", token: "do-not-log", documentContent: "invoice-body-must-not-log" }));
    await h.commands.transition(context, record.id, "submitted");
    await assert.rejects(attempt(() => h.commands.transition(context, record.id, "finalised")), code("INVALID_TRANSITION"));
    await h.commands.transition(context, record.id, "approved", "Reviewed inventory override");
    assert.equal((await h.commands.transition(context, record.id, "finalised")).status, "finalised");
    assert.equal((await h.commands.get(context, record.id)).status, "finalised");
    await assert.rejects(attempt(() => h.commands.transition(context, record.id, "cancelled")), code("INVALID_TRANSITION"));

    const trail = await h.audit.forCompany(context);
    assert.deepEqual(trail.map((event) => event.action), ["sale.finalise.created", "sale.finalise.submitted", "sale.finalise.approved", "sale.finalise.finalised"]);
    const created = trail[0] as AuditEvent;
    const payload = created.after?.payload as Record<string, unknown>;
    assert.equal(payload.token, "[REDACTED]");
    assert.equal(payload.documentContent, "[REDACTED]");
    assert.equal(payload.overrideReason, "manager approved");
    assert.equal(trail[2]?.reason, "Reviewed inventory override");
    assert.deepEqual(trail[2]?.before, { status: "submitted" });
    assert.equal(created.actorId, context.actorId);
    assert.equal(created.correlationId, record.id);
    assert.throws(() => { (created.after as Record<string, unknown>).status = "tampered"; }, TypeError);
  });

  test(`${label}: approving needs the permission the policy names`, { skip }, async () => {
    const { h, context } = await member(["sale.draft.create"]);
    const record = await h.commands.create(context, sale("sale-3"));
    await h.commands.transition(context, record.id, "submitted");
    await assert.rejects(attempt(() => h.commands.transition(context, record.id, "approved")), code("FORBIDDEN"));
    assert.equal((await h.commands.get(context, record.id)).status, "submitted");
  });

  test(`${label}: a command keeps the input it was created with`, { skip }, async () => {
    const { h, context } = await member();
    const payload = { lines: [{ quantity: 1 }] };
    const record = await h.commands.create(context, { action: "sale.finalise", risk: "low", idempotencyKey: "snapshot-1", payload });
    payload.lines[0]!.quantity = 99;
    assert.equal((record.payload.lines as { quantity: number }[])[0]!.quantity, 1);
    assert.equal(((await h.commands.get(context, record.id)).payload.lines as { quantity: number }[])[0]!.quantity, 1);
  });

  test(`${label}: one company's audit trail never shows another's`, { skip }, async () => {
    const a = await member();
    const b = await member();
    await a.h.commands.create(a.context, sale("sale-a"));
    await a.h.commands.create(b.context, sale("sale-b"));
    const trail = await a.h.audit.forCompany(a.context);
    assert.equal(trail.length, 1);
    assert.ok(trail.every((event) => event.companyId === a.companyId));
  });

  test(`${label}: a person whose access was removed gets no request context`, { skip }, async () => {
    const { h, companyId, branchId, userId } = await member();
    await h.access.revoke(companyId, userId);
    await assert.rejects(attempt(() => h.access.context(companyId, branchId, userId, crypto.randomUUID())), code("SESSION_REVOKED"));
    const other = await h.company();
    const stranger = await member();
    await assert.rejects(attempt(() => h.access.context(other.companyId, other.branchId, stranger.userId, crypto.randomUUID())), code("SESSION_REVOKED"), "a member of one company is nobody in another");
  });

  test(`${label}: held exceptions keep their evidence, comments and audit trail, per company`, { skip }, async () => {
    const a = await member();
    const b = await member();
    const item = await a.h.exceptions.create(a.context, "Missing GST rate", ["invoice-page-1"]);
    assert.equal(item.status, "open");
    assert.deepEqual(item.evidence, ["invoice-page-1"]);
    await a.h.exceptions.comment(a.context, item.id, "Awaiting supplier clarification");
    const commented = await a.h.exceptions.comment(a.context, item.id, "Supplier confirmed 18%");
    assert.deepEqual(commented.comments.map((comment) => comment.body), ["Awaiting supplier clarification", "Supplier confirmed 18%"]);
    assert.equal(commented.comments[0]?.actorId, a.userId);
    await assert.rejects(attempt(() => a.h.exceptions.get(b.context, item.id)), code("TENANT_ISOLATION", "NOT_FOUND"));
    await assert.rejects(attempt(() => a.h.exceptions.resolve(b.context, item.id)), code("TENANT_ISOLATION", "NOT_FOUND"));
    await assert.rejects(attempt(() => a.h.exceptions.create(a.context, "No evidence", [])), /summary and supporting evidence/);
    await assert.rejects(attempt(() => a.h.exceptions.comment(a.context, item.id, "  ")), /cannot be empty/);
    assert.equal((await a.h.exceptions.resolve(a.context, item.id)).status, "resolved");
    assert.equal((await a.h.exceptions.get(a.context, item.id)).status, "resolved");
    assert.deepEqual((await a.h.audit.forCompany(a.context)).map((event) => event.action), ["exception.created", "exception.commented", "exception.commented", "exception.resolved"]);
  });

  test(`${label}: an invitation grants exactly its company, branch and permissions, once`, { skip }, async () => {
    const owner = await member(["access.review"]);
    const auth = owner.h.auth();
    const { token, invitation } = await auth.invite(owner.context, "Cashier@example.invalid", new Set(["sale.draft.create"]));
    assert.equal(invitation.email, "cashier@example.invalid");
    const cashier = await owner.h.user();
    await auth.acceptInvitation(token, cashier);
    const session = await auth.createSession(owner.companyId, owner.branchId, cashier);
    const context = await auth.authenticate(session.id);
    assert.equal(context.companyId, owner.companyId);
    assert.equal(context.actorId, cashier);
    assert.deepEqual([...context.permissions], ["sale.draft.create"]);
    assert.equal(context.permissions.has("bank.balance.read"), false);
    assert.equal(context.permissions.has("gst.file"), false);
    assert.equal((await auth.review(owner.companyId)).length, 2);
    const second = await owner.h.user();
    await assert.rejects(attempt(() => auth.acceptInvitation(token, second)), /INVALID_INVITATION/, "an invitation cannot be used twice");
    assert.equal((await auth.review(owner.companyId)).length, 2);
    await assert.rejects(attempt(() => auth.acceptInvitation(crypto.randomUUID(), cashier)), /INVALID_INVITATION/);
    const cashierContext = await owner.h.access.context(owner.companyId, owner.branchId, cashier, crypto.randomUUID());
    await assert.rejects(attempt(() => auth.invite(cashierContext, "x@example.invalid", new Set())), code("FORBIDDEN"));
  });
  test(`${label}: an invitation past its date cannot be accepted`, { skip }, async () => {
    let now = 1_000_000;
    const owner = await member(["access.review"]);
    const auth = owner.h.auth(() => now);
    const { token } = await auth.invite(owner.context, "late@example.invalid", new Set(["sale.draft.create"]), 10);
    now += 11;
    await assert.rejects(attempt(async () => auth.acceptInvitation(token, await owner.h.user())), /INVALID_INVITATION/);
    assert.equal((await auth.review(owner.companyId)).length, 1);
  });

  test(`${label}: a session that has expired or been ended cannot be used`, { skip }, async () => {
    let now = 1_000_000;
    const { h, companyId, branchId, userId } = await member([]);
    const auth = h.auth(() => now);
    const session = await auth.createSession(companyId, branchId, userId, 10);
    assert.equal((await auth.authenticate(session.id)).actorId, userId);
    now += 11;
    await assert.rejects(attempt(() => auth.authenticate(session.id)), code("SESSION_EXPIRED"));
    const ended = await auth.createSession(companyId, branchId, userId);
    await auth.revokeSession(ended.id);
    await assert.rejects(attempt(() => auth.authenticate(ended.id)), code("SESSION_EXPIRED"));
    await assert.rejects(attempt(() => auth.authenticate("not-a-session")), code("SESSION_EXPIRED"));
    await assert.rejects(attempt(() => auth.authenticate(crypto.randomUUID())), code("SESSION_EXPIRED"));
  });

  test(`${label}: removing a person's access ends every session they have`, { skip }, async () => {
    const { h, companyId, branchId, userId } = await member([]);
    const auth = h.auth();
    const sessions = [await auth.createSession(companyId, branchId, userId), await auth.createSession(companyId, branchId, userId)];
    await auth.revokeMember(companyId, userId);
    for (const session of sessions) await assert.rejects(attempt(() => auth.authenticate(session.id)), code("SESSION_EXPIRED"));
    await assert.rejects(attempt(() => h.access.context(companyId, branchId, userId, crypto.randomUUID())), code("SESSION_REVOKED"));
  });
}
