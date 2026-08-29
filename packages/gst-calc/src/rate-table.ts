/**
 * Issue #25 [E25] — effective-dated tax data with a source and a review state.
 *
 * A rate is not a constant. It applies to a classification, in a period, and it comes from
 * somewhere. Every entry here carries its effective range, the identifier of the notification it
 * came from, and whether that source has been reviewed.
 *
 * **Every entry shipped today is `DRAFT` with a placeholder source.** In `production` mode the
 * lookup refuses a rate that has not been reviewed, so a real business is told "we cannot work
 * out the GST yet" instead of being given a plausible number. Issue #54 supplies the sources; when
 * it does, the review state changes and nothing else has to.
 */
import { compareDates, type IsoDate } from '@invoice/kernel';
import type { ReviewState } from '@invoice/rules-engine';

export interface CessRule {
  /** Percentage of the taxable value, times 100. 12% is 1200n. */
  readonly percentTimes100?: bigint;
  /** A fixed amount of paise per base unit. */
  readonly perUnitPaise?: bigint;
  /** When both are set, the larger of the two applies. */
  readonly takeHigher?: boolean;
}

export interface RateEntry {
  /** HSN for goods, SAC for services. Matched by longest prefix, so "0808" covers "08081000". */
  readonly code: string;
  readonly kind: 'GOODS' | 'SERVICES';
  readonly description: string;
  /** The full GST rate times 100. 18% is 1800n. Split in half for CGST and SGST or UTGST. */
  readonly ratePercentTimes100: bigint;
  readonly cess?: CessRule;
  readonly effectiveFrom: IsoDate;
  readonly effectiveTo: IsoDate | null;
  readonly sourceRef: string | null;
  readonly reviewState: ReviewState;
}

export type RateLookup =
  | { readonly found: true; readonly entry: RateEntry }
  | { readonly found: false; readonly reason: 'NO_CODE' | 'NO_ENTRY' | 'NOT_REVIEWED' };

export class RateTable {
  readonly #entries: RateEntry[];

  constructor(entries: readonly RateEntry[]) {
    this.#entries = [...entries];
  }

  /**
   * Longest-prefix match among entries effective on `date`. In `production` mode an entry that has
   * not been reviewed is reported as `NOT_REVIEWED` rather than used.
   */
  find(
    code: string | null,
    kind: 'GOODS' | 'SERVICES',
    date: IsoDate,
    mode: 'production' | 'development',
  ): RateLookup {
    if (code === null || code.trim() === '') return { found: false, reason: 'NO_CODE' };
    const effective = this.#entries.filter(
      (e) =>
        e.kind === kind &&
        code.startsWith(e.code) &&
        compareDates(date, e.effectiveFrom) >= 0 &&
        (e.effectiveTo === null || compareDates(date, e.effectiveTo) <= 0),
    );
    if (effective.length === 0) return { found: false, reason: 'NO_ENTRY' };

    // Longest code wins; ties broken by the later effective date, then by code, so the choice is
    // never dependent on the order entries happened to be declared in.
    const ranked = [...effective].sort((a, b) => {
      if (a.code.length !== b.code.length) return b.code.length - a.code.length;
      if (a.effectiveFrom !== b.effectiveFrom) return b.effectiveFrom.localeCompare(a.effectiveFrom);
      return a.code.localeCompare(b.code);
    });
    const best = ranked[0] as RateEntry;
    if (mode === 'production' && best.reviewState !== 'APPROVED') return { found: false, reason: 'NOT_REVIEWED' };
    if (best.reviewState === 'WITHDRAWN' || best.reviewState === 'SUPERSEDED') {
      return { found: false, reason: 'NOT_REVIEWED' };
    }
    return { found: true, entry: best };
  }

  entries(): readonly RateEntry[] {
    return this.#entries;
  }
}

const draft = (
  code: string,
  kind: 'GOODS' | 'SERVICES',
  description: string,
  ratePercentTimes100: bigint,
  effectiveFrom: IsoDate,
  effectiveTo: IsoDate | null = null,
  cess?: CessRule,
): RateEntry => ({
  code,
  kind,
  description,
  ratePercentTimes100,
  effectiveFrom,
  effectiveTo,
  sourceRef: `pending:#54/rate-${code}`,
  reviewState: 'DRAFT',
  ...(cess === undefined ? {} : { cess }),
});

/**
 * **Fixture rate data.** These codes and percentages exist to exercise the arithmetic, the
 * effective-date boundaries and the cess paths. They are not a statement of Indian law, no module
 * may copy a number out of this file, and production mode refuses every one of them until #54
 * records a source and a reviewer.
 */
export const FIXTURE_RATE_TABLE = new RateTable([
  draft('0808', 'GOODS', 'Fresh apples and pears', 0n, '2026-04-01' as IsoDate),
  draft('2009', 'GOODS', 'Packaged fruit juice', 1200n, '2026-04-01' as IsoDate),
  draft('3923', 'GOODS', 'Plastic crates and packing articles', 1800n, '2026-04-01' as IsoDate, '2026-06-30' as IsoDate),
  // The same code at a different rate from 1 July, so an effective-date boundary can be proved.
  draft('3923', 'GOODS', 'Plastic crates and packing articles', 1200n, '2026-07-01' as IsoDate),
  draft('2202', 'GOODS', 'Aerated drinks', 2800n, '2026-04-01' as IsoDate, null, {
    percentTimes100: 1200n,
  }),
  draft('2402', 'GOODS', 'Cigars and similar', 2800n, '2026-04-01' as IsoDate, null, {
    percentTimes100: 500n,
    perUnitPaise: 400n,
    takeHigher: true,
  }),
  draft('9965', 'SERVICES', 'Goods transport by road', 500n, '2026-04-01' as IsoDate),
  draft('9987', 'SERVICES', 'Repair and maintenance', 1800n, '2026-04-01' as IsoDate),
]);
