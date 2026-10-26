/**
 * Issue #350 — rate limits and spending caps. Every limit is exceeded here; each refusal is a 429 in
 * the usual error shape with `Retry-After`, worded for the shopkeeper. (Across servers and restarts:
 * rate-limits.integration.test.ts, on PostgreSQL.)
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import { apiServer, handleApi, clientAddress, ROUTES } from '../src/server.ts';
import { companyQuota, globalCap, LIMITS, MemoryCounterStore, RateLimited, RateLimiter, expensiveLimit } from '../../../packages/platform/src/rate-limits.ts';
import { COSTS } from '../src/routes/costs.ts';
import { spend } from '../src/spending.ts';
import { DEMO_SIGN_IN_CODE } from '../../../packages/platform/src/seed.ts';
import { signIn } from './sign-in-helper.ts';

let base = '';
before(async () => {
  await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => apiServer.close(() => resolve())));

const post = (path: string, body: unknown, ip = '203.0.113.7') => handleApi('POST', path, body, undefined, undefined, undefined, ip);
const parse = (reply: { body: string | Buffer }) => JSON.parse(String(reply.body)) as Record<string, any>;

test('#350: a loop of 20 wrong sign-ins is blocked after 5, and then even the right code waits', async () => {
  const address = 'owner@konkan.example.invalid';
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 20; attempt += 1) statuses.push((await post('/api/auth/sign-in', { address, code: '000000' }, '198.51.100.20')).status);
  assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.ok(statuses.slice(5).every((status) => status === 429), statuses.join(','));
  const blocked = await post('/api/auth/sign-in', { address, code: DEMO_SIGN_IN_CODE }, '198.51.100.21');
  assert.equal(blocked.status, 429, 'the right code from another place waits too: the address is the one being guessed');
  const body = parse(blocked);
  assert.equal(body.code, 'TOO_MANY_REQUESTS');
  assert.match(body.message, /^Too many wrong codes for this number or email\. Please wait \d+ minutes? and try again\.$/);
  const retry = Number(blocked.headers['retry-after']);
  assert.ok(retry > 0 && retry <= 15 * 60, `Retry-After ${retry}`);
});

test('#350: many addresses guessed from one place are blocked per IP', async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 8; i += 1) statuses.push((await post('/api/auth/sign-in', { address: `guess-${i}@example.invalid`, code: '000000' }, '198.51.100.30')).status);
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429, 429, 429]);
});

test('#350: codes are limited per number, per day and per IP — each one is an SMS', async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 7; i += 1) statuses.push((await post('/api/auth/code', { address: '+919812355501' }, `192.0.2.${i}`)).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
  const fromOnePlace: number[] = [];
  for (let i = 0; i < 7; i += 1) fromOnePlace.push((await post('/api/auth/code', { address: `+91981235560${i}` }, '192.0.2.200')).status);
  assert.deepEqual(fromOnePlace, [200, 200, 200, 200, 200, 429, 429]);
  // The same number and its other spellings are one number.
  assert.equal((await post('/api/auth/code', { address: '098123 55501' }, '192.0.2.99')).status, 429);
});

test('#350: a signed-in person is limited per minute, after the permission check (a refusal stays 403)', async () => {
  const viewer = await signIn('viewer@konkan.example.invalid');
  let last = 0;
  for (let i = 0; i < LIMITS.perUser.max; i += 1) last = (await handleApi('GET', '/api/session', {}, `Bearer ${viewer}`)).status;
  assert.equal(last, 200);
  const over = await handleApi('GET', '/api/session', {}, `Bearer ${viewer}`);
  assert.equal(over.status, 429);
  assert.ok(Number(over.headers['retry-after']) <= 60);
  assert.equal((await handleApi('POST', '/api/team/invite', { address: 'x@example.invalid', role: 'staff' }, `Bearer ${viewer}`)).status, 403, 'no permission: still 403, not 429');
});

test('#350: heavy work is limited per company per minute, by plan', async () => {
  const owner = await signIn('accounts@konkan.example.invalid');
  const limit = expensiveLimit('free');
  const statuses: number[] = [];
  for (let i = 0; i <= limit.max; i += 1) statuses.push((await handleApi('POST', '/api/assistant/ask', { question: 'How much do customers owe?' }, `Bearer ${owner}`)).status);
  assert.ok(statuses.slice(0, limit.max).every((status) => status !== 429), statuses.join(','));
  assert.equal(statuses.at(-1), 429);
  // Another company's limit is its own.
  const sampoorna = await signIn('owner@sampoorna.example.invalid');
  assert.notEqual((await handleApi('POST', '/api/assistant/ask', { question: 'How much do customers owe?' }, `Bearer ${sampoorna}`)).status, 429);
  assert.ok(limit.max < expensiveLimit('growth').max, 'a bigger plan gets more');
});

test('#350: a paid service stops at the company\'s daily allowance and at Karobar\'s daily cap, warning at 80%', async () => {
  const limits = new RateLimiter(new MemoryCounterStore());
  const quota = companyQuota('ocr');
  for (let i = 0; i < quota.max; i += 1) await spend(limits, 'ocr', 'company-a');
  await assert.rejects(spend(limits, 'ocr', 'company-a'), (error: unknown) => error instanceof RateLimited && /today's allowance for reading supplier bills/.test(error.message) && /try again tomorrow/i.test(error.message));
  await spend(limits, 'ocr', 'company-b');
  const capped = new RateLimiter(new MemoryCounterStore());
  const cap = globalCap('sms');
  assert.equal(cap.max, 20_000, '₹5,000 a day at 25 paise a message');
  for (let i = 0; i < cap.max; i += 1) await capped.take(cap, 'all');
  await assert.rejects(spend(capped, 'sms', null), /switched off for today/);
  await assert.rejects(spend(capped, 'sms', 'company-c'), /switched off for today/, 'the cap holds before any allowance');
});

test('#350: the usage view shows today\'s use of each paid service against the allowance', async () => {
  const owner = await signIn('owner@sampoorna.example.invalid');
  const before = parse(await handleApi('GET', '/api/usage', {}, `Bearer ${owner}`)).services as { service: string; usedToday: number; allowancePerDay: number }[];
  assert.deepEqual(before.map((row) => row.service), ['llm', 'ocr', 'gsp', 'sms']);
  await handleApi('POST', '/api/assistant/ask', { question: 'What did I sell today?' }, `Bearer ${owner}`);
  const afterAsk = parse(await handleApi('GET', '/api/usage', {}, `Bearer ${owner}`)).services as typeof before;
  assert.equal(afterAsk.find((row) => row.service === 'llm')!.usedToday, before.find((row) => row.service === 'llm')!.usedToday + 1);
  const viewer = await signIn('viewer@sampoorna.example.invalid');
  assert.equal((await handleApi('GET', '/api/usage', {}, `Bearer ${viewer}`)).status, 403);
});

test('#350: every heavy or paid route named in the cost table is a real route', () => {
  const routes = new Set(ROUTES.map((route) => `${route.method} ${route.path}`));
  for (const name of Object.keys(COSTS)) assert.ok(routes.has(name), `${name} is in costs.ts but not in the route table`);
});

test('#350: over HTTP, signed-out callers are limited per address, and a proxy is believed only when trusted', async () => {
  assert.equal(clientAddress({ headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }, socket: { remoteAddress: '10.0.0.9' } } as never, false), '10.0.0.9');
  assert.equal(clientAddress({ headers: { 'x-forwarded-for': 'forged, 1.2.3.4' }, socket: { remoteAddress: '10.0.0.9' } } as never, true), '1.2.3.4');
  // The health check a load balancer polls from one address is never limited.
  for (let i = 0; i <= LIMITS.signedOutPerIp.max + 5; i += 1) assert.equal((await fetch(`${base}/api/status`)).status, 200);
  // Guessing at sessions is: requests with no valid session count per address.
  const statuses: number[] = [];
  for (let i = 0; i <= LIMITS.signedOutPerIp.max; i += 1) statuses.push((await fetch(`${base}/api/dashboard`, { headers: { cookie: `__Host-karobar_session=guess-${i}` } })).status);
  assert.ok(statuses.slice(0, LIMITS.signedOutPerIp.max).every((status) => status === 401), statuses.join(','));
  assert.equal(statuses.at(-1), 429);
});

// ------------------------------------------------------------------ review findings (#350)

test('#350 review: guesses sent all at once are all counted; a right code is given back', async () => {
  const address = '+919812366601';
  const burst = await Promise.all(Array.from({ length: 12 }, () => post('/api/auth/sign-in', { address, code: '000000' }, '198.51.100.60')));
  const statuses = burst.map((reply) => reply.status).sort();
  assert.equal(statuses.filter((status) => status === 401).length, 5, `only five guesses reach the code check: ${statuses.join(',')}`);
  assert.equal(statuses.filter((status) => status === 429).length, 7);
  // Right codes are given back, so a person signing in often is never locked out by it.
  for (let i = 0; i < 8; i += 1) assert.notEqual((await post('/api/auth/sign-in', { address: 'owner@sampoorna.example.invalid', code: DEMO_SIGN_IN_CODE }, '198.51.100.61')).status, 429);
});

test('#350 review: a company over its allowance never uses up Karobar\'s cap for everybody else', async () => {
  const limits = new RateLimiter(new MemoryCounterStore());
  const quota = companyQuota('gsp');
  for (let i = 0; i < quota.max; i += 1) await spend(limits, 'gsp', 'greedy');
  for (let i = 0; i < 100; i += 1) await assert.rejects(spend(limits, 'gsp', 'greedy'), /today's allowance/);
  assert.equal(await limits.used(globalCap('gsp'), 'all'), quota.max, 'its refused calls did not count towards the cap');
});

test('#350 review: buckets are keyed with a server secret, required outside development', async () => {
  const { createHash } = await import('node:crypto');
  const { rateLimitSecret, DEVELOPMENT_RATE_LIMIT_SECRET } = await import('../../../packages/platform/src/rate-limits.ts');
  const buckets: string[] = [];
  const store = { hit: async (bucket: string) => { buckets.push(bucket); return { count: 1, resetsAt: Date.now() + 1000 }; }, peek: async () => ({ count: 0, resetsAt: 0 }), unhit: async () => {} };
  await new RateLimiter(store, Date.now, 'a'.repeat(32)).take(LIMITS.codeRequestsPerAddress, '+919812300001');
  await new RateLimiter(store, Date.now, 'b'.repeat(32)).take(LIMITS.codeRequestsPerAddress, '+919812300001');
  const plain = createHash('sha256').update('+919812300001').digest('hex').slice(0, 32);
  assert.notEqual(buckets[0], buckets[1], 'a different secret gives a different bucket');
  assert.ok(!buckets[0]!.includes(plain), 'not the plain hash anyone can recompute');
  assert.throws(() => rateLimitSecret({}, false), /KAROBAR_RATE_LIMIT_SECRET is not set/);
  assert.throws(() => rateLimitSecret({ KAROBAR_RATE_LIMIT_SECRET: 'short' }, false), /at least 32/);
  assert.equal(rateLimitSecret({}, true), DEVELOPMENT_RATE_LIMIT_SECRET);
});

test('#350 review: one caller is one address — IPv4 in IPv6 form, and an IPv6 /64', async () => {
  const { normaliseAddress } = await import('../src/server.ts');
  assert.equal(normaliseAddress('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(normaliseAddress('2001:db8:0:1:aaaa::1'), normaliseAddress('2001:0db8:0000:0001:ffff:ffff:ffff:ffff'));
  assert.notEqual(normaliseAddress('2001:db8:0:1::1'), normaliseAddress('2001:db8:0:2::1'));
  assert.equal(normaliseAddress('::1'), '0:0:0:0::/64');
});
