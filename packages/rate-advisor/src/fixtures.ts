/**
 * Issue #59 [E59] — a business with a rate register, for the tests and the demo.
 *
 * Three goods, chosen because they are the three cases that actually happen:
 *
 *   * **TMT steel** — an ordinary item with an item-level default. The easy case.
 *   * **Cement** — an HSN-level default and no item entry, and the goods in the issue's own
 *     cross-check example.
 *   * **Aerated drinks** — 28% plus 12% cess, because a suggestion that mentions the rate and
 *     forgets the cess under-bills, and nothing catches that until a notice arrives.
 *
 * Every rate here is a **synthetic business declaration**, not a legal source. The compliance
 * register (#54) is the only thing in this product allowed to state what the law says, and a
 * fixture claiming otherwise would be the exact thing this issue's non-goals forbid.
 */
import { AccessControl, AuditLog, PlatformCommandService } from '../../platform/src/index.ts';
import { MASTER_APPROVAL_POLICIES, MasterDataService } from '../../masters/src/masters.ts';
import { mastersLearning, mastersRegistry } from './masters-adapter.ts';
import { RateAdvisorService } from './service.ts';
import type { Id } from '../../masters/src/types.ts';
import type { RateAuditPort } from './ports.ts';

export const COMPANY: Id = 'rate-advisor-company';
export const OWNER: Id = 'rate-advisor-owner';

/** The wording every fixture rate carries, so no test can mistake one for the law. */
export const SYNTHETIC_BASIS = '(synthetic test declaration, not a legal source)';

export class InMemoryRateAudit implements RateAuditPort {
  readonly events: Parameters<RateAuditPort['record']>[0][] = [];
  async record(event: Parameters<RateAuditPort['record']>[0]): Promise<void> {
    this.events.push(event);
  }
}

/**
 * A shop with items, an HSN default and item defaults, all effective-dated.
 *
 * The cement rate changes on 2026-07-01 — 18% before, 28% from — which is what makes the
 * back-dated-document test mean something. A bill from June must still be answered with 18%.
 */
export const makeShop = (options: { readonly now?: string } = {}) => {
  const access = new AccessControl();
  access.grant({
    companyId: COMPANY, userId: OWNER, branchIds: new Set(['main']), active: true,
    permissions: new Set(['approval.decide', 'access.review']),
  });
  const audit = new AuditLog();
  const masters = new MasterDataService(new PlatformCommandService(audit, MASTER_APPROVAL_POLICIES), audit);
  const context = access.context(COMPANY, 'main', OWNER, 'rate-advisor-session');
  let counter = 0;
  const key = (label: string) => `rate-${label}-${(counter += 1)}`;

  const steel = masters.createItem(context, {
    code: 'TMT12', name: 'TMT Steel Bar 12mm', kind: 'goods', hsnSac: '72142090', baseUnit: 'KGS',
  } as never, { idempotencyKey: key('item-steel'), effectiveFrom: '2026-04-01' }).record.id;

  const cement = masters.createItem(context, {
    code: 'CEM', name: 'Portland Cement 50kg', kind: 'goods', hsnSac: '25232930', baseUnit: 'BAG',
  } as never, { idempotencyKey: key('item-cement'), effectiveFrom: '2026-04-01' }).record.id;

  const cola = masters.createItem(context, {
    code: 'COLA', name: 'Aerated drink 300ml', kind: 'goods', hsnSac: '22021010', baseUnit: 'PCS',
  } as never, { idempotencyKey: key('item-cola'), effectiveFrom: '2026-04-01' }).record.id;

  // An item with nothing said about its tax anywhere. The "we have to ask" case.
  const mystery = masters.createItem(context, {
    code: 'MYST', name: 'Assorted hardware', kind: 'goods', hsnSac: '82055900', baseUnit: 'NOS',
  } as never, { idempotencyKey: key('item-mystery'), effectiveFrom: '2026-04-01' }).record.id;

  masters.setTaxDefault(context, {
    itemId: steel, gstRateBasisPoints: 1800, reverseCharge: false,
    source: `Notification 1/2017-CTR Schedule III entry 224 ${SYNTHETIC_BASIS}`,
  } as never, { idempotencyKey: key('tax-steel'), effectiveFrom: '2026-04-01' });

  // Cement is set at the HSN, not the item, which is how a business that sells three brands of the
  // same thing usually sets it up.
  masters.setTaxDefault(context, {
    hsnSac: '25232930', gstRateBasisPoints: 1800, reverseCharge: false,
    source: `Notification 1/2017-CTR Schedule III ${SYNTHETIC_BASIS}`,
  } as never, { idempotencyKey: key('tax-cement-old'), effectiveFrom: '2026-04-01' });

  masters.setTaxDefault(context, {
    hsnSac: '22021010', gstRateBasisPoints: 2800, cessRateBasisPoints: 1200, reverseCharge: false,
    source: `Notification 1/2017-CTR Schedule IV with compensation cess ${SYNTHETIC_BASIS}`,
  } as never, { idempotencyKey: key('tax-cola'), effectiveFrom: '2026-04-01' });

  const rateAudit = new InMemoryRateAudit();
  const contextFor = () => context;
  const advisor = new RateAdvisorService({
    registry: mastersRegistry(masters, contextFor),
    learning: mastersLearning(masters, contextFor),
    audit: rateAudit,
    clock: () => new Date(options.now ?? '2026-08-29T10:00:00.000Z'),
  });

  return { masters, context, advisor, audit, rateAudit, key, items: { steel, cement, cola, mystery } };
};
