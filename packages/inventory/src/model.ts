/**
 * Issue #12 [E12] — stock, as movements rather than as a number.
 *
 * There is no "quantity on hand" column anywhere in this module. Stock is the sum of every
 * movement, exactly as a ledger balance is the sum of every journal line, and for the same reason:
 * a stored count can be edited, and once it has been, nothing in the system disagrees with it.
 *
 * Quantities use GPT 3's `Quantity` from `packages/masters` — integer micro-units with a unit code
 * — because unit conversion is theirs and stock is the thing that must never be converted
 * approximately.
 */
import type { CompanyId, IsoDate, Money, UserId } from '@invoice/kernel';
import type { Quantity } from '../../masters/src/units.ts';

/** Why stock moved. The kind is never inferred from the sign; both are recorded. */
export type MovementKind =
  | 'OPENING'
  | 'PURCHASE_IN'
  | 'SALE_OUT'
  | 'SALES_RETURN_IN'
  | 'PURCHASE_RETURN_OUT'
  | 'TRANSFER_OUT'
  | 'TRANSFER_IN'
  | 'ADJUSTMENT_IN'
  | 'ADJUSTMENT_OUT'
  | 'REVERSAL_IN'
  | 'REVERSAL_OUT';

export type Direction = 'IN' | 'OUT';

export const DIRECTION_OF: Record<MovementKind, Direction> = {
  OPENING: 'IN',
  PURCHASE_IN: 'IN',
  SALE_OUT: 'OUT',
  SALES_RETURN_IN: 'IN',
  PURCHASE_RETURN_OUT: 'OUT',
  TRANSFER_OUT: 'OUT',
  TRANSFER_IN: 'IN',
  ADJUSTMENT_IN: 'IN',
  ADJUSTMENT_OUT: 'OUT',
  REVERSAL_IN: 'IN',
  REVERSAL_OUT: 'OUT',
};

export interface SourceDocument {
  readonly kind: string;
  readonly id: string;
  readonly number: string | null;
}

export interface StockMovement {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly itemId: string;
  readonly warehouseId: string;
  /** A tracked lot, when the item is batched. */
  readonly batchId: string | null;
  /** Individually tracked units, when the item is serialised. */
  readonly serialNumbers: readonly string[];
  readonly kind: MovementKind;
  readonly direction: Direction;
  /** Always in the item's base unit. What the person typed is kept in `enteredQuantity`. */
  readonly quantity: Quantity;
  /** What was actually typed, before conversion, so a bill can be explained later. */
  readonly enteredQuantity: Quantity;
  /** Cost of the goods moving in. Absent on an OUT movement, which is valued by the method. */
  readonly unitCost: Money | null;
  readonly documentDate: IsoDate;
  readonly source: SourceDocument;
  readonly postedBy: UserId;
  readonly postedAt: string;
  readonly idempotencyKey: string;
  /** Set on a movement that undoes another. Nothing is ever deleted. */
  readonly reversesMovementId: string | null;
  readonly reason: string | null;
  /** Recorded when an authorised person allowed stock to go below zero. */
  readonly negativeOverride: { readonly reason: string; readonly allowedBy: UserId } | null;
}

/** See docs/product/spec/states.json, machine `stock_reservation`. */
export type ReservationState = 'HELD' | 'CONSUMED' | 'RELEASED' | 'EXPIRED';

export interface Reservation {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly documentId: string;
  readonly lineId: string;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly batchId: string | null;
  readonly quantity: Quantity;
  readonly state: ReservationState;
  readonly createdBy: UserId;
  readonly createdAt: string;
  /** A held reservation expires so an abandoned draft cannot lock goods for ever. */
  readonly expiresAt: string;
  readonly settledAt: string | null;
}

export interface StockKey {
  readonly itemId: string;
  readonly warehouseId: string;
  readonly batchId?: string | null;
}

export interface StockBalance {
  readonly itemId: string;
  readonly warehouseId: string;
  /** The batch this figure is for, or `null` when it is not about one batch. */
  readonly batchId: string | null;
  /**
   * True when no batch filter was applied, so this is every batch added together.
   *
   * It exists because `batchId: null` alone cannot tell "all the stock" from "the stock that is in
   * no batch", and answering the wrong one of those with a confident zero is how a batch-tracked
   * item reads as out of stock (issue #86).
   */
  readonly coversAllBatches: boolean;
  readonly unitCode: string;
  /** What is actually in the godown, from posted movements only. */
  readonly physical: Quantity;
  /** Held by unfinished bills. */
  readonly reserved: Quantity;
  /** What can still be sold: physical minus reserved. */
  readonly available: Quantity;
}

export const INVENTORY_PERMISSIONS = {
  move: 'inventory.move',
  adjust: 'inventory.adjust',
  transfer: 'inventory.transfer',
  overrideNegative: 'inventory.override_negative',
} as const;
