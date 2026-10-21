/** Issue #366 — the reminder repository contract, against the in-memory store. */
import type { BranchId, CompanyId } from '@invoice/kernel';
import { InMemoryReminderRepository } from '../src/repository.ts';
import { reminderRepositoryContract } from './reminder-repository-contract.ts';

const repository = new InMemoryReminderRepository();
reminderRepositoryContract('memory', () => ({
  repository,
  company: async () => ({ companyId: crypto.randomUUID() as CompanyId, branchId: crypto.randomUUID() as BranchId }),
  write: (_companyId, work) => work(),
  transactional: false,
}));
