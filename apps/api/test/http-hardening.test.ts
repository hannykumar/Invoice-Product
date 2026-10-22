/**
 * Issue #349 — the API server's own guard rails, tested over a real socket: the browser headers on
 * every response, the 1 MB ceiling (413, and the server still answers afterwards), the refusal of a
 * write posted from another website, and the time limits.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { apiServer } from '../src/server.ts';
import {
  CONTENT_SECURITY_POLICY, HEADERS_TIMEOUT_MS, isCrossSiteWrite, isSignedCallback, MAX_FILE_BODY_BYTES, MAX_JSON_BODY_BYTES,
  REQUEST_TIMEOUT_MS, SECURITY_HEADERS,
} from '../src/http-hardening.ts';

let port = 0;
before(async () => {
  await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  port = (apiServer.address() as AddressInfo).port;
});
after(async () => { await new Promise<void>((resolve) => apiServer.close(() => resolve())); });

interface Reply { readonly status: number; readonly headers: Record<string, string | string[] | undefined>; readonly body: string }

/** One request with full control of its headers (fetch adds and hides some). */
const send = (method: string, path: string, headers: Record<string, string> = {}, body?: string | Buffer): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    // The server may stop reading and close once it has refused a body; that is the point.
    outgoing.on('error', (error: NodeJS.ErrnoException) => error.code === 'EPIPE' || error.code === 'ECONNRESET' ? undefined : reject(error));
    if (body !== undefined) outgoing.write(body);
    outgoing.end();
  });

const host = () => `127.0.0.1:${port}`;

test('every API response carries the security headers, refusals and errors included', async () => {
  const replies = [
    await send('GET', '/api/status'),
    await send('HEAD', '/api/status'),
    await send('GET', '/api/no-such-route'),
    await send('GET', '/api/session'),
    await send('POST', '/api/sales/preview', { 'content-type': 'application/json' }, 'not json'),
  ];
  for (const reply of replies) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(reply.headers[name], value, `${name} on a ${reply.status}`);
  }
  assert.equal(replies[0]!.status, 200);
  assert.equal(replies[3]!.status, 401);
  assert.equal(replies[4]!.status, 400);
});

test('the content policy allows no inline or foreign script and no framing', () => {
  const directives = new Map(CONTENT_SECURITY_POLICY.split('; ').map((part) => [part.split(' ')[0], part]));
  assert.equal(directives.get('script-src'), "script-src 'self'");
  assert.equal(directives.get('frame-ancestors'), "frame-ancestors 'none'");
  assert.equal(directives.get('object-src'), "object-src 'none'");
  assert.equal(SECURITY_HEADERS['x-frame-options'], 'DENY');
  assert.equal(SECURITY_HEADERS['x-content-type-options'], 'nosniff');
});

test('a 10 MB POST is refused with 413 in the usual error shape, and the server keeps answering', async () => {
  const tenMegabytes = Buffer.alloc(10 * 1024 * 1024, 'a');
  const declared = await send('POST', '/api/sales/preview', { 'content-type': 'application/json', 'content-length': String(tenMegabytes.length) }, tenMegabytes);
  assert.equal(declared.status, 413);
  const reply = JSON.parse(declared.body) as Record<string, unknown>;
  assert.equal(reply.state, 'failed');
  assert.equal(reply.code, 'REQUEST_TOO_LARGE');
  assert.match(String(reply.message), /too much to send at once \(more than 1 MB\)/);
  assert.equal(declared.headers['content-security-policy'], CONTENT_SECURITY_POLICY);

  // Sent in chunks with no declared length, it is cut off at the limit all the same, and the
  // client still gets the 413 and its message rather than a dropped connection.
  const chunked = await send('POST', '/api/sales/preview', { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }, tenMegabytes);
  assert.equal(chunked.status, 413);
  assert.equal((JSON.parse(chunked.body) as Record<string, unknown>).code, 'REQUEST_TOO_LARGE');

  assert.equal((await send('GET', '/api/status')).status, 200);
});

test('a body just under 1 MB is read; the file screens may send up to 5 MB and no more', async () => {
  const underLimit = JSON.stringify({ padding: 'a'.repeat(MAX_JSON_BODY_BYTES - 100) });
  const ordinary = await send('POST', '/api/sales/preview', { 'content-type': 'application/json' }, underLimit);
  assert.equal(ordinary.status, 401, 'read in full, then refused for want of a sign-in');

  const fileSized = JSON.stringify({ content: 'a'.repeat(3 * 1024 * 1024) });
  assert.equal((await send('POST', '/api/sales/preview', { 'content-type': 'application/json' }, fileSized)).status, 413);
  assert.equal((await send('POST', '/api/migration/analyse', { 'content-type': 'application/json' }, fileSized)).status, 401);
  assert.equal((await send('POST', '/api/itc/import', { 'content-type': 'application/json' }, fileSized)).status, 401);
  const tooBigFile = Buffer.alloc(MAX_FILE_BODY_BYTES + 1, 'a');
  assert.equal((await send('POST', '/api/migration/analyse', { 'content-type': 'application/json' }, tooBigFile)).status, 413);
});

test('a write posted from another website is refused before anything is read', async () => {
  const body = JSON.stringify({ address: 'owner@example.invalid' });
  const crossSite = await send('POST', '/api/auth/code', { 'content-type': 'application/json', origin: 'https://evil.example', host: host() }, body);
  assert.equal(crossSite.status, 403);
  assert.equal((JSON.parse(crossSite.body) as Record<string, unknown>).code, 'CROSS_SITE_REQUEST');

  const nullOrigin = await send('POST', '/api/auth/code', { 'content-type': 'application/json', origin: 'null', host: host() }, body);
  assert.equal(nullOrigin.status, 403);

  const fetchMetadataOnly = await send('POST', '/api/auth/code', { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body);
  assert.equal(fetchMetadataOnly.status, 403);

  // The page itself, and a client that is not a browser, still get through to the route.
  const sameOrigin = await send('POST', '/api/auth/code', { 'content-type': 'application/json', origin: `http://${host()}`, host: host(), 'sec-fetch-site': 'same-origin' }, body);
  assert.notEqual(sameOrigin.status, 403);
  const noBrowser = await send('POST', '/api/auth/code', { 'content-type': 'application/json' }, body);
  assert.notEqual(noBrowser.status, 403);

  // Reading is not a write: a cross-site GET is answered (and protected by the bearer token).
  assert.equal((await send('GET', '/api/status', { origin: 'https://evil.example' })).status, 200);
});

test('the signed government callback is the one route another site may post to', async () => {
  const reply = await send('POST', '/api/webhooks/government/irp', { 'content-type': 'application/json', origin: 'https://provider.example', host: host() }, '{}');
  assert.notEqual(JSON.parse(reply.body).code, 'CROSS_SITE_REQUEST');
  assert.equal(reply.status, 401, 'it still has to prove itself with a signature');
});

test('cross-site detection, case by case', () => {
  assert.equal(isCrossSiteWrite('GET', { origin: 'https://evil.example', host: 'karobar.in' }), false);
  assert.equal(isCrossSiteWrite('POST', { origin: 'https://karobar.in', host: 'karobar.in' }), false);
  assert.equal(isCrossSiteWrite('POST', { origin: 'https://karobar.in.evil.example', host: 'karobar.in' }), true);
  assert.equal(isCrossSiteWrite('DELETE', { origin: 'https://evil.example', host: 'karobar.in' }), true);
  assert.equal(isCrossSiteWrite('POST', { origin: 'not a url', host: 'karobar.in' }), true);
  assert.equal(isCrossSiteWrite('POST', { host: 'karobar.in', 'sec-fetch-site': 'same-site' }), false);
  assert.equal(isCrossSiteWrite('POST', { host: 'karobar.in' }), false);
});

test('behind a proxy, the public address decides, scheme and host together', () => {
  const publicOrigins = new Set(['https://karobar.in']);
  // A proxy that rewrites Host no longer turns the page's own writes into refusals.
  assert.equal(isCrossSiteWrite('POST', { origin: 'https://karobar.in', host: '127.0.0.1:4173' }, publicOrigins), false);
  // A plain-http page on the same host is not the https site.
  assert.equal(isCrossSiteWrite('POST', { origin: 'http://karobar.in', host: 'karobar.in' }, publicOrigins), true);
  assert.equal(isCrossSiteWrite('POST', { origin: 'https://evil.example', host: 'karobar.in' }, publicOrigins), true);
  assert.equal(isSignedCallback('/api/webhooks/government/irp'), true);
  assert.equal(isSignedCallback('/api/webhooks/government/irp/extra'), false);
  assert.equal(isSignedCallback('/api/sales/record'), false);
});

test('slow clients are cut off: request and header time limits are set', () => {
  assert.equal(apiServer.requestTimeout, REQUEST_TIMEOUT_MS);
  assert.equal(apiServer.headersTimeout, HEADERS_TIMEOUT_MS);
  assert.ok(HEADERS_TIMEOUT_MS <= REQUEST_TIMEOUT_MS);
});
