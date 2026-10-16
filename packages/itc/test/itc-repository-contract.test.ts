/** Issue #366 — the storage contract, against the in-memory stores. */
import type { CompanyId, UserId } from '@invoice/kernel';
import { InMemoryImportBatches, InMemoryItcClaims, InMemoryItcDecisions, InMemoryPortalRecords } from '../src/adapters.ts';
import { itcRepositoryContract } from './itc-repository-contract.ts';

const stores = {
  records: new InMemoryPortalRecords(),
  batches: new InMemoryImportBatches(),
  decisions: new InMemoryItcDecisions(),
  claims: new InMemoryItcClaims(),
};
itcRepositoryContract('memory', () => ({
  ...stores,
  company: async () => crypto.randomUUID() as CompanyId,
  user: async () => crypto.randomUUID() as UserId,
  write: (_companyId, work) => work(),
}));
