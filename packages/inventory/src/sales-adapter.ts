/**
 * Issue #12 [E12] — the real inventory behind issue #9's port.
 *
 * This is the mock replacement the sales lane was waiting for. Nothing in `packages/sales` changes:
 * it asked for `reserve`, `release`, `issue` and `returnToStock`, and now gets stock that actually
 * exists rather than an adapter that always says yes.
 *
 * This file used to translate between two `Quantity` types that meant the same thing. There is now
 * one, in `@invoice/kernel`, so a sale line's quantity is handed straight to the godown (#77).
 */
import type { IsoDate } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import type { InventoryPort, ReservationRequest, ReservationResult } from '@invoice/sales';
import type { InventoryService } from './service.ts';

export interface SalesInventoryAdapterOptions {
  /** Used when a sale line does not name one. Most small businesses have exactly one godown. */
  readonly defaultWarehouseId: string;
}

export const salesInventoryAdapter = (
  service: InventoryService,
  options: SalesInventoryAdapterOptions,
): InventoryPort => ({
  async reserve(actor: ActorContext, request: ReservationRequest): Promise<ReservationResult> {
    const result = await service.reserve(actor, {
      documentId: request.documentId,
      documentDate: request.documentDate,
      lines: request.lines.map((line) => ({
        lineId: line.lineId,
        itemId: line.itemId,
        warehouseId: line.warehouseId ?? options.defaultWarehouseId,
        quantity: line.quantity,
      })),
    });
    if (result.ok) return { ok: true, reservationId: request.documentId };
    return { ok: false, shortfalls: result.shortfalls };
  },

  async release(actor: ActorContext, documentId: string): Promise<void> {
    await service.release(actor, documentId);
  },

  async issue(actor: ActorContext, documentId: string, documentDate: IsoDate, number: string | null): Promise<void> {
    await service.issue(actor, {
      documentId,
      documentDate,
      source: { kind: 'sales_invoice', id: documentId, number },
    });
  },

  async returnToStock(actor: ActorContext, documentId: string, documentDate: IsoDate, reason: string): Promise<void> {
    await service.returnToStock(actor, {
      documentId,
      documentDate,
      source: { kind: 'sales_invoice', id: documentId, number: null },
      reason,
    });
  },
});
