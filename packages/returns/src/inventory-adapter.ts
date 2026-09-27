import type { ActorContext } from '@invoice/ledger';
import type { InventoryService, MovementKind } from '@invoice/inventory';
import type { ReturnInventoryLine, ReturnInventoryPort } from './ports.ts';

export const returnInventoryAdapter = (inventory: InventoryService): ReturnInventoryPort => ({
  async applySalesReturnIn(actor: ActorContext, line: ReturnInventoryLine): Promise<readonly string[]> {
    const source = { kind: 'credit_note', id: line.noteId, number: line.noteNumber };
    const ids: string[] = [];
    // Issue #229 — goods that come back are worth what they cost when they went out on the bill,
    // not nothing. Coming back at no cost would lower the value of every kilo already in the godown.
    const cost = await inventory.issuedUnitCost(actor, { kind: 'sales_invoice', id: line.originalDocumentId }, line.itemId)
      ?? await inventory.averageUnitCost(actor, { itemId: line.itemId, warehouseId: line.warehouseId });
    const move = async (suffix: string, kind: MovementKind, serialNumbers: readonly string[]) => {
      const movement = await inventory.recordMovementIn(actor, {
        idempotencyKey: `sales-return:${line.noteId}:${line.originalLineId}:${suffix}`,
        itemId: line.itemId,
        warehouseId: line.warehouseId,
        batchId: line.batchId,
        serialNumbers,
        kind,
        quantity: line.quantity,
        ...(kind === 'SALES_RETURN_IN' ? { unitCost: cost } : {}),
        documentDate: line.documentDate,
        source,
        reason: line.reason,
      });
      ids.push(movement.id);
    };

    await move('in', 'SALES_RETURN_IN', line.serialNumbers);
    if (line.disposition === 'SCRAPPED') await move('scrap', 'ADJUSTMENT_OUT', line.serialNumbers);
    if (line.disposition === 'REPLACEMENT') await move('replacement', 'SALE_OUT', line.replacementSerialNumbers);
    return ids;
  },

  async applyPurchaseReturnIn(actor: ActorContext, line: ReturnInventoryLine): Promise<readonly string[]> {
    const movement = await inventory.recordMovementIn(actor, {
      idempotencyKey: `purchase-return:${line.noteId}:${line.originalLineId}:out`,
      itemId: line.itemId,
      warehouseId: line.warehouseId,
      batchId: line.batchId,
      serialNumbers: line.serialNumbers,
      kind: 'PURCHASE_RETURN_OUT',
      quantity: line.quantity,
      documentDate: line.documentDate,
      source: { kind: 'debit_note', id: line.noteId, number: line.noteNumber },
      reason: line.disposition === 'REPLACEMENT' ? `${line.reason} Replacement is still awaited.` : line.reason,
    });
    return [movement.id];
  },
});
