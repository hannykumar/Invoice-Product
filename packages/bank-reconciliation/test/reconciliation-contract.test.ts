import { InMemoryReconciliationStore } from '../src/index.ts';
import { reconciliationContract } from './reconciliation-contract.ts';

reconciliationContract('memory', () => ({ store: new InMemoryReconciliationStore(), company: async () => crypto.randomUUID() }));
