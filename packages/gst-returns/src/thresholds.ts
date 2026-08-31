/**
 * Issue #30 [E30] — the one boundary on GSTR-1 that is a number rather than a calculation.
 *
 * Almost every table on GSTR-1 is decided by facts the product already holds: does the buyer have a
 * GST number, is the place of supply the seller's own state, is this a bill or a credit note. One
 * table is not. A sale to a consumer in another state goes into `B2CL` — reported bill by bill —
 * only when the bill is above a value fixed by notification, and into `B2CS` — a rate-wise total —
 * below it. That threshold has changed before and will change again.
 *
 * So it is treated exactly the way `@invoice/gst-calc` treats a tax rate, and for the same reason:
 *
 *  - it is **effective-dated**, so a return for an old month uses the figure that applied then;
 *  - it carries a **source reference and a review state**, so a figure nobody has checked against
 *    the notification cannot silently decide a filing;
 *  - a business may **declare its own**, attributed to the person who declared it, so the product
 *    stays usable while the register (#54) catches up.
 *
 * The entries below are `DRAFT`. In `production` mode the lookup refuses them, and every bill that
 * would have been decided by one becomes an exception saying so in words. That is the honest
 * behaviour: "we do not know where the line is this month" is a real answer, and quietly filing a
 * ₹1.4 lakh bill in the wrong table is not.
 */
import { compareDates, invalid, type IsoDate, type Money } from '@invoice/kernel';
import type { ReviewState } from '@invoice/rules-engine';

export interface B2clThreshold {
  /** A bill *above* this value is reported one by one. At exactly this value it is not. */
  readonly aboveValue: Money;
  readonly effectiveFrom: IsoDate;
  readonly effectiveTo: IsoDate | null;
  readonly sourceRef: string | null;
  readonly reviewState: ReviewState;
  /** What the entry says, in words, for the screen that shows why a bill landed where it did. */
  readonly description: string;
}

export type ThresholdLookup =
  | { readonly found: true; readonly threshold: B2clThreshold; readonly basis: 'REGISTER' }
  | { readonly found: true; readonly threshold: B2clThreshold; readonly basis: 'BUSINESS_DECLARED'; readonly declaredBy: string; readonly declaredBasis: string }
  | { readonly found: false; readonly reason: 'NO_ENTRY' | 'NOT_REVIEWED' };

/**
 * A threshold the business itself has set.
 *
 * Same bargain as a business-declared tax rate: the figure is used, whose figure it is gets
 * recorded, and no screen ever presents it as checked law.
 */
export interface DeclaredThreshold {
  readonly companyId: string;
  readonly aboveValue: Money;
  readonly effectiveFrom: IsoDate;
  readonly effectiveTo: IsoDate | null;
  readonly declaredBy: string;
  readonly declaredOn: IsoDate;
  /** Where the business says the figure came from — their accountant, the portal, a circular. */
  readonly basis: string;
}

export const validateDeclaredThreshold = (declared: DeclaredThreshold): void => {
  if (declared.declaredBy.trim() === '') {
    throw invalid('DECLARED_THRESHOLD_NO_AUTHOR', 'A threshold the business sets must record who set it.');
  }
  if (declared.basis.trim() === '') {
    throw invalid('DECLARED_THRESHOLD_NO_BASIS', 'A threshold the business sets must say where the figure came from.');
  }
  if (declared.aboveValue.minor <= 0n) {
    throw invalid('DECLARED_THRESHOLD_NOT_POSITIVE', 'A threshold has to be an amount above zero.');
  }
};

export interface DeclaredThresholdReader {
  find(companyId: string, on: IsoDate): DeclaredThreshold | undefined;
}

/**
 * **Fixture data, not a statement of Indian law.**
 *
 * Two entries are shipped because the boundary is known to have moved, and a product that holds
 * only today's figure gets last year's return wrong. Both are `DRAFT` with a placeholder source:
 * issue #54 replaces `sourceRef` with a register entry and `reviewState` with `APPROVED`, and
 * nothing else in this package has to change when it does.
 */
export const FIXTURE_B2CL_THRESHOLDS: readonly B2clThreshold[] = Object.freeze([
  {
    aboveValue: { currency: 'INR', minor: 25_000_000n },
    effectiveFrom: '2017-07-01' as IsoDate,
    effectiveTo: '2024-07-31' as IsoDate,
    sourceRef: 'pending:#54/gstr1-b2cl-threshold-250000',
    reviewState: 'DRAFT',
    description: 'Bills above ₹2,50,000 to a consumer in another state were reported one by one.',
  },
  {
    aboveValue: { currency: 'INR', minor: 10_000_000n },
    effectiveFrom: '2024-08-01' as IsoDate,
    effectiveTo: null,
    sourceRef: 'pending:#54/gstr1-b2cl-threshold-100000',
    reviewState: 'DRAFT',
    description: 'Bills above ₹1,00,000 to a consumer in another state are reported one by one.',
  },
]);

export class B2clThresholdTable {
  readonly #entries: readonly B2clThreshold[];
  readonly #declared: DeclaredThresholdReader | undefined;

  constructor(entries: readonly B2clThreshold[] = FIXTURE_B2CL_THRESHOLDS, declared?: DeclaredThresholdReader) {
    this.#entries = [...entries];
    this.#declared = declared;
  }

  /**
   * The threshold that applied on `on`.
   *
   * The business's own declaration is preferred over an unreviewed entry, because an attributed
   * figure a person stands behind is worth more than an unchecked one nobody does. It is *not*
   * preferred over a reviewed one: once the register carries the notification, the notification
   * wins, and a business that disagrees is disagreeing with the law rather than with us.
   */
  find(companyId: string, on: IsoDate, mode: 'production' | 'development'): ThresholdLookup {
    const effective = this.#entries.filter(
      (entry) =>
        compareDates(on, entry.effectiveFrom) >= 0 &&
        (entry.effectiveTo === null || compareDates(on, entry.effectiveTo) <= 0),
    );
    const reviewed = effective.find((entry) => entry.reviewState === 'APPROVED');
    if (reviewed !== undefined) return { found: true, threshold: reviewed, basis: 'REGISTER' };

    const declared = this.#declared?.find(companyId, on);
    if (declared !== undefined) {
      return {
        found: true,
        basis: 'BUSINESS_DECLARED',
        declaredBy: declared.declaredBy,
        declaredBasis: declared.basis,
        threshold: {
          aboveValue: declared.aboveValue,
          effectiveFrom: declared.effectiveFrom,
          effectiveTo: declared.effectiveTo,
          sourceRef: null,
          reviewState: 'DRAFT',
          description: `The business set this threshold itself on ${declared.declaredOn}.`,
        },
      };
    }

    if (effective.length === 0) return { found: false, reason: 'NO_ENTRY' };
    // In development the unreviewed figure is used so the whole workspace can be exercised; in
    // production it is refused, and the caller turns that refusal into a plain-words exception.
    if (mode === 'production') return { found: false, reason: 'NOT_REVIEWED' };
    const best = [...effective].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] as B2clThreshold;
    return { found: true, threshold: best, basis: 'REGISTER' };
  }

  entries(): readonly B2clThreshold[] {
    return this.#entries;
  }
}

/** An in-memory reader, so a business's own threshold can be exercised without a database. */
export class InMemoryDeclaredThresholds implements DeclaredThresholdReader {
  readonly #rows: DeclaredThreshold[] = [];

  declare(threshold: DeclaredThreshold): void {
    validateDeclaredThreshold(threshold);
    this.#rows.push(threshold);
  }

  find(companyId: string, on: IsoDate): DeclaredThreshold | undefined {
    return [...this.#rows]
      .filter(
        (row) =>
          row.companyId === companyId &&
          compareDates(on, row.effectiveFrom) >= 0 &&
          (row.effectiveTo === null || compareDates(on, row.effectiveTo) <= 0),
      )
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  }
}
