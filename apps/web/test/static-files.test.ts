/**
 * Issue #393 — the web server hands out the page's own files and nothing else. Its source code,
 * its tests, its notes, and anything later dropped into the folder (a `.env`, a backup, a log)
 * answer 404, however the address is written.
 */
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { loadWebAsset, webServer } from "../server.ts";

const root = resolve(import.meta.dirname, "..");
let port = 0;

before(async () => {
  await new Promise<void>((done) => webServer.listen(0, "127.0.0.1", done));
  port = (webServer.address() as AddressInfo).port;
});
after(() => new Promise<void>((done) => webServer.close(() => done())));

// node:http sends the path exactly as written, so encoded and dotted forms reach the server unchanged.
function get(path: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => done({ status: response.statusCode ?? 0, type: String(response.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", fail);
    req.end();
  });
}

const hidden = [
  "/server.ts",
  "/test/web.test.ts",
  "/README.md",
  "/test/",
  "/test",
  "/.env",
  "/app.js.bak",
  "/server.log",
  "/package.json",
  "/no-such-screen",
  "/%2e%2e/package.json",
  "/test%2fweb.test.ts",
  "/test%2Fweb.test.ts",
  "/./server.ts",
  "/SERVER.TS",
  "/server.ts%00.js",
  "/../../package.json",
  "/test/web.test.0123456789ab.js",
  "/README.0123456789ab.css",
  "/server.0123456789ab.js",
];

test("#393: the server's source, its tests, its notes and unknown addresses are not served", async () => {
  for (const path of hidden) {
    const response = await get(path);
    assert.equal(response.status, 404, `${path} must not be served`);
    assert.doesNotMatch(response.body, /import |loadWebAsset|<html/i, `${path} must not leak a file`);
  }
  // `//server.ts` reads as a host named `server.ts` with the path `/`: the page itself, never the source.
  const doubled = await get("//server.ts");
  assert.doesNotMatch(doubled.body, /loadWebAsset|createServer/);
});

test("#393: the helper refuses the same files the issue named", async () => {
  for (const path of ["/server.ts", "/test/web.test.ts", "/README.md", "/../../private-file"]) {
    assert.equal((await loadWebAsset(path)).status, 404, path);
  }
});

test("#393: every file the page loads is still served, with its own type", async () => {
  const [html, app] = await Promise.all([readFile(resolve(root, "index.html"), "utf8"), readFile(resolve(root, "app.js"), "utf8")]);
  const linked = [...html.matchAll(/(?:src|href)="(\/[^"/]+\.(?:js|css|svg))"/g)].map((match) => match[1]!);
  const imported = [...app.matchAll(/import\("\.(\/[^"]+\.js)"\)/g)].map((match) => match[1]!);
  const files = [...new Set([...linked, ...imported])];
  assert.ok(files.includes("/app.js") && files.includes("/styles.css") && files.includes("/done-screen.js"), files.join(", "));
  for (const file of files) {
    const response = await get(file);
    assert.equal(response.status, 200, file);
    assert.equal(response.body, await readFile(resolve(root, file.slice(1)), "utf8"), file);
    assert.match(response.type, file.endsWith(".css") ? /text\/css/ : /text\/javascript/, file);
  }
  for (const path of ["/", "/?company=1", "/index.html"]) {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    assert.match(response.body, /id="view-dashboard"/, path);
  }
  // The shell names each file by its content hash (#360); those names are still served.
  const shell = (await get("/")).body;
  const hashedNames = [...shell.matchAll(/(?:src|href)="(\/[\w-]+\.[0-9a-f]{12}\.(?:js|css))"/g)].map((match) => match[1]!);
  assert.ok(hashedNames.length >= 4, hashedNames.join(", "));
  for (const file of hashedNames) assert.equal((await get(file)).status, 200, file);
});
