/**
 * Issue #488 — the app's use of the purchase inbox holding. With a database the app gets the
 * PostgreSQL holding (a held message survives a new process), without one the in-memory holding,
 * and the worker's sweep removes unrouted documents past the retention period (decision 0010).
 *
 * Needs DATABASE_URL (the owner). Skipped locally without it; fails in CI.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { createDatabase } from '../../../packages/platform/src/database.ts';
import { InMemoryInboxHolding } from '../../../packages/purchasing/src/inbox-holding.ts';
import { PostgresInboxHolding } from '../../../packages/purchasing/src/inbox-holding-postgres.ts';
import { MEMORY } from '../src/persistence.ts';
import { purchaseInboxHolding, sweepHeldInbox } from '../src/purchase-inbox-holding.ts';
import { appDatabase } from './processes.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the holding tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';

let database: Awaited<ReturnType<typeof appDatabase>> | undefined;
before(async () => { if (url !== undefined) database = await appDatabase(url); });
after(async () => { await database?.close(); });

test('without a database the app keeps the holding in memory; with one, in PostgreSQL', { skip }, async () => {
  assert.ok(purchaseInboxHolding(MEMORY) instanceof InMemoryInboxHolding);
  assert.equal(purchaseInboxHolding(MEMORY), purchaseInboxHolding(MEMORY));
  const db = createDatabase(database!.appUrl);
  try { assert.ok(purchaseInboxHolding({ kind: 'postgres', db }) instanceof PostgresInboxHolding); } finally { await db.close(); }
});

test('the worker sweep removes a document held past 30 days and keeps a recent one', { skip }, async () => {
  const db = createDatabase(database!.appUrl);
  try {
    const holding = new PostgresInboxHolding(db);
    const put = async (daysAgo: number) => {
      const id = randomUUID();
      const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
      await holding.put({
        document: { id, companyId: '__unrouted__', channel: 'email', sender: { channel: 'email', address: 'accounts@supplier.example' }, attachment: { id: 'a', fileName: 'bill.pdf', declaredMimeType: 'application/pdf', sizeBytes: 10, sha256: '0'.repeat(64), storageKey: `held/${id}` }, receivedAt: at, status: 'quarantined', quarantineReason: 'COMPANY_NOT_IDENTIFIED', statusMessage: 'Held.', attempts: 1 },
        keys: { messageKey: null, intakeKey: `k-${id}` }, delivery: {},
      }, []);
      return id;
    };
    const [old, recent] = [await put(31), await put(29)];
    const swept = await sweepHeldInbox(db);
    assert.ok(swept.expired >= 1);
    assert.equal(await holding.get(old), null);
    assert.ok(await holding.get(recent));
  } finally { await db.close(); }
});
