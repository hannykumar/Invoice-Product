/**
 * Issue #366 — two API processes on one database are one shop.
 *
 * Two real server processes are started on one PostgreSQL. A customer, a supplier or an item saved
 * through one is on the other's very next answer; the same retry reaching both makes one record; one
 * GST number cannot be claimed twice by going to the other process; and after both are killed and one
 * is started again, nothing is missing.
 *
 * Needs DATABASE_URL (the owner, for migrations). Skipped locally without it; fails in CI.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import type { ChildProcess } from 'node:child_process';
import { syntheticGstin } from '../../../packages/masters/src/fixtures.ts';
import { signInOverHttp } from './sign-in-helper.ts';
import { appDatabase, callApi, freePort, killProcess, startApi } from './processes.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the two-process test runs.');
const skip = url === undefined && 'DATABASE_URL is not set';

const COMPANY = '00000000-0000-4000-8000-000000000001';
let database: Awaited<ReturnType<typeof appDatabase>> | undefined;
const servers: { port: number; process: ChildProcess; call: ReturnType<typeof callApi>; token: string }[] = [];

const startOne = async (): Promise<(typeof servers)[number]> => {
  const port = await freePort();
  const process_ = await startApi(database!.appUrl, port);
  const token = (await signInOverHttp(`http://127.0.0.1:${port}`, 'owner@sampoorna.example.invalid', COMPANY)).split('=')[1]!;
  const server = { port, process: process_, call: callApi(port), token };
  servers.push(server);
  return server;
};
const stopAll = async (): Promise<void> => { for (const server of servers.splice(0)) await killProcess(server.process); };

before(async () => { if (url !== undefined) database = await appDatabase(url); });
after(async () => { await stopAll(); await database?.close(); });

const names = async (server: (typeof servers)[number]) => {
  const catalogue = await server.call('GET', '/api/catalogue', undefined, server.token);
  assert.equal(catalogue.status, 200, JSON.stringify(catalogue));
  return {
    customers: catalogue.customers.map((c: { name: string }) => c.name) as string[],
    suppliers: catalogue.suppliers.map((c: { name: string }) => c.name) as string[],
    items: catalogue.items.map((c: { name: string }) => c.name) as string[],
  };
};

test('a customer, a supplier and an item saved by one process are on the other one\'s next answer', { skip }, async () => {
  const run = randomBytes(3).toString('hex');
  const [a, b] = [await startOne(), await startOne()];

  const customer = await a.call('POST', '/api/customers', { name: `Two Process Stores ${run}`, registration: 'unregistered', stateCode: '29', pincode: '560058', city: 'Bengaluru', address1: '12 MG Road', acknowledgeSimilar: true }, a.token);
  assert.equal(customer.status, 200, JSON.stringify(customer));
  assert.ok((await names(b)).customers.includes(`Two Process Stores ${run}`), 'process B sees the customer process A just saved');

  const gstin = syntheticGstin('29', `AABCT${String(Math.floor(Math.random() * 9000) + 1000)}C`);
  const supplier = await b.call('POST', '/api/suppliers', { name: `Two Process Steels ${run}`, registration: 'regular', gstin, pincode: '560058', city: 'Bengaluru', address1: '4 Peenya', acknowledgeSimilar: true }, b.token);
  assert.equal(supplier.status, 200, JSON.stringify(supplier));
  assert.ok((await names(a)).suppliers.includes(`Two Process Steels ${run}`), 'process A sees the supplier process B just saved');
  // The GST number is already someone's, whichever process is asked.
  const again = await a.call('POST', '/api/suppliers', { name: `Another Firm Entirely ${run}`, registration: 'regular', gstin, pincode: '560058', city: 'Bengaluru', address1: '9 Other Road', acknowledgeSimilar: true }, a.token);
  assert.notEqual(again.status, 200, 'the same GST number is not accepted twice');

  const item = await a.call('POST', '/api/items', { name: `Two Process Widget ${run}`, hsn: '72142090', unit: 'KGS', price: '50', kind: 'goods', ratePercent: '18', basis: 'Rate this business charges', effectiveFrom: '2026-04-01', acknowledgeSimilar: true }, a.token);
  assert.equal(item.status, 200, JSON.stringify(item));
  assert.ok((await names(b)).items.includes(`Two Process Widget ${run}`));
  const same = { name: `Two Process Widget ${run}`, hsn: '72142090', unit: 'KGS', price: '50', kind: 'goods', ratePercent: '18', basis: 'Rate this business charges', effectiveFrom: '2026-04-01' };
  const retried = await b.call('POST', '/api/items', same, b.token);
  assert.equal(retried.item?.id, item.item.id, 'the same item sent to the other process is the same record, not a second one');
  const twin = await b.call('POST', '/api/items', { ...same, hsn: '72142091' }, b.token);
  assert.notEqual(twin.status, 200, 'a look-alike of an item saved in the other process waits for a yes');
  assert.equal((await names(a)).items.filter((name) => name === `Two Process Widget ${run}`).length, 1);

  // The same save reaching both processes at once is one customer.
  const reference = `double-${run}`;
  const body = { name: `Double Tap Stores ${run}`, registration: 'unregistered', stateCode: '29', pincode: '560058', city: 'Bengaluru', address1: '1 Tap Road', reference, acknowledgeSimilar: true };
  const [x, y] = await Promise.all([a.call('POST', '/api/customers', body, a.token), b.call('POST', '/api/customers', body, b.token)]);
  assert.deepEqual([x.status, y.status], [200, 200], JSON.stringify([x, y]));
  assert.equal(x.customer.id, y.customer.id, 'one record, not two');
  assert.equal((await names(a)).customers.filter((name) => name === `Double Tap Stores ${run}`).length, 1);

  // Both processes die; one comes back. Nothing is missing.
  await stopAll();
  const [back] = [await startOne()];
  const kept = await names(back);
  for (const wanted of [`Two Process Stores ${run}`, `Double Tap Stores ${run}`]) assert.ok(kept.customers.includes(wanted), `${wanted} survived`);
  assert.ok(kept.suppliers.includes(`Two Process Steels ${run}`));
  assert.ok(kept.items.includes(`Two Process Widget ${run}`));
});
