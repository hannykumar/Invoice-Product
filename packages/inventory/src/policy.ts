/**
 * Issue #12 [E12] — what a business decides about its own stock.
 *
 * The default is to block. A shop that sells what it does not have discovers it at the worst
 * possible moment, and the product's job is to make that discoverable at the counter instead.
 * A business that genuinely needs to sell ahead of paperwork can switch to warn-with-override,
 * and every override is then named and reasoned.
 */
export type NegativeStockPolicy = 'BLOCK' | 'WARN_WITH_OVERRIDE';

export interface InventoryPolicy {
  readonly negativeStock: NegativeStockPolicy;
  /** How long an unfinished bill may hold goods before they go back on the shelf. */
  readonly reservationMinutes: number;
  /**
   * How stock is valued. Only weighted average is implemented; asking for anything else is
   * refused rather than silently treated as weighted average.
   */
  readonly valuationMethod: 'WEIGHTED_AVERAGE';
}

export const DEFAULT_INVENTORY_POLICY: InventoryPolicy = {
  negativeStock: 'BLOCK',
  reservationMinutes: 120,
  valuationMethod: 'WEIGHTED_AVERAGE',
};
