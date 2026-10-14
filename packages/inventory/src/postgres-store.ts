/**
 * Issue #366 — stock movements and holds in PostgreSQL, on the tables of #365
 * (docs/contracts/sales-schema-v1.md). It behaves as `InMemoryInventoryStore`.
 *
 *  - Writes join the action's unit of work; a write outside one throws `NO_UNIT_OF_WORK`. Reads use
 *    `tenantTransaction`, which joins an open unit of work and so sees its own writes.
 *  - A movement is inserted and nothing else: the database moves `stock_balances` by itself, and
 *    refuses a movement that would take it below nothing. That refusal is the same "not enough
 *    stock" the service gives, because two tills can still race past the service's own check.
 *  - Which holds count is the service's decision, exactly as in memory: every `HELD` row, until
 *    `expireStaleReservations` moves it on.
 */
import { conflict, money, notAllowed, notFound, type CompanyId, type IsoDate } from '@invoice/kernel';
import type { Page } from '@invoice/sales';
import type { SqlExecutor, TransactionalExecutor } from '../../platform/src/database.ts';
import type { Reservation, StockMovement } from './model.ts';
import type { InventoryStore, MovementFilter, MovementRepository, ReservationRepository } from './ports.ts';

type Row = Record<string, unknown>;
const big = (v: unknown): bigint => BigInt(String(v));
const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const time = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));
const placeholders = (count: number): string => Array.from({ length: count }, (_, i) => `$${i + 1}`).join(', ');

/** Keyset paging in id order, as the in-memory `pageOf`. */
const paged = (where: string, values: unknown[], page: Page | undefined, order: string): { sql: string; values: unknown[] } => {
  if (page === undefined) return { sql: `${where} ORDER BY ${order}`, values };
  const next = page.after === undefined ? values : [...values, page.after];
  const after = page.after === undefined ? '' : ` AND id > $${next.length}::uuid`;
  return { sql: `${where}${after} ORDER BY id LIMIT $${next.length + 1}`, values: [...next, page.limit] };
};

/** `undefined` is every batch, `null` the stock in no batch, a string that one batch (issue #86). */
const batchClause = (batchId: string | null | undefined, values: unknown[]): string => {
  if (batchId === undefined) return '';
  if (batchId === null) return ' AND batch_id IS NULL';
  values.push(batchId);
  return ` AND batch_id = $${values.length}`;
};

const MOVEMENT_COLUMNS = ['id', 'company_id', 'item_id', 'warehouse_id', 'batch_id', 'serial_numbers', 'kind', 'direction', 'quantity_micro', 'unit_code',
  'entered_quantity_micro', 'entered_unit_code', 'unit_cost_paise', 'document_date', 'source_kind', 'source_id', 'source_number', 'posted_by',
  'posted_at', 'idempotency_key', 'reverses_movement_id', 'reason'];
const MOVEMENT_READ = MOVEMENT_COLUMNS.map((c) => (c === 'document_date' ? 'document_date::text AS document_date' : c)).join(', ');
/**
 * Unpaged, in the order the stock ledger is read. ponytail: two movements of one item posted in the
 * same millisecond come back in id order, not in the order they were written; a sequence column
 * if weighted-average valuation ever needs that tie broken by insertion.
 */
const MOVEMENT_ORDER = 'document_date, posted_at, id';

const toMovement = (r: Row): StockMovement => ({
  id: String(r.id),
  companyId: r.company_id as CompanyId,
  itemId: String(r.item_id),
  warehouseId: String(r.warehouse_id),
  batchId: text(r.batch_id),
  serialNumbers: r.serial_numbers as string[],
  kind: r.kind as StockMovement['kind'],
  direction: r.direction as StockMovement['direction'],
  quantity: { scaled: big(r.quantity_micro), unit: String(r.unit_code) },
  enteredQuantity: { scaled: big(r.entered_quantity_micro), unit: String(r.entered_unit_code) },
  unitCost: r.unit_cost_paise === null ? null : money(big(r.unit_cost_paise)),
  documentDate: r.document_date as IsoDate,
  source: { kind: String(r.source_kind), id: String(r.source_id), number: text(r.source_number) },
  postedBy: r.posted_by as StockMovement['postedBy'],
  postedAt: time(r.posted_at) as string,
  idempotencyKey: String(r.idempotency_key),
  reversesMovementId: text(r.reverses_movement_id),
  reason: text(r.reason),
});

const RESERVATION_COLUMNS = ['id', 'company_id', 'document_id', 'line_id', 'item_id', 'warehouse_id', 'batch_id', 'quantity_micro', 'unit_code', 'state',
  'created_by', 'created_at', 'expires_at', 'settled_at'];
const RESERVATION_READ = RESERVATION_COLUMNS.join(', ');

const toReservation = (r: Row): Reservation => ({
  id: String(r.id),
  companyId: r.company_id as CompanyId,
  documentId: String(r.document_id),
  lineId: String(r.line_id),
  itemId: String(r.item_id),
  warehouseId: String(r.warehouse_id),
  batchId: text(r.batch_id),
  quantity: { scaled: big(r.quantity_micro), unit: String(r.unit_code) },
  state: r.state as Reservation['state'],
  createdBy: r.created_by as Reservation['createdBy'],
  createdAt: time(r.created_at) as string,
  expiresAt: time(r.expires_at) as string,
  settledAt: time(r.settled_at),
});

export class PostgresInventoryStore implements InventoryStore {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  #read<T>(companyId: CompanyId, work: (sql: SqlExecutor) => Promise<T>): Promise<T> {
    return this.#db.tenantTransaction(companyId, work);
  }

  async #movements(companyId: CompanyId, where: string, values: unknown[], page?: Page): Promise<StockMovement[]> {
    const q = paged(`company_id = $1${where}`, [companyId, ...values], page, MOVEMENT_ORDER);
    const { rows } = await this.#read(companyId, (sql) => sql.query(`SELECT ${MOVEMENT_READ} FROM stock_movements WHERE ${q.sql}`, q.values));
    return rows.map(toMovement);
  }

  async #reservations(companyId: CompanyId, where: string, values: unknown[], page?: Page): Promise<Reservation[]> {
    const q = paged(`company_id = $1${where}`, [companyId, ...values], page, 'created_at, id');
    const { rows } = await this.#read(companyId, (sql) => sql.query(`SELECT ${RESERVATION_READ} FROM stock_reservations WHERE ${q.sql}`, q.values));
    return rows.map(toReservation);
  }

  readonly movements: MovementRepository = {
    insert: async (m: StockMovement): Promise<void> => {
      const sql = this.#db.requireUnitOfWork(m.companyId).sql;
      try {
        await sql.query(`INSERT INTO stock_movements (${MOVEMENT_COLUMNS.join(', ')}) VALUES (${placeholders(MOVEMENT_COLUMNS.length)})`, [
          m.id, m.companyId, m.itemId, m.warehouseId, m.batchId, JSON.stringify(m.serialNumbers), m.kind, m.direction, m.quantity.scaled.toString(),
          m.quantity.unit, m.enteredQuantity.scaled.toString(), m.enteredQuantity.unit, m.unitCost?.minor.toString() ?? null, m.documentDate,
          m.source.kind, m.source.id, m.source.number, m.postedBy, m.postedAt, m.idempotencyKey, m.reversesMovementId, m.reason,
        ]);
      } catch (error) {
        const { code, constraint } = error as { code?: string; constraint?: string };
        if (code === '23505') throw conflict('STOCK_DUPLICATE_MOVEMENT', 'This stock movement was already recorded.');
        // Stock never goes below nothing (#262). The service checks first; this is the database's
        // answer when another till took the goods between that check and this write.
        if (code === '23514' && constraint === 'stock_balances_never_negative') {
          throw notAllowed('STOCK_WOULD_GO_NEGATIVE', 'There is not enough of this item in the godown. Someone else may have just sold it; please check the stock and try again.');
        }
        throw error;
      }
    },
    findByIdempotencyKey: async (companyId: CompanyId, key: string): Promise<StockMovement | null> =>
      (await this.#movements(companyId, ' AND idempotency_key = $2', [key]))[0] ?? null,
    findById: async (companyId: CompanyId, id: string): Promise<StockMovement | null> =>
      (await this.#movements(companyId, ' AND id = $2', [id]))[0] ?? null,
    list: async (companyId: CompanyId, filter: MovementFilter = {}, page?: Page): Promise<StockMovement[]> => {
      const values: unknown[] = [companyId];
      let where = '';
      if (filter.itemId !== undefined) { values.push(filter.itemId); where += ` AND item_id = $${values.length}`; }
      if (filter.warehouseId !== undefined) { values.push(filter.warehouseId); where += ` AND warehouse_id = $${values.length}`; }
      where += batchClause(filter.batchId, values);
      if (filter.from !== undefined) { values.push(filter.from); where += ` AND document_date >= $${values.length}`; }
      if (filter.to !== undefined) { values.push(filter.to); where += ` AND document_date <= $${values.length}`; }
      return this.#movements(companyId, where, values.slice(1), page);
    },
    listBySource: (companyId: CompanyId, sourceKind: string, sourceId: string, page?: Page): Promise<StockMovement[]> =>
      this.#movements(companyId, ' AND source_kind = $2 AND source_id = $3', [sourceKind, sourceId], page),
  };

  readonly reservations: ReservationRepository = {
    insert: async (r: Reservation): Promise<void> => {
      await this.#db.requireUnitOfWork(r.companyId).sql.query(
        `INSERT INTO stock_reservations (${RESERVATION_COLUMNS.join(', ')}) VALUES (${placeholders(RESERVATION_COLUMNS.length)})`,
        [r.id, r.companyId, r.documentId, r.lineId, r.itemId, r.warehouseId, r.batchId, r.quantity.scaled.toString(), r.quantity.unit, r.state,
          r.createdBy, r.createdAt, r.expiresAt, r.settledAt],
      );
    },
    update: async (r: Reservation): Promise<void> => {
      const { rows } = await this.#db.requireUnitOfWork(r.companyId).sql.query(
        `UPDATE stock_reservations SET document_id = $3, line_id = $4, item_id = $5, warehouse_id = $6, batch_id = $7, quantity_micro = $8,
           unit_code = $9, state = $10, created_by = $11, created_at = $12, expires_at = $13, settled_at = $14, updated_at = now()
          WHERE company_id = $1 AND id = $2 RETURNING id`,
        [r.companyId, r.id, r.documentId, r.lineId, r.itemId, r.warehouseId, r.batchId, r.quantity.scaled.toString(), r.quantity.unit, r.state,
          r.createdBy, r.createdAt, r.expiresAt, r.settledAt],
      );
      if (rows.length === 0) throw notFound('STOCK_RESERVATION_NOT_FOUND', 'That hold on stock no longer exists.');
    },
    findById: async (companyId: CompanyId, id: string): Promise<Reservation | null> =>
      (await this.#reservations(companyId, ' AND id = $2', [id]))[0] ?? null,
    listHeld: (companyId: CompanyId, filter: { itemId?: string; warehouseId?: string; batchId?: string | null } = {}, page?: Page): Promise<Reservation[]> => {
      const values: unknown[] = [companyId];
      let where = " AND state = 'HELD'";
      if (filter.itemId !== undefined) { values.push(filter.itemId); where += ` AND item_id = $${values.length}`; }
      if (filter.warehouseId !== undefined) { values.push(filter.warehouseId); where += ` AND warehouse_id = $${values.length}`; }
      where += batchClause(filter.batchId, values);
      return this.#reservations(companyId, where, values.slice(1), page);
    },
    listForDocument: (companyId: CompanyId, documentId: string, page?: Page): Promise<Reservation[]> =>
      this.#reservations(companyId, ' AND document_id = $2', [documentId], page),
  };
}
