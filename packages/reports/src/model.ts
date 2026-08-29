/**
 * Issue #35 [E35] — what a report is made of.
 *
 * The shape that matters is `Figure`: an amount that carries the records it was folded from.
 * Nothing in this product stores a balance, so those records are already in hand at the moment the
 * total is worked out. Carrying them costs almost nothing and is the difference between a number
 * an owner is asked to believe and a number they can check.
 */
import { formatDate, isZero, subtract, sum, zero, type BranchId, type CompanyId, type IsoDate, type Money, type PartyId } from '@invoice/kernel';

/**
 * Which records a report is about. There is no default period and no company argument: the company
 * comes from the authenticated actor, so one business's figures cannot be asked for from another's
 * session.
 */
export interface ReportFilter {
  readonly from: IsoDate;
  readonly to: IsoDate;
  /**
   * `undefined` means every branch. `null` means only entries that carry no branch — the
   * accountant's own journal entries. They are different questions and the difference is
   * load-bearing, so it is not collapsed into one optional field.
   */
  readonly branchId?: BranchId | null;
}

/** One record behind a total. This is the drill-down. */
export interface Contribution {
  /** "voucher", "sales_invoice", "purchase_invoice", "stock_movement", "payment". */
  readonly sourceKind: string;
  readonly sourceId: string;
  /** The number a person would recognise, when the record has one. */
  readonly sourceNumber: string | null;
  readonly date: IsoDate;
  readonly branchId: BranchId | null;
  readonly partyId: PartyId | null;
  readonly description: string;
  readonly amount: Money;
}

export interface Figure {
  readonly amount: Money;
  readonly contributors: readonly Contribution[];
}

/** The only way to build a figure, so an amount and its records cannot drift apart. */
export const figureOf = (contributors: readonly Contribution[]): Figure => ({
  amount: sum(contributors.map((c) => c.amount)),
  contributors,
});

export const emptyFigure = (): Figure => ({ amount: zero('INR'), contributors: [] });

/** Adds figures without losing anyone's records. */
export const addFigures = (figures: readonly Figure[]): Figure => figureOf(figures.flatMap((f) => f.contributors));

/**
 * A figure minus another, keeping both sets of records. The subtrahend's rows are kept with their
 * sign flipped, so the result still folds to its own amount and still names every record.
 */
export const subtractFigures = (left: Figure, right: Figure): Figure =>
  figureOf([
    ...left.contributors,
    ...right.contributors.map((c) => ({ ...c, amount: { currency: c.amount.currency, minor: -c.amount.minor } })),
  ]);

/** True when the amount really is the sum of the rows. Asserted over every figure in the tests. */
export const reconciles = (figure: Figure): boolean =>
  isZero(subtract(figure.amount, sum(figure.contributors.map((c) => c.amount))));

export type ReportId =
  | 'trial_balance'
  | 'profit_and_loss'
  | 'balance_sheet'
  | 'sales_register'
  | 'purchase_register'
  | 'stock'
  | 'ageing'
  | 'gst_summary'
  | 'exceptions';

export interface Bilingual {
  readonly 'en-IN': string;
  readonly 'hi-IN': string;
}

export interface ReportHeader {
  readonly reportId: ReportId;
  readonly title: Bilingual;
  readonly companyId: CompanyId;
  readonly filter: ReportFilter;
  /** The instant the figures were taken. Two reports of the same period differ if this differs. */
  readonly asAt: string;
  /** Deterministic in the report id, the filter and `asAt`. Same question, same answer, same id. */
  readonly snapshotId: string;
  /** What the reader has to know to read the page honestly, in plain words. */
  readonly notes: readonly Bilingual[];
}

export interface Report<TBody> {
  readonly header: ReportHeader;
  readonly body: TBody;
}

export const REPORT_PERMISSIONS = {
  financial: 'reports.view.financial',
  sales: 'reports.view.sales',
  purchase: 'reports.view.purchase',
  stock: 'reports.view.stock',
  dues: 'reports.view.dues',
  gst: 'reports.view.gst',
  exceptions: 'reports.view.exceptions',
  export: 'reports.export',
} as const;

/**
 * A stable id for one asking of one report.
 *
 * Deliberately not a hash: an owner who exports the same period twice should be able to see that
 * the two files are the same document, and a readable id makes that obvious without a tool.
 */
export const snapshotIdOf = (reportId: ReportId, filter: ReportFilter, asAt: string): string => {
  const branch = filter.branchId === undefined ? 'all' : filter.branchId === null ? 'none' : filter.branchId;
  return `${reportId}:${filter.from}:${filter.to}:${branch}:${asAt}`;
};

export const describeFilter = (filter: ReportFilter, branchName: string | null): Bilingual => {
  const where =
    filter.branchId === undefined
      ? { en: 'the whole business', hi: 'poore business' }
      : filter.branchId === null
        ? { en: 'entries not tied to any shop', hi: 'kisi shop se na jude entries' }
        : { en: branchName ?? 'one shop', hi: branchName ?? 'ek shop' };
  return {
    'en-IN': `${formatDate(filter.from)} to ${formatDate(filter.to)}, for ${where.en}`,
    'hi-IN': `${formatDate(filter.from)} se ${formatDate(filter.to)} tak, ${where.hi} ke liye`,
  };
};
