/**
 * Issue #367 — a second server. Run as its own process by concurrency.integration.test.ts: it
 * records `count` one-crate sales for a shop another process set up, all at once, and prints how
 * many went through.
 */
import { createDatabase } from '../../platform/src/database.ts';
import { makePilot } from './record-sale-pilot.ts';

const [companyId, userId, partyId, prefix, count] = process.argv.slice(2) as [string, string, string, string, string];
const db = createDatabase(process.env.DATABASE_URL);
const shop = makePilot(db, { companyId, userId, partyId });
// Ten sales in flight at a time, as a server with a request queue would send them: enough to overlap
// with the other process on every bill, without waiting on the pool longer than a real request would.
const outcomes: PromiseSettledResult<unknown>[] = [];
for (let start = 0; start < Number(count); start += 10) {
  outcomes.push(...await Promise.allSettled(Array.from({ length: Math.min(10, Number(count) - start) }, (_x, i) => shop.recordSale(`${prefix}-${start + i}`, '1'))));
}
const failed = outcomes.filter((o) => o.status === 'rejected').map((o) => String((o as PromiseRejectedResult).reason));
process.stdout.write(`${JSON.stringify({ issued: outcomes.length - failed.length, failed: failed.slice(0, 3) })}\n`);
await db.close();
