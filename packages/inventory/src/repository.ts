/**
 * Issue #12 [E12] — the in-memory store.
 *
 * It joins the ledger's transaction, so posting a stock movement and posting the entry that values
 * it either both happen or neither does. In Postgres that is one transaction; here it is a
 * snapshot and a restore.
 */
import { conflict, notFound, type CompanyId } from '@invoice/kernel';
import type { TransactionParticipant } from '@invoice/ledger';
import type { Reservation, StockMovement } from './model.ts';
import type { InventoryStore, MovementFilter, MovementRepository, ReservationRepository } from './ports.ts';

interface State {
  movements: StockMovement[];
  reservations: Reservation[];
  keys: Map<string, string>;
}

export class InMemoryInventoryStore implements InventoryStore, TransactionParticipant {
  #state: State = { movements: [], reservations: [], keys: new Map() };

  snapshot(): unknown {
    return {
      movements: [...this.#state.movements],
      reservations: [...this.#state.reservations],
      keys: new Map(this.#state.keys),
    };
  }

  restore(taken: unknown): void {
    this.#state = taken as State;
  }

  readonly movements: MovementRepository = {
    insert: async (movement: StockMovement): Promise<void> => {
      const composite = `${movement.companyId}:${movement.idempotencyKey}`;
      if (this.#state.keys.has(composite)) {
        throw conflict('STOCK_DUPLICATE_MOVEMENT', 'This stock movement was already recorded.');
      }
      this.#state = {
        ...this.#state,
        movements: [...this.#state.movements, movement],
        keys: new Map(this.#state.keys).set(composite, movement.id),
      };
    },
    findByIdempotencyKey: async (companyId: CompanyId, key: string): Promise<StockMovement | null> => {
      const id = this.#state.keys.get(`${companyId}:${key}`);
      return id === undefined ? null : this.movements.findById(companyId, id);
    },
    findById: async (companyId: CompanyId, id: string): Promise<StockMovement | null> =>
      this.#state.movements.find((m) => m.companyId === companyId && m.id === id) ?? null,
    list: async (companyId: CompanyId, filter: MovementFilter = {}): Promise<StockMovement[]> =>
      this.#state.movements.filter(
        (m) =>
          m.companyId === companyId &&
          (filter.itemId === undefined || m.itemId === filter.itemId) &&
          (filter.warehouseId === undefined || m.warehouseId === filter.warehouseId) &&
          (filter.batchId === undefined || m.batchId === filter.batchId) &&
          (filter.from === undefined || m.documentDate >= filter.from) &&
          (filter.to === undefined || m.documentDate <= filter.to),
      ),
    listBySource: async (companyId: CompanyId, sourceKind: string, sourceId: string): Promise<StockMovement[]> =>
      this.#state.movements.filter((m) => m.companyId === companyId && m.source.kind === sourceKind && m.source.id === sourceId),
  };

  readonly reservations: ReservationRepository = {
    insert: async (reservation: Reservation): Promise<void> => {
      this.#state = { ...this.#state, reservations: [...this.#state.reservations, reservation] };
    },
    update: async (reservation: Reservation): Promise<void> => {
      const index = this.#state.reservations.findIndex(
        (r) => r.companyId === reservation.companyId && r.id === reservation.id,
      );
      if (index === -1) throw notFound('STOCK_RESERVATION_NOT_FOUND', 'That hold on stock no longer exists.');
      const next = [...this.#state.reservations];
      next[index] = reservation;
      this.#state = { ...this.#state, reservations: next };
    },
    findById: async (companyId: CompanyId, id: string): Promise<Reservation | null> =>
      this.#state.reservations.find((r) => r.companyId === companyId && r.id === id) ?? null,
    listHeld: async (
      companyId: CompanyId,
      filter: { itemId?: string; warehouseId?: string; batchId?: string | null } = {},
    ): Promise<Reservation[]> =>
      this.#state.reservations.filter(
        (r) =>
          r.companyId === companyId &&
          r.state === 'HELD' &&
          (filter.itemId === undefined || r.itemId === filter.itemId) &&
          (filter.warehouseId === undefined || r.warehouseId === filter.warehouseId) &&
          (filter.batchId === undefined || r.batchId === filter.batchId),
      ),
    listForDocument: async (companyId: CompanyId, documentId: string): Promise<Reservation[]> =>
      this.#state.reservations.filter((r) => r.companyId === companyId && r.documentId === documentId),
  };
}
