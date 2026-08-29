/**
 * Issue #12 [E12] — stock is a fold, never a stored number.
 *
 * "Stock is derived from traceable movements" is the first acceptance criterion, so there is no
 * balance to update and therefore no balance to get wrong. Every figure below is computed from the
 * movements, and every figure can be drilled back to them.
 */
import { compareDates, type IsoDate, type Money } from '@invoice/kernel';
import { MICRO, type Quantity } from '../../masters/src/units.ts';
import { DIRECTION_OF, type Reservation, type StockBalance, type StockMovement } from './model.ts';

/**
 * The number alone, without its unit.
 *
 * `formatQuantity` from master data appends the unit code, which reads well in a sentence and
 * wrongly in a field. The sales shortfall message already supplies the unit separately — "you have
 * {available} {unit} of {itemName}" — so putting it in both would print "30.000 KGS boxes".
 */
export const amountOf = (q: Quantity, decimals = 3): string => {
  const negative = q.scaled < 0n;
  const absolute = negative ? -q.scaled : q.scaled;
  const whole = absolute / MICRO;
  const fraction = (absolute % MICRO).toString().padStart(6, '0').slice(0, decimals);
  return `${negative ? '-' : ''}${decimals > 0 ? `${whole}.${fraction}` : whole}`;
};

export interface AsOf {
  readonly on?: IsoDate;
}

const inRange = (movement: StockMovement, asOf: AsOf): boolean =>
  asOf.on === undefined || compareDates(movement.documentDate, asOf.on) <= 0;

const q = (scaled: bigint, unitCode: string): Quantity => ({ scaled, unit: unitCode });

/** Physical stock: what is in the godown, from posted movements only. */
export const physicalQuantity = (
  movements: readonly StockMovement[],
  unitCode: string,
  asOf: AsOf = {},
): Quantity =>
  q(
    movements
      .filter((m) => inRange(m, asOf))
      .reduce((total, m) => (DIRECTION_OF[m.kind] === 'IN' ? total + m.quantity.scaled : total - m.quantity.scaled), 0n),
    unitCode,
  );

/** What unfinished bills are holding. Only `HELD` reservations count. */
export const reservedQuantity = (reservations: readonly Reservation[], unitCode: string): Quantity =>
  q(
    reservations.filter((r) => r.state === 'HELD').reduce((total, r) => total + r.quantity.scaled, 0n),
    unitCode,
  );

/**
 * What can still be sold.
 *
 * This is the number a sale is checked against, not the physical count. A hundred boxes in the
 * godown with seventy promised to someone else is thirty boxes you can sell, and telling a
 * shopkeeper otherwise is how the same goods get sold twice.
 */
export const availableQuantity = (physical: Quantity, reserved: Quantity): Quantity =>
  q(physical.scaled - reserved.scaled, physical.unit);

export const buildBalance = (
  itemId: string,
  warehouseId: string,
  batchId: string | null,
  unitCode: string,
  movements: readonly StockMovement[],
  reservations: readonly Reservation[],
  asOf: AsOf = {},
): StockBalance => {
  const physical = physicalQuantity(movements, unitCode, asOf);
  const reserved = reservedQuantity(reservations, unitCode);
  return {
    itemId,
    warehouseId,
    batchId,
    unitCode,
    physical,
    reserved,
    available: availableQuantity(physical, reserved),
  };
};

export interface StockValue {
  readonly quantity: Quantity;
  readonly value: Money;
  /** Weighted average cost per base unit, or null when nothing is in stock. */
  readonly averageUnitCost: Money | null;
}

/**
 * Weighted average valuation.
 *
 * Every movement in carries its cost; movements out are valued at the running average at the time
 * they happened, which is why this walks the movements in date order rather than summing them. The
 * method is fixed for the company: changing it retrospectively changes profit already reported, so
 * it is a decision with an audit trail, not a setting.
 */
export const valueStock = (movements: readonly StockMovement[], asOf: AsOf = {}): StockValue => {
  const ordered = [...movements]
    .filter((m) => inRange(m, asOf))
    .sort((a, b) => (a.documentDate === b.documentDate ? a.postedAt.localeCompare(b.postedAt) : a.documentDate.localeCompare(b.documentDate)));

  let quantityMicro = 0n;
  let valuePaise = 0n;
  let unitCode = 'PCS';

  for (const movement of ordered) {
    unitCode = movement.quantity.unit;
    if (DIRECTION_OF[movement.kind] === 'IN') {
      const cost = movement.unitCost?.minor ?? 0n;
      quantityMicro += movement.quantity.scaled;
      valuePaise += (cost * movement.quantity.scaled) / MICRO;
    } else {
      // Out at the running average, so the cost of what is left does not jump when goods leave.
      const average = quantityMicro === 0n ? 0n : (valuePaise * MICRO) / quantityMicro;
      const removed = (average * movement.quantity.scaled) / MICRO;
      quantityMicro -= movement.quantity.scaled;
      valuePaise -= removed;
    }
  }

  const averageUnitCost =
    quantityMicro === 0n ? null : ({ currency: 'INR', minor: (valuePaise * MICRO) / quantityMicro } as Money);
  return {
    quantity: q(quantityMicro, unitCode),
    value: { currency: 'INR', minor: valuePaise },
    averageUnitCost,
  };
};
