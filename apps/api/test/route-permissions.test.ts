/**
 * Issue #280 — every POST route is refused to a read-only viewer unless it is on the allow-list
 * below. Issue #344: the routes are read from the route table `ROUTES` that the server serves, so a
 * route added tomorrow is walked too, and the table's type will not let it be declared without an
 * access rule. (Before #344 this file read server.ts as text with regexes; that text is gone.)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi, ROUTES } from '../src/server.ts';
import { signIn as signInAs } from './sign-in-helper.ts';

const COMPANY_A = '00000000-0000-4000-8000-000000000001';

/** The only POSTs a signed-in viewer (or nobody at all) may make. Keep this list short. */
const ALLOWED = new Set([
  // Signing in: there is no session yet to hold a permission (#342).
  '/api/auth/code',
  '/api/auth/sign-in',
  // "Sign in as tester": a developer's machine only, 404 everywhere else (tester-sign-in.test.ts).
  '/api/auth/tester',
  // Ending one's own session, and moving it to another business one belongs to (checked against one's memberships).
  '/api/auth/sign-out',
  '/api/session/company',
  // Leaving a business one belongs to (#343): anyone's own choice; the last owner is refused by the team service.
  '/api/team/leave',
  // The government provider's callback: no session, it proves itself by signing the bytes it sent.
  '/api/webhooks/government/:kind',
  // Issue #489 — the email and WhatsApp providers' deliveries: the same, a signature over the bytes (purchase-inbox.test.ts).
  '/api/webhooks/purchase-inbox/:channel',
  // Which state a PIN code is in: a lookup in the public PIN table. Reads nothing of the company, stores nothing.
  '/api/pincode/state',
]);

const POSTS = ROUTES.filter((route) => route.method === 'POST');

const call = async (path: string, session?: string, body: Record<string, unknown> = {}) => {
  const response = await handleApi('POST', path.replace(/:\w+/g, 'probe'), body, session === undefined ? undefined : `Bearer ${session}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const signIn = (email: string): Promise<string> => signInAs(email, COMPANY_A);

test('#344: every route declares who may call it, and only the allow-listed POSTs are ungated', () => {
  assert.ok(POSTS.length > 100, `only ${POSTS.length} POST routes are in the table`);
  for (const route of ROUTES) {
    assert.ok(['gate', 'public', 'signedIn'].includes(route.access.kind), `${route.method} ${route.path} declares no access`);
    if (route.access.kind !== 'gate') assert.ok(route.access.reason.length > 10, `${route.method} ${route.path} is open without saying why`);
    // Nothing but asking for a code, signing in, the status check and the signed webhook is open to someone with no session.
    if (route.access.kind === 'public') assert.ok(['/api/auth/code', '/api/auth/sign-in', '/api/auth/tester', '/api/status', '/api/webhooks/government/:kind', '/api/webhooks/purchase-inbox/:channel'].includes(route.path), `${route.path} needs no session`);
  }
  const paths = POSTS.map((route) => route.path);
  for (const allowed of ALLOWED) assert.ok(paths.includes(allowed), `${allowed} is allow-listed but is no longer a route`);
  for (const route of POSTS) if (route.access.kind === 'gate') assert.ok(!ALLOWED.has(route.path), `${route.path} is both allow-listed and gated`);
  const ungated = POSTS.filter((route) => route.access.kind !== 'gate' && !ALLOWED.has(route.path)).map((route) => route.path);
  assert.deepEqual(ungated, [], 'these POST routes have no permission and are not allow-listed');
});

test('#280: every POST route refuses a read-only viewer before it reads the body, unless allow-listed', async () => {
  const viewer = await signIn('viewer@sampoorna.example.invalid');
  const open: string[] = [];
  for (const route of POSTS) {
    if (ALLOWED.has(route.path)) continue;
    // An empty body: a 422 here would mean the handler read it before the permission was checked.
    const { status } = await call(route.path, viewer);
    if (status !== 401 && status !== 403) open.push(`${route.path} answered ${status}`);
    // A body that is not even an object must still be refused for the permission, not for its shape (#344).
    const garbage = await handleApi('POST', route.path.replace(/:\w+/g, 'probe'), ['not', 'an', 'object'], `Bearer ${viewer}`);
    if (garbage.status !== 403) open.push(`${route.path} answered ${garbage.status} to a viewer's malformed body`);
  }
  assert.deepEqual(open, [], 'these POST routes are open to a read-only viewer');
});

test('#280: the owner holds every permission a route asks for', async () => {
  const owner = await signIn('owner@sampoorna.example.invalid');
  const session = await handleApi('GET', '/api/session', {}, `Bearer ${owner}`);
  const held = new Set<string>(JSON.parse(String(session.body)).permissions);
  for (const route of ROUTES) {
    if (route.access.kind !== 'gate') continue;
    const gate = route.access;
    for (const permission of gate.all) assert.ok(held.has(permission), `the owner lacks ${permission} for ${route.path}`);
    if (gate.any.length > 0) assert.ok(gate.any.some((permission) => held.has(permission)), `the owner lacks all of ${gate.any.join(', ')} for ${route.path}`);
  }
});

test('#280: the viewer cannot redirect customer money, and the owner sees every change to where it goes', async () => {
  const owner = await signIn('owner@sampoorna.example.invalid');
  const viewer = await signIn('viewer@sampoorna.example.invalid');
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
