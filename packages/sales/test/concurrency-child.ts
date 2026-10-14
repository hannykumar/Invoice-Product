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
const outcomes = await Promise.allSettled(Array.from({ length: Number(count) }, (_x, i) => shop.recordSale(`${prefix}-${i}`, '1')));
const failed = outcomes.filter((o) => o.status === 'rejected').map((o) => String((o as PromiseRejectedResult).reason));
process.stdout.write(`${JSON.stringify({ issued: outcomes.length - failed.length, failed: failed.slice(0, 3) })}\n`);
await db.close();
