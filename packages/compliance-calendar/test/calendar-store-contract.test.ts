/** Issue #366 — the compliance calendar store contract, on the in-memory stores. */
import type { CompanyId, UserId } from '@invoice/kernel';
import { InMemoryAlerts, InMemoryComplianceExceptions, InMemoryOccurrences } from '../src/adapters.ts';
import { calendarStoreContract } from './calendar-store-contract.ts';

calendarStoreContract('memory', () => ({
  occurrences: new InMemoryOccurrences(),
  alerts: new InMemoryAlerts(),
  exceptions: new InMemoryComplianceExceptions(),
  write: (_companyId, work) => work(),
  company: async () => crypto.randomUUID() as CompanyId,
  user: async () => crypto.randomUUID() as UserId,
}));
