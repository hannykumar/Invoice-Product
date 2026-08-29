/**
 * Issue #12 [E12] — the real inventory behind issue #9's port.
 *
 * This is the mock replacement the sales lane was waiting for. Nothing in `packages/sales` changes:
 * it asked for `reserve`, `release`, `issue` and `returnToStock`, and now gets stock that actually
 * exists rather than an adapter that always says yes.
 *
 * The one translation this file performs is between two `Quantity` types that mean the same thing:
 * the kernel's `{ scaled, unit }` and master data's `{ micro, unitCode }`. Both are integer
 * micro-units, so the conversion is a rename and nothing is lost. That duplication is a
 * shared-contract wrinkle worth removing; it is raised with GPT 3 rather than papered over here.
 */
import type { IsoDate, Quantity as KernelQuantity } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import type { InventoryPort, ReservationRequest, ReservationResult } from '@invoice/sales';
import type { Quantity as MasterQuantity } from '../../masters/src/units.ts';
import type { InventoryService } from './service.ts';

/** Kernel quantity to master-data quantity. Same integer, different field names. */
export const toMasterQuantity = (q: KernelQuantity): MasterQuantity => ({ micro: q.scaled, unitCode: q.unit });

/** Master-data quantity to kernel quantity. */
export const toKernelQuantity = (q: MasterQuantity): KernelQuantity => ({ scaled: q.micro, unit: q.unitCode });

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
        quantity: toMasterQuantity(line.quantity),
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
