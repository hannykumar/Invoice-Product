/**
 * Issue #4 [E04] — the Sharma Fruit Traders books, wired to the in-memory store.
 *
 * The same business and the same figures as docs/product/05-worked-examples.md, so a test failure
 * points at a documented example rather than at an invented one.
 */
import { asId, fixedClock, isoDate, type AccountId, type CompanyId, type PartyId, type UserId } from '@invoice/kernel';
import { buildDefaultChart, defaultChartIdFactory } from '../src/domain/chart-of-accounts.ts';
import type { Account, SystemAccountRole } from '../src/domain/account.ts';
import { InMemoryAuditPort, InMemoryLedgerStore, permissionPortFromActor } from '../src/adapters/memory.ts';
import { LedgerService } from '../src/service.ts';
import type { ActorContext } from '../src/ports.ts';

export const SHARMA: CompanyId = asId<'Company'>('11111111-1111-4111-8111-111111111111');
export const OTHER_COMPANY: CompanyId = asId<'Company'>('22222222-2222-4222-8222-222222222222');

export const ABC_TRADERS: PartyId = asId<'Party'>('aaaaaaaa-0000-4000-8000-000000000001');
export const NASHIK_FARMS: PartyId = asId<'Party'>('aaaaaaaa-0000-4000-8000-000000000002');

export const PRIYA: UserId = asId<'User'>('bbbbbbbb-0000-4000-8000-000000000001');

/** Every permission the ledger knows about, for tests that are not about permissions. */
export const ALL_PERMISSIONS = [
  'ledger.setup',
  'ledger.post.sale',
  'ledger.post.purchase',
  'ledger.post.receipt',
  'ledger.post.payment',
  'ledger.post.journal',
  'ledger.post.credit_note',
  'ledger.post.debit_note',
  'ledger.post.opening_balance',
  'ledger.post.locked_period',
  'ledger.reverse',
  'periods.lock',
  'periods.reopen',
  'periods.hard_lock',
];

export const actorWith = (permissions: readonly string[], companyId: CompanyId = SHARMA): ActorContext => ({
  companyId,
  branchId: null,
  userId: PRIYA,
  permissions,
});

/** Party accounts are ordinary accounts that belong to one party, so party balances fold from lines. */
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

export interface Ledger {
  service: LedgerService;
  store: InMemoryLedgerStore;
  audit: InMemoryAuditPort;
  actor: ActorContext;
  account: (role: SystemAccountRole) => AccountId;
  abcTradersAccount: AccountId;
  nashikFarmsAccount: AccountId;
  hdfcAccount: AccountId;
  idSeq: () => string;
}

let counter = 0;

export const makeLedger = async (
  options: { permissions?: readonly string[]; companyId?: CompanyId; booksStartDate?: string } = {},
): Promise<Ledger> => {
  const companyId = options.companyId ?? SHARMA;
  const store = new InMemoryLedgerStore();
  const audit = new InMemoryAuditPort();
  let n = 0;
  counter += 1;
  const prefix = `t${counter}`;
  const idSeq = (): string => {
    n += 1;
    return `${prefix}-${String(n).padStart(8, '0')}`;
  };
  const service = new LedgerService({
    store,
    permissions: permissionPortFromActor,
    audit,
    clock: fixedClock('2026-05-12T11:04:00.000Z'),
    idFactory: idSeq,
  });

  const chart = buildDefaultChart(companyId, defaultChartIdFactory(companyId));
  const hdfc: Account = {
    id: asId<'Account'>(`${companyId}:acc:1121`),
    companyId,
    code: '1121',
    name: 'HDFC Current Account',
    type: 'ASSET',
    parentId: asId<'Account'>(`${companyId}:acc:1120`),
    isGroup: false,
    active: true,
    partyId: null,
    systemRole: null,
  };
  const accounts: Account[] = [
    ...chart,
    hdfc,
    partyAccount(companyId, ABC_TRADERS, '1201', 'ABC Traders', true),
    partyAccount(companyId, NASHIK_FARMS, '2101', 'Nashik Farms', false),
  ];

  const setupActor = actorWith(options.permissions ?? ALL_PERMISSIONS, companyId);
  await service.initialiseCompany(setupActor, {
    booksStartDate: isoDate(options.booksStartDate ?? '2026-04-01'),
    accounts,
  });

  const byRole = new Map<string, AccountId>(
    accounts.filter((a) => a.systemRole !== null).map((a) => [a.systemRole as string, a.id]),
  );

  return {
    service,
    store,
    audit,
    actor: setupActor,
    account: (role: SystemAccountRole): AccountId => {
      const id = byRole.get(role);
      if (id === undefined) throw new Error(`fixture has no account for role ${role}`);
      return id;
    },
    abcTradersAccount: asId<'Account'>(`${companyId}:acc:1201`),
    nashikFarmsAccount: asId<'Account'>(`${companyId}:acc:2101`),
    hdfcAccount: hdfc.id,
    idSeq,
  };
};

export const key = (name: string): string => `test:${name}`;
