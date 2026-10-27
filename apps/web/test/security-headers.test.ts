/**
 * Issue #349 — every file the page loads carries the security headers, and the server's time limits
 * are set. The half of this check that needs a browser (the page under its content policy, the
 * bill frame's sandbox) lives in tests/browser/security-headers.spec.ts since #496.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { webServer } from '../server.ts';
import { HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS, SECURITY_HEADERS } from '../../api/src/http-hardening.ts';

let base = '';

before(async () => {
  await new Promise<void>((resolve) => webServer.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(webServer.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => webServer.close(() => resolve()));
});

test('the page, its scripts and styles, and the API all carry every security header', async () => {
  for (const path of ['/', '/app.js', '/styles.css', '/sale-slides.js', '/api/status', '/no-such-page']) {
    const response = await fetch(`${base}${path}`, { method: 'HEAD' });
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(response.headers.get(name), value, `${name} on ${path}`);
  }
  assert.equal(webServer.requestTimeout, REQUEST_TIMEOUT_MS);
  assert.equal(webServer.headersTimeout, HEADERS_TIMEOUT_MS);
});
