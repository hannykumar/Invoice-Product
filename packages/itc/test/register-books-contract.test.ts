/** Issue #366 — the purchase comparison's books contract, against the in-memory bill store. */
import type { CompanyId } from '@invoice/kernel';
import { InMemoryPurchaseBillStore } from '../../purchasing/src/posting-adapters.ts';
import { registerBooksContract } from './register-books-contract.ts';

const bills = new InMemoryPurchaseBillStore();

registerBooksContract('memory', () => ({
  bills,
  scene: async () => ({ companyId: crypto.randomUUID() as CompanyId, userId: crypto.randomUUID(), partyId: crypto.randomUUID(), itemId: crypto.randomUUID(), warehouseId: crypto.randomUUID(), batchId: crypto.randomUUID() }),
  write: (_companyId, work) => work(),
}));
