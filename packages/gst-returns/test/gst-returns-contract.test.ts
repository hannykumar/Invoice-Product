/** Issue #366 — the return-storage contract, against the in-memory stores. */
import type { CompanyId, UserId } from '@invoice/kernel';
import { InMemoryReturnPreparations } from '../src/adapters.ts';
import { InMemoryDeclaredThresholds } from '../src/thresholds.ts';
import { gstReturnContract } from './gst-returns-contract.ts';

const preparations = new InMemoryReturnPreparations();
const thresholds = new InMemoryDeclaredThresholds();
gstReturnContract('memory', () => ({
  preparations, thresholds,
  company: async () => crypto.randomUUID() as CompanyId,
  user: async () => crypto.randomUUID() as UserId,
  write: (_companyId, work) => work(),
}));
