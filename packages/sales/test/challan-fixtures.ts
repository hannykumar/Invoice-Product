/** Issue #141 — Sharma Fruit Traders' dispatch desk: the till from issue #9, plus challans. */
import { GstCalculator, FIXTURE_RATE_TABLE } from '@invoice/gst-calc';
import { InMemoryAuditPort, permissionPortFromActor, type ActorContext } from '@invoice/ledger';
import { RulesEngine, shippedRegistry } from '@invoice/rules-engine';
import { fixedClock } from '@invoice/kernel';
import { InMemoryChallanRepository } from '../src/challan-repository.ts';
import { ChallanService } from '../src/challan-service.ts';
import type { ChallanSeries } from '../src/challan-numbering.ts';
import type { ChallanInput } from '../src/challan-model.ts';
import { ABC, ALL_PERMISSIONS, actorWith, inr, makeTill, on, qty, type Till } from './fixtures.ts';

export const CHALLAN_PERMISSIONS_FOR_TESTS = [...ALL_PERMISSIONS, 'challan.issue', 'challan.cancel'];

export interface DispatchDesk {
  till: Till;
  challans: ChallanService;
  repository: InMemoryChallanRepository;
  audit: InMemoryAuditPort;
  actor: ActorContext;
}

let counter = 0;

export const makeDispatchDesk = async (options: { series?: ChallanSeries; permissions?: readonly string[] } = {}): Promise<DispatchDesk> => {
  const till = await makeTill();
  const repository = new InMemoryChallanRepository();
  till.store.join(repository);
  const audit = new InMemoryAuditPort();
  counter += 1;
  let n = 0;
  const challans = new ChallanService({
    store: till.store,
    calculator: new GstCalculator({
      masterData: till.masterData,
      rates: FIXTURE_RATE_TABLE,
      gstEngine: new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.gst', mode: 'development' }),
      mode: 'development',
    }),
    masterData: till.masterData,
    repository,
    invoices: till.repository,
    permissions: permissionPortFromActor,
    audit,
    clock: fixedClock('2026-05-12T11:04:00.000Z'),
    invoicePrefix: till.service.policy.series.prefix,
    ...(options.series === undefined ? {} : { series: options.series }),
    idFactory: () => `c${counter}-${String((n += 1)).padStart(6, '0')}`,
  });
  return { till, challans, repository, audit, actor: actorWith(options.permissions ?? CHALLAN_PERMISSIONS_FOR_TESTS) };
};

/** Forty plastic crates at ₹210 each: ₹8,400 of goods. */
export const crateChallan = (overrides: Partial<ChallanInput> = {}): ChallanInput => ({
  partyId: ABC,
  reason: 'JOB_WORK',
  documentDate: on('2026-05-10'),
  lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: qty('40', 'PCS'), unitPrice: inr(210) }],
  ...overrides,
});
