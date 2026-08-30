/**
 * Issue #37 [E37] — the seams this module writes through.
 *
 * Nothing here re-implements anybody's module. Customers, suppliers and items belong to GPT 3's
 * master data (#5); stock belongs to inventory (#12); balances belong to the ledger (#4), which this
 * module calls directly because the ledger is GPT 1's own. Each of those is reached through a
 * narrow port so the rules in this package can be tested on their own — and `src/adapters/` holds
 * the real implementations over the real services, so nothing ships against a mock.
 */
import type { CompanyId, IsoDate, Money, UserId } from '@invoice/kernel';
import type { MatchableRecord } from '../../masters/src/matching.ts';
import type { Quantity } from '../../masters/src/units.ts';
import type { CustomerRow, ImportBatch, ItemRow } from './model.ts';

/** A master record as this module needs to see it: enough to match on, and an id to write against. */
export interface ExistingRecord extends MatchableRecord {
  readonly id: string;
}

/** What the business already has. Read-only; used for duplicate control and for resolving names. */
export interface ExistingMasters {
  parties(companyId: CompanyId, kind: 'CUSTOMER' | 'SUPPLIER'): Promise<readonly ExistingRecord[]>;
  items(companyId: CompanyId): Promise<readonly ExistingRecord[]>;
}

export interface CreatedParty {
  readonly partyId: string;
  readonly name: string;
}

export interface CreatedItem {
  readonly itemId: string;
  readonly name: string;
  readonly baseUnit: string;
}

/**
 * What happened to one row.
 *
 * Master data has its own duplicate control, and it refuses a name that is all but identical to
 * one already there even when the importer thought the row was new. That refusal is an outcome of
 * the row, not a failure of the import: the other nineteen hundred rows still belong in the books,
 * so it comes back as a value and is reported, rather than thrown and losing the file.
 */
export type WriteOutcome<T> =
  | { readonly status: 'created'; readonly record: T }
  | { readonly status: 'refused_as_duplicate'; readonly why: string };

/** Writing master data. Implemented over GPT 3's `MasterDataService` in `adapters/masters.ts`. */
export interface MasterWriter {
  createParty(
    companyId: CompanyId,
    actorId: UserId,
    row: CustomerRow,
    options: { readonly idempotencyKey: string; readonly effectiveFrom: IsoDate },
  ): Promise<WriteOutcome<CreatedParty>>;
  createItem(
    companyId: CompanyId,
    actorId: UserId,
    row: ItemRow,
    options: { readonly idempotencyKey: string; readonly effectiveFrom: IsoDate },
  ): Promise<WriteOutcome<CreatedItem>>;
  /** Rollback: a record this batch created is switched off, never deleted, so the trail survives. */
  deactivate(
    companyId: CompanyId,
    actorId: UserId,
    kind: 'party' | 'item',
    id: string,
    options: { readonly idempotencyKey: string; readonly reason: string },
  ): Promise<void>;
}

export interface StockLine {
  readonly itemId: string;
  readonly warehouseId: string;
  readonly batchId: string | null;
  readonly quantity: Quantity;
  readonly value: Money;
}

/** Opening stock. Implemented over the real `InventoryService` in `adapters/inventory.ts`. */
export interface OpeningStockWriter {
  /** Resolves what the file called an item to an item the books know. */
  resolveItem(companyId: CompanyId, reference: string): Promise<{ itemId: string; name: string; baseUnit: string } | null>;
  resolveWarehouse(companyId: CompanyId, reference: string | null): Promise<{ warehouseId: string; name: string } | null>;
  record(
    companyId: CompanyId,
    actorId: UserId,
    line: StockLine,
    options: { readonly idempotencyKey: string; readonly asOn: IsoDate; readonly batchId: string | null },
  ): Promise<{ movementId: string }>;
  /** Reads back what stock actually says, so the reconciliation is not a copy of the input. */
  valueOf(companyId: CompanyId, itemId: string, warehouseId: string): Promise<Money>;
  /**
   * Whether the opening quantity can still be taken back out.
   *
   * Checked for every line **before** any of them is reversed, so a rollback either happens
   * completely or does not start — stock that has already been sold cannot be un-received, and
   * finding that out halfway would leave the books in a state nobody asked for.
   */
  canReverse(companyId: CompanyId, movementId: string): Promise<{ readonly ok: boolean; readonly why: string | null }>;
  /** Rollback: takes the opening quantity back out. Blocked if it has already been sold. */
  reverse(
    companyId: CompanyId,
    actorId: UserId,
    movementId: string,
    options: { readonly idempotencyKey: string; readonly reason: string; readonly on: IsoDate },
  ): Promise<void>;
}

/** Where batches live between the file arriving and somebody approving the mapping. */
export interface MigrationBatchStore {
  findById(companyId: CompanyId, id: string): Promise<ImportBatch | null>;
  findByDigest(companyId: CompanyId, digest: string): Promise<ImportBatch | null>;
  list(companyId: CompanyId): Promise<readonly ImportBatch[]>;
  insert(batch: ImportBatch): Promise<void>;
  update(batch: ImportBatch, expectedVersion: number): Promise<void>;
}

/** The file's text, kept with the batch so a preview, a commit and an error file all read the same bytes. */
export interface MigrationSourceStore {
  putSource(companyId: CompanyId, batchId: string, text: string): Promise<void>;
  source(companyId: CompanyId, batchId: string): Promise<string | null>;
}
