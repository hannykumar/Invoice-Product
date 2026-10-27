/**
 * Issue #349 — the API server's own guard rails, tested over a real socket: the browser headers on
 * every response, the 1 MB ceiling (413, and the server still answers afterwards), the refusal of a
 * write posted from another website, and the time limits.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Agent, request as httpRequest, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { connect, type AddressInfo } from 'node:net';
import { apiServer } from '../src/server.ts';
import {
  CONTENT_SECURITY_POLICY, discardRest, HEADERS_TIMEOUT_MS, isCrossSiteWrite, isSignedCallback, MAX_FILE_BODY_BYTES, MAX_JSON_BODY_BYTES,
  REQUEST_TIMEOUT_MS, SECURITY_HEADERS,
} from '../src/http-hardening.ts';

/*
 * Writing a test that talks to a raw socket or to a server that refuses uploads (issue #497):
 *  - Connect to 127.0.0.1 explicitly, never "localhost" (macOS resolves it to ::1 first).
 *  - Settle on EVERY outcome. An `error` handler that only ignores ECONNRESET/EPIPE leaves the
 *    promise pending for ever: macOS reports a reset before it hands over the reply the server
 *    already sent, where Linux hands over the reply first. Here every error rejects, with a message.
 *  - Bound every wait (`CLIENT_WAIT_MS`) and give every test its own `timeout`, so a stall is a
 *    failure that names the case, not a stuck `npm test`.
 *  - Use `agent: false` so no kept-alive socket outlives its test, and tear down with
 *    `closeAllConnections()` before `close()` so the server never waits on a client.
 */
const CLIENT_WAIT_MS = 10_000;
const TEST_TIMEOUT_MS = 30_000;

let port = 0;
before(async () => {
  await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  port = (apiServer.address() as AddressInfo).port;
});
after(async () => {
  await new Promise<void>((resolve) => { apiServer.close(() => resolve()); apiServer.closeAllConnections(); });
});

interface Reply { readonly status: number; readonly headers: Record<string, string | string[] | undefined>; readonly body: string }

/** One request with full control of its headers (fetch adds and hides some). Always settles. */
const send = (method: string, path: string, headers: Record<string, string> = {}, body?: string | Buffer): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, method, path, headers, agent: new Agent({ keepAlive: false }) }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('error', reject);
      incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.setTimeout(CLIENT_WAIT_MS, () => outgoing.destroy(new Error(`no complete reply to ${method} ${path} within ${CLIENT_WAIT_MS} ms`)));
    outgoing.on('error', (error: NodeJS.ErrnoException) => reject(new Error(`${method} ${path} failed before a reply arrived: ${error.code ?? error.message}`)));
    if (body !== undefined) outgoing.write(body);
    outgoing.end();
  });

const host = () => `127.0.0.1:${port}`;

test('every API response carries the security headers, refusals and errors included', { timeout: TEST_TIMEOUT_MS }, async () => {
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

test('a 10 MB POST is refused with 413 in the usual error shape, and the server keeps answering', { timeout: TEST_TIMEOUT_MS }, async () => {
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

test('a body just under 1 MB is read; the file screens may send up to 5 MB and no more', { timeout: TEST_TIMEOUT_MS }, async () => {
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

test('a write posted from another website is refused before anything is read', { timeout: TEST_TIMEOUT_MS }, async () => {
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

test('the signed government callback is the one route another site may post to', { timeout: TEST_TIMEOUT_MS }, async () => {
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

/** Raw socket: writes everything first and only then reads, like a client blocked in write(). */
const rawUpload = (bytes: number, headerLine: string): Promise<{ head: string; closedBy: string }> => new Promise((resolve, reject) => {
  const socket = connect(port, '127.0.0.1');
  let received = '';
  const timer = setTimeout(() => { socket.destroy(); reject(new Error(`no 413 within ${CLIENT_WAIT_MS} ms (got ${JSON.stringify(received.slice(0, 40))})`)); }, CLIENT_WAIT_MS);
  const finish = (closedBy: string) => { clearTimeout(timer); socket.destroy(); resolve({ head: received.split('\r\n')[0] ?? '', closedBy }); };
  socket.on('error', (error: NodeJS.ErrnoException) => { clearTimeout(timer); reject(new Error(`upload failed before the 413 was read: ${error.code ?? error.message}`)); });
  socket.on('data', (chunk) => { received += chunk.toString('latin1'); if (received.includes('\r\n\r\n')) finish('reply'); });
  socket.pause();
  socket.write(`POST /api/sales/preview HTTP/1.1\r\nhost: ${host()}\r\ncontent-type: application/json\r\n${headerLine}\r\n\r\n`);
  socket.write(Buffer.alloc(bytes, 'a'), () => socket.resume());
});

test('an oversize upload still gets its 413 when the client finishes sending before it reads (issue #497)', { timeout: TEST_TIMEOUT_MS }, async () => {
  // Cutting the connection with the body unread resets it; the client then sees EPIPE/ECONNRESET
  // and never the message. The rest of a refused body is read and dropped instead.
  const declared = await rawUpload(10 * 1024 * 1024, `content-length: ${10 * 1024 * 1024}`);
  assert.match(declared.head, /^HTTP\/1\.1 413 /);
  assert.equal((await send('GET', '/api/status')).status, 200);
});

test('a refused upload that never stops is cut off after the discard limit (no connection is held for ever)', { timeout: TEST_TIMEOUT_MS }, async () => {
  const request = new Readable({ read() { /* fed below */ } });
  discardRest(request as unknown as IncomingMessage, 1024);
  request.push(Buffer.alloc(600));
  request.push(Buffer.alloc(600));
  await once(request, 'close');
  assert.equal(request.destroyed, true);
});
