/** Issue #366 — the return-note repository contract, against the in-memory store. */
import { InMemoryLedgerStore } from '@invoice/ledger';
import type { CompanyId, PartyId, UserId } from '@invoice/kernel';
import { InMemoryReturnNoteRepository } from '../src/index.ts';
import { returnsContract } from './returns-contract.ts';

returnsContract('memory', () => {
  const store = new InMemoryLedgerStore();
  const repository = new InMemoryReturnNoteRepository();
  store.join(repository);
  return {
    repository,
    unitOfWork: (companyId, work) => store.transaction(companyId, () => work()),
    company: async () => ({
      companyId: crypto.randomUUID() as CompanyId, partyId: crypto.randomUUID() as PartyId, itemId: crypto.randomUUID(),
      warehouseId: crypto.randomUUID(), userId: crypto.randomUUID() as UserId,
    }),
  };
});
