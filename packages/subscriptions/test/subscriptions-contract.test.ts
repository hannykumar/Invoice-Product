/** Issue #366 — the subscription stores contract, on the in-memory stores. */
import { InMemoryServiceInvoiceRepository, InMemorySubscriptionRepository, InMemoryUsageRepository } from '../src/index.ts';
import { subscriptionStoresContract } from './subscriptions-contract.ts';

subscriptionStoresContract('memory', () => ({
  subscriptions: new InMemorySubscriptionRepository(),
  usage: new InMemoryUsageRepository(),
  invoices: new InMemoryServiceInvoiceRepository(),
  company: async () => crypto.randomUUID(),
  write: (_companyId, work) => work(),
  transactional: false,
}));
