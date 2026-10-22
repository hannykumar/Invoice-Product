/** Issue #366 — the ledger store contract on the in-memory store the running app uses today. */
import { asId } from '@invoice/kernel';
import { InMemoryLedgerStore } from '../src/adapters/memory.ts';
import { ledgerStoreContract } from './ledger-store-contract.ts';

ledgerStoreContract('memory', () => ({
  store: new InMemoryLedgerStore(),
  company: async () => ({ companyId: asId<'Company'>(crypto.randomUUID()), userId: asId<'User'>(crypto.randomUUID()) }),
}));
