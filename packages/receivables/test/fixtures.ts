/** Issue #20 [E20] — ABC Traders with three bills and a shopkeeper taking money. */
import { asId, fixedClock, isoDate, rupees, type CompanyId, type IsoDate, type Money, type PartyId } from '@invoice/kernel';
import {
  buildDefaultChart,
  defaultChartIdFactory,
  InMemoryAuditPort,
  InMemoryLedgerStore,
  LedgerService,
  permissionPortFromActor,
  type Account,
  type ActorContext,
} from '@invoice/ledger';
import { InMemoryPaymentRepository } from '../src/repository.ts';
import { ReceivablesService } from '../src/service.ts';
import type { DocumentLedgerPort } from '../src/ports.ts';
import type { OpenDocument } from '../src/model.ts';

export const COMPANY: CompanyId = asId<'Company'>('rec-co');
export const OTHER: CompanyId = asId<'Company'>('rec-other');
export const ABC: PartyId = asId<'Party'>('abc');
export const NASHIK: PartyId = asId<'Party'>('nashik');
export const PRIYA = asId<'User'>('rec-priya');

export const ALL_PERMISSIONS = [
  'ledger.setup', 'ledger.post.receipt', 'ledger.post.payment', 'ledger.post.journal', 'ledger.reverse',
  'payments.record', 'payments.allocate', 'payments.reverse', 'payments.write_off',
];

export const actorWith = (permissions: readonly string[], companyId: CompanyId = COMPANY): ActorContext => ({
  companyId,
  branchId: asId<'Branch'>('kb'),
  userId: PRIYA,
  permissions,
});

/** Stands in for #9's sales invoices and #17's purchase bills. */
export class FakeDocuments implements DocumentLedgerPort {
  #documents: OpenDocument[] = [];
  set(documents: OpenDocument[]): void {
    this.#documents = documents;
  }
  async openDocuments(_c: CompanyId, partyId: PartyId): Promise<readonly OpenDocument[]> {
    return this.#documents.filter((d) => d.partyId === partyId);
  }
  async parties(): Promise<readonly PartyId[]> {
    return [...new Set(this.#documents.map((d) => d.partyId))];
  }
  async nameOf(_c: CompanyId, partyId: PartyId): Promise<string> {
    return partyId === ABC ? 'ABC Traders' : 'Nashik Farms';
  }
}

const partyAccount = (companyId: CompanyId, party: PartyId, code: string, name: string, receivable: boolean): Account => ({
  id: asId<'Account'>(`${companyId}:acc:${code}`),
  companyId,
  code,
  name,
  type: receivable ? 'ASSET' : 'LIABILITY',
  parentId: asId<'Account'>(`${companyId}:acc:${receivable ? '1200' : '2100'}`),
  isGroup: false,
  active: true,
  partyId: party,
  systemRole: null,
});

let counter = 0;

export const makeDesk = async (companyId: CompanyId = COMPANY) => {
  const store = new InMemoryLedgerStore();
  const repository = new InMemoryPaymentRepository();
  store.join(repository);
  const audit = new InMemoryAuditPort();
  const clock = fixedClock('2026-08-29T10:00:00.000Z');
  counter += 1;
  let n = 0;
  const idFactory = (): string => `pay${counter}-${String((n += 1)).padStart(6, '0')}`;

  const ledger = new LedgerService({ store, permissions: permissionPortFromActor, audit, clock, idFactory });
  const bank: Account = {
    id: asId<'Account'>(`${companyId}:acc:1121`), companyId, code: '1121', name: 'HDFC Current Account',
    type: 'ASSET', parentId: asId<'Account'>(`${companyId}:acc:1120`), isGroup: false, active: true,
    partyId: null, systemRole: null,
  };
  await ledger.initialiseCompany(actorWith(ALL_PERMISSIONS, companyId), {
    booksStartDate: isoDate('2026-04-01'),
    accounts: [
      ...buildDefaultChart(companyId, defaultChartIdFactory(companyId)),
      bank,
      partyAccount(companyId, ABC, '1201', 'ABC Traders', true),
      partyAccount(companyId, NASHIK, '2101', 'Nashik Farms', false),
    ],
  });

  const documents = new FakeDocuments();
  const service = new ReceivablesService({
    store, ledger, repository, documents,
    permissions: permissionPortFromActor, audit, clock, idFactory,
  });
  return { store, ledger, service, documents, repository, audit, actor: actorWith(ALL_PERMISSIONS, companyId) };
};

export const bill = (number: string, value: Money, date: string, due: string, partyId: PartyId = ABC): OpenDocument => ({
  documentId: number,
  kind: partyId === ABC ? 'SALES_INVOICE' : 'PURCHASE_INVOICE',
  number,
  partyId,
  date: isoDate(date),
  dueDate: isoDate(due),
  value,
  side: partyId === ABC ? 'RECEIVABLE' : 'PAYABLE',
});

export const on = (date: string): IsoDate => isoDate(date);
export const inr = (whole: number, paise = 0): Money => rupees(whole, paise);
