/**
 * A database of its own for a test that runs migrations down and up (#365, #366).
 *
 * Test files run in parallel against one server. Two things kept this from being safe:
 *  - dropping a scratch database WITH (FORCE) ends every connection still open to it, and a
 *    pool with no error handler fails whatever test is running when one of its idle
 *    connections is ended;
 *  - two such tests creating and dropping databases at once.
 * So: the up/down tests take turns (one advisory lock on the shared database, the same family
 * as migrate()'s), the scratch pool is closed before its database is dropped, and the drop is a
 * plain one that never ends anyone else's connection.
 */
import { randomBytes } from 'node:crypto';
import type { TransactionalExecutor } from '../src/database.ts';

/** (363, 1) is migrate(); (363, 2) is the pilot tables; this is the scratch databases. */
const SCRATCH_DATABASES = 3;

export const withScratchDatabase = async <T>(
  owner: TransactionalExecutor, url: string, prefix: string, work: (scratch: TransactionalExecutor) => Promise<T>,
): Promise<T> => {
  const { createDatabase } = await import('../src/database.ts');
  // Held for the whole test on one connection of the owner's pool; CREATE and DROP DATABASE run on
  // another, because they cannot run inside a transaction.
  return owner.transaction(async (lock) => {
    // Waiting for another up/down test to finish is waiting our turn, not a stuck lock: the pool's
    // 15-second lock_timeout would otherwise fail this test whenever the other one runs long.
    await lock.query("SET LOCAL lock_timeout = '10min'");
    await lock.query('SELECT pg_advisory_xact_lock(363, $1)', [SCRATCH_DATABASES]);
    const name = `${prefix}_${randomBytes(6).toString('hex')}`;
    await owner.query(`CREATE DATABASE ${name}`);
    const scratchUrl = new URL(url);
    scratchUrl.pathname = `/${name}`;
    const scratch = createDatabase(scratchUrl.toString());
    try {
      return await work(scratch);
    } finally {
      await scratch.close();
      await owner.query(`DROP DATABASE IF EXISTS ${name}`);
    }
  });
};
