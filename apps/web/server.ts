import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serveApi } from "../api/src/server.ts";

const root = dirname(fileURLToPath(import.meta.url));
// `PORT` is honoured too, so a tool that assigns a free port can start this without a clash.
const port = Number(process.env.WEB_PORT ?? process.env.PORT ?? 4173);
const types: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export interface WebAsset { readonly status: number; readonly contentType: string; readonly body: Buffer; readonly cacheControl: string; readonly etag?: string; }

// Issue #360 — static files are public and hold no company data. The shell names each script and
// stylesheet by a hash of its content, so a browser or CDN may keep that name for a year: a new
// deploy changes the hash, hence the name. Everything else is revalidated against its ETag.
const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";
const HASHED = /^(.+)\.([0-9a-f]{12})(\.(?:js|css))$/;
const LINK = /(src|href)="\/([\w-]+)(\.(?:js|css))"/g;
const hashOf = (body: Buffer) => createHash("sha256").update(body).digest("hex").slice(0, 12);

// ponytail: hashes are read per shell request (a few hundred KB, about a millisecond); memoise them
// if a measurement in #361 ever shows the shell is slow.
async function shell(): Promise<Buffer> {
  const html = await readFile(resolve(root, "index.html"), "utf8");
  const links = [...html.matchAll(LINK)];
  const hashes = await Promise.all(links.map(([, , name, ext]) => readFile(resolve(root, `${name}${ext}`)).then(hashOf, () => null)));
  let index = 0;
  return Buffer.from(html.replace(LINK, (link, attribute, name, ext) => {
    const hash = hashes[index++];
    return hash ? `${attribute}="/${name}.${hash}${ext}"` : link;
  }));
}

export async function loadWebAsset(pathname: string): Promise<WebAsset> {
  const hashed = HASHED.exec(pathname);
  const requested = hashed ? `${hashed[1]}${hashed[3]}` : pathname;
  const relative = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
  const path = resolve(root, relative);
  if (!path.startsWith(`${root}/`)) return { status: 403, contentType: "text/plain; charset=utf-8", body: Buffer.from("Forbidden"), cacheControl: "no-store" };
  let contentType = types[extname(path)] ?? "application/octet-stream";
  let body: Buffer;
  try {
    body = relative === "index.html" ? await shell() : await readFile(path);
  } catch {
    contentType = types[".html"]!;
    body = await shell();
  }
  const hash = hashOf(body);
  // A stale hash (a page from the previous deploy) still gets today's file, but never for a year.
  return { status: 200, contentType, body, cacheControl: hashed?.[2] === hash ? IMMUTABLE : REVALIDATE, etag: `"${hash}"` };
}

export const webServer = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname.startsWith('/api/')) return serveApi(request, response);
  const asset = await loadWebAsset(url.pathname);
  const headers = { "content-type": asset.contentType, "cache-control": asset.cacheControl, ...(asset.etag ? { etag: asset.etag } : {}) };
  // A CDN that compresses may weaken the tag to W/"…", so compare without the W/ and across a list.
  const sent = (request.headers["if-none-match"] ?? "").split(",").map((tag) => tag.trim().replace(/^W\//, ""));
  if (asset.etag && sent.includes(asset.etag)) return void response.writeHead(304, headers).end();
  response.writeHead(asset.status, headers);
  response.end(asset.body);
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  webServer.listen(port, "127.0.0.1", () => console.log(`Karobar web preview: http://127.0.0.1:${port}`));
}
