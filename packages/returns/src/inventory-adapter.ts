import type { ActorContext } from '@invoice/ledger';
import type { InventoryService, MovementKind } from '@invoice/inventory';
import type { ReturnInventoryLine, ReturnInventoryPort } from './ports.ts';

export const returnInventoryAdapter = (inventory: InventoryService): ReturnInventoryPort => ({
  async applySalesReturnIn(actor: ActorContext, line: ReturnInventoryLine): Promise<readonly string[]> {
    const source = { kind: 'credit_note', id: line.noteId, number: line.noteNumber };
    const ids: string[] = [];
    const move = async (suffix: string, kind: MovementKind, serialNumbers: readonly string[]) => {
      const movement = await inventory.recordMovementIn(actor, {
        idempotencyKey: `sales-return:${line.noteId}:${line.originalLineId}:${suffix}`,
        itemId: line.itemId,
        warehouseId: line.warehouseId,
        batchId: line.batchId,
        serialNumbers,
        kind,
        quantity: line.quantity,
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
});
