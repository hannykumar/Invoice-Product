/**
 * Issue #342 — real sign-in. A code to a phone or an email (ADR D1), a session the page's script
 * cannot read (ADR D2), switching between one's own businesses without signing in again, and never
 * seeing the other business's data.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import { apiServer, handleApi } from '../src/server.ts';
import { CODE_NOT_ACCEPTED, SignIn, signInStore } from '../src/sign-in.ts';
import { MEMORY } from '../src/persistence.ts';
import { CodeNotAccepted, identityProviderFor, MockIdentityProvider, readSignInAddress, SupabaseIdentityProvider } from '../../../packages/platform/src/identity.ts';
import { DEMO_SIGN_IN_CODE } from '../../../packages/platform/src/seed.ts';
import { KONKAN_OWNER, SAMPOORNA_OWNER, SYNTHETIC_CA, signIn, signInOverHttp, tokenFrom } from './sign-in-helper.ts';

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const KONKAN = '00000000-0000-4000-8000-000000000011';
const call = async (method: string, path: string, body: unknown = {}, token?: string) => {
  const reply = await handleApi(method, path, body, token === undefined ? undefined : `Bearer ${token}`);
  return { status: reply.status, headers: reply.headers, body: JSON.parse(String(reply.body)) as Record<string, any> };
};

test('#342: there is no password sign-in any more', async () => {
  assert.equal((await call('POST', '/api/auth/login', { companyId: SAMPOORNA, email: SAMPOORNA_OWNER, password: 'anything' })).status, 404);
});

test('#342: a code opens a session that comes back only as an HttpOnly, Secure, SameSite cookie', async () => {
  const sent = await call('POST', '/api/auth/code', { address: SAMPOORNA_OWNER });
  assert.equal(sent.status, 200);
  assert.match(sent.body.hint, /demo sign-in/i, 'the demo says so plainly; a real provider sends no hint');
  const opened = await call('POST', '/api/auth/sign-in', { address: SAMPOORNA_OWNER, code: DEMO_SIGN_IN_CODE });
  assert.equal(opened.status, 200);
  const cookie = opened.headers['set-cookie']!;
  assert.match(cookie, /^__Host-karobar_session=[A-Za-z0-9_-]{43};/);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(cookie.split('; ').includes(flag), `${flag} is set`);
  const token = tokenFrom(opened.headers)!;
  assert.ok(!JSON.stringify(opened.body).includes(token), 'the reply body never carries the session');
  assert.equal(opened.body.company.id, SAMPOORNA);
  assert.equal((await call('GET', '/api/session', {}, token)).body.company.id, SAMPOORNA);
});

test('#342: a wrong code, and an address nobody uses, get the same answer', async () => {
  const known = await call('POST', '/api/auth/sign-in', { address: SAMPOORNA_OWNER, code: '000000' });
  const unknown = await call('POST', '/api/auth/sign-in', { address: 'nobody-at-all@example.invalid', code: '000000' });
  assert.equal(known.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(known.body.message, CODE_NOT_ACCEPTED);
  assert.equal(unknown.body.message, known.body.message);
  const sentKnown = await call('POST', '/api/auth/code', { address: SAMPOORNA_OWNER });
  const sentUnknown = await call('POST', '/api/auth/code', { address: 'nobody-at-all@example.invalid' });
  assert.deepEqual(sentUnknown, { ...sentKnown, headers: { ...sentKnown.headers, 'x-request-id': sentUnknown.headers['x-request-id']! } }, 'asking for a code does not reveal who exists');
});

test('#342: an address that is not a phone or an email is refused in plain words', async () => {
  const reply = await call('POST', '/api/auth/code', { address: '12345' });
  assert.equal(reply.status, 400);
  assert.equal(reply.body.message, 'Type a 10-digit mobile number or an email address.');
  assert.deepEqual(readSignInAddress('098765 43210'), { kind: 'phone', value: '+919876543210' });
  assert.deepEqual(readSignInAddress('+91-98765-43210'), { kind: 'phone', value: '+919876543210' });
  assert.deepEqual(readSignInAddress(' Owner@Example.Invalid '), { kind: 'email', value: 'owner@example.invalid' });
});

test('#342: someone who signs up before any business adds them is told so, and gets no session', async () => {
  const reply = await call('POST', '/api/auth/sign-in', { address: '+919812300001', code: DEMO_SIGN_IN_CODE });
  assert.equal(reply.status, 403);
  assert.match(reply.body.message, /no business has added you yet/);
  assert.equal(reply.headers['set-cookie'], undefined);
});

test('#342: signing out ends the session on the server at once', async () => {
  const token = await signIn();
  const out = await call('POST', '/api/auth/sign-out', {}, token);
  assert.equal(out.status, 200);
  assert.match(out.headers['set-cookie']!, /^__Host-karobar_session=; .*Max-Age=0/);
  assert.equal((await call('GET', '/api/session', {}, token)).status, 401, 'a copy of the cookie taken before signing out no longer works');
});

test('#342: a CA in two businesses switches without signing in again, and never sees the other business', async () => {
  const inSampoorna = await signIn(SYNTHETIC_CA);
  const session = (await call('GET', '/api/session', {}, inSampoorna)).body;
  assert.equal(session.company.id, SAMPOORNA);
  assert.deepEqual(session.companies.map((company: { id: string }) => company.id), [SAMPOORNA, KONKAN]);
  const sampoornaBills = (await call('GET', '/api/einvoices/invoices', {}, inSampoorna)).body.invoices as { id: string; customer: string }[];
  assert.ok(sampoornaBills.length > 0);

  const switched = await call('POST', '/api/session/company', { companyId: KONKAN }, inSampoorna);
  assert.equal(switched.status, 200);
  assert.equal(switched.body.company.id, KONKAN);
  const inKonkan = tokenFrom(switched.headers)!;
  assert.notEqual(inKonkan, inSampoorna);
  assert.equal((await call('GET', '/api/session', {}, inSampoorna)).status, 401, 'the old session ended: one cookie never opens two businesses');

  assert.equal((await call('GET', '/api/session', {}, inKonkan)).body.company.id, KONKAN);
  const konkanBills = (await call('GET', '/api/einvoices/invoices', {}, inKonkan)).body.invoices as { id: string; customer: string }[];
  for (const bill of sampoornaBills) {
    assert.ok(!konkanBills.some((other) => other.id === bill.id), 'no Sampoorna bill is listed in Konkan');
    assert.equal((await call('POST', '/api/sales/print', { invoice: bill.id }, inKonkan)).status, 404, `Sampoorna's bill ${bill.id} is not found from Konkan`);
  }
  // Asking for the other business in the body changes nothing: the company comes from the session.
  assert.equal((await call('GET', `/api/session?companyId=${SAMPOORNA}`, { companyId: SAMPOORNA }, inKonkan)).body.company.id, KONKAN);

  const back = await call('POST', '/api/session/company', { companyId: SAMPOORNA }, inKonkan);
  assert.equal(back.status, 200);
  assert.equal((await call('GET', '/api/session', {}, tokenFrom(back.headers)!)).body.company.id, SAMPOORNA);
});

test('#342: a business or branch that is not yours cannot be switched to, and its existence is not told', async () => {
  const owner = await signIn(SAMPOORNA_OWNER);
  const other = await call('POST', '/api/session/company', { companyId: KONKAN }, owner);
  const invented = await call('POST', '/api/session/company', { companyId: '00000000-0000-4000-8000-0000000000ff' }, owner);
  assert.equal(other.status, 404);
  assert.deepEqual({ ...other.body, requestId: '' }, { ...invented.body, requestId: '' });
  assert.equal(other.headers['set-cookie'], undefined);
  const wrongBranch = await call('POST', '/api/session/company', { companyId: SAMPOORNA, branchId: '00000000-0000-4000-8000-000000000012' }, owner);
  assert.equal(wrongBranch.status, 404, "Konkan's branch is not one of the Sampoorna owner's branches");
  assert.equal((await call('GET', '/api/session', {}, owner)).status, 200, 'a refused switch leaves the session as it was');
  const konkan = await signIn(KONKAN_OWNER);
  assert.deepEqual((await call('GET', '/api/session', {}, konkan)).body.companies.map((company: { id: string }) => company.id), [KONKAN]);
});

test('#342: switching keeps the session\'s fixed end, and of two switches sent at once only one wins', async () => {
  const { AccessControl, AuthenticationService } = await import('../../../packages/platform/src/index.ts');
  let now = 1_000_000_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const access = new AccessControl();
    const store = new AuthenticationService(access, () => now);
    const service = new SignIn(store, new MockIdentityProvider('111111'));
    store.addUser({ id: 'u-ca', email: 'ca-two@example.invalid' });
    for (const company of ['c1', 'c2']) access.grant({ companyId: company, userId: 'u-ca', branchIds: new Set([`${company}-b`]), active: true, permissions: new Set(['dashboard.read']) });
    const first = await service.checkCode('ca-two@example.invalid', '111111');
    // Six days of a busy shop: used every ten hours, so the idle limit never ends it.
    for (let hours = 0; hours < 6 * 24; hours += 10) { now += 10 * 60 * 60 * 1000; await service.authenticate(`Bearer ${first.token}`); }
    const context = await service.authenticate(`Bearer ${first.token}`);
    const [won, lost] = await Promise.allSettled([service.switchCompany(context, 'c2'), service.switchCompany(context, 'c2')]);
    assert.equal(won.status, 'fulfilled');
    assert.equal(lost.status, 'rejected', 'one cookie never becomes two live sessions');
    assert.equal((won as PromiseFulfilledResult<{ expiresAt: string }>).value.expiresAt, first.expiresAt, 'the week started at sign-in, not at the switch');
    const switched = (won as PromiseFulfilledResult<{ token: string }>).value.token;
    for (let hours = 0; hours < 48; hours += 10) { now += 10 * 60 * 60 * 1000; try { await service.authenticate(`Bearer ${switched}`); } catch { break; } }
    await assert.rejects(service.authenticate(`Bearer ${switched}`), /Sign in again/, 'switching every few days cannot keep a stolen session alive');
  } finally { Date.now = realNow; }
});

test('#342: signing in on a browser that still held a session ends the old one', async () => {
  const old = await signIn(SAMPOORNA_OWNER);
  const reply = await handleApi('POST', '/api/auth/sign-in', { address: SAMPOORNA_OWNER, code: DEMO_SIGN_IN_CODE }, `Bearer ${old}`);
  assert.equal(reply.status, 200);
  assert.equal((await call('GET', '/api/session', {}, old)).status, 401);
  assert.equal((await call('GET', '/api/session', {}, tokenFrom(reply.headers))).status, 200);
});

test('#342: a sign-in asked for another company opens the person\'s own one instead', async () => {
  const token = await signIn(KONKAN_OWNER, SAMPOORNA);
  assert.equal((await call('GET', '/api/session', {}, token)).body.company.id, KONKAN);
});

test('#342: branch access is enforced, not just membership', async () => {
  const { AccessControl, AuthenticationService } = await import('../../../packages/platform/src/index.ts');
  const access = new AccessControl();
  const store = new AuthenticationService(access);
  const signInService = new SignIn(store, new MockIdentityProvider('111111'));
  store.addUser({ id: 'u-branch', email: 'cashier@example.invalid' });
  access.grant({ companyId: 'c1', userId: 'u-branch', branchIds: new Set(['b1']), active: true, permissions: new Set(['dashboard.read']) });
  const opened = await signInService.checkCode('cashier@example.invalid', '111111');
  const context = await signInService.authenticate(`Bearer ${opened.token}`);
  assert.equal(context.branchId, 'b1');
  await assert.rejects(signInService.switchCompany(context, 'c1', 'b2'), /not one you have been added to/);
  // The branch is taken away: the session for it stops working at once.
  access.grant({ companyId: 'c1', userId: 'u-branch', branchIds: new Set(['b2']), active: true, permissions: new Set(['dashboard.read']) });
  await assert.rejects(signInService.authenticate(`Bearer ${opened.token}`), /Sign in again/);
  // Removed from the business: no session, and no company to sign in to.
  access.revoke('c1', 'u-branch');
  await assert.rejects(signInService.checkCode('cashier@example.invalid', '111111'), /no business has added you yet/);
});

test('#342: the demo sign-in and the in-memory store never run outside development', () => {
  assert.throws(() => identityProviderFor({ NODE_ENV: 'production' }, DEMO_SIGN_IN_CODE), /demo sign-in only runs on a developer's machine/);
  assert.throws(() => identityProviderFor({ NODE_ENV: 'staging' }, DEMO_SIGN_IN_CODE), /demo sign-in only runs/);
  assert.throws(() => identityProviderFor({ NODE_ENV: 'production', SUPABASE_URL: 'https://x.supabase.co' }, DEMO_SIGN_IN_CODE), /SUPABASE_ANON_KEY/);
  assert.throws(() => identityProviderFor({ NODE_ENV: 'production', SUPABASE_URL: 'http://x.supabase.co', SUPABASE_ANON_KEY: 'k' }, DEMO_SIGN_IN_CODE), /https/);
  assert.equal(identityProviderFor({ NODE_ENV: 'production', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k' }, DEMO_SIGN_IN_CODE).kind, 'supabase');
  assert.equal(identityProviderFor({ NODE_ENV: 'test' }, DEMO_SIGN_IN_CODE).kind, 'mock');
  // A deployment that forgot NODE_ENV still has its database: it is not mistaken for a developer's machine.
  assert.throws(() => identityProviderFor({ DATABASE_URL: 'postgresql://db.example.invalid/books' }, DEMO_SIGN_IN_CODE), /demo sign-in only runs/);
  // The owner's own Mac: the database on this machine, no NODE_ENV, no Supabase — the stand-in signs in.
  assert.equal(identityProviderFor({ DATABASE_URL: 'postgresql://invoice:invoice@localhost:55460/invoice' }, DEMO_SIGN_IN_CODE).kind, 'mock');
  assert.equal(identityProviderFor({ DATABASE_URL: 'postgresql://invoice:invoice@127.0.0.1:5432/invoice' }, DEMO_SIGN_IN_CODE).kind, 'mock');
  assert.equal(identityProviderFor({}, DEMO_SIGN_IN_CODE).kind, 'mock', 'no NODE_ENV and no database: a developer running it bare');
});

test('#342: no file carries a demo password or hashes a password itself', () => {
  const root = new URL('../../../', import.meta.url).pathname;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'test' || name.startsWith('.')) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path); else if (/\.(ts|js|html)$/.test(name)) files.push(path);
    }
  };
  for (const dir of ['apps', 'packages', 'ops']) walk(join(root, dir));
  assert.ok(files.length > 100);
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /karobar-demo|viewer-demo|DEMO_(OWNER|VIEWER)_PASSWORD/, `${file} carries a demo password`);
    assert.doesNotMatch(source, /createHash\(\s*['"]sha256['"]\s*\)\.update\(\s*password/, `${file} hashes a password itself`);
  }
});

// ------------------------------------------------------------------ over HTTP, as the browser sees it

let base = '';
before(async () => {
  await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => apiServer.close(() => resolve())));

test('#342: over HTTP the session is the cookie alone; a header token is not read', async () => {
  const cookie = await signInOverHttp(base);
  assert.equal((await fetch(`${base}/api/session`, { headers: { cookie } })).status, 200);
  const token = cookie.split('=')[1]!;
  assert.equal((await fetch(`${base}/api/session`, { headers: { authorization: `Bearer ${token}` } })).status, 401, 'a token copied into a header is not a session');
});

test('#342: a write carrying the session cookie must say which page sent it', async () => {
  const cookie = await signInOverHttp(base);
  const post = (headers: Record<string, string>) => fetch(`${base}/api/pincode/state`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, ...headers }, body: JSON.stringify({ pincode: '560058' }) });
  const unnamed = await post({});
  assert.equal(unnamed.status, 403);
  assert.equal((await unnamed.json() as { code: string }).code, 'CROSS_SITE_REQUEST');
  assert.equal((await post({ origin: 'https://evil.example.invalid' })).status, 403);
  assert.equal((await post({ origin: base })).status, 200);
});

// ------------------------------------------------------------------ the Supabase adapter, against a stand-in

const SUPABASE = 'https://synthetic-project.supabase.co';
const jwt = (key: KeyObject, header: Record<string, unknown>, claims: Record<string, unknown>) => {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${part(header)}.${part(claims)}`;
  return `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
};
const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwks = { keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'key-1', alg: 'ES256', use: 'sig' }] };
const nowSeconds = () => Math.floor(Date.now() / 1000);
const goodClaims = (extra: Record<string, unknown> = {}) => ({ iss: `${SUPABASE}/auth/v1`, aud: 'authenticated', role: 'authenticated', sub: 'supabase-user-1', phone: '919876543210', exp: nowSeconds() + 3600, ...extra });
const standIn = (verifyReply: () => Response) => {
  const calls: { url: string; body: unknown; apikey: string | null }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body === undefined ? undefined : JSON.parse(String(init.body)), apikey: new Headers(init.headers).get('apikey') });
    if (url.endsWith('/.well-known/jwks.json')) return Response.json(jwks);
    if (url.endsWith('/auth/v1/otp')) return Response.json({});
    return verifyReply();
  }) as typeof fetch;
  return { calls, provider: new SupabaseIdentityProvider(SUPABASE, 'synthetic-anon-key', fetcher) };
};
const phone = readSignInAddress('9876543210');

test('#342: Supabase is asked to send and check the code, and its token is verified before it is believed', async () => {
  const { calls, provider } = standIn(() => Response.json({ access_token: jwt(keys.privateKey, { alg: 'ES256', kid: 'key-1' }, goodClaims()) }));
  await provider.sendCode(phone);
  assert.deepEqual(calls[0], { url: `${SUPABASE}/auth/v1/otp`, body: { phone: '+919876543210', create_user: true }, apikey: 'synthetic-anon-key' });
  assert.deepEqual(await provider.checkCode(phone, ' 123456 '), { subject: 'supabase-user-1', phone: '+919876543210' });
  assert.deepEqual(calls[1]!.body, { type: 'sms', phone: '+919876543210', token: '123456' });
});

test('#342: a Supabase token that is forged, old, for someone else, or signed with a shared secret is refused', async () => {
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const refused = [
    jwt(other.privateKey, { alg: 'ES256', kid: 'key-1' }, goodClaims()),
    jwt(keys.privateKey, { alg: 'ES256', kid: 'key-unknown' }, goodClaims()),
    jwt(keys.privateKey, { alg: 'ES256', kid: 'key-1' }, goodClaims({ exp: nowSeconds() - 120 })),
    jwt(keys.privateKey, { alg: 'ES256', kid: 'key-1' }, goodClaims({ iss: 'https://evil.example.invalid/auth/v1' })),
    jwt(keys.privateKey, { alg: 'ES256', kid: 'key-1' }, goodClaims({ aud: 'anon' })),
    jwt(keys.privateKey, { alg: 'ES256', kid: 'key-1' }, goodClaims({ phone: '919000000000' })),
    jwt(keys.privateKey, { alg: 'HS256', kid: 'key-1' }, goodClaims()),
    'not-a-token',
  ];
  for (const token of refused) {
    const { provider } = standIn(() => Response.json({ access_token: token }));
    await assert.rejects(provider.checkCode(phone, '123456'), (error: unknown) => (error as { code?: string }).code === 'UNAUTHORIZED', token.slice(0, 40));
  }
});

test('#342: Supabase saying the code is wrong is the person\'s to fix; Supabase being down is ours, and says so', async () => {
  const wrong = standIn(() => new Response('{"msg":"Token has expired or is invalid"}', { status: 403 }));
  await assert.rejects(wrong.provider.checkCode(phone, '000000'), CodeNotAccepted);
  const store = signInStore(MEMORY);
  await assert.rejects(new SignIn(store, wrong.provider).checkCode('9876543210', '000000'), { message: CODE_NOT_ACCEPTED });
  const down = standIn(() => new Response('upstream', { status: 502 }));
  await assert.rejects(new SignIn(store, down.provider).checkCode('9876543210', '000000'), /Sign-in is not working just now/);
});
