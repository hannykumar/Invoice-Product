/** Issue #366 — the gsp store contract suite on the in-memory stores. */
import type { CompanyId, UserId } from '@invoice/kernel';
import { InMemoryAuthorisations, InMemoryCallLog } from '../src/adapters.ts';
import { gspStoreContract } from './gsp-store-contract.ts';

gspStoreContract('memory', () => ({
  authorisations: new InMemoryAuthorisations(),
  calls: new InMemoryCallLog(),
  company: async () => ({ companyId: crypto.randomUUID() as CompanyId, userId: crypto.randomUUID() as UserId }),
  write: (_companyId, work) => work(),
}));
