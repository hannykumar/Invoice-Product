/**
 * Issue #12 [E12] — the stock service.
 *
 * Three properties carry the issue, and each is a test:
 *
 *  1. **Stock is traceable.** Every figure folds from movements, each linked to the document that
 *     caused it. Nothing is stored and nothing is edited.
 *  2. **Concurrent bills cannot oversell.** Checking availability and taking the hold happen inside
 *     one transaction, so two tills cannot both be told there are thirty boxes.
 *  3. **Negative stock is a decision, not an accident.** The default refuses. A business that needs
 *     to sell ahead of its paperwork switches policy, and every override is named and reasoned.
 */
import {
  conflict,
  forbidden,
  invalid,
  notAllowed,
  notFound,
  type Clock,
  type CompanyId,
  type IsoDate,
  type Money,
  type UserId,
} from '@invoice/kernel';
import type { ActorContext, AuditPort, LedgerStore, PermissionPort } from '@invoice/ledger';
import { UnitConversionError, formatQuantity, type Quantity } from '../../masters/src/units.ts';
import { amountOf, buildBalance, valueStock, type StockValue } from './balances.ts';
import { DEFAULT_INVENTORY_POLICY, type InventoryPolicy } from './policy.ts';
import {
  DIRECTION_OF,
  INVENTORY_PERMISSIONS,
  type MovementKind,
  type Reservation,
  type SourceDocument,
  type StockBalance,
  type StockMovement,
} from './model.ts';
import type { InventoryStore, StockMasterData } from './ports.ts';

export interface InventoryServiceDeps {
  readonly store: LedgerStore;
  readonly inventory: InventoryStore;
  readonly masterData: StockMasterData;
  readonly permissions: PermissionPort;
  readonly audit: AuditPort;
  readonly clock: Clock;
  readonly policy?: InventoryPolicy;
  readonly idFactory?: () => string;
}

export interface RecordMovementCommand {
  readonly idempotencyKey: string;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly batchId?: string | null;
  readonly serialNumbers?: readonly string[];
  readonly kind: MovementKind;
  /** In any unit that converts exactly to the item's base unit. */
  readonly quantity: Quantity;
  readonly unitCost?: Money | null;
  readonly documentDate: IsoDate;
  readonly source: SourceDocument;
  readonly reason?: string | null;
  /** Only for a policy that allows it, and only with the permission and a written reason. */
  readonly negativeOverride?: { readonly reason: string };
}

export interface ReserveLine {
  readonly lineId: string;
  readonly itemId: string;
  readonly warehouseId: string;
  readonly batchId?: string | null;
  readonly quantity: Quantity;
}

export interface Shortfall {
  readonly lineId: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly warehouseName: string;
  readonly available: string;
  readonly required: string;
  readonly shortfall: string;
  readonly unit: string;
}

export type ReserveResult =
  | { readonly ok: true; readonly reservations: readonly Reservation[] }
  | { readonly ok: false; readonly shortfalls: readonly Shortfall[] };

export class InventoryService {
  readonly #store: LedgerStore;
  readonly #inventory: InventoryStore;
  readonly #masterData: StockMasterData;
  readonly #permissions: PermissionPort;
  readonly #audit: AuditPort;
  readonly #clock: Clock;
  readonly #policy: InventoryPolicy;
  readonly #newId: () => string;

  constructor(deps: InventoryServiceDeps) {
    this.#store = deps.store;
    this.#inventory = deps.inventory;
    this.#masterData = deps.masterData;
    this.#permissions = deps.permissions;
    this.#audit = deps.audit;
    this.#clock = deps.clock;
    this.#policy = deps.policy ?? DEFAULT_INVENTORY_POLICY;
    this.#newId = deps.idFactory ?? (() => crypto.randomUUID());
  }

  get policy(): InventoryPolicy {
    return this.#policy;
  }

  /**
   * Converts what the person typed into the item's base unit.
   *
   * Refuses rather than rounds. Half a box that does not divide into whole pieces is a question for
   * the person, not a rounding decision for the software — GPT 3's `convertExact` already says so
   * in words a shopkeeper can act on.
   */
  #toBaseUnit(companyId: CompanyId, itemId: string, quantity: Quantity): Quantity {
    const item = this.#masterData.item(companyId, itemId);
    if (item === undefined) {
      throw notFound('STOCK_ITEM_UNKNOWN', 'We do not have details for that item.');
    }
    if (quantity.unitCode === item.baseUnit) return quantity;
    try {
      return this.#masterData.units(companyId).convertExact(quantity, item.baseUnit, itemId);
    } catch (error) {
      if (error instanceof UnitConversionError) {
        throw invalid('STOCK_UNIT_CONVERSION', error.message, { details: { unit: quantity.unitCode } });
      }
      throw error;
    }
  }

  async #balanceIn(
    companyId: CompanyId,
    itemId: string,
    warehouseId: string,
    batchId: string | null,
    unitCode: string,
  ): Promise<StockBalance> {
    const movements = await this.#inventory.movements.list(companyId, { itemId, warehouseId, batchId });
    const held = await this.#inventory.reservations.listHeld(companyId, { itemId, warehouseId, batchId });
    return buildBalance(itemId, warehouseId, batchId, unitCode, movements, held);
  }

  /** What is in the godown, what is held, and what can still be sold. */
  async balance(
    actor: ActorContext,
    key: { itemId: string; warehouseId: string; batchId?: string | null },
  ): Promise<StockBalance> {
    const item = this.#masterData.item(actor.companyId, key.itemId);
    if (item === undefined) throw notFound('STOCK_ITEM_UNKNOWN', 'We do not have details for that item.');
    return this.#balanceIn(actor.companyId, key.itemId, key.warehouseId, key.batchId ?? null, item.baseUnit);
  }

  /** Every movement behind a figure, so a total can always be drilled into. */
  async movementsFor(
    actor: ActorContext,
    key: { itemId?: string; warehouseId?: string; from?: IsoDate; to?: IsoDate },
  ): Promise<StockMovement[]> {
    return this.#inventory.movements.list(actor.companyId, key);
  }

  async value(actor: ActorContext, key: { itemId: string; warehouseId?: string }, on?: IsoDate): Promise<StockValue> {
    const movements = await this.#inventory.movements.list(actor.companyId, key);
    return valueStock(movements, on === undefined ? {} : { on });
  }

  /**
   * Records one movement.
   *
   * Idempotent by key, so a retry after a timeout moves stock once. Refuses to take stock below
   * zero unless the business's policy allows it and an authorised person has said why.
   */
  async recordMovement(actor: ActorContext, command: RecordMovementCommand): Promise<StockMovement> {
    return this.#store.transaction(actor.companyId, () => this.recordMovementIn(actor, command));
  }

  /**
   * Records a movement inside a transaction the caller already opened.
   *
   * A module that owns a document and must move stock as part of the same decision — purchase
   * posting (#17) receives goods, books the bill and credits the supplier, or does none of them —
   * calls this, exactly as it calls `LedgerService.postVoucherIn`. Everyone else calls
   * `recordMovement`. The in-memory store joins the ledger store as a transaction participant, so
   * a failure after this point unwinds the movement too.
   */
  async recordMovementIn(actor: ActorContext, command: RecordMovementCommand): Promise<StockMovement> {
    this.#permissions.require(actor, INVENTORY_PERMISSIONS.move, 'record a stock movement');
    if (command.idempotencyKey.trim() === '') {
      throw invalid('STOCK_IDEMPOTENCY_KEY_REQUIRED', 'Every stock movement needs a key so a retry cannot record it twice.');
    }

    const existing = await this.#inventory.movements.findByIdempotencyKey(actor.companyId, command.idempotencyKey);
    if (existing !== null) return existing;

    const item = this.#masterData.item(actor.companyId, command.itemId);
    if (item === undefined) throw notFound('STOCK_ITEM_UNKNOWN', 'We do not have details for that item.');
    if (this.#masterData.warehouse(actor.companyId, command.warehouseId) === undefined) {
      throw notFound('STOCK_WAREHOUSE_UNKNOWN', 'We do not have that godown.');
    }
    const batchId = command.batchId ?? null;
    if (item.tracksBatches && batchId === null) {
      throw invalid(
        'STOCK_BATCH_REQUIRED',
        `"${item.name}" is kept in batches, so please say which batch this is.`,
      );
    }
    const serials = command.serialNumbers ?? [];
    const base = this.#toBaseUnit(actor.companyId, command.itemId, command.quantity);
    if (base.micro <= 0n) {
      throw invalid('STOCK_QUANTITY_NOT_POSITIVE', 'A stock movement needs a quantity greater than zero.');
    }
    if (item.tracksSerials && BigInt(serials.length) * 1000000n !== base.micro) {
      throw invalid(
        'STOCK_SERIALS_MISMATCH',
        `"${item.name}" is tracked piece by piece, so the number of serial numbers must match the quantity.`,
      );
    }

    const overridden = await this.#guardNegative(actor, command, item.baseUnit, base, batchId, item.name);

    const movement: StockMovement = {
      id: this.#newId(),
      companyId: actor.companyId,
      itemId: command.itemId,
      warehouseId: command.warehouseId,
      batchId,
      serialNumbers: serials,
      kind: command.kind,
      direction: DIRECTION_OF[command.kind],
      quantity: base,
      enteredQuantity: command.quantity,
      unitCost: command.unitCost ?? null,
      documentDate: command.documentDate,
      source: command.source,
      postedBy: actor.userId,
      postedAt: this.#clock.now().toISOString(),
      idempotencyKey: command.idempotencyKey,
      reversesMovementId: null,
      reason: command.reason ?? null,
      negativeOverride: overridden,
    };
    await this.#inventory.movements.insert(movement);
    return movement;
  }

  async #guardNegative(
    actor: ActorContext,
    command: RecordMovementCommand,
    baseUnit: string,
    base: Quantity,
    batchId: string | null,
    itemName: string,
  ): Promise<{ reason: string; allowedBy: UserId } | null> {
    if (DIRECTION_OF[command.kind] === 'IN') return null;
    const balance = await this.#balanceIn(actor.companyId, command.itemId, command.warehouseId, batchId, baseUnit);
    if (balance.physical.micro >= base.micro) return null;

    const shortfall = { micro: base.micro - balance.physical.micro, unitCode: baseUnit };
    if (this.#policy.negativeStock === 'BLOCK') {
      throw notAllowed(
        'STOCK_WOULD_GO_NEGATIVE',
        `There is not enough of "${itemName}" in the godown. You have ${formatQuantity(balance.physical)} and this takes out ${formatQuantity(base)}, so ${formatQuantity(shortfall)} is missing.`,
        { messageId: 'stock.not_enough', details: { itemName, shortfall: formatQuantity(shortfall) } },
      );
    }
    const override = command.negativeOverride;
    if (override === undefined || override.reason.trim() === '') {
      throw invalid(
        'STOCK_OVERRIDE_REASON_REQUIRED',
        'Please write why you are taking out stock you do not have on record.',
        { messageId: 'override.reason_required' },
      );
    }
    this.#permissions.require(actor, INVENTORY_PERMISSIONS.overrideNegative, 'allow a sale with stock you do not have');
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at: this.#clock.now().toISOString(),
      action: 'inventory.negative_stock_allowed',
      subjectType: 'item',
      subjectId: command.itemId,
      summary: `${formatQuantity(shortfall)} of "${itemName}" taken out beyond what is on record.`,
      details: { itemName, warehouseId: command.warehouseId, shortfall: formatQuantity(shortfall) },
      overrideReason: override.reason,
    });
    return { reason: override.reason, allowedBy: actor.userId };
  }

  /**
   * Holds stock for an unfinished bill.
   *
   * Availability is checked and the hold is taken inside one transaction. That is the whole
   * defence against two tills selling the same thirty boxes, and there is a test that fires
   * twenty bills at once to prove it.
   */
  async reserve(
    actor: ActorContext,
    command: { documentId: string; documentDate: IsoDate; lines: readonly ReserveLine[] },
  ): Promise<ReserveResult> {
    this.#permissions.require(actor, INVENTORY_PERMISSIONS.move, 'hold stock for a bill');
    return this.#store.transaction(actor.companyId, async (): Promise<ReserveResult> => {
      // Re-holding for the same document replaces the previous hold rather than stacking on it.
      const previous = await this.#inventory.reservations.listForDocument(actor.companyId, command.documentId);
      for (const reservation of previous.filter((r) => r.state === 'HELD')) {
        await this.#inventory.reservations.update({
          ...reservation,
          state: 'RELEASED',
          settledAt: this.#clock.now().toISOString(),
        });
      }

      const shortfalls: Shortfall[] = [];
      const taken: Reservation[] = [];
      // Accumulated within this call, so two lines for the same item cannot both claim the last box.
      const claimed = new Map<string, bigint>();

      for (const line of command.lines) {
        const item = this.#masterData.item(actor.companyId, line.itemId);
        if (item === undefined) throw notFound('STOCK_ITEM_UNKNOWN', 'We do not have details for that item.');
        const warehouse = this.#masterData.warehouse(actor.companyId, line.warehouseId);
        if (warehouse === undefined) throw notFound('STOCK_WAREHOUSE_UNKNOWN', 'We do not have that godown.');

        const batchId = line.batchId ?? null;
        const base = this.#toBaseUnit(actor.companyId, line.itemId, line.quantity);
        const key = `${line.itemId}|${line.warehouseId}|${batchId ?? ''}`;
        const balance = await this.#balanceIn(actor.companyId, line.itemId, line.warehouseId, batchId, item.baseUnit);
        const alreadyClaimed = claimed.get(key) ?? 0n;
        const available = balance.available.micro - alreadyClaimed;

        if (available < base.micro) {
          shortfalls.push({
            lineId: line.lineId,
            itemId: line.itemId,
            itemName: item.name,
            warehouseName: warehouse.name,
            // Numbers only: the message that shows these supplies the unit separately.
            available: amountOf({ micro: available < 0n ? 0n : available, unitCode: item.baseUnit }),
            required: amountOf(base),
            shortfall: amountOf({ micro: base.micro - available, unitCode: item.baseUnit }),
            unit: item.baseUnit,
          });
          continue;
        }

        claimed.set(key, alreadyClaimed + base.micro);
        const at = this.#clock.now();
        taken.push({
          id: this.#newId(),
          companyId: actor.companyId,
          documentId: command.documentId,
          lineId: line.lineId,
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          batchId,
          quantity: base,
          state: 'HELD',
          createdBy: actor.userId,
          createdAt: at.toISOString(),
          expiresAt: new Date(at.getTime() + this.#policy.reservationMinutes * 60_000).toISOString(),
          settledAt: null,
        });
      }

      if (shortfalls.length > 0) {
        // Nothing is held when any line falls short: a half-held bill is a bill that quietly
        // locks goods it will never use.
        return { ok: false, shortfalls };
      }
      for (const reservation of taken) await this.#inventory.reservations.insert(reservation);
      return { ok: true, reservations: taken };
    });
  }

  /** Puts held stock back, when a draft is abandoned or changed. */
  async release(actor: ActorContext, documentId: string): Promise<number> {
    this.#permissions.require(actor, INVENTORY_PERMISSIONS.move, 'release held stock');
    return this.#store.transaction(actor.companyId, async () => {
      const held = (await this.#inventory.reservations.listForDocument(actor.companyId, documentId)).filter(
        (r) => r.state === 'HELD',
      );
      for (const reservation of held) {
        await this.#inventory.reservations.update({
          ...reservation,
          state: 'RELEASED',
          settledAt: this.#clock.now().toISOString(),
        });
      }
      return held.length;
    });
  }

  /** Turns a hold into a real movement out, when the bill is issued. */
  async issue(
    actor: ActorContext,
    command: { documentId: string; documentDate: IsoDate; source: SourceDocument },
  ): Promise<StockMovement[]> {
    this.#permissions.require(actor, INVENTORY_PERMISSIONS.move, 'issue stock');
    const held = (await this.#inventory.reservations.listForDocument(actor.companyId, command.documentId)).filter(
      (r) => r.state === 'HELD',
    );

    const posted: StockMovement[] = [];
    for (const reservation of held) {
      // The hold is consumed before the movement, so availability never briefly double-counts.
      await this.#store.transaction(actor.companyId, async () => {
        await this.#inventory.reservations.update({
          ...reservation,
          state: 'CONSUMED',
          settledAt: this.#clock.now().toISOString(),
        });
      });
      posted.push(
        await this.recordMovement(actor, {
          idempotencyKey: `issue:${command.documentId}:${reservation.lineId}`,
          itemId: reservation.itemId,
          warehouseId: reservation.warehouseId,
          batchId: reservation.batchId,
          kind: 'SALE_OUT',
          quantity: reservation.quantity,
          documentDate: command.documentDate,
          source: command.source,
        }),
      );
    }
    return posted;
  }

  /**
   * Puts goods back when a bill is cancelled or returned.
   *
   * Each original movement is mirrored, never deleted, so the stock ledger shows what happened
   * rather than showing that nothing happened.
   */
  async returnToStock(
    actor: ActorContext,
    command: { documentId: string; documentDate: IsoDate; source: SourceDocument; reason: string },
  ): Promise<StockMovement[]> {
    this.#permissions.require(actor, INVENTORY_PERMISSIONS.move, 'put stock back');
    if (command.reason.trim() === '') {
      throw invalid('STOCK_REASON_REQUIRED', 'Please write why the goods are going back.', {
        messageId: 'override.reason_required',
      });
    }
    const original = (await this.#inventory.movements.listBySource(actor.companyId, command.source.kind, command.source.id))
      .filter((m) => m.direction === 'OUT' && m.reversesMovementId === null);

    const reversed: StockMovement[] = [];
    for (const movement of original) {
      const already = await this.#inventory.movements.findByIdempotencyKey(
        actor.companyId,
        `return:${command.documentId}:${movement.id}`,
      );
      if (already !== null) {
        reversed.push(already);
        continue;
      }
      const mirror = await this.#store.transaction(actor.companyId, async () => {
        const created: StockMovement = {
          ...movement,
          id: this.#newId(),
          kind: 'REVERSAL_IN',
          direction: 'IN',
          documentDate: command.documentDate,
          postedBy: actor.userId,
          postedAt: this.#clock.now().toISOString(),
          idempotencyKey: `return:${command.documentId}:${movement.id}`,
          reversesMovementId: movement.id,
          reason: command.reason,
          negativeOverride: null,
        };
        await this.#inventory.movements.insert(created);
        return created;
      });
      reversed.push(mirror);
    }
    return reversed;
  }

  /**
   * Moves goods between godowns as two linked movements, so both ends are traceable and the total
   * across the business does not change.
   */
  async transfer(
    actor: ActorContext,
    command: {
      idempotencyKey: string;
      itemId: string;
      fromWarehouseId: string;
      toWarehouseId: string;
      batchId?: string | null;
      quantity: Quantity;
      documentDate: IsoDate;
      reason: string;
    },
  ): Promise<{ out: StockMovement; in: StockMovement }> {
    this.#permissions.require(actor, INVENTORY_PERMISSIONS.transfer, 'move stock between godowns');
    if (command.fromWarehouseId === command.toWarehouseId) {
      throw invalid('STOCK_TRANSFER_SAME_PLACE', 'The goods are already in that godown.');
    }
    if (command.reason.trim() === '') {
      throw invalid('STOCK_REASON_REQUIRED', 'Please write why the goods are being moved.');
    }
    const source: SourceDocument = { kind: 'stock_transfer', id: command.idempotencyKey, number: null };
    const out = await this.recordMovement(actor, {
      idempotencyKey: `${command.idempotencyKey}:out`,
      itemId: command.itemId,
      warehouseId: command.fromWarehouseId,
      batchId: command.batchId ?? null,
      kind: 'TRANSFER_OUT',
      quantity: command.quantity,
      documentDate: command.documentDate,
      source,
      reason: command.reason,
    });
    const movedIn = await this.recordMovement(actor, {
      idempotencyKey: `${command.idempotencyKey}:in`,
      itemId: command.itemId,
      warehouseId: command.toWarehouseId,
      batchId: command.batchId ?? null,
      kind: 'TRANSFER_IN',
      quantity: command.quantity,
      documentDate: command.documentDate,
      source,
      reason: command.reason,
      unitCost: out.unitCost,
    });
    return { out, in: movedIn };
  }

  /** A counted correction. Always needs a reason, because the difference is unexplained by itself. */
  async adjust(
    actor: ActorContext,
    command: {
      idempotencyKey: string;
      itemId: string;
      warehouseId: string;
      batchId?: string | null;
      quantity: Quantity;
      direction: 'IN' | 'OUT';
      documentDate: IsoDate;
      reason: string;
      unitCost?: Money | null;
    },
  ): Promise<StockMovement> {
    this.#permissions.require(actor, INVENTORY_PERMISSIONS.adjust, 'correct a stock count');
    if (command.reason.trim() === '') {
      throw invalid('STOCK_REASON_REQUIRED', 'Please write why the count is being changed.', {
        messageId: 'override.reason_required',
      });
    }
    return this.recordMovement(actor, {
      idempotencyKey: command.idempotencyKey,
      itemId: command.itemId,
      warehouseId: command.warehouseId,
      batchId: command.batchId ?? null,
      kind: command.direction === 'IN' ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
      quantity: command.quantity,
      documentDate: command.documentDate,
      source: { kind: 'stock_adjustment', id: command.idempotencyKey, number: null },
      reason: command.reason,
      ...(command.unitCost === undefined ? {} : { unitCost: command.unitCost }),
    });
  }

  /** Releases holds that were never used, so an abandoned draft cannot lock goods for ever. */
  async expireStaleReservations(actor: ActorContext, now: Date): Promise<number> {
    return this.#store.transaction(actor.companyId, async () => {
      const held = await this.#inventory.reservations.listHeld(actor.companyId);
      const stale = held.filter((r) => new Date(r.expiresAt).getTime() <= now.getTime());
      for (const reservation of stale) {
        await this.#inventory.reservations.update({
          ...reservation,
          state: 'EXPIRED',
          settledAt: now.toISOString(),
        });
      }
      return stale.length;
    });
  }
}

export { conflict, forbidden };
