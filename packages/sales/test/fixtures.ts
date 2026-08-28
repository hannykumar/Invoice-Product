/** Issue #9 [E09] — Sharma Fruit Traders with books, a tax calculator and a till. */
import {
  asId,
  fixedClock,
  isoDate,
  quantityFromString,
  rupees,
  type AccountId,
  type BranchId,
  type CompanyId,
  type IsoDate,
  type Money,
  type PartyId,
  type Quantity,
  type UserId,
} from '@invoice/kernel';
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
import { GstCalculator, FIXTURE_RATE_TABLE, InMemoryMasterData, type ItemTaxClassification } from '@invoice/gst-calc';
import { RulesEngine, shippedRegistry } from '@invoice/rules-engine';
import { InMemorySalesRepository } from '../src/repository.ts';
import { SalesService } from '../src/service.ts';
import { DEFAULT_SALES_POLICY, type SalesPolicy } from '../src/policy.ts';
import { noComplianceHooks, permissiveInventory, type ComplianceHookPort, type InventoryPort } from '../src/ports.ts';

export const SHARMA: CompanyId = asId<'Company'>('company-sharma');
export const OTHER: CompanyId = asId<'Company'>('company-other');
export const KAROL_BAGH: BranchId = asId<'Branch'>('branch-kb');
export const ABC: PartyId = asId<'Party'>('abc-traders');
export const GURUGRAM: PartyId = asId<'Party'>('gurugram-fresh');
export const WALK_IN: PartyId = asId<'Party'>('walk-in');
export const PRIYA: UserId = asId<'User'>('user-priya');
export const RAJESH: UserId = asId<'User'>('user-rajesh');

export const ALL_PERMISSIONS = [
  'ledger.setup',
  'ledger.post.sale',
  'ledger.post.journal',
  'ledger.reverse',
  'periods.lock',
  'periods.reopen',
  'periods.hard_lock',
  'sales.draft.write',
  'sales.finalise',
  'sales.approve',
  'sales.cancel',
];

export const actorWith = (
  permissions: readonly string[],
  options: { companyId?: CompanyId; userId?: UserId } = {},
): ActorContext => ({
  companyId: options.companyId ?? SHARMA,
  branchId: KAROL_BAGH,
  userId: options.userId ?? PRIYA,
  permissions,
});

const partyAccount = (companyId: CompanyId, party: PartyId, code: string, name: string): Account => ({
  id: asId<'Account'>(`${companyId}:acc:${code}`),
  companyId,
  code,
  name,
  type: 'ASSET',
  parentId: asId<'Account'>(`${companyId}:acc:1200`),
  isGroup: false,
  active: true,
  partyId: party,
  systemRole: null,
});

const ITEMS: ItemTaxClassification[] = [
  { itemId: 'APL-BOX-10', name: 'Apple box, 10 kg', kind: 'GOODS', hsnOrSac: '0808', treatment: 'NIL_RATED', reverseCharge: false, baseUnit: 'BOX' },
  { itemId: 'CRATE-P', name: 'Plastic crate', kind: 'GOODS', hsnOrSac: '3923', treatment: 'TAXABLE', reverseCharge: false, baseUnit: 'PCS' },
  { itemId: 'REPAIR', name: 'Crate repair work', kind: 'SERVICES', hsnOrSac: '9987', treatment: 'TAXABLE', reverseCharge: false, baseUnit: 'JOB' },
  { itemId: 'MYSTERY', name: 'Uncategorised item', kind: 'GOODS', hsnOrSac: null, treatment: 'UNKNOWN', reverseCharge: false, baseUnit: 'PCS' },
];

export interface Till {
  service: SalesService;
  ledger: LedgerService;
  store: InMemoryLedgerStore;
  repository: InMemorySalesRepository;
  audit: InMemoryAuditPort;
  masterData: InMemoryMasterData;
  actor: ActorContext;
  account: (role: string) => AccountId;
  customerAccount: AccountId;
}

let counter = 0;

export const makeTill = async (
  options: {
    policy?: Partial<SalesPolicy>;
    inventory?: InventoryPort;
    compliance?: ComplianceHookPort;
    permissions?: readonly string[];
    companyId?: CompanyId;
    seedAccounts?: boolean;
  } = {},
): Promise<Till> => {
  const companyId = options.companyId ?? SHARMA;
  const store = new InMemoryLedgerStore();
  const repository = new InMemorySalesRepository();
  store.join(repository);
  const audit = new InMemoryAuditPort();
  counter += 1;
  let n = 0;
  const idFactory = (): string => {
    n += 1;
    return `s${counter}-${String(n).padStart(8, '0')}`;
  };
  const clock = fixedClock('2026-05-12T11:04:00.000Z');
  const ledger = new LedgerService({ store, permissions: permissionPortFromActor, audit, clock, idFactory });

  const chart = buildDefaultChart(companyId, defaultChartIdFactory(companyId));
  const accounts: Account[] = [
    ...(options.seedAccounts === false ? chart.filter((a) => a.systemRole !== 'SALES_GOODS') : chart),
    partyAccount(companyId, ABC, '1201', 'ABC Traders'),
    partyAccount(companyId, GURUGRAM, '1202', 'Gurugram Fresh Mart'),
    partyAccount(companyId, WALK_IN, '1203', 'Counter customer'),
  ];
  const setupActor = actorWith(ALL_PERMISSIONS, { companyId });
  await ledger.initialiseCompany(setupActor, { booksStartDate: isoDate('2026-04-01'), accounts });

  const masterData = new InMemoryMasterData();
  masterData.putCompany({ companyId, gstin: '07AAAAA0000A1Z4', stateCode: '07', registration: 'REGULAR' });
  masterData
    .putParty(companyId, { partyId: ABC, gstin: '07DDDDD3333D1ZV', stateCode: '07', registration: 'REGULAR' })
    .putParty(companyId, { partyId: GURUGRAM, gstin: '06BBBBB1111B1ZR', stateCode: '06', registration: 'REGULAR' })
    .putParty(companyId, { partyId: WALK_IN, gstin: null, stateCode: null, registration: 'UNKNOWN' });
  for (const item of ITEMS) masterData.putItem(companyId, item);

  const calculator = new GstCalculator({
    masterData,
    rates: FIXTURE_RATE_TABLE,
    gstEngine: new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.gst', mode: 'development' }),
    mode: 'development',
  });

  const service = new SalesService({
    store,
    ledger,
    calculator,
    repository,
    inventory: options.inventory ?? permissiveInventory,
    compliance: options.compliance ?? noComplianceHooks,
    permissions: permissionPortFromActor,
    audit,
    clock,
    policy: { ...DEFAULT_SALES_POLICY, series: { prefix: 'INV', branchCode: 'KB', padding: 5 }, ...options.policy },
    idFactory,
  });

  const byRole = new Map<string, AccountId>(
    accounts.filter((a) => a.systemRole !== null).map((a) => [a.systemRole as string, a.id]),
  );

  return {
    service,
    ledger,
    store,
    repository,
    audit,
    masterData,
    actor: actorWith(options.permissions ?? ALL_PERMISSIONS, { companyId }),
    account: (role: string): AccountId => {
      const id = byRole.get(role);
      if (id === undefined) throw new Error(`fixture has no account for role ${role}`);
      return id;
    },
    customerAccount: asId<'Account'>(`${companyId}:acc:1201`),
  };
};

export const qty = (value: string, unit: string): Quantity => quantityFromString(value, unit);
export const on = (date: string): IsoDate => isoDate(date);
export const inr = (whole: number, paise = 0): Money => rupees(whole, paise);
