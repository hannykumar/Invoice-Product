/**
 * Issue #48 [E48] — collecting what the gates judge, from the real modules.
 *
 * Every observation here comes from actually exercising the product: bills are issued, stock is
 * moved, a posting is retried, a finished record is prodded to see whether it can be changed. None
 * of it is asserted here — this file only watches, and `invariants.ts` judges — because a checker
 * that also gathers its own evidence can quietly gather evidence that suits it.
 */
import {
  DomainError,
  asId,
  fixedClock,
  isoDate,
  quantityFromString,
  rupees,
  type CompanyId,
} from '@invoice/kernel';
import {
  InMemoryAuditPort,
  InMemoryLedgerStore,
  LedgerService,
  buildDefaultChart,
  defaultChartIdFactory,
  permissionPortFromActor,
  trialBalance,
  type Account,
  type ActorContext,
} from '@invoice/ledger';
import { InMemoryInventoryStore, InventoryService, type StockItem, type StockMasterData, type Warehouse } from '@invoice/inventory';
import { createDefaultUnitRegistry, type UnitRegistry } from '../../masters/src/units.ts';
import { shippedRegistry } from '@invoice/rules-engine';
import {
  AssistantSession,
  MATERIAL_CONFIDENCE,
  type EntityResolver,
  type ResolvedItem,
  type ResolvedParty,
  type Resolution,
} from '@invoice/voice-assistant';
import { compareRefusalReasons, compareToExpected, loadAllFixtures, replay } from '@invoice/golden-dataset';
import type {
  GoldenObservation,
  ModelFieldObservation,
  ImmutabilityObservation,
  RetryObservation,
  RuleObservation,
  StockObservation,
  TaxObservation,
  VoucherObservation,
} from './invariants.ts';

const COMPANY: CompanyId = asId<'Company'>('gates-co');
const PERMISSIONS = [
  'ledger.setup', 'ledger.post.sale', 'ledger.post.journal', 'ledger.post.receipt', 'ledger.reverse',
  'inventory.move', 'inventory.adjust', 'inventory.override_negative',
];
const actor: ActorContext = {
  companyId: COMPANY,
  branchId: asId<'Branch'>('main'),
  userId: asId<'User'>('gates-owner'),
  permissions: PERMISSIONS,
};

class Masters implements StockMasterData {
  readonly #registry: UnitRegistry = createDefaultUnitRegistry();
  item(_companyId: CompanyId, itemId: string): StockItem | undefined {
    return itemId === 'CRATE' ? { itemId: 'CRATE', name: 'Plastic crate', baseUnit: 'PCS', tracksBatches: false, tracksSerials: false } : undefined;
  }
  warehouse(_companyId: CompanyId, warehouseId: string): Warehouse | undefined {
    return warehouseId === 'shop' ? { warehouseId: 'shop', name: 'Shop' } : undefined;
  }
  units(): UnitRegistry {
    return this.#registry;
  }
}

export interface Observations {
  readonly vouchers: readonly VoucherObservation[];
  readonly totalDebits: bigint;
  readonly totalCredits: bigint;
  readonly stock: readonly StockObservation[];
  readonly tax: readonly TaxObservation[];
  readonly retries: readonly RetryObservation[];
  readonly rules: readonly RuleObservation[];
  readonly immutability: readonly ImmutabilityObservation[];
  readonly golden: readonly GoldenObservation[];
  readonly modelFields: readonly ModelFieldObservation[];
  readonly materialConfidence: number;
}

/** Every rule the product ships, across every version of every rule set it knows about. */
export const observeRules = (): RuleObservation[] => {
  const registry = shippedRegistry();
  const observations: RuleObservation[] = [];
  for (const setId of ['in.policy', 'in.gst']) {
    for (const version of registry.versions(setId)) {
      const set = registry.get(setId, version);
      for (const rule of set.rules) {
        observations.push({
          ruleSetId: `${setId}@${version}`,
          ruleId: rule.id,
          kind: rule.kind,
          reviewState: rule.reviewState,
          sourceRef: rule.sourceRef,
          effectiveFrom: rule.effectiveFrom,
        });
      }
    }
  }
  return observations;
};

/** Replays every golden fixture and reports where, if anywhere, it no longer matches. */
export const observeGolden = async (): Promise<GoldenObservation[]> => {
  const results: GoldenObservation[] = [];
  for (const { fixture } of loadAllFixtures()) {
    const actual = await replay(fixture);
    const mismatches = [...compareToExpected(fixture.expected, actual), ...compareRefusalReasons(fixture, actual)];
    results.push({ fixtureId: fixture.id, mismatches: mismatches.map((m) => `${m.what}: expected ${m.expected}, got ${m.actual}`) });
  }
  return results;
};

/**
 * Exercises the ledger and inventory for real: posts entries, retries one, tries to change a
 * finished one, and takes stock below zero with and without an authorised reason.
 */
export const observeLive = async (): Promise<Omit<Observations, 'rules' | 'golden' | 'materialConfidence' | 'tax' | 'modelFields'>> => {
  const store = new InMemoryLedgerStore();
  const inventoryStore = new InMemoryInventoryStore();
  store.join(inventoryStore);
  const audit = new InMemoryAuditPort();
  const clock = fixedClock('2026-08-29T10:00:00.000Z');
  let n = 0;
  const idFactory = (): string => `gate-${String((n += 1)).padStart(6, '0')}`;

  const ledger = new LedgerService({ store, permissions: permissionPortFromActor, audit, clock, idFactory });
  const customer: Account = {
    id: asId<'Account'>(`${COMPANY}:acc:1201`), companyId: COMPANY, code: '1201', name: 'A customer',
    type: 'ASSET', parentId: asId<'Account'>(`${COMPANY}:acc:1200`), isGroup: false, active: true,
    partyId: asId<'Party'>('a-customer'), systemRole: null,
  };
  await ledger.initialiseCompany(actor, {
    booksStartDate: isoDate('2026-04-01'),
    accounts: [...buildDefaultChart(COMPANY, defaultChartIdFactory(COMPANY)), customer],
  });

  const cash = asId<'Account'>(`${COMPANY}:acc:1110`);
  const sales = asId<'Account'>(`${COMPANY}:acc:4100`);

  // An ordinary entry, and then the same one again to see whether it is recorded twice.
  const first = await ledger.postVoucher(actor, {
    idempotencyKey: 'gate-retry',
    type: 'JOURNAL',
    date: isoDate('2026-04-10'),
    narration: 'Counter takings',
    lines: [
      { accountId: cash, debit: rupees(1000), credit: rupees(0), partyId: null, narration: null },
      { accountId: sales, debit: rupees(0), credit: rupees(1000), partyId: null, narration: null },
    ],
  });
  const before = (await store.read().vouchers.list(COMPANY, {})).length;
  const second = await ledger.postVoucher(actor, {
    idempotencyKey: 'gate-retry',
    type: 'JOURNAL',
    date: isoDate('2026-04-10'),
    narration: 'Counter takings',
    lines: [
      { accountId: cash, debit: rupees(1000), credit: rupees(0), partyId: null, narration: null },
      { accountId: sales, debit: rupees(0), credit: rupees(1000), partyId: null, narration: null },
    ],
  });
  const after = (await store.read().vouchers.list(COMPANY, {})).length;
  const retries: RetryObservation[] = [
    {
      idempotencyKey: 'gate-retry',
      firstResultId: first.voucher.id,
      secondResultId: second.voucher.id,
      documentsCreated: after - before + 1,
    },
  ];

  // Can a finished entry be undone twice? Reversing once is a correction; reversing the same entry
  // again would undo history rather than correct it, and must be refused. This is observed by
  // actually trying it, and the result is whatever happened — not a value written by hand.
  await ledger.reverseVoucher(actor, {
    idempotencyKey: 'gate-reverse-1',
    voucherId: first.voucher.id,
    date: isoDate('2026-04-12'),
    reason: 'A genuine correction.',
  });
  let editRefused = false;
  try {
    await ledger.reverseVoucher(actor, {
      idempotencyKey: 'gate-reverse-2',
      voucherId: first.voucher.id,
      date: isoDate('2026-04-13'),
      reason: 'A second attempt at the same entry.',
    });
  } catch (error) {
    editRefused = error instanceof DomainError;
  }
  const immutability: ImmutabilityObservation[] = [
    { voucherId: first.voucher.id, state: 'REVERSED', editRefused },
  ];

  const inventory = new InventoryService({
    store, inventory: inventoryStore, masterData: new Masters(),
    permissions: permissionPortFromActor, audit, clock,
    policy: { negativeStock: 'WARN_WITH_OVERRIDE', reservationMinutes: 60, valuationMethod: 'WEIGHTED_AVERAGE' },
    idFactory,
  });
  await inventory.recordMovement(actor, {
    idempotencyKey: 'gate-stock-in',
    itemId: 'CRATE', warehouseId: 'shop', kind: 'PURCHASE_IN',
    quantity: quantityFromString('10', 'PCS'),
    documentDate: isoDate('2026-04-02'),
    source: { kind: 'purchase_invoice', id: 'p1', number: 'P1' },
    unitCost: rupees(50),
  });
  // Taking out more than there is, with an authorised reason: allowed, and recorded as such.
  await inventory.recordMovement(actor, {
    idempotencyKey: 'gate-stock-over',
    itemId: 'CRATE', warehouseId: 'shop', kind: 'SALE_OUT',
    quantity: quantityFromString('12', 'PCS'),
    documentDate: isoDate('2026-04-11'),
    source: { kind: 'sales_invoice', id: 's1', number: 'S1' },
    negativeOverride: { reason: 'The goods are on the van, the bill has not been entered yet.' },
  });

  const balance = await inventory.balance(actor, { itemId: 'CRATE', warehouseId: 'shop' });
  const movements = await inventoryStore.movements.list(COMPANY, { itemId: 'CRATE', warehouseId: 'shop' });
  const override = movements.map((movement) => movement.negativeOverride).filter((o) => o !== null).at(-1) ?? null;
  const stock: StockObservation[] = [
    {
      itemId: 'CRATE',
      warehouseId: 'shop',
      physical: balance.physical.scaled,
      overrideReason: override?.reason ?? null,
      overrideAllowedBy: override?.allowedBy ?? null,
    },
  ];

  const vouchers = (await store.read().vouchers.list(COMPANY, {})).map(
    (voucher): VoucherObservation => ({
      id: voucher.id,
      number: voucher.number,
      state: voucher.state,
      debits: voucher.lines.reduce((total, line) => total + line.debit.minor, 0n),
      credits: voucher.lines.reduce((total, line) => total + line.credit.minor, 0n),
    }),
  );
  const balances = await trialBalance(store.read(), COMPANY);


  return {
    vouchers,
    totalDebits: balances.totalDebit.minor,
    totalCredits: balances.totalCredit.minor,
    stock,
    retries,
    immutability,
  };
};

/**
 * Tax as the calculator actually worked it out, from the golden businesses' issued bills. These
 * are real priced invoices, so the split being checked is one the product produced rather than one
 * written into a fixture by hand.
 */
export const observeTax = async (): Promise<TaxObservation[]> => {
  const observations: TaxObservation[] = [];
  for (const { fixture } of loadAllFixtures()) {
    const actual = await replay(fixture);
    // Per line, deliberately. A document's total tax is re-summed from its components, so comparing
    // the two at that level compares a number with itself. A line's components and its own total
    // are produced independently, which is where a disagreement can actually exist.
    for (const line of actual.taxLines) {
      observations.push({
        documentNumber: `${line.documentNumber} line ${line.lineId}`,
        cgst: line.cgst,
        sgst: line.sgst,
        utgst: line.utgst,
        igst: line.igst,
        cess: line.cess,
        totalTax: line.totalTax,
      });
    }
  }
  return observations;
};

/** What the voice assistant treats as sure enough to act on without asking. */
export const observeMaterialConfidence = (): number => MATERIAL_CONFIDENCE;

/**
 * What the app does with something it was not sure it heard.
 *
 * A real session is started from a deliberately poor transcription — two readings of the same
 * sentence, "seventeen" and "seventy", neither confident — and we watch whether the quantity is
 * taken as decided or turned into a question. Whether a draft can be produced at all is the same
 * test from the other side: an unsure session must refuse.
 */
export const observeModelFields = (): ModelFieldObservation[] => {
  const party: ResolvedParty = { partyId: 'mehta', name: 'Mehta Stores', kind: 'CUSTOMER' } as ResolvedParty;
  const item: ResolvedItem = { itemId: 'APL', name: 'Apple box', baseUnit: 'BOX' } as ResolvedItem;
  const resolver: EntityResolver = {
    party(): Resolution<ResolvedParty> {
      return { status: 'resolved', record: party, score: 1 };
    },
    item(): Resolution<ResolvedItem> {
      return { status: 'resolved', record: item, score: 0.9 };
    },
  };

  const unsure = AssistantSession.fromSpeech(
    COMPANY,
    {
      alternatives: [
        { text: 'Mehta Stores ko sattar box apple aath sau per box becho', confidence: 0.62 },
        { text: 'Mehta Stores ko satrah box apple aath sau per box becho', confidence: 0.55 },
      ],
      audioRef: 'gates-rec-1',
    },
    resolver,
    isoDate('2026-08-29'),
    '2026-08-29T10:00:00.000Z',
  );

  const askedAboutQuantity = unsure.questions().some((question) => question.kind === 'QUANTITY');
  let draftRefused = false;
  try {
    unsure.toDraftInput();
  } catch {
    draftRefused = true;
  }

  return [
    {
      field: 'quantity',
      source: 'MODEL',
      confidence: 0.62,
      // Only counts as asked about if the app both raised the question and refused to go on.
      acceptedWithoutAsking: !(askedAboutQuantity && draftRefused),
    },
  ];
};

export const observeEverything = async (): Promise<Observations> => {
  const live = await observeLive();
  return {
    ...live,
    tax: await observeTax(),
    rules: observeRules(),
    golden: await observeGolden(),
    modelFields: observeModelFields(),
    materialConfidence: observeMaterialConfidence(),
  };
};

export { DomainError };
