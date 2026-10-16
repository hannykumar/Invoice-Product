/** Issue #366 — the inventory store contract, against the in-memory store. */
import type { CompanyId, UserId } from '@invoice/kernel';
import { InMemoryLedgerStore } from '@invoice/ledger';
import { InMemoryInventoryStore } from '../src/repository.ts';
import { inventoryStoreContract } from './inventory-store-contract.ts';

const ledger = new InMemoryLedgerStore();
const store = new InMemoryInventoryStore();
ledger.join(store);
const id = () => crypto.randomUUID();

inventoryStoreContract('memory', () => ({
  store,
  writesNeedUnitOfWork: false,
  unit: (companyId, work) => ledger.transaction(companyId, () => work()),
  shop: async () => ({ companyId: id() as CompanyId, userId: id() as UserId, itemIds: [id(), id()], warehouseIds: [id(), id()], batchId: id() }),
}));
