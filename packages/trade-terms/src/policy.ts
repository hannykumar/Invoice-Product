/**
 * Issue #11 [E11] — the choices a business makes about its own selling.
 *
 * These are configuration, not code. A threshold living in an `if` is a threshold nobody can
 * change without a deployment, and every one of these differs between a wholesaler and a shop.
 */

export interface TradeTermsPolicy {
  /**
   * What going over a credit limit does. `WARN` lets an ordinary till carry on and tells the
   * person; `BLOCK` stops the bill until somebody with permission overrides it.
   */
  readonly overLimit: 'WARN' | 'BLOCK';
  /**
   * A customer whose oldest unpaid bill is later than this is blocked whatever their limit says,
   * because a limit means little when the last bill was never paid. `null` turns it off.
   */
  readonly blockWhenOverdueByDays: number | null;
  /** How much a person may take off without anyone approving it. 1000 is 10%. */
  readonly discountWithoutApprovalBasisPoints: number;
  /** Whether to say so when a line would sell below what the goods cost. */
  readonly warnBelowCost: boolean;
  /**
   * Whether a credit warning is enough to need approval before the bill can be issued. A shop that
   * only wants to be told sets this false; one that wants a second pair of eyes sets it true.
   */
  readonly warnNeedsApproval: boolean;
}

/**
 * Cautious, but not obstructive: tell the person, let them carry on, and keep the bigger decisions
 * with someone who is allowed to make them.
 */
export const DEFAULT_TRADE_TERMS_POLICY: TradeTermsPolicy = {
  overLimit: 'WARN',
  blockWhenOverdueByDays: null,
  discountWithoutApprovalBasisPoints: 1000,
  warnBelowCost: true,
  warnNeedsApproval: false,
};
