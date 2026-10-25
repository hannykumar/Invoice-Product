/** Issue #12 [E12] — storage and the slice of master data (#5) stock needs. */
import type { CompanyId, IsoDate, Money } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import type { UnitRegistry } from '../../masters/src/units.ts';
import type { Page } from '@invoice/sales';
import type { Reservation, StockMovement } from './model.ts';

/** What #5 knows about an item that stock cares about. */
export interface StockItem {
  readonly itemId: string;
  readonly name: string;
  readonly baseUnit: string;
  readonly tracksBatches: boolean;
  readonly tracksSerials: boolean;
}

export interface Warehouse {
  readonly warehouseId: string;
  readonly name: string;
  /**
   * Issue #292 — `false` for a place that holds goods which must not be sold, such as damaged
   * goods a customer sent back. Its stock is counted and valued, but none of it is free to sell.
   * Left out, the place is an ordinary godown.
   */
  readonly sellable?: boolean;
}

export interface StockMasterData {
  item(companyId: CompanyId, itemId: string): StockItem | undefined;
  warehouse(companyId: CompanyId, warehouseId: string): Warehouse | undefined;
  /** GPT 3's registry. Item-specific conversions (1 BOX = 10 KG) live in it. */
  units(companyId: CompanyId): UnitRegistry;
}

export interface MovementFilter {
  readonly itemId?: string;
  readonly warehouseId?: string;
  readonly batchId?: string | null;
  readonly from?: IsoDate;
  readonly to?: IsoDate;
}

export interface MovementRepository {
  insert(movement: StockMovement): Promise<void>;
  findByIdempotencyKey(companyId: CompanyId, key: string): Promise<StockMovement | null>;
  findById(companyId: CompanyId, id: string): Promise<StockMovement | null>;
  /** Issue #366 — `page` is optional keyset paging in id order (`Page` in @invoice/sales); without it, every row. */
  list(companyId: CompanyId, filter?: MovementFilter, page?: Page): Promise<StockMovement[]>;
  listBySource(companyId: CompanyId, sourceKind: string, sourceId: string, page?: Page): Promise<StockMovement[]>;
}

export interface ReservationRepository {
  insert(reservation: Reservation): Promise<void>;
  update(reservation: Reservation): Promise<void>;
  findById(companyId: CompanyId, id: string): Promise<Reservation | null>;
  listHeld(companyId: CompanyId, filter?: { itemId?: string; warehouseId?: string; batchId?: string | null }, page?: Page): Promise<Reservation[]>;
  listForDocument(companyId: CompanyId, documentId: string, page?: Page): Promise<Reservation[]>;
}

export interface InventoryStore {
  readonly movements: MovementRepository;
  readonly reservations: ReservationRepository;
  /**
   * Issue #367 — holds the stock of these places for the rest of the transaction, so two bills
   * cannot both see the same last box as free. Locked in one fixed order, so they cannot deadlock.
   * Optional: the in-memory store has no other writer to wait for.
   */
  lockStock?(companyId: CompanyId, places: readonly { itemId: string; warehouseId: string; batchId: string | null }[]): Promise<void>;
}

/**
 * Issue #229 — the books' side of a movement.
 *
 * Goods are money: when 500 kg worth ₹32,000 come in, the business owns ₹32,000 more of stock, and
 * when 450 kg of it go out on a bill, it owns ₹28,800 less. The inventory service works out how much
 * each movement changed the value of the stock it touched, and hands that figure here, inside the
 * movement's own transaction, so the movement and its entry are saved together or not at all.
 */
export interface StockBooksPort {
  /** `change` is positive when the stock gained value and negative when it lost value. Never zero. */
  valueChanged(actor: ActorContext, movement: StockMovement, change: Money): Promise<void>;
}
