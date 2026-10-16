/** Issue #366 — the sales repository contract, against the in-memory stores. */
import type { CompanyId, PartyId, UserId, VoucherId } from '@invoice/kernel';
import { InMemoryLedgerStore } from '@invoice/ledger';
import { InMemoryChallanRepository } from '../src/challan-repository.ts';
import { InMemoryPreSaleRepository } from '../src/presale-repository.ts';
import { InMemorySalesRepository } from '../src/repository.ts';
import { salesRepositoryContract } from './sales-repository-contract.ts';

const store = new InMemoryLedgerStore();
const sales = new InMemorySalesRepository();
const presale = new InMemoryPreSaleRepository();
const challans = new InMemoryChallanRepository();
store.join(sales).join(presale).join(challans);
const id = () => crypto.randomUUID();

salesRepositoryContract('memory', () => ({
  sales, presale, challans,
  writesNeedUnitOfWork: false,
  unit: (companyId, work) => store.transaction(companyId, () => work()),
  shop: async () => ({
    companyId: id() as CompanyId, userId: id() as UserId, partyId: id() as PartyId,
    itemIds: [id(), id()], warehouseId: id(), vouchers: [id() as VoucherId, id() as VoucherId],
  }),
}));
