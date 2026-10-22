/**
 * Issue #366 — the assistant's plan store on a real PostgreSQL.
 *
 *  - The same contract suite the in-memory store passes (agent-plan-store-contract.ts), connected as
 *    the application role so row-level security and the #368 freeze are really in force.
 *  - What only a database can show: a write outside a unit of work is refused, a rolled-back action
 *    leaves nothing, the database itself hides another company's rows, and an executed plan and a
 *    report cannot be changed or removed.
 *  - The real service, plan → preview → approve → execute → replay, on this store.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import type { TransactionalExecutor } from '../../platform/src/database.ts';
import type { AgentPlan, AgentReport } from '../src/model.ts';
import type { AgentPlanStore } from '../src/ports.ts';
import { agentPlanStoreContract, planOf, previewed, reportOf, type AgentPlanStoreHarness } from './agent-plan-store-contract.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the action-agent store database tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';
const login = `invoice_app_agent_${randomBytes(6).toString('hex')}`;

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let harness: AgentPlanStoreHarness;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import('../../platform/src/database.ts');
  const { migrate } = await import('../../platform/src/migrations.ts');
  const { PostgresAgentPlanStore } = await import('../src/postgres-store.ts');
  owner = createDatabase(url);
  await migrate(owner);
  // What a deployment does once: a login for the server, with nothing but membership of invoice_app.
  const password = randomBytes(18).toString('hex');
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const appUrl = new URL(url);
  appUrl.username = login;
  appUrl.password = password;
  app = createDatabase(appUrl.toString());
  harness = {
    store: new PostgresAgentPlanStore(app),
    // The owner only sets the scene; everything under test runs as the application role.
    company: async () => {
      const id = crypto.randomUUID();
      await owner.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Agent Traders')", [id]);
      return id;
    },
    user: async () => {
      const id = crypto.randomUUID();
      await owner.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Synthetic person')", [id, `agent-${id}@example.invalid`]);
      return id;
    },
    write: (companyId, work) => app.unitOfWork(companyId, () => work()),
  };
});
after(async () => {
  await app?.close();
  if (owner !== undefined) { await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

agentPlanStoreContract('postgres as the application role', () => harness, skip);

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const scene = async () => ({ companyId: await harness.company(), userId: await harness.user() });
const counts = async (companyId: string): Promise<number[]> =>
  Promise.all(['agent_plans', 'agent_reports'].map(async (table) =>
    Number((await owner.query(`SELECT count(*)::int AS n FROM ${table} WHERE company_id = $1`, [companyId])).rows[0]?.n)));

test('a write outside a unit of work is refused, and saves nothing', { skip }, async () => {
  const { companyId, userId } = await scene();
  const plan = planOf(companyId, userId);
  await assert.rejects(harness.store.put(plan), code('NO_UNIT_OF_WORK'));
  await assert.rejects(harness.store.putReport(companyId, `${plan.id}:run-1`, reportOf(plan)), code('NO_UNIT_OF_WORK'));
  // Nor inside another company's action.
  const other = await scene();
  await assert.rejects(app.unitOfWork(other.companyId, () => harness.store.put(plan)), code('TENANT_ISOLATION'));
  assert.deepEqual(await counts(companyId), [0, 0]);
});

test('an action that fails after writing leaves nothing behind', { skip }, async () => {
  const { companyId, userId } = await scene();
  const plan = previewed(planOf(companyId, userId));
  await assert.rejects(app.unitOfWork(companyId, async () => {
    await harness.store.put(plan);
    await harness.store.putReport(companyId, `${plan.id}:run-1`, reportOf(plan));
    // The action's own writes are visible to it before it ends.
    assert.deepEqual(await harness.store.find(companyId, plan.id), plan);
    throw new Error('the power went out');
  }), /the power went out/);
  assert.deepEqual(await counts(companyId), [0, 0]);
  assert.equal(await harness.store.find(companyId, plan.id), null);
});

test('a report for a plan that was never saved is refused', { skip }, async () => {
  const { companyId, userId } = await scene();
  const plan = planOf(companyId, userId);
  await assert.rejects(app.unitOfWork(companyId, () => harness.store.putReport(companyId, `${plan.id}:run-1`, reportOf(plan))), code('23503'));
});

test('the database itself keeps one company out of another\'s plans', { skip }, async () => {
  const a = await scene();
  const b = await scene();
  const plan = previewed(planOf(a.companyId, a.userId));
  await harness.write(a.companyId, async () => {
    await harness.store.put(plan);
    await harness.store.putReport(a.companyId, `${plan.id}:run-1`, reportOf(plan));
  });
  for (const table of ['agent_plans', 'agent_reports']) {
    // A query that forgot its company filter, run for company B: row-level security answers for it.
    const seen = await app.tenantTransaction(b.companyId, (sql) => sql.query(`SELECT count(*)::int AS n FROM ${table}`));
    assert.equal(seen.rows[0]?.n, 0, `${table} hides company A from company B`);
    assert.equal((await app.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n, 0, `${table} shows nothing without a company`);
  }
  // Company B cannot write a plan that says it belongs to company A …
  await assert.rejects(app.unitOfWork(b.companyId, (uow) => uow.sql.query(
    `INSERT INTO agent_plans (id, company_id, request, today, intent, evidence, confidence, steps, refusals, needs_approval, summary, state, requested_by, requested_at)
     VALUES ($1, $2, 'x', '2026-06-01', 'CHASE_UNPAID', 'x', 0.5, '[]', '[]', false, '{}', 'PLANNED', $3, now())`,
    [crypto.randomUUID(), a.companyId, b.userId],
  )), code('42501'));
  // … nor save over company A's plan by its id.
  await assert.rejects(harness.write(b.companyId, () => harness.store.put({ ...plan, companyId: b.companyId, request: 'taken over' })), code('AGENT_PLAN_ID_TAKEN'));
  assert.deepEqual(await harness.store.find(a.companyId, plan.id), plan);
});

test('an executed plan and its report are kept as they were', { skip }, async () => {
  const { companyId, userId } = await scene();
  const plan: AgentPlan = { ...previewed(planOf(companyId, userId)), state: 'EXECUTED' };
  const report = reportOf(plan);
  await harness.write(companyId, async () => {
    await harness.store.put({ ...plan, state: 'APPROVED' });
    await harness.store.putReport(companyId, `${plan.id}:run-1`, report);
    await harness.store.put(plan);
  });
  const run = (sql: string) => app.unitOfWork(companyId, (uow) => uow.sql.query(sql, [companyId, plan.id]));
  await assert.rejects(harness.write(companyId, () => harness.store.put({ ...plan, fingerprint: 'e'.repeat(64) })), code('23001'));
  await assert.rejects(harness.write(companyId, () => harness.store.put({ ...plan, state: 'PREVIEWED' })), code('23001'), 'never back to where it could be edited');
  await assert.rejects(run("UPDATE agent_plans SET steps = '[]' WHERE company_id = $1 AND id = $2"), code('23001'));
  await assert.rejects(run('DELETE FROM agent_plans WHERE company_id = $1 AND id = $2'), code('42501'));
  await assert.rejects(run("UPDATE agent_reports SET state = 'DONE' WHERE company_id = $1 AND plan_id = $2"), code('23001'));
  await assert.rejects(run('DELETE FROM agent_reports WHERE company_id = $1 AND plan_id = $2'), code('42501'));
  // Saved again unchanged, as the service does for a read-only plan run under a second key.
  await harness.write(companyId, () => harness.store.put(plan));
  assert.deepEqual(await harness.store.find(companyId, plan.id), plan);
  assert.deepEqual(await harness.store.reportFor(companyId, plan.id), report);
  // A plan not yet executed is still the service's to change.
  const open = previewed(planOf(companyId, userId));
  await harness.write(companyId, () => harness.store.put(open));
  await harness.write(companyId, () => harness.store.put({ ...open, state: 'REJECTED' }));
  await harness.write(companyId, () => harness.store.put({ ...open, state: 'PREVIEWED' }));
});

/**
 * The harness's business uses readable ids ("the company", "Priya"); the tables want rows that
 * exist. This only renames them on the way in and out.
 */
const renamed = (inner: AgentPlanStore, from: { companyId: string; userId: string }, to: { companyId: string; userId: string }): AgentPlanStore => {
  const toDb = (plan: AgentPlan): AgentPlan => ({ ...plan, companyId: to.companyId, requestedBy: plan.requestedBy === from.userId ? to.userId : plan.requestedBy });
  const fromDb = (plan: AgentPlan | null): AgentPlan | null => plan === null ? null : { ...plan, companyId: from.companyId, requestedBy: plan.requestedBy === to.userId ? from.userId : plan.requestedBy };
  const company = (id: string) => (id === from.companyId ? to.companyId : id);
  return {
    put: (plan) => inner.put(toDb(plan)),
    find: async (companyId, id) => fromDb(await inner.find(company(companyId), id)),
    list: async (companyId, page) => (await inner.list(company(companyId), page)).map((plan) => fromDb(plan) as AgentPlan),
    putReport: (companyId, key, report) => inner.putReport(company(companyId), key, report),
    findReport: (companyId, key) => inner.findReport(company(companyId), key),
    reportFor: (companyId, planId) => inner.reportFor(company(companyId), planId),
  };
};

test('the service runs a whole request on PostgreSQL: plan, preview, approve, execute, replay, history', { skip }, async () => {
  const { makeAgentDesk, TODAY } = await import('./harness.ts');
  const { PostgresAgentPlanStore } = await import('../src/postgres-store.ts');
  const { companyId, userId } = await scene();
  let store: AgentPlanStore | null = null;
  const desk = await makeAgentDesk({
    store: { // built once the desk's actor is known; every call goes to it
      put: (plan) => (store as AgentPlanStore).put(plan),
      find: (c, id) => (store as AgentPlanStore).find(c, id),
      list: (c, page) => (store as AgentPlanStore).list(c, page),
      putReport: (c, key, report) => (store as AgentPlanStore).putReport(c, key, report),
      findReport: (c, key) => (store as AgentPlanStore).findReport(c, key),
      reportFor: (c, planId) => (store as AgentPlanStore).reportFor(c, planId),
    },
    idFactory: () => crypto.randomUUID(),
  });
  store = renamed(new PostgresAgentPlanStore(app), { companyId: desk.actor.companyId, userId: desk.actor.userId }, { companyId, userId });
  // Each command is one unit of work, which is what the API's request handling wraps it in.
  const action = <T>(work: () => Promise<T>) => app.unitOfWork(companyId, () => work());

  const planned = await action(() => desk.agent.plan(desk.actor, { text: 'remind everyone who owes me money', today: TODAY }));
  const shown = await action(() => desk.agent.preview(desk.actor, planned.id));
  assert.ok(shown.needsApproval && shown.fingerprint !== null && shown.steps.some((step) => step.amount !== null));
  const approved = await action(() => desk.agent.approve(desk.actor, planned.id, shown.fingerprint as string));
  const report: AgentReport = await action(() => desk.agent.execute(desk.actor, planned.id, { fingerprint: shown.fingerprint as string, idempotencyKey: 'run-1' }));
  assert.equal(report.state, 'DONE');
  const sent = desk.provider.sent.length;
  assert.ok(sent > 0);
  const again = await action(() => desk.agent.execute(desk.actor, planned.id, { fingerprint: shown.fingerprint as string, idempotencyKey: 'run-1' }));
  assert.deepEqual(again, report, 'the same key returns the first report from the database');
  assert.equal(desk.provider.sent.length, sent, 'and sends nothing a second time');

  assert.deepEqual(await desk.agent.plans(desk.actor), [{ ...approved, state: 'EXECUTED' }]);
  assert.deepEqual(await desk.agent.report(desk.actor, planned.id), report);
  assert.deepEqual(await counts(companyId), [1, 1]);
});
