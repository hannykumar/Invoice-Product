/**
 * The web server's own behaviour: what it serves, how it names and caches it. The page itself — its
 * screens, buttons, languages, drafts and what it sends — is tested by driving it in a real browser:
 * see `web-*.test.ts` and docs/testing.md ("Testing the web app"). Issue #495: nothing here reads
 * `app.js` or `index.html` as text to assert on; a string existing in the source proves only that.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { loadWebAsset, webServer } from "../server.ts";

test("the local web preview serves the application shell", async () => {
  const asset = await loadWebAsset("/");
  assert.equal(asset.status, 200);
  assert.match(asset.contentType, /text\/html/);
  assert.match(asset.body.toString("utf8"), /id="view-dashboard"/);
  assert.equal((await loadWebAsset("/../../private-file")).status, 404);
});

test("#360: scripts and styles are named by their content and cached for a year; the shell and the API are not", async () => {
  const shell = await loadWebAsset("/");
  assert.equal(shell.cacheControl, "no-cache");
  const html = shell.body.toString("utf8");
  const names = [...html.matchAll(/(?:src|href)="(\/[\w-]+\.[0-9a-f]{12}\.(?:js|css))"/g)].map((match) => match[1]!);
  assert.deepEqual(names.map((name) => name.replace(/\.[0-9a-f]{12}/, "")).sort(), ["/app.js", "/item-picker.js", "/sale-slides.js", "/styles.css"]);
  for (const name of names) {
    const asset = await loadWebAsset(name);
    assert.equal(asset.cacheControl, "public, max-age=31536000, immutable", name);
    // The name IS the content: twelve hex digits of the file's own SHA-256, so a changed file has a new name.
    assert.equal(name.match(/\.([0-9a-f]{12})\.(?:js|css)$/)![1], createHash("sha256").update(asset.body).digest("hex").slice(0, 12), name);
    assert.deepEqual(asset.body, (await loadWebAsset(name.replace(/\.[0-9a-f]{12}/, ""))).body, "the same bytes under the plain name");
    assert.match(asset.contentType, /javascript|css/);
  }
  // A page from the previous deploy asks for a hash that no longer exists: today's file, revalidated.
  const stale = await loadWebAsset("/app.000000000000.js");
  assert.equal(stale.cacheControl, "no-cache");
  assert.deepEqual(stale.body, (await loadWebAsset("/app.js")).body, "today's file, under a name from the previous deploy");
  assert.equal((await loadWebAsset("/done-screen.js")).cacheControl, "no-cache");
  assert.equal((await loadWebAsset("/../../private-file")).cacheControl, "no-store");

  await new Promise<void>((done) => webServer.listen(0, "127.0.0.1", done));
  try {
    const base = `http://127.0.0.1:${(webServer.address() as AddressInfo).port}`;
    const first = await fetch(`${base}/styles.css`);
    const etag = first.headers.get("etag")!;
    assert.equal(first.headers.get("cache-control"), "no-cache");
    const again = await fetch(`${base}/styles.css`, { headers: { "if-none-match": etag } });
    assert.equal(again.status, 304);
    assert.equal(await again.text(), "");
    assert.equal((await fetch(`${base}/styles.css`, { headers: { "if-none-match": `"x", W/${etag}` } })).status, 304);
    // Anything behind sign-in is never kept by a browser, proxy or CDN.
    const api = await fetch(`${base}/api/session`);
    assert.equal(api.headers.get("cache-control"), "no-store");
  } finally {
    await new Promise<void>((done) => webServer.close(() => done()));
  }
});
