/** Issue #366 — the storage contract, against the in-memory repository. */
import type { CompanyId, UserId } from '@invoice/kernel';
import { InMemoryOnboardingRepository } from '../src/repository.ts';
import { onboardingRepositoryContract } from './onboarding-repository-contract.ts';

const repository = new InMemoryOnboardingRepository();
onboardingRepositoryContract('memory', () => ({
  repository,
  company: async () => crypto.randomUUID() as CompanyId,
  user: async () => crypto.randomUUID() as UserId,
  write: (_companyId, work) => work(),
}));
