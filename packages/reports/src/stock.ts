/**
 * Issue #35 [E35] — what is left in the godown, and what it is worth.
 *
 * The quantities and the valuation both come from `@invoice/inventory`, which folds them from the
 * movements. They are not recomputed here for the same reason the ledger figures are not: two
 * places that work out the same number are two places that can disagree about it.
 *
 * One thing this report does not do is put its valuation on the balance sheet. Stock value has
 * never been posted to the ledger — that belongs with the purchase side, issue #17 — so the two
 * figures are shown as what they are, and the difference between them is raised as an exception
 * rather than quietly closed.
 */
import { formatINR, sum, zero, type CompanyId, type Money } from '@invoice/kernel';
import {
  amountOf,
  physicalQuantity,
  reservedQuantity,
  valueStock,
  DIRECTION_OF,
  type InventoryStore,
  type StockMasterData,
  type StockMovement,
} from '@invoice/inventory';
import { figureOf, type Bilingual, type Contribution, type Figure, type ReportFilter } from './model.ts';
import { nameOr, type ReportNames } from './ports.ts';

const MICRO = 1_000_000n;

export interface StockRow {
  readonly itemId: string;
  readonly itemName: string;
  readonly warehouseId: string;
  readonly warehouseName: string;
  readonly unitCode: string;
  /** How much was there when the period began. */
  readonly opening: string;
  readonly received: string;
  readonly issued: string;
  /** How much is there on the closing date. */
  readonly closing: string;
  /** Held by unfinished bills, so the same goods cannot be promised twice. */
  readonly reserved: string;
  readonly available: string;
  readonly value: Money;
  readonly averageUnitCost: Money | null;
  /** Every movement behind the closing figure, so a count can be argued with. */
  readonly movements: readonly Contribution[];
}

export interface StockBody {
  readonly rows: readonly StockRow[];
  /** What the movements say the stock is worth on the closing date. */
  readonly value: Figure;
  readonly sentence: Bilingual;
}

const valueOf = (movement: StockMovement): Money =>
  movement.unitCost === null
    ? zero('INR')
    : { currency: 'INR', minor: (movement.unitCost.minor * movement.quantity.micro) / MICRO };

const movementContribution = (movement: StockMovement, itemName: string): Contribution => {
  const direction = DIRECTION_OF[movement.kind];
  const value = valueOf(movement);
  return {
    sourceKind: 'stock_movement',
    sourceId: movement.id,
    sourceNumber: movement.source.number,
    date: movement.documentDate,
    branchId: null,
    partyId: null,
    description: `${direction === 'IN' ? 'Came in' : 'Went out'}: ${amountOf(movement.quantity)} ${movement.quantity.unitCode} of ${itemName}`,
    amount: direction === 'IN' ? value : { currency: 'INR', minor: -value.minor },
  };
};

const totalMicro = (movements: readonly StockMovement[]): bigint =>
  movements.reduce((running, m) => running + m.quantity.micro, 0n);

/**
 * Stock is counted per item and godown, which is the pair a person walks up to and checks. Batches
 * and serials sit under that pair and are counted by `@invoice/inventory`; this report does not
 * split them out yet.
 */
export const stockReportBody = async (
  inventory: InventoryStore,
  masterData: StockMasterData,
  names: ReportNames,
  companyId: CompanyId,
  filter: ReportFilter,
): Promise<StockBody> => {
  const all = await inventory.movements.list(companyId, { to: filter.to });

  const groups = new Map<string, { itemId: string; warehouseId: string; movements: StockMovement[] }>();
  for (const movement of all) {
    const key = JSON.stringify([movement.itemId, movement.warehouseId]);
    const group = groups.get(key) ?? { itemId: movement.itemId, warehouseId: movement.warehouseId, movements: [] };
    group.movements.push(movement);
    groups.set(key, group);
  }

  const rows: StockRow[] = [];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key) as { itemId: string; warehouseId: string; movements: StockMovement[] };
    const { itemId, warehouseId, movements } = group;
    const item = masterData.item(companyId, itemId);
    const itemName = nameOr(item?.name ?? names.item(companyId, itemId), itemId);
    const unitCode = movements[0]?.quantity.unitCode ?? item?.baseUnit ?? 'PCS';
    const held = await inventory.reservations.listHeld(companyId, { itemId, warehouseId });

    const before = movements.filter((m) => m.documentDate < filter.from);
    const during = movements.filter((m) => m.documentDate >= filter.from && m.documentDate <= filter.to);
    const opening = physicalQuantity(before, unitCode);
    const closing = physicalQuantity(movements, unitCode, { on: filter.to });
    const reserved = reservedQuantity(held, unitCode);
    const valued = valueStock(movements, { on: filter.to });

    rows.push({
      itemId,
      itemName,
      warehouseId,
      warehouseName: nameOr(
        masterData.warehouse(companyId, warehouseId)?.name ?? names.warehouse(companyId, warehouseId),
        warehouseId,
      ),
      unitCode,
      opening: amountOf(opening),
      received: amountOf({ micro: totalMicro(during.filter((m) => DIRECTION_OF[m.kind] === 'IN')), unitCode }),
      issued: amountOf({ micro: totalMicro(during.filter((m) => DIRECTION_OF[m.kind] === 'OUT')), unitCode }),
      closing: amountOf(closing),
      reserved: amountOf(reserved),
      available: amountOf({ micro: closing.micro - reserved.micro, unitCode }),
      value: valued.value,
      averageUnitCost: valued.averageUnitCost,
      movements: movements.map((m) => movementContribution(m, itemName)),
    });
  }

  const value = figureOf(
    rows.map((row) => ({
      sourceKind: 'stock_valuation',
      sourceId: `${row.itemId}:${row.warehouseId}`,
      sourceNumber: null,
      date: filter.to,
      branchId: null,
      partyId: null,
      description: `${row.closing} ${row.unitCode} of ${row.itemName} at ${row.warehouseName}`,
      amount: row.value,
    })),
  );

  const worth = formatINR(sum(rows.map((r) => r.value)));
  return {
    rows,
    value,
    sentence: {
      'en-IN': `You are holding goods worth ${worth}, across ${rows.length} item and godown ${rows.length === 1 ? 'pair' : 'pairs'}.`,
      'hi-IN': `Aapke paas ${rows.length} item aur godown ke jodon mein ${worth} ka maal pada hai.`,
    },
  };
};
