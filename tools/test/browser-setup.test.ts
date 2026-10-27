/** Issue #350 — the browser suite's counter reset fails closed: it never touches a database it was not told is a test one. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { testDatabaseUrl } from '../../tests/browser/global-setup.ts';

test('#350: the browser setup clears counters only on a database marked as a test one, with NODE_ENV=test', () => {
  const real = 'postgresql://invoice:secret@db.example.invalid:5432/karobar';
  assert.throws(() => testDatabaseUrl({ DATABASE_URL: real }), /only with NODE_ENV=test/, 'no NODE_ENV is not a test');
  assert.throws(() => testDatabaseUrl({ NODE_ENV: 'development', DATABASE_URL: real }), /only with NODE_ENV=test/);
  assert.throws(() => testDatabaseUrl({ NODE_ENV: 'test' }), /DATABASE_URL is not set/, 'no fallback database');
  assert.throws(() => testDatabaseUrl({ NODE_ENV: 'test', DATABASE_URL: real }), /not marked as a test database/);
  assert.throws(() => testDatabaseUrl({ NODE_ENV: 'test', DATABASE_URL: real, KAROBAR_TEST_DATABASE: 'yes' }), /not marked/, 'only exactly 1 marks it');
  assert.equal(testDatabaseUrl({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://invoice:invoice@localhost:5432/invoice_test' }), 'postgresql://invoice:invoice@localhost:5432/invoice_test');
  assert.equal(testDatabaseUrl({ NODE_ENV: 'test', DATABASE_URL: real, KAROBAR_TEST_DATABASE: '1' }), real);
});
