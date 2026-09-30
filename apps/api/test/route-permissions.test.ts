/**
 * Issue #280 — every POST route is refused to a read-only viewer unless it is on the allow-list
 * below. The routes are read out of server.ts itself, so a route added tomorrow is walked too: if it
 * has no permission in POST_PERMISSIONS and is not allow-listed here, this file fails.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { handleApi, POST_PERMISSIONS } from '../src/server.ts';

const COMPANY_A = '00000000-0000-4000-8000-000000000001';

/** The only POSTs a signed-in viewer (or nobody at all) may make. Keep this list short. */
const ALLOWED = new Set([
  // Signing in: there is no session yet to hold a permission.
  '/api/auth/login',
  // The government provider's callback: no session, it proves itself by signing the bytes it sent.
  '/api/webhooks/government/:param',
  // Which state a PIN code is in: a lookup in the public PIN table. Reads nothing of the company, stores nothing.
  '/api/pincode/state',
]);

/** Every POST route in server.ts: literal paths, and regex routes as `/…/:param`. */
const postRoutes = (): string[] => {
  const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const handleApi = source.slice(source.indexOf('export async function handleApi('));
  const found: string[] = [];
  let posts = 0;
  for (const match of handleApi.matchAll(/method === 'POST' && ([^)\n]+)/g)) {
    posts += 1;
    const literal = /^pathname === '([^']+)'/.exec(match[1]!);
    if (literal) { found.push(literal[1]!); continue; }
    const variable = /^(\w+)\?\.\[1\]/.exec(match[1]!);
    const pattern = variable && new RegExp(`const ${variable[1]} = /\\^(.+?)\\$/\\.exec\\(pathname\\)`).exec(handleApi);
    if (pattern) found.push(pattern[1]!.replaceAll('\\/', '/').replaceAll('([^/]+)', ':param'));
  }
  assert.equal(found.length, posts, 'every POST in server.ts must be a literal path or a regex route this test can read');
  return found;
};

const call = async (path: string, session?: string, body: Record<string, unknown> = {}) => {
  const response = await handleApi('POST', path.replace(':param', 'probe'), body, session === undefined ? undefined : `Bearer ${session}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const signIn = async (email: string, password: string): Promise<string> => {
  const response = await call('/api/auth/login', undefined, { companyId: COMPANY_A, email, password });
  assert.equal(response.status, 200);
  return response.body.sessionId as string;
};

test('#280: every POST route refuses a read-only viewer before it reads the body, unless allow-listed', async () => {
  const routes = postRoutes();
  assert.ok(routes.length > 100, `only ${routes.length} POST routes were found — the parser has gone wrong`);
  for (const allowed of ALLOWED) assert.ok(routes.includes(allowed), `${allowed} is allow-listed but is no longer a route`);
  for (const gated of Object.keys(POST_PERMISSIONS)) {
    assert.ok(routes.includes(gated), `${gated} has a permission but is no longer a route`);
    assert.ok(!ALLOWED.has(gated), `${gated} is both allow-listed and gated`);
  }

  const viewer = await signIn('viewer@sampoorna.example.invalid', 'viewer-demo');
  const open: string[] = [];
  for (const route of routes) {
    if (ALLOWED.has(route)) continue;
    if (!Object.hasOwn(POST_PERMISSIONS, route)) { open.push(`${route} (no permission in POST_PERMISSIONS)`); continue; }
    // An empty body: a 422 here would mean the handler read it before the permission was checked.
    const { status } = await call(route, viewer);
    if (status !== 401 && status !== 403) open.push(`${route} answered ${status}`);
  }
  assert.deepEqual(open, [], 'these POST routes are open to a read-only viewer');
});

test('#280: the owner holds every permission a route asks for', async () => {
  const owner = await signIn('owner@sampoorna.example.invalid', 'karobar-demo');
  const session = await handleApi('GET', '/api/session', {}, `Bearer ${owner}`);
  const held = new Set<string>(JSON.parse(String(session.body)).permissions);
  for (const [route, gate] of Object.entries(POST_PERMISSIONS)) {
    for (const permission of gate.all) assert.ok(held.has(permission), `the owner lacks ${permission} for ${route}`);
    if (gate.any.length > 0) assert.ok(gate.any.some((permission) => held.has(permission)), `the owner lacks all of ${gate.any.join(', ')} for ${route}`);
  }
});

test('#280: the viewer cannot redirect customer money, and the owner sees every change to where it goes', async () => {
  const owner = await signIn('owner@sampoorna.example.invalid', 'karobar-demo');
  const viewer = await signIn('viewer@sampoorna.example.invalid', 'viewer-demo');
  const upiOf = async () => JSON.parse(String((await handleApi('GET', '/api/branding', {}, `Bearer ${owner}`)).body)).upiId;

  assert.equal((await call('/api/branding/upi', owner, { upiId: 'sampoorna@okhdfcbank' })).status, 200);
  const refused = await call('/api/branding/upi', viewer, { upiId: 'viewer@okicici' });
  assert.equal(refused.status, 403);
  assert.match(refused.body.message, /You cannot change the UPI id customers pay into/);
  assert.equal(await upiOf(), 'sampoorna@okhdfcbank');

  const details = JSON.parse(String((await handleApi('GET', '/api/business-details', {}, `Bearer ${owner}`)).body)).details;
  const refusedDetails = await call('/api/business-details', viewer, { ...details, address1: 'CHANGED BY VIEWER' });
  assert.equal(refusedDetails.status, 403);
  const bank = { ...details, bankName: 'HDFC Bank', accountNumber: '50100012345678', ifsc: 'HDFC0001234' };
  assert.equal((await call('/api/business-details', owner, bank)).status, 200);
  // Saving the same account again is not a change.
  assert.equal((await call('/api/business-details', owner, bank)).status, 200);

  const dashboard = JSON.parse(String((await handleApi('GET', '/api/dashboard', {}, `Bearer ${owner}`)).body));
  const changes = dashboard.activity.filter((item: { kind: string }) => item.kind === 'payee').map((item: { title: string }) => item.title);
  assert.deepEqual(changes, [
    'The bank account customers pay into was set to HDFC Bank, HDFC0001234, account ending 5678',
    'The UPI id customers pay into was set to sampoorna@okhdfcbank',
  ]);
  assert.ok(changes.every((title: string) => !title.includes('50100012345678')), 'the full account number is never shown');
});
