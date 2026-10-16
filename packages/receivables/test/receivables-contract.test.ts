/** Issue #366 — the receivables contract, against the in-memory stores. */
import { InMemoryLedgerStore } from '@invoice/ledger';
import { InMemoryAdvanceRepository } from '../src/advance.ts';
import { InMemoryPaymentRepository } from '../src/repository.ts';
import { receivablesContract } from './receivables-contract.ts';

receivablesContract('memory', () => {
  const store = new InMemoryLedgerStore();
  const payments = new InMemoryPaymentRepository();
  const advances = new InMemoryAdvanceRepository();
  store.join(payments).join(advances);
  return {
    store, payments, advances,
    unit: (companyId, work) => store.transaction(companyId as never, () => work()),
    seedCompany: async () => {},
    seedBill: async () => {},
    seedProforma: async () => {},
  };
});
