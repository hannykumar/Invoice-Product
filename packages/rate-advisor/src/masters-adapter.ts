/**
 * Issue #59 [E59] — reading and writing #5's register through its own service.
 *
 * The whole module is written against the ports so that it can be tested without a master-data
 * service and so that a different register — a migration, a fixture, a future replacement — can be
 * put behind it. This is the real one, and it is thin on purpose: it translates, it does not decide.
 *
 * Learning writes back through `setTaxDefault`, which means an approved rate is exactly the same
 * kind of record as one somebody typed into the master screens: same versioning, same audit, same
 * effective dating. A separate "learned rates" store would have been easier and would have created
 * a second register that the first one does not know about.
 */
import { MasterDataError } from '../../masters/src/masters.ts';
import type { MasterDataService } from '../../masters/src/masters.ts';
import type { RequestContext } from '../../platform/src/types.ts';
import type { Id, IsoDate, TaxDefault } from '../../masters/src/types.ts';
import type { RateLearningPort, TaxDefaultRegistryPort } from './ports.ts';
import type { ApprovedRate } from './types.ts';
import { percent } from './resolve.ts';

/**
 * The register, read as of a date.
 *
 * `contextFor` exists because #5's service takes a full `RequestContext` — company, actor,
 * permissions — and this module only ever knows a company id at read time. The caller supplies the
 * context it already has rather than this adapter inventing one with permissions nobody granted.
 */
export const mastersRegistry = (
  masters: MasterDataService,
  contextFor: (companyId: Id) => RequestContext,
): TaxDefaultRegistryPort => ({
  async candidates(companyId, lookup, asOf) {
    const versions = masters.taxDefaultCandidates(contextFor(companyId), lookup, asOf);
    return versions.map((version) => ({ entry: version.data, effectiveFrom: version.effectiveFrom }));
  },
  async item(companyId, itemId, asOf) {
    try {
      const found = masters.item(contextFor(companyId), itemId, asOf);
      return { name: found.name, hsnSac: found.hsnSac ?? null };
    } catch (error) {
      // An item that is not in the list is the ordinary case for a freshly photographed bill, not
      // an error. Anything else — a tenant violation, say — is still thrown.
      if (error instanceof MasterDataError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  },
});

export const mastersLearning = (
  masters: MasterDataService,
  contextFor: (companyId: Id) => RequestContext,
): RateLearningPort => ({
  async remember(companyId, input): Promise<ApprovedRate> {
    const written = masters.setTaxDefault(
      contextFor(companyId),
      {
        itemId: input.itemId,
        gstRateBasisPoints: input.gstRateBasisPoints,
        ...(input.cessRateBasisPoints === undefined ? {} : { cessRateBasisPoints: input.cessRateBasisPoints }),
        ...(input.cessPerUnitPaise === undefined ? {} : { cessPerUnitPaise: input.cessPerUnitPaise }),
        reverseCharge: input.reverseCharge,
        source: input.source,
      } as Omit<TaxDefault, 'id' | 'companyId'>,
      { idempotencyKey: input.idempotencyKey, effectiveFrom: input.effectiveFrom },
    );
    return {
      itemId: input.itemId,
      gstRateBasisPoints: written.record.gstRateBasisPoints,
      effectiveFrom: written.version.effectiveFrom as IsoDate,
      source: written.record.source,
      learned: true,
      message: {
        'en-IN':
          `${percent(written.record.gstRateBasisPoints)} saved for this item from ${written.version.effectiveFrom}. `
          + 'The next bill for it will use this without asking.',
        'hi-IN':
          `${percent(written.record.gstRateBasisPoints)} is item ke liye ${written.version.effectiveFrom} se save ho gaya. `
          + 'Agle bill mein yeh apne aap lag jaayega.',
      },
    };
  },
});
