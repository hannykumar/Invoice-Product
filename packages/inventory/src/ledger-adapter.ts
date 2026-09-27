/**
 * Issue #229 — the value of stock, written into the books as the goods move.
 *
 * Every movement that changes what the godown is worth posts one entry between "Stock in hand" and
 * "Change in stock of goods":
 *
 *  - 500 kg bought at ₹64 come in: stock in hand goes up by 500 × ₹64 = ₹32,000.
 *  - 450 kg go out on a bill: stock in hand goes down by 450 × ₹64 = ₹28,800.
 *  - 50 kg come back from the customer: stock in hand goes up by 50 × ₹64 = ₹3,200.
 *
 * The purchase itself still stands in full under "Purchases of goods". "Change in stock of goods"
 * takes back the part of it that is still lying in the godown, so the two together are what the
 * goods sold cost, and the profit is not overstated or understated by whatever happens to be unsold.
 *
 * Opening stock is different: it was bought before these books began, so its other side is the
 * opening balance, not this year's costs.
 *
 * The entry is posted inside the movement's own transaction, so a movement without its entry, or an
 * entry without its movement, cannot be saved.
 */
import { isoDate, type Money } from '@invoice/kernel';
import type { ActorContext, LedgerService, LedgerStore } from '@invoice/ledger';
import type { StockMovement } from './model.ts';
import type { StockBooksPort } from './ports.ts';

const NAMES: Record<StockMovement['kind'], string> = {
  OPENING: 'Opening stock',
  PURCHASE_IN: 'Goods bought',
  SALE_OUT: 'Goods sold',
  SALES_RETURN_IN: 'Goods returned by a customer',
  PURCHASE_RETURN_OUT: 'Goods returned to a supplier',
  TRANSFER_OUT: 'Goods moved out of this godown',
  TRANSFER_IN: 'Goods moved into this godown',
  ADJUSTMENT_IN: 'Stock count correction',
  ADJUSTMENT_OUT: 'Stock count correction',
  REVERSAL_IN: 'Goods back on a cancelled bill',
  REVERSAL_OUT: 'Goods out on a cancelled return',
};

export const ledgerStockBooks = (store: LedgerStore, ledger: LedgerService): StockBooksPort => ({
  async valueChanged(actor: ActorContext, movement: StockMovement, change: Money): Promise<void> {
    const posted = await store.transaction(actor.companyId, async (uow) => {
      const stock = await uow.accounts.findBySystemRole(actor.companyId, 'STOCK_IN_HAND');
      const other = await uow.accounts.findBySystemRole(
        actor.companyId,
        movement.kind === 'OPENING' ? 'OPENING_BALANCE_DIFFERENCE' : 'STOCK_CHANGE',
      );
      if (stock === null || other === null) {
        throw new Error('This business has no "Stock in hand" or "Change in stock of goods" account, so the value of its goods cannot be recorded.');
      }
      const gained = change.minor > 0n;
      const amount: Money = { currency: change.currency, minor: gained ? change.minor : -change.minor };
      const nil: Money = { currency: change.currency, minor: 0n };
      const number = movement.source.number === null ? '' : ` ${movement.source.number}`;
      return ledger.postVoucherIn(uow, actor, {
        idempotencyKey: `stock-value:${movement.id}`,
        type: 'JOURNAL',
        date: isoDate(movement.documentDate),
        narration: `${NAMES[movement.kind]}${number}: value of stock ${gained ? 'up' : 'down'}`,
        source: { kind: 'stock_movement', id: movement.id, number: movement.source.number },
        lines: gained
          ? [
              { accountId: stock.id, debit: amount, credit: nil },
              { accountId: other.id, debit: nil, credit: amount },
            ]
          : [
              { accountId: other.id, debit: amount, credit: nil },
              { accountId: stock.id, debit: nil, credit: amount },
            ],
      });
    });
    if (!posted.deduplicated) await ledger.recordPosted(actor, posted.voucher);
  },
});
