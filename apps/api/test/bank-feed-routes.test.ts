/** Issue #366 — only the bank-feed writes skip the request-wide unit of work, and they keep their gate. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTES } from '../src/routes/index.ts';

test('the bank-feed POST routes open their own units of work, every other route is wrapped as before', () => {
  const own = ROUTES.filter((route) => route.ownUnitsOfWork).map((route) => `${route.method} ${route.path}`).sort();
  assert.deepEqual(own, ['POST /api/bank-feeds/consent', 'POST /api/bank-feeds/consent/complete', 'POST /api/bank-feeds/disconnect', 'POST /api/bank-feeds/sync']);
  for (const route of ROUTES.filter((item) => item.ownUnitsOfWork)) {
    assert.notEqual((route.access as { kind?: string }).kind, 'public', route.path);
    assert.ok(route.input, route.path);
  }
});
