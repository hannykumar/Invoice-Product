/**
 * Issue #345 — background work that survives a restart, done by a separate worker.
 *
 * Done when: "Killing the worker mid-job and restarting it finishes the job exactly once." A B2B
 * bill from a business above ₹5 crore needs an e-invoice (Notification 13/2020-CT as amended by
 * 10/2023-CT). The bill queues it in its own transaction; a worker claims it, the synthetic portal
 * answers, and the worker is killed before it can save the answer — the worst moment. A second
 * worker takes the message over once its lease has passed, asks again with the same idempotency key,
 * and the bill ends with one registered e-invoice, one IRN and one audit record of it.
 *
 * Also: the API itself sends nothing (no worker, no e-invoice), and recurring work is claimed from
 * the database with a lease, so a run whose worker died is run again, and two workers never run
 * the same job at once.
 *
 * Needs DATABASE_URL (the owner). Skipped locally without it; fails in CI.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import type { ChildProcess } from 'node:child_process';
import type { TransactionalExecutor } from '../../../packages/platform/src/database.ts';
import type { RequestContext } from '../../../packages/platform/src/index.ts';
import { signInOverHttp } from './sign-in-helper.ts';
import { syntheticGstin } from '../../../packages/masters/src/fixtures.ts';
import { appDatabase, callApi, freePort, killProcess, startApi, startProcess, waitFor, WORKER } from './processes.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the worker tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';

const COMPANY = '00000000-0000-4000-8000-000000000001';
let database: Awaited<ReturnType<typeof appDatabase>> | undefined;
let owner: TransactionalExecutor;
let port: number;
let api: ChildProcess | undefined;
const workers: ChildProcess[] = [];

before(async () => {
  if (url === undefined) return;
  database = await appDatabase(url);
  owner = database.owner;
  port = await freePort();
});

after(async () => {
  for (const worker of workers) await killProcess(worker);
  await killProcess(api);
  await database?.close();
});

const worker = (env: Record<string, string> = {}): ChildProcess => {
  const started = startProcess(WORKER, { DATABASE_URL: database!.appUrl, WORKER_IDLE_MS: '500', WORKER_OUTBOX_LEASE_SECONDS: '2', ...env });
  workers.push(started);
  return started;
};

test('a worker killed after the portal answered, before it saved the answer: the e-invoice is registered exactly once', { skip }, async () => {
  const run = randomBytes(3).toString('hex');
  api = await startApi(database!.appUrl, port);
  const call = callApi(port);
  const token = (await signInOverHttp(`http://127.0.0.1:${port}`, 'owner@sampoorna.example.invalid', COMPANY)).split('=')[1]!;
  // Above ₹5 crore and below ₹10 crore: e-invoices are needed, and the 30-day reporting limit does not apply.
  assert.equal((await call('POST', '/api/business-details', { legalName: 'Sampoorna Traders', address1: 'Plot 14, 2nd Phase, Peenya Industrial Area', city: 'Bengaluru', pincode: '560058', stateCode: '29', turnoverBand: '5_TO_10_CRORE' }, token)).status, 200);
  const customer = await call('POST', '/api/customers', { name: `Mysuru Distributors ${run}`, registration: 'regular', gstin: syntheticGstin('29', `BBBCM${String(randomBytes(2).readUInt16BE() % 10_000).padStart(4, '0')}Z`), stateCode: '29', pincode: '570001', city: 'Mysuru', address1: '4 Sayyaji Rao Road', acknowledgeSimilar: true }, token);
  assert.equal(customer.status, 200, JSON.stringify(customer));
  const item = await call('POST', '/api/items', { name: `Machine servicing ${run}`, hsn: '998719', unit: 'NOS', kind: 'service', ratePercent: '18', basis: 'Rate this business charges', effectiveFrom: '2026-04-01', acknowledgeSimilar: true }, token);
  assert.equal(item.status, 200, JSON.stringify(item));
  const sale = await call('POST', '/api/sales/record', { customerId: customer.customer.id, itemId: item.item.id, quantity: '1', rate: '10000', date: new Date().toISOString().slice(0, 10), terms: '30', reference: `worker-${run}` }, token);
  assert.equal(sale.status, 200, JSON.stringify(sale));
  assert.equal(sale.eInvoice?.needed, 'YES', JSON.stringify(sale.eInvoice));
  const bill = String(sale.invoice.id);

  const message = async () => (await owner.query(
    "SELECT attempts, sent_at, dead_at, last_error FROM outbox_messages WHERE company_id = $1 AND topic = 'einvoice.generate' AND dedupe_key = $2", [COMPANY, bill])).rows[0];
  const einvoice = async () => (await owner.query('SELECT status, irn FROM e_invoices WHERE company_id = $1 AND document_id = $2', [COMPANY, bill])).rows;
  // The bill queued it with itself; with no worker running, nothing has been sent.
  assert.deepEqual({ attempts: (await message())?.attempts, sent: (await message())?.sent_at }, { attempts: 0, sent: null });
  assert.equal((await einvoice()).length, 0);

  // The first worker sends it; the portal answers; the worker waits before saving, and is killed.
  const first = worker({ SYNTHETIC_IRP_ANSWER_DELAY_MS: '60000' });
  // A worker process composes the whole app before its first sweep, which is slow on a busy CI machine.
  await waitFor('the e-invoice to be marked as sent and waiting', async () => (await einvoice())[0]?.status === 'PENDING', 90_000);
  await new Promise((resolve) => setTimeout(resolve, 500)); // the portal has answered by now
  await killProcess(first);
  assert.equal((await message())?.sent_at, null, 'the answer was never saved');

  // A second worker takes it over once the lease has passed, and finishes it.
  const second = worker();
  const sent = await waitFor('the second worker to finish the message', async () => { const row = await message(); return row?.sent_at === null ? null : row; }, 90_000);
  // Stopped at once: a worker left polling would hold claims while other test files change the schema.
  await killProcess(second);
  assert.equal(sent.attempts, 2, 'sent twice, once by each worker');
  assert.equal(sent.dead_at, null);
  const records = await einvoice();
  assert.equal(records.length, 1, 'one e-invoice record for the bill');
  assert.equal(records[0]!.status, 'REGISTERED');
  const audits = (await owner.query(
    `SELECT count(*)::int AS n FROM audit_events WHERE company_id = $1 AND action IN ('einvoice.registered', 'einvoice.duplicate_reconciled')
        AND correlation_id = $2`, [COMPANY, bill])).rows[0]!.n;
  assert.equal(audits, 1, 'registered once');

  // The Operations screen reads the same rows: the job, and the company's recurring work.
  const operations = await call('GET', '/api/operations', undefined, token);
  assert.equal(operations.status, 200);
  assert.ok(operations.jobs.some((job: { kind: string; state: string; idempotencyKey: string }) => job.kind === 'einvoice.generate' && job.idempotencyKey === bill && job.state === 'success'));
  assert.ok(operations.recurring.some((row: { jobKey: string }) => row.jobKey === 'einvoice-retry'));

  // A job that gave up is shown as failed and can be put back by an operator.
  await owner.query("UPDATE outbox_messages SET sent_at = NULL, dead_at = now(), last_error = 'IRP_TEMPORARILY_UNAVAILABLE: test' WHERE company_id = $1 AND dedupe_key = $2", [COMPANY, bill]);
  const dead = (await call('GET', '/api/operations', undefined, token)).jobs.find((job: { idempotencyKey: string }) => job.idempotencyKey === bill);
  assert.deepEqual({ state: dead.state, code: dead.lastErrorCode }, { state: 'failure', code: 'IRP_TEMPORARILY_UNAVAILABLE' });
  assert.equal((await call('POST', '/api/operations/jobs/replay', { jobId: dead.id }, token)).status, 200);
  const replayed = await message();
  assert.deepEqual({ dead: replayed?.dead_at, attempts: replayed?.attempts }, { dead: null, attempts: 0 });
});

test('recurring work: a run whose worker died is claimed again after its lease, and two workers never run it at once', { skip }, async () => {
  const { createDatabase } = await import('../../../packages/platform/src/database.ts');
  const { PostgresRecurringWork } = await import('../../../ops/operations/src/recurring-postgres.ts');
  const db = createDatabase(database!.appUrl);
  try {
    const context: RequestContext = { companyId: COMPANY, branchId: '00000000-0000-4000-8000-000000000002', actorId: 'worker-test', sessionId: 'worker-test', permissions: new Set(['queue.replay', 'operations.read']) };
    const key = `test-sweep-${randomBytes(3).toString('hex')}`;
    let runs = 0;
    const slow = { key, name: 'Test sweep', everyMs: 60_000, requiredPermissions: [], maxAttempts: 3, timeoutMs: 5_000, run: async () => { runs += 1; await new Promise((resolve) => setTimeout(resolve, 300)); return { summary: 'swept' }; } };
    const asAction = <T>(work: () => Promise<T>) => work();
    const schedule = new PostgresRecurringWork(db, { leaseMs: 1_000 });
    await schedule.ensure(context, [slow]);

    // Two workers at the same moment: one runs it, the other finds it taken.
    const [a, b] = await Promise.all([schedule.runDue(context, [slow], asAction), schedule.runDue(context, [slow], asAction)]);
    assert.equal(runs, 1);
    assert.equal(a.length + b.length, 1);
    assert.equal([...a, ...b][0]!.outcome, 'success');
    // Not due again until its next slot.
    assert.equal((await schedule.runDue(context, [slow], asAction)).length, 0);

    // A worker claims it and dies: the row is left running, as a killed process leaves it.
    await owner.query("UPDATE recurring_work_status SET outcome = 'running', last_started_at = now(), next_run_at = now() WHERE company_id = $1 AND job_key = $2", [COMPANY, key]);
    assert.equal((await schedule.runDue(context, [slow], asAction)).length, 0, 'not taken over while its lease holds');
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const retaken = await schedule.runDue(context, [slow], asAction);
    assert.equal(runs, 2, 'run again once, by the worker that took it over');
    assert.equal(retaken[0]!.outcome, 'success');
    const status = (await schedule.status(context)).find((row) => row.jobKey === key)!;
    assert.equal(status.summary, 'swept');
  } finally {
    await db.close();
  }
});
