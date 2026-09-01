/**
 * Issue #59 [E59] — what this module needs from the modules around it.
 *
 * Narrow on purpose. The register belongs to #5 and the sources behind it belong to #54; this
 * module reads them and never writes law. The only write it makes is the one a person explicitly
 * approved, and it goes back through #5's own register so that a learned default is the same kind
 * of record as one somebody typed in.
 */
import type { Id, IsoDate, TaxDefault } from '../../masters/src/types.ts';
import type { ApprovedRate, ProposedClassification } from './types.ts';

/** What a line looks like to this module: what it is, and what the paper says about the tax. */
export interface RateLine {
  /** Where on the document, for the finding's field path. Zero-based. */
  readonly index: number;
  readonly description: string;
  /** The item in the master list, when the line has been matched to one. */
  readonly itemId?: Id;
  /** The HSN or SAC printed on the document, or read from it. */
  readonly hsnSac?: string;
  /** The rate printed on the document, in basis points. Absent when it could not be read. */
  readonly printedRateBasisPoints?: number;
  /** A model's reading of what these goods are. Never a rate. */
  readonly proposed?: ProposedClassification;
}

/**
 * The tax-default register from #5, as this module reads it.
 *
 * `candidates` returns everything that matches rather than the first thing that does, because the
 * difference between one entry and three that disagree is the difference between a suggestion and
 * a question.
 */
export interface TaxDefaultRegistryPort {
  /**
   * Entries with their effective dates.
   *
   * The date is not decoration: it is half of what makes a rate defensible, and it lives on the
   * register's version rather than on the row, so it has to travel with it.
   */
  candidates(
    companyId: Id,
    lookup: { readonly itemId?: Id; readonly hsnSac?: string },
    asOf: IsoDate,
  ): Promise<readonly { readonly entry: TaxDefault; readonly effectiveFrom: IsoDate }[]>;
  /** The item's own record, for its name and its HSN. Null when the item is not in the list. */
  item(companyId: Id, itemId: Id, asOf: IsoDate): Promise<{ readonly name: string; readonly hsnSac: string | null } | null>;
}

/** Writing back the one thing a person approved. */
export interface RateLearningPort {
  remember(
    companyId: Id,
    input: {
      readonly itemId: Id;
      readonly gstRateBasisPoints: number;
      readonly cessRateBasisPoints?: number;
      readonly cessPerUnitPaise?: bigint;
      readonly reverseCharge: boolean;
      readonly source: string;
      readonly effectiveFrom: IsoDate;
      readonly idempotencyKey: string;
    },
  ): Promise<ApprovedRate>;
}

/** #6's audit trail, as much of it as this module needs. */
export interface RateAuditPort {
  record(event: {
    readonly companyId: Id;
    readonly actorId: Id;
    readonly at: string;
    readonly action: string;
    readonly subjectId: string;
    readonly summary: string;
    readonly details?: Readonly<Record<string, string>>;
  }): Promise<void>;
}
