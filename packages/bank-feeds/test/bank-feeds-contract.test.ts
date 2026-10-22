/** Issue #366 — the bank-feed contract suite on the in-memory store the running app uses today. */
import { InMemoryBankFeedStore } from '../src/index.ts';
import { bankFeedContract } from './bank-feeds-contract.ts';

bankFeedContract('memory', () => ({
  store: new InMemoryBankFeedStore(),
  company: async () => ({ companyId: crypto.randomUUID(), userId: crypto.randomUUID() }),
  write: (_companyId, work) => work(),
  atomic: false,
  inUnitOfWork: () => false,
}));
