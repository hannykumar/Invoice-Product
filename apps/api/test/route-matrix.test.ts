/**
 * Issue #343 — permission tests generated from the route table (`ROUTES`, #344) and the role table
 * (`packages/platform/src/roles.ts`). Nothing here lists routes by hand: a route added tomorrow is
 * walked by every test below the moment it is in the table.
 *
 *  - No session: 401 on every route that is not public.
 *  - Each role, signed in for real (#342): a route its permissions do not cover is 403; one they do
 *    cover is never 403 — the role can do exactly what docs/permissions.md says, nothing more.
 *  - Another company's resource: its id in the path, or a bill's id in the body, is "not found"
 *    (404) and never answered with that company's data.
 */
import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { handleApi, ROUTES } from '../src/server.ts';
import { ROLES, ROLE_NAMES, type RoleName } from '../../../packages/platform/src/roles.ts';
import type { Permission } from '../../../packages/platform/src/index.ts';
import type { Route } from '../src/routes/route.ts';
import { signIn, tokenFrom } from './sign-in-helper.ts';

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const KONKAN = '00000000-0000-4000-8000-000000000011';
/** One synthetic person per role in Sampoorna Traders (packages/platform/src/seed.ts). */
const ADDRESS: Readonly<Record<RoleName, string>> = {
  owner: 'owner@sampoorna.example.invalid',
  admin: 'admin@sampoorna.example.invalid',
  accountant: 'accounts@sampoorna.example.invalid',
  staff: 'staff@sampoorna.example.invalid',
  viewer: 'viewer@sampoorna.example.invalid',
};

/** Routes that end or move the session they are called with: the caller signs in again afterwards. */
const ENDS_SESSION = new Set(['/api/auth/sign-out', '/api/session/company', '/api/team/leave']);

const call = async (route: Pick<Route, 'method' | 'path'>, token: string | undefined, path = route.path.replace(/:\w+/g, 'probe'), body: unknown = {}) => {
  const reply = await handleApi(route.method, path, body, token === undefined ? undefined : `Bearer ${token}`);
  let parsed: Record<string, any> = {};
  try { parsed = JSON.parse(String(reply.body)) as Record<string, any>; } catch { /* a PDF */ }
  return { status: reply.status, body: parsed, text: Buffer.isBuffer(reply.body) ? '' : String(reply.body), headers: reply.headers };
};

const permits = (route: Route, held: readonly Permission[]): boolean => {
  if (route.access.kind !== 'gate') return true;
  const { all, any } = route.access;
  return all.every((permission) => held.includes(permission)) && (any.length === 0 || any.some((permission) => held.includes(permission)));
};

const SESSIONS = ROUTES.filter((route) => route.access.kind !== 'public');

test('#343: every route that is not public refuses a caller with no session (401)', async () => {
  assert.ok(SESSIONS.length > 140, `only ${SESSIONS.length} session routes were found`);
  const wrong: string[] = [];
  for (const route of SESSIONS) {
    const reply = await call(route, undefined);
    if (reply.status !== 401) wrong.push(`${route.method} ${route.path} → ${reply.status}`);
    const forged = await call(route, 'made-up-session');
    if (forged.status !== 401) wrong.push(`${route.method} ${route.path} with a made-up session → ${forged.status}`);
  }
  assert.deepEqual(wrong, []);
});

test('#343: no route is open to every member by accident; only a few name why they need no permission', () => {
  const open = SESSIONS.filter((route) => route.access.kind === 'signedIn').map((route) => `${route.method} ${route.path}`);
  assert.deepEqual(open.sort(), [
    'GET /api/challans/reasons', 'GET /api/eway/states', 'GET /api/session', 'GET /api/states',
    'POST /api/auth/sign-out', 'POST /api/pincode/state', 'POST /api/session/company', 'POST /api/team/leave',
  ].sort(), 'a new route without a permission must be argued for here, by name');
});

for (const role of ROLE_NAMES) {
  test(`#343: a ${role} can do exactly what the role table says, nothing more`, async () => {
    const held = ROLES[role].permissions;
    let token = await signIn(ADDRESS[role], SAMPOORNA);
    const refusedWrongly: string[] = [];
    const allowedWrongly: string[] = [];
    for (const route of SESSIONS) {
      const reply = await call(route, token);
      const allowed = permits(route, held);
      if (allowed && reply.status === 403) refusedWrongly.push(`${route.method} ${route.path}: ${reply.body.message}`);
      if (!allowed && reply.status !== 403) allowedWrongly.push(`${route.method} ${route.path} → ${reply.status}`);
      if (ENDS_SESSION.has(route.path) && reply.status === 200) token = tokenFrom(reply.headers) ?? await signIn(ADDRESS[role], SAMPOORNA);
      if ((await call({ method: 'GET', path: '/api/session' }, token)).status === 401) token = await signIn(ADDRESS[role], SAMPOORNA);
    }
    assert.deepEqual(allowedWrongly, [], `the ${role} reached routes its permissions do not cover`);
    assert.deepEqual(refusedWrongly, [], `the ${role} was refused routes its permissions cover: the role table and the services disagree`);
  });
}

// ------------------------------------------------------------------ another company's resources

const fixtures = { invoice: '', note: '', id: '', invoiceNumber: '', customer: '' };

before(async () => {
  const owner = await signIn(ADDRESS.owner, SAMPOORNA);
  const bills = (await call({ method: 'GET', path: '/api/einvoices/invoices' }, owner)).body.invoices as { id: string; number: string; customer: string }[];
  fixtures.invoice = bills[0]!.id;
  fixtures.invoiceNumber = bills[0]!.number;
  fixtures.customer = bills[0]!.customer;
  const catalogue = (await call({ method: 'GET', path: '/api/catalogue' }, owner)).body;
  const steel = catalogue.items.find((item: { name: string }) => item.name === 'TMT Steel Bar 12mm');
  const purchase = await call({ method: 'POST', path: '/api/purchases/record' }, owner, '/api/purchases/record', {
    supplierId: 'sampoorna:party:supplier', reference: 'MATRIX-343', date: (await call({ method: 'GET', path: '/api/dashboard' }, owner)).body.today,
    lines: [{ itemId: steel.id, item: steel.name, quantity: '10', rate: '64', gst: '1800' }],
  });
  assert.equal(purchase.status, 200, purchase.text);
  fixtures.id = String(purchase.body.purchase?.id ?? purchase.body.id ?? purchase.body.bill?.id);
  const documents = (await call({ method: 'GET', path: '/api/returns/documents' }, owner)).body.documents as { id: string; lines: { id: string; quantity: string }[] }[];
  const sold = documents.find((document) => document.id === fixtures.invoice) ?? documents[0]!;
  const returned = await call({ method: 'POST', path: '/api/returns/record' }, owner, '/api/returns/record', {
    documentId: sold.id, lines: JSON.stringify([{ lineId: sold.lines[0]!.id, quantity: '1', condition: 'usable' }]), reason: 'Matrix test', idempotencyKey: 'matrix-343',
  });
  fixtures.note = String(returned.body.note?.id ?? returned.body.id ?? '');
});

/** What each `:param` in a path names. A new kind of param must be added here, with a real fixture. */
const PARAM_FIXTURE: Readonly<Record<string, keyof typeof fixtures>> = { invoice: 'invoice', note: 'note', id: 'id' };

test('#343: another company\'s id in the path is "not found" (404), never its data', async () => {
  assert.ok(fixtures.invoice && fixtures.id, `fixtures were made: ${JSON.stringify(fixtures)}`);
  const konkan = await signIn('owner@konkan.example.invalid', KONKAN);
  const wrong: string[] = [];
  for (const route of SESSIONS.filter((candidate) => candidate.path.includes(':'))) {
    const names = [...route.path.matchAll(/:(\w+)/g)].map((match) => match[1]!);
    for (const name of names) assert.ok(name in PARAM_FIXTURE, `${route.path}: say which resource :${name} names in PARAM_FIXTURE`);
    if (names.some((name) => fixtures[PARAM_FIXTURE[name]!] === '')) { wrong.push(`${route.path}: no fixture`); continue; }
    const path = route.path.replace(/:(\w+)/g, (_whole, name: string) => encodeURIComponent(fixtures[PARAM_FIXTURE[name]!]));
    const reply = await call(route, konkan, path);
    if (reply.status !== 404) wrong.push(`${route.method} ${path} → ${reply.status}`);
    if (reply.text.includes(fixtures.invoiceNumber) || reply.text.includes(fixtures.customer)) wrong.push(`${route.method} ${path} answered with Sampoorna's data`);
  }
  assert.deepEqual(wrong, []);
});

test('#343: another company\'s bill id in the body is never acted on or answered with its data', async () => {
  const konkan = await signIn('owner@konkan.example.invalid', KONKAN);
  const takesBill = SESSIONS.filter((route) => route.method === 'POST' && 'invoice' in ((route.input as { shape?: object }).shape ?? {}));
  assert.ok(takesBill.length > 20, `only ${takesBill.length} routes take a bill id`);
  const wrong: string[] = [];
  for (const route of takesBill) {
    const reply = await call(route, konkan, route.path, { invoice: fixtures.invoice });
    if (reply.status < 400) wrong.push(`${route.path} → ${reply.status}`);
    if (reply.text.includes(fixtures.invoiceNumber) || reply.text.includes(fixtures.customer)) wrong.push(`${route.path} answered with Sampoorna's data`);
  }
  assert.deepEqual(wrong, []);
  // The DevTools case from the issue: the print request, copied, with the id changed.
  assert.equal((await call({ method: 'POST', path: '/api/sales/print' }, konkan, '/api/sales/print', { invoice: fixtures.invoice })).status, 404);
});
