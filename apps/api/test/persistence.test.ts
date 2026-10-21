/** Issue #340 — where the books are kept is decided at start-up, and production never falls back to memory. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { openPersistence, recordId, stableUuid } from '../src/persistence.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('without a database the app runs in memory on a developer machine or in a test', async () => {
  for (const NODE_ENV of [undefined, '', 'development', 'test']) {
    assert.deepEqual(await openPersistence({ NODE_ENV }), { kind: 'memory' });
  }
});

test('anywhere else, a missing DATABASE_URL stops the app instead of keeping books in memory', async () => {
  for (const NODE_ENV of ['production', 'Production', 'staging']) {
    await assert.rejects(openPersistence({ NODE_ENV, DATABASE_URL: '  ' }), /DATABASE_URL is not set/);
  }
});

test('the real server process refuses to start in production without its database', () => {
  const server = fileURLToPath(new URL('../src/server.ts', import.meta.url));
  const { DATABASE_URL: _unset, ...env } = process.env;
  const run = spawnSync(process.execPath, ['--experimental-strip-types', server], { env: { ...env, NODE_ENV: 'production', API_PORT: '0' }, encoding: 'utf8', timeout: 20_000 });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /DATABASE_URL is not set/);
});

test('a named record keeps its name in memory and one fixed UUID in the database', () => {
  const company = '00000000-0000-4000-8000-000000000001';
  assert.equal(recordId({ kind: 'memory' }, company, 'wh-main'), 'wh-main');
  const stored = recordId({ kind: 'postgres', db: {} as never }, company, 'wh-main');
  assert.match(stored, UUID);
  assert.equal(stored, stableUuid(company, 'wh-main'));
  assert.notEqual(stored, stableUuid('00000000-0000-4000-8000-000000000011', 'wh-main'), 'another company gets another id');
});
