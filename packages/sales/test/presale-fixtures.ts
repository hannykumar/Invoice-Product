/** Issue #142 — Sharma Fruit Traders' sales counter: the till from issue #9, plus quotations and proformas. */
import { GstCalculator, FIXTURE_RATE_TABLE } from '@invoice/gst-calc';
import { InMemoryAuditPort, permissionPortFromActor, type ActorContext } from '@invoice/ledger';
import { RulesEngine, shippedRegistry } from '@invoice/rules-engine';
import { fixedClock } from '@invoice/kernel';
import { InMemoryPreSaleRepository } from '../src/presale-repository.ts';
import { PreSaleService } from '../src/presale-service.ts';
import type { PreSaleSeries } from '../src/presale-numbering.ts';
import type { PreSaleInput, PreSaleKind } from '../src/presale-model.ts';
import type { InventoryPort } from '../src/ports.ts';
import { ABC, ALL_PERMISSIONS, actorWith, inr, makeTill, on, qty, type Till } from './fixtures.ts';

export const PRESALE_PERMISSIONS_FOR_TESTS = [...ALL_PERMISSIONS, 'quotation.issue', 'quotation.cancel', 'proforma.issue', 'proforma.cancel'];

/** Every call the stock side received, so a test can prove there were none. */
export const recordingInventory = (): InventoryPort & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    async reserve(_actor, request) {
      calls.push(`reserve:${request.documentId}`);
      return { ok: true, reservationId: `mock:${request.documentId}` };
    },
    async release(_actor, documentId) {
      calls.push(`release:${documentId}`);
    },
    async issue(_actor, documentId) {
      calls.push(`issue:${documentId}`);
    },
    async returnToStock(_actor, documentId) {
      calls.push(`return:${documentId}`);
    },
  };
};

export interface SalesCounter {
  till: Till;
  presale: PreSaleService;
  repository: InMemoryPreSaleRepository;
  audit: InMemoryAuditPort;
  inventory: ReturnType<typeof recordingInventory>;
  actor: ActorContext;
}

let counter = 0;

export const makeSalesCounter = async (
  options: { series?: Partial<Record<PreSaleKind, PreSaleSeries>>; permissions?: readonly string[]; now?: string } = {},
): Promise<SalesCounter> => {
  const inventory = recordingInventory();
  const till = await makeTill({ inventory });
  const repository = new InMemoryPreSaleRepository();
  till.store.join(repository);
  const audit = new InMemoryAuditPort();
  counter += 1;
  let n = 0;
  const presale = new PreSaleService({
    store: till.store,
    calculator: new GstCalculator({
      masterData: till.masterData,
      rates: FIXTURE_RATE_TABLE,
      gstEngine: new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.gst', mode: 'development' }),
      mode: 'development',
    }),
    repository,
    invoices: till.repository,
    sales: till.service,
    permissions: permissionPortFromActor,
    audit,
    clock: fixedClock(options.now ?? '2026-05-12T11:04:00.000Z'),
    takenPrefixes: [till.service.policy.series.prefix, 'DC'],
    ...(options.series === undefined ? {} : { series: options.series }),
    idFactory: () => `p${counter}-${String((n += 1)).padStart(6, '0')}`,
  });
  return { till, presale, repository, audit, inventory, actor: actorWith(options.permissions ?? PRESALE_PERMISSIONS_FOR_TESTS) };
};

/** Forty plastic crates at ₹210 each, to ABC Traders in Delhi: ₹8,400 before tax. */
export const crateOffer = (overrides: Partial<PreSaleInput> = {}): PreSaleInput => ({
  partyId: ABC,
  customerType: 'B2B',
  supplyKind: 'GOODS',
  documentDate: on('2026-05-10'),
  lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: qty('40', 'PCS'), unitPrice: inr(210), priceBasis: 'EXCLUSIVE' }],
  ...overrides,
});
