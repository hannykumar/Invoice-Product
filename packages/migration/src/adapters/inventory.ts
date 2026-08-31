/**
 * Issue #37 [E37] — bringing opening stock in through the real stock ledger (#12).
 *
 * Opening stock is a movement like any other, so it goes in as one: `OPENING`, with the value the
 * file gave as its cost, through `InventoryService`, which means the negative-stock rules, the unit
 * conversions and the idempotency are the ones the rest of the product uses. Nothing here keeps its
 * own count of anything.
 */
import { invalid, money, toQuantityString, type CompanyId, type IsoDate, type Money, type UserId } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import type { InventoryService } from '../../../inventory/src/service.ts';
import type { InventoryStore, StockItem, StockMasterData, Warehouse as InventoryWarehouse } from '../../../inventory/src/ports.ts';
import { MasterDataService } from '../../../masters/src/masters.ts';
import type { UnitRegistry } from '../../../masters/src/units.ts';
import { normaliseName } from '../../../masters/src/matching.ts';
import type { RequestContext } from '../../../platform/src/types.ts';
import type { OpeningStockWriter, StockLine } from '../ports.ts';

export interface InventoryAdapterOptions {
  readonly branchId: string;
  readonly sessionId: string;
  /** The permissions stock movements are made with. Must include `inventory.move`. */
  readonly permissions: readonly string[];
}

export class InventoryMigrationAdapter implements OpeningStockWriter {
  readonly #inventory: InventoryService;
  readonly #store: InventoryStore;
  readonly #masters: MasterDataService;
  readonly #options: InventoryAdapterOptions;

  constructor(inventory: InventoryService, store: InventoryStore, masters: MasterDataService, options: InventoryAdapterOptions) {
    this.#inventory = inventory;
    this.#store = store;
    this.#masters = masters;
    this.#options = options;
  }

  #actor(companyId: CompanyId, actorId: UserId): ActorContext {
    return {
      companyId,
      branchId: this.#options.branchId as ActorContext['branchId'],
      userId: actorId,
      permissions: this.#options.permissions,
    };
  }

  #context(companyId: CompanyId): RequestContext {
    return {
      companyId,
      branchId: this.#options.branchId,
      actorId: 'migration',
      permissions: new Set(),
      sessionId: this.#options.sessionId,
    };
  }

  /**
   * Finds the item the file is talking about.
   *
   * An exact code or name wins outright. Otherwise GPT 3's name resolution decides, and it returns
   * "ambiguous" rather than a guess when two items are equally close — in which case this returns
   * nothing and the import stops with the name the file used, because picking one of two items
   * would put stock against the wrong thing.
   */
  async resolveItem(companyId: CompanyId, reference: string): Promise<{ itemId: string; name: string; baseUnit: string } | null> {
    const context = this.#context(companyId);
    const wanted = reference.trim();
    const items = this.#masters.items(context);
    const exact =
      items.find((item) => item.code !== undefined && item.code.toLowerCase() === wanted.toLowerCase()) ??
      items.find((item) => item.name.toLowerCase() === wanted.toLowerCase()) ??
      items.find((item) => normaliseName(item.name) === normaliseName(wanted));
    if (exact !== undefined) return { itemId: exact.id, name: exact.name, baseUnit: exact.baseUnit };

    const outcome = this.#masters.resolveItem(context, wanted);
    return outcome.status === 'resolved'
      ? { itemId: outcome.record.id, name: outcome.record.name, baseUnit: outcome.record.baseUnit }
      : null;
  }

  /** The named godown, or the only one there is when the file does not say. */
  async resolveWarehouse(companyId: CompanyId, reference: string | null): Promise<{ warehouseId: string; name: string } | null> {
    const warehouses = this.#masters.warehouses(this.#context(companyId));
    if (reference === null || reference.trim() === '') {
      const only = warehouses.length === 1 ? warehouses[0] : undefined;
      return only === undefined ? null : { warehouseId: only.id, name: only.name };
    }
    const wanted = reference.trim().toLowerCase();
    const found = warehouses.find((warehouse) => warehouse.code.toLowerCase() === wanted || warehouse.name.toLowerCase() === wanted);
    return found === undefined ? null : { warehouseId: found.id, name: found.name };
  }

  async record(
    companyId: CompanyId,
    actorId: UserId,
    line: StockLine,
    options: { readonly idempotencyKey: string; readonly asOn: IsoDate; readonly batchId: string | null },
  ): Promise<{ movementId: string }> {
    const actor = this.#actor(companyId, actorId);
    const item = this.#masters.item(this.#context(companyId), line.itemId);
    let batchId: string | null = null;
    if (item.trackBatches) {
      if (options.batchId === null) {
        throw invalid(
          'MIGRATION_BATCH_REQUIRED',
          `"${item.name}" is kept in batches, so the stock file needs a batch column for it.`,
          { details: { itemId: line.itemId } },
        );
      }
      batchId = this.#batchIdFor(companyId, line.itemId, options.batchId, options.asOn);
    }

    // The unit cost is what the file's value comes to per unit; the stock ledger values every
    // movement in, so an opening line with no value is worth nothing rather than worth a guess.
    const unitCost: Money | null =
      line.quantity.scaled === 0n ? null : money((line.value.minor * 1_000_000n) / line.quantity.scaled);

    const movement = await this.#inventory.recordMovement(actor, {
      idempotencyKey: options.idempotencyKey,
      itemId: line.itemId,
      warehouseId: line.warehouseId,
      batchId,
      kind: 'OPENING',
      quantity: line.quantity,
      unitCost,
      documentDate: options.asOn,
      source: { kind: 'migration', id: options.idempotencyKey, number: null },
      reason: 'Opening stock brought in from another system',
    });
    return { movementId: movement.id };
  }

  /**
   * The batch record for a batch number from the file.
   *
   * Keyed on the item and the batch number, so the same batch appearing on two rows — or the file
   * being brought in twice — lands on one batch record rather than making a second one.
   */
  #batchIdFor(companyId: CompanyId, itemId: string, batchNumber: string, asOn: IsoDate): string {
    const created = this.#masters.createBatch(
      this.#context(companyId),
      { itemId, batchNumber },
      { idempotencyKey: `migration:batch:${itemId}:${batchNumber}`, effectiveFrom: asOn },
    );
    return created.record.id;
  }

  async valueOf(companyId: CompanyId, itemId: string, warehouseId: string): Promise<Money> {
    const actor = this.#actor(companyId, 'migration' as UserId);
    const value = await this.#inventory.value(actor, { itemId, warehouseId });
    return value.value;
  }

  /**
   * Whether the opening quantity is all still there.
   *
   * Asked for every line before a rollback touches anything. If some of it has been sold, the
   * import cannot be un-done — the sale is a real event, and pretending the goods were never
   * received would leave stock below zero.
   */
  async canReverse(companyId: CompanyId, movementId: string): Promise<{ ok: boolean; why: string | null }> {
    const movement = await this.#store.movements.findById(companyId, movementId);
    if (movement === null) return { ok: true, why: null };
    const actor = this.#actor(companyId, 'migration' as UserId);
    const balance = await this.#inventory.balance(actor, {
      itemId: movement.itemId,
      warehouseId: movement.warehouseId,
      ...(movement.batchId === null ? {} : { batchId: movement.batchId }),
    });
    if (balance.physical.scaled >= movement.quantity.scaled) return { ok: true, why: null };
    return {
      ok: false,
      why: `Only ${toQuantityString(balance.physical)} ${balance.physical.unit} of the ${toQuantityString(movement.quantity)} ${movement.quantity.unit} this import brought in is still in the godown.`,
    };
  }

  async reverse(
    companyId: CompanyId,
    actorId: UserId,
    movementId: string,
    options: { readonly idempotencyKey: string; readonly reason: string; readonly on: IsoDate },
  ): Promise<void> {
    const movement = await this.#store.movements.findById(companyId, movementId);
    if (movement === null) return;
    const actor = this.#actor(companyId, actorId);
    await this.#inventory.recordMovement(actor, {
      idempotencyKey: options.idempotencyKey,
      itemId: movement.itemId,
      warehouseId: movement.warehouseId,
      batchId: movement.batchId,
      kind: 'REVERSAL_OUT',
      quantity: movement.quantity,
      unitCost: movement.unitCost,
      documentDate: options.on,
      source: movement.source,
      reason: options.reason,
    });
  }
}

/**
 * The slice of master data the stock ledger asks for, answered from GPT 3's real master data.
 *
 * `InventoryService` needs to know an item's base unit and whether it is batched or serialised.
 * Without this the running app would have to keep a second, hand-written list of items — and an
 * item imported into master data would be invisible to stock, which is exactly the kind of gap
 * issue #76 is about.
 */
export class MastersStockData implements StockMasterData {
  readonly #masters: MasterDataService;
  readonly #options: InventoryAdapterOptions;

  constructor(masters: MasterDataService, options: InventoryAdapterOptions) {
    this.#masters = masters;
    this.#options = options;
  }

  #context(companyId: CompanyId): RequestContext {
    return { companyId, branchId: this.#options.branchId, actorId: 'stock', permissions: new Set(), sessionId: this.#options.sessionId };
  }

  item(companyId: CompanyId, itemId: string): StockItem | undefined {
    const found = this.#masters.items(this.#context(companyId)).find((item) => item.id === itemId);
    return found === undefined
      ? undefined
      : { itemId: found.id, name: found.name, baseUnit: found.baseUnit, tracksBatches: found.trackBatches, tracksSerials: found.trackSerials };
  }

  warehouse(companyId: CompanyId, warehouseId: string): InventoryWarehouse | undefined {
    const found = this.#masters.warehouses(this.#context(companyId)).find((warehouse) => warehouse.id === warehouseId);
    return found === undefined ? undefined : { warehouseId: found.id, name: found.name };
  }

  units(): UnitRegistry {
    return this.#masters.units;
  }
}
