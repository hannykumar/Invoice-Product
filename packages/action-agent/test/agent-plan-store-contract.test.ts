/** Issue #366 — the plan store contract, against the in-memory store. */
import { InMemoryAgentPlanStore } from '../src/store.ts';
import { agentPlanStoreContract } from './agent-plan-store-contract.ts';

const store = new InMemoryAgentPlanStore();
agentPlanStoreContract('memory', () => ({
  store,
  company: async () => crypto.randomUUID(),
  user: async () => crypto.randomUUID(),
  write: (_companyId, work) => work(),
}));
