/**
 * Issue #488 — the purchase inbox's holding for documents whose company is not known yet, as the
 * running app uses it. With `DATABASE_URL` it is PostgreSQL (migration `…_inbox_holding`), so a
 * message held for a shared address survives a restart; in memory it is the in-process one, which
 * is what a developer's machine and `npm test` use.
 *
 * Whatever builds `PurchaseInboxService` for an inbound channel passes `purchaseInboxHolding(...)`
 * as its `holding`. The worker (`worker.ts`) runs `sweepHeldInbox` so unrouted documents do not
 * stay past the retention period (decision 0010).
 */
import type { TransactionalExecutor } from '../../../packages/platform/src/database.ts';
import { HOLDING_RETENTION_DAYS, InMemoryInboxHolding, sweepInboxHolding, type HoldingSweepResult, type InboxHolding } from '../../../packages/purchasing/src/inbox-holding.ts';
import { PostgresInboxHolding } from '../../../packages/purchasing/src/inbox-holding-postgres.ts';
import type { Persistence } from './persistence.ts';

let inMemory: InboxHolding | null = null;

export const purchaseInboxHolding = (persistence: Persistence): InboxHolding => {
  if (persistence.kind === 'postgres') return new PostgresInboxHolding(persistence.db);
  inMemory ??= new InMemoryInboxHolding();
  return inMemory;
};

/** Removes what has been held for longer than the retention period. Safe to run from any number of workers. */
export const sweepHeldInbox = (db: TransactionalExecutor, now: Date = new Date()): Promise<HoldingSweepResult> =>
  sweepInboxHolding(new PostgresInboxHolding(db), { now, retentionDays: HOLDING_RETENTION_DAYS });
