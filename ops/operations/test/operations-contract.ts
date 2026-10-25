/**
 * Issue #366 — one contract suite for the operations store, run against memory
 * (operations-contract.test.ts) and PostgreSQL (operations-contract.integration.test.ts), always
 * through the real services. Everything is synthetic: random ids, invented connectors.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PlatformError, type Permission, type RequestContext } from "../../../packages/platform/src/index.ts";
import { OperationsTelemetry, StatusService, SupportAccessService } from "../src/operations.ts";
import type { OperationsAudit, OperationsStore } from "../src/store.ts";

export interface OperationsHarness {
  store: OperationsStore;
  audit: OperationsAudit;
  /** The audit actions written for a company, oldest first. */
  auditActions(companyId: string): Promise<readonly string[]>;
  /** A company, a person in it who grants access, and a support person, wherever users live. */
  company(): Promise<{ companyId: string; userId: string; supportId: string }>;
  /** Whether a failed action's writes are undone (a database) or not (memory has no transaction). */
  atomic: boolean;
}

const ALL = new Set<Permission>(["operations.read", "support.access.grant", "incident.manage"]);
const ctx = (companyId: string, actorId: string, permissions: ReadonlySet<Permission> = ALL): RequestContext => ({ companyId, branchId: crypto.randomUUID(), actorId, sessionId: crypto.randomUUID(), permissions });
const clock = (start: string) => { let now = Date.parse(start); return { now: () => new Date(now), tick: (ms = 1000) => { now += ms; } }; };
const code = (expected: string) => (error: unknown) => error instanceof PlatformError && error.code === expected;

export function operationsContract(name: string, make: () => OperationsHarness, skip: string | false = false): void {
  test(`${name}: connector failures are kept per company and paged without gaps or repeats`, { skip }, async () => {
    const h = make();
    const a = await h.company();
    const b = await h.company();
    const time = clock("2026-10-01T10:00:00.000Z");
    const telemetry = new OperationsTelemetry(() => {}, time.now, h.store);
    for (let i = 0; i < 5; i += 1) {
      await telemetry.externalFailure(ctx(a.companyId, a.userId), { correlationId: `corr-${i}`, connector: "irp", operation: "register", errorCode: `IRP_${i}` });
      time.tick();
    }
    await telemetry.externalFailure(ctx(b.companyId, b.userId), { correlationId: "corr-b", connector: "bank", operation: "sync", errorCode: "BANK_DOWN" });
    const first = await telemetry.failures(ctx(a.companyId, a.userId), { limit: 2 });
    const second = await telemetry.failures(ctx(a.companyId, a.userId), { limit: 2, after: first.at(-1)!.id });
    const rest = await telemetry.failures(ctx(a.companyId, a.userId), { after: second.at(-1)!.id });
    assert.deepEqual([...first, ...second, ...rest].map((f) => f.errorCode), ["IRP_4", "IRP_3", "IRP_2", "IRP_1", "IRP_0"]);
    assert.deepEqual((await telemetry.failures(ctx(b.companyId, b.userId))).map((f) => f.errorCode), ["BANK_DOWN"]);
    assert.equal(rest.at(-1)!.occurredAt, "2026-10-01T10:00:00.000Z");
    await assert.rejects(telemetry.failures(ctx(a.companyId, a.userId, new Set())), code("FORBIDDEN"));
  });

  test(`${name}: a support grant is read only by its own company, revoked once and audited once`, { skip }, async () => {
    const h = make();
    const a = await h.company();
    const b = await h.company();
    const time = clock("2026-10-01T10:00:00.000Z");
    const support = new SupportAccessService(h.audit, time.now, h.store);
    const telemetry = new OperationsTelemetry(() => {}, time.now, h.store);
    await telemetry.externalFailure(ctx(a.companyId, a.userId), { correlationId: "c-1", connector: "irp", operation: "register", errorCode: "IRP_DOWN" });
    const grant = await support.grant(ctx(a.companyId, a.userId), { supportActorId: a.supportId, reason: "Owner approved a look at the IRP failure", scopes: ["external-failures", "health"], durationMs: 30 * 60 * 1000 });
    const stored = await h.store.grant(a.companyId, grant.id);
    assert.deepEqual({ ...stored, scopes: [...stored!.scopes].sort() }, { ...grant, scopes: ["external-failures", "health"] });
    assert.equal(await h.store.grant(b.companyId, grant.id), null);
    assert.equal(await h.store.grant(a.companyId, "not-a-grant-id"), null);
    assert.deepEqual((await telemetry.failuresForSupport(support, { grantId: grant.id, supportActorId: a.supportId, companyId: a.companyId })).map((f) => f.errorCode), ["IRP_DOWN"]);
    await assert.rejects(telemetry.failuresForSupport(support, { grantId: grant.id, supportActorId: a.supportId, companyId: b.companyId }), code("NOT_FOUND"));
    await assert.rejects(support.revoke(ctx(b.companyId, b.userId), grant.id), code("NOT_FOUND"));
    await assert.rejects(support.grant(ctx(a.companyId, a.userId), { supportActorId: a.supportId, reason: " ", scopes: ["health"], durationMs: 1000 }), /CONSENT_REASON/);
    await assert.rejects(support.grant(ctx(a.companyId, a.userId), { supportActorId: a.supportId, reason: "x", scopes: ["health"], durationMs: Number.NaN }), /DURATION/);
    time.tick();
    const revoked = await support.revoke(ctx(a.companyId, a.userId), grant.id);
    time.tick();
    const again = await support.revoke(ctx(a.companyId, a.userId), grant.id);
    assert.equal(again.revokedAt, revoked.revokedAt);
    assert.equal((await h.store.grant(a.companyId, grant.id))!.revokedAt, "2026-10-01T10:00:01.000Z");
    await assert.rejects(support.authorize(grant.id, a.supportId, a.companyId, "health"), code("FORBIDDEN"));
    assert.deepEqual(await h.auditActions(a.companyId), ["support.access.granted", "support.diagnostic.viewed", "support.access.revoked"]);
    assert.deepEqual(await h.auditActions(b.companyId), []);
  });

  test(`${name}: two revocations at once leave one revocation and one audit event`, { skip }, async () => {
    const h = make();
    const a = await h.company();
    const support = new SupportAccessService(h.audit, () => new Date("2026-10-01T10:00:00.000Z"), h.store);
    const grant = await support.grant(ctx(a.companyId, a.userId), { supportActorId: a.supportId, reason: "queue check", scopes: ["queue-state"], durationMs: 60_000 });
    const both = await Promise.all([support.revoke(ctx(a.companyId, a.userId), grant.id), support.revoke(ctx(a.companyId, a.userId), grant.id)]);
    assert.equal(both[0].revokedAt, both[1].revokedAt);
    assert.deepEqual(await h.auditActions(a.companyId), ["support.access.granted", "support.access.revoked"]);
  });

  test(`${name}: a grant whose audit cannot be written is not kept where the store has transactions`, { skip }, async () => {
    const h = make();
    const a = await h.company();
    const broken: OperationsAudit = { append: async () => { throw new Error("audit store down"); } };
    const ids: string[] = [];
    const store = h.store;
    const spy: OperationsStore = new Proxy(store, {
      get: (target, key) => key === "addGrant"
        ? async (g: Parameters<OperationsStore["addGrant"]>[0]) => { ids.push(g.id); await target.addGrant(g); }
        : (Reflect.get(target, key) as (...args: unknown[]) => unknown).bind(target),
    });
    const guarded = new SupportAccessService(broken, () => new Date("2026-10-01T10:00:00.000Z"), spy);
    await assert.rejects(guarded.grant(ctx(a.companyId, a.userId), { supportActorId: a.supportId, reason: "diagnose", scopes: ["health"], durationMs: 60_000 }), /audit store down/);
    assert.equal(ids.length, 1);
    assert.equal((await h.store.grant(a.companyId, ids[0]!)) === null, h.atomic);
  });

  test(`${name}: the public status timeline keeps every update in order, newest incident first`, { skip }, async () => {
    const h = make();
    const a = await h.company();
    const time = clock("2026-10-02T09:00:00.000Z");
    const status = new StatusService(h.audit, time.now, h.store);
    const operator = ctx(a.companyId, a.userId);
    const older = await status.openIncident(operator, `Bank sync slow ${crypto.randomUUID()}`, "Bank feeds", "Some bank lines are late.");
    time.tick(60_000);
    const newer = await status.openIncident(operator, `IRP delay ${crypto.randomUUID()}`, "Invoice Registration Portal", "Some registrations are delayed.");
    time.tick(60_000);
    await status.updateIncident(operator, newer.id, "identified", "The portal is rejecting logins.");
    time.tick(60_000);
    const resolved = await status.updateIncident(operator, newer.id, "resolved", "The portal recovered.");
    assert.equal(resolved.resolvedAt, "2026-10-02T09:03:00.000Z");
    const stored = await h.store.incident(newer.id);
    assert.deepEqual(stored, resolved);
    assert.deepEqual(stored!.timeline.map((u) => u.state), ["investigating", "identified", "resolved"]);
    const page = await h.store.incidents({ limit: 500 });
    const mine = page.filter((i) => i.id === older.id || i.id === newer.id).map((i) => i.id);
    assert.deepEqual(mine, [newer.id, older.id]);
    const afterNewer = await h.store.incidents({ after: newer.id, limit: 500 });
    assert.equal(afterNewer.some((i) => i.id === newer.id), false);
    assert.equal(afterNewer.some((i) => i.id === older.id), true);
    await assert.rejects(status.updateIncident(operator, crypto.randomUUID(), "resolved", "x"), code("NOT_FOUND"));
    await assert.rejects(status.updateIncident(operator, "not-an-incident", "resolved", "x"), code("NOT_FOUND"));
    await assert.rejects(status.updateIncident(operator, older.id, "fixed" as "resolved", "x"), /INCIDENT_STATE_INVALID/);
    await assert.rejects(status.openIncident(ctx(a.companyId, a.userId, new Set()), "t", "s", "m"), code("FORBIDDEN"));
    assert.deepEqual(await h.auditActions(a.companyId), ["incident.opened", "incident.opened", "incident.updated", "incident.updated"]);
  });
}
