/**
 * Issue #345 — the worker: a separate process that does the work that must not run inside a
 * customer's request. It sends what bills queued in the outbox (the e-invoice, after the bill has
 * committed) and runs each company's recurring jobs from `recurring_work_status`.
 *
 * Any number of workers may run at once: every message and every job is claimed with
 * `FOR UPDATE SKIP LOCKED` and a lease, and its result is saved only while the claim is still
 * the worker's. A worker killed mid-job leaves the claim to lapse; the next worker picks the job up
 * and the job's idempotency key makes the repeat the same request (the portal answers a repeated
 * e-invoice with the IRN it already gave). Same code as the API, different entrypoint.
 *
 *   DATABASE_URL=… npm run worker
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECURRING_LEASE_MS } from '../../../ops/operations/src/recurring-postgres.ts';
import { reportError } from '../../../packages/platform/src/error-reporting.ts';
import { installErrorReporting } from './error-reporting.ts';
import { log } from './log.ts';
import { openPersistence } from './persistence.ts';
import { startRuntime } from './runtime.ts';

/** How often the worker looks for due work when it found none. */
const IDLE_MS = Number(process.env.WORKER_IDLE_MS ?? 5_000);

export async function runWorker(signal: AbortSignal): Promise<void> {
  const persistence = await openPersistence();
  if (persistence.kind !== 'postgres') throw new Error('The worker needs its database: set DATABASE_URL.');
  const runtime = startRuntime(persistence);
  const db = persistence.db;
  log.info('The worker is running', {});
  try {
    while (!signal.aborted) {
      // Company ids only: the function cannot show anything else of any company (migration …worker_finds_due_work).
      const { rows } = await db.query('SELECT companies_with_due_work(make_interval(secs => $1)) AS id', [RECURRING_LEASE_MS / 1000]);
      let worked = false;
      for (const row of rows) {
        if (signal.aborted) break;
        try {
          worked = (await runtime.workOn(String(row.id))) || worked;
        } catch (error) {
          // One company's trouble never stops the others; the job itself keeps its failure for the operator.
          reportError('worker.company', error, { company: String(row.id) });
        }
      }
      // Straight on while there was work; otherwise a pause (a company this process cannot open stays due).
      if (!worked) await new Promise((done) => { const timer = setTimeout(done, IDLE_MS); signal.addEventListener('abort', () => { clearTimeout(timer); done(undefined); }, { once: true }); });
    }
  } finally {
    await db.close();
    log.info('The worker has stopped', {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installErrorReporting();
  const stop = new AbortController();
  // Finishes the company it is on, then stops; anything it had claimed and not finished is picked up again.
  for (const name of ['SIGTERM', 'SIGINT'] as const) process.once(name, () => stop.abort());
  await runWorker(stop.signal);
}
