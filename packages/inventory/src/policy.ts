/**
 * Issue #12 [E12] — what a business decides about its own stock.
 *
 * Whether stock may go below nothing is not one of those decisions: it never may (Samay, 28 Sep
 * 2026, issue #262). A sale of goods the godown does not hold is stopped, and the way through is to
 * record the purchase bill first.
 */
export interface InventoryPolicy {
  /** How long an unfinished bill may hold goods before they go back on the shelf. */
  readonly reservationMinutes: number;
  /**
   * How stock is valued. Only weighted average is implemented; asking for anything else is
   * refused rather than silently treated as weighted average.
   */
  readonly valuationMethod: 'WEIGHTED_AVERAGE';
}

export const DEFAULT_INVENTORY_POLICY: InventoryPolicy = {
  reservationMinutes: 120,
  valuationMethod: 'WEIGHTED_AVERAGE',
};
