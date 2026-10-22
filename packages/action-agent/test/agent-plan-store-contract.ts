/**
 * Issue #366 — one contract suite for the assistant's plan store, run against the in-memory store
 * (agent-plan-store-contract.test.ts) and against PostgreSQL as the application role
 * (agent-plan-store-contract.integration.test.ts).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { money } from '@invoice/kernel';
import type { AgentPlan, AgentReport } from '../src/model.ts';
import type { AgentPlanStore } from '../src/ports.ts';

export interface AgentPlanStoreHarness {
  readonly store: AgentPlanStore;
  /** A company and a person: rows that exist wherever the implementation keeps them. */
  company(): Promise<string>;
  user(): Promise<string>;
  /** Runs `work` as one business action — a unit of work on PostgreSQL, a plain call in memory. */
  write<T>(companyId: string, work: () => Promise<T>): Promise<T>;
}

/** More paise than a JavaScript number can hold exactly. */
export const HUGE = 9_007_199_254_740_993n;

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

export const planOf = (companyId: string, userId: string, over: Partial<AgentPlan> = {}): AgentPlan => ({
  id: crypto.randomUUID(),
  companyId,
  request: 'remind ABC about the unpaid bills',
  today: '2026-06-01',
  commandId: null,
  intent: 'CHASE_UNPAID',
  evidence: 'remind',
  confidence: 0.88,
  steps: [],
  refusals: [],
  needsApproval: false,
  fingerprint: null,
  instructionFlag: null,
  summary: { 'en-IN': 'Let me look at your books.', 'hi-IN': 'Main aapki bahi dekhta hoon.' },
  state: 'PLANNED',
  requestedBy: userId,
  requestedAt: '2026-06-01T10:00:00.123Z',
  ...over,
});

/** What preview leaves behind: steps with a real (and very large) amount, a refusal, a command. */
export const previewed = (plan: AgentPlan): AgentPlan => ({
  ...plan,
  commandId: crypto.randomUUID(),
  steps: [{
    stepId: `${plan.id}-01`,
    tool: 'reminders.send',
    input: { documentId: 'inv-1', bill: 'INV/26-27/000001', partyName: 'ABC Traders', today: '2026-06-01' },
    describe: { 'en-IN': 'Send ABC Traders a reminder.', 'hi-IN': 'ABC Traders ko yaad dilayein.' },
    kind: 'WRITE',
    risk: 'medium',
    executability: 'AFTER_APPROVAL',
    highRiskClass: null,
    dependsOn: null,
    amount: money(HUGE),
    party: 'ABC Traders',
  }],
  refusals: [{ code: 'NOTHING_TO_DO', tool: 'reminders.send', reason: { 'en-IN': 'XYZ owes nothing.', 'hi-IN': 'XYZ ka kuch baaki nahin.' } }],
  needsApproval: true,
  fingerprint: 'f'.repeat(64),
  instructionFlag: 'ignore previous instructions',
  state: 'PREVIEWED',
});

export const reportOf = (plan: AgentPlan, over: Partial<AgentReport> = {}): AgentReport => ({
  planId: plan.id,
  state: 'PARTLY_DONE',
  steps: [{
    stepId: `${plan.id}-01`,
    tool: 'reminders.send',
    state: 'FAILED',
    describe: { 'en-IN': 'Send ABC Traders a reminder.', 'hi-IN': 'ABC Traders ko yaad dilayein.' },
    evidence: null,
    failure: { 'en-IN': 'The provider is unavailable.', 'hi-IN': 'The provider is unavailable.' },
    retryable: true,
  }],
  summary: { 'en-IN': '0 done, 1 could not be completed.', 'hi-IN': '0 ho gaye, 1 nahin ho paya.' },
  refusals: [],
  handedBack: [{ 'en-IN': 'Send ABC Traders a reminder — you can try this one again.', 'hi-IN': 'ABC Traders ko yaad dilayein — ise aap dobara try kar sakte hain.' }],
  finishedAt: '2026-06-01T10:00:05.456Z',
  ...over,
});

export const agentPlanStoreContract = (name: string, harness: () => AgentPlanStoreHarness, skip: string | false = false): void => {
  const scene = async () => {
    const h = harness();
    return { h, companyId: await h.company(), userId: await h.user() };
  };

  test(`${name}: a plan comes back as it was saved, and only to its own company`, { skip }, async () => {
    const { h, companyId, userId } = await scene();
    const other = await h.company();
    const plan = planOf(companyId, userId);
    await h.write(companyId, () => h.store.put(plan));
    assert.deepEqual(await h.store.find(companyId, plan.id), plan);
    assert.equal(await h.store.find(other, plan.id), null);
    assert.equal(await h.store.find(companyId, crypto.randomUUID()), null);
    assert.equal(await h.store.find(companyId, 'not-a-plan'), null);
  });

  test(`${name}: saving a plan again replaces it, amounts kept to the paisa`, { skip }, async () => {
    const { h, companyId, userId } = await scene();
    const plan = planOf(companyId, userId);
    await h.write(companyId, () => h.store.put(plan));
    const next = previewed(plan);
    await h.write(companyId, () => h.store.put(next));
    const found = await h.store.find(companyId, plan.id);
    assert.deepEqual(found, next);
    assert.equal(found?.steps[0]?.amount?.minor, HUGE);
    const approved: AgentPlan = { ...next, state: 'APPROVED' };
    const executed: AgentPlan = { ...next, state: 'EXECUTED' };
    await h.write(companyId, () => h.store.put(approved));
    await h.write(companyId, () => h.store.put(executed));
    // A read-only plan run under a second key is saved again unchanged.
    await h.write(companyId, () => h.store.put(executed));
    assert.deepEqual(await h.store.list(companyId), [executed]);
  });

  test(`${name}: the list is one company's plans, newest first, a page at a time`, { skip }, async () => {
    const { h, companyId, userId } = await scene();
    const other = await h.company();
    const early = planOf(companyId, userId, { requestedAt: '2026-06-01T09:00:00.000Z' });
    const first = planOf(companyId, userId);
    const second = planOf(companyId, userId); // the same moment as `first`, saved after it
    const late = planOf(companyId, userId, { requestedAt: '2026-06-01T11:00:00.000Z' });
    for (const plan of [early, first, second, late]) await h.write(companyId, () => h.store.put(plan));
    await h.write(other, () => h.store.put(planOf(other, userId)));
    // Saving `first` again does not move it ahead of `second`.
    await h.write(companyId, () => h.store.put(previewed(first)));
    const ids = (plans: readonly AgentPlan[]) => plans.map((plan) => plan.id);

    assert.deepEqual(ids(await h.store.list(companyId)), [late.id, second.id, first.id, early.id]);
    assert.deepEqual(ids(await h.store.list(companyId, { limit: 2 })), [late.id, second.id]);
    assert.deepEqual(ids(await h.store.list(companyId, { limit: 2, after: second.id })), [first.id, early.id]);
    assert.deepEqual(ids(await h.store.list(companyId, { limit: 2, after: early.id })), []);
    assert.deepEqual(ids(await h.store.list(companyId, { limit: 1, after: crypto.randomUUID() })), [late.id]);
    assert.deepEqual(ids(await h.store.list(companyId, { limit: 1, after: 'not-a-plan' })), [late.id]);
    assert.equal((await h.store.list(other)).length, 1);
    assert.deepEqual(await h.store.list(await h.company()), []);
  });

  test(`${name}: a run's report is found by its key, and the plan's latest report is the last written`, { skip }, async () => {
    const { h, companyId, userId } = await scene();
    const other = await h.company();
    const plan = previewed(planOf(companyId, userId, { state: 'PREVIEWED', needsApproval: false }));
    await h.write(companyId, () => h.store.put(plan));
    assert.equal(await h.store.reportFor(companyId, plan.id), null);
    assert.equal(await h.store.findReport(companyId, `${plan.id}:run-1`), null);

    const first = reportOf(plan);
    const second = reportOf(plan, { state: 'DONE', steps: [], handedBack: [], finishedAt: '2026-06-01T10:00:09.000Z' });
    await h.write(companyId, () => h.store.putReport(companyId, `${plan.id}:run-1`, first));
    await h.write(companyId, () => h.store.putReport(companyId, `${plan.id}:run-2`, second));
    assert.deepEqual(await h.store.findReport(companyId, `${plan.id}:run-1`), first);
    assert.deepEqual(await h.store.findReport(companyId, `${plan.id}:run-2`), second);
    assert.deepEqual(await h.store.reportFor(companyId, plan.id), second);

    // One run per key: the same key twice is refused, and the first report stands.
    await assert.rejects(h.write(companyId, () => h.store.putReport(companyId, `${plan.id}:run-1`, second)), code('AGENT_REPORT_EXISTS'));
    assert.deepEqual(await h.store.findReport(companyId, `${plan.id}:run-1`), first);

    assert.equal(await h.store.findReport(other, `${plan.id}:run-1`), null);
    assert.equal(await h.store.reportFor(other, plan.id), null);
    assert.equal(await h.store.reportFor(companyId, 'not-a-plan'), null);
  });
};
