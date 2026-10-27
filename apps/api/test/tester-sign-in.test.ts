/**
 * The owner's request (27 Oct): "Sign in as tester" — the demo owner of Sampoorna Traders, in one
 * click, on a developer's machine only. Anywhere else its endpoint is 404, exactly like a route that
 * does not exist, and the page shows no button.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi, ROUTES } from '../src/server.ts';
import { ApiRuntime } from '../src/runtime.ts';
import { MEMORY } from '../src/persistence.ts';
import { Reply } from '../src/routes/route.ts';
import { ROLES } from '../../../packages/platform/src/roles.ts';
import { tokenFrom } from './sign-in-helper.ts';

test('on a developer\'s machine the button is offered, and one click signs in as the demo owner of Sampoorna Traders', async () => {
  assert.equal((await handleApi('GET', '/api/auth/tester')).status, 200);
  const opened = await handleApi('POST', '/api/auth/tester', {});
  assert.equal(opened.status, 200, String(opened.body));
  assert.match(opened.headers['set-cookie']!, /^__Host-karobar_session=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  const session = JSON.parse(String((await handleApi('GET', '/api/session', {}, `Bearer ${tokenFrom(opened.headers)}`)).body));
  assert.equal(session.company.name, 'Sampoorna Traders');
  assert.deepEqual([...session.permissions].sort(), [...ROLES.owner.permissions].sort());
});

test('outside development the endpoint is 404, word for word like a route that does not exist, so no button shows', async () => {
  const saved = { ...process.env };
  for (const key of ['NODE_ENV', 'DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']) delete process.env[key];
  Object.assign(process.env, { NODE_ENV: 'production', DATABASE_URL: 'postgresql://invoice:invoice@localhost:5432/invoice', SUPABASE_URL: 'https://synthetic-project.supabase.co', SUPABASE_ANON_KEY: 'synthetic-anon-key', KAROBAR_RATE_LIMIT_SECRET: 'p'.repeat(32) });
  try {
    const runtime = new ApiRuntime(MEMORY);
    for (const method of ['GET', 'POST']) {
      const route = ROUTES.find((candidate) => candidate.method === method && candidate.path === '/api/auth/tester')!;
      const reply = await (route.handle as (call: unknown) => Promise<unknown>)({ input: {}, params: {}, runtime, requestId: 'req-tester', delivery: undefined });
      assert.ok(reply instanceof Reply, method);
      assert.deepEqual(reply.result, { status: 404, json: { state: 'failed', title: 'Not found', message: 'That API route does not exist. Nothing was saved.', requestId: 'req-tester' } }, method);
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  const unknown = JSON.parse(String((await handleApi('GET', '/api/auth/no-such-route')).body));
  assert.deepEqual({ ...unknown, requestId: 'req-tester' }, { state: 'failed', title: 'Not found', message: 'That API route does not exist. Nothing was saved.', requestId: 'req-tester' }, 'the same reply as a route that does not exist');
});
