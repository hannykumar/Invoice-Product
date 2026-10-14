import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serveApi } from "../api/src/server.ts";
import { applySecurityHeaders, applyTimeouts } from "../api/src/http-hardening.ts";
import { log } from "../api/src/log.ts";
import { installErrorReporting } from "../api/src/error-reporting.ts";

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

export interface WebAsset { readonly status: number; readonly contentType: string; readonly body: Buffer; }

export async function loadWebAsset(pathname: string): Promise<WebAsset> {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const path = resolve(root, relative);
  if (!path.startsWith(`${root}/`)) return { status: 403, contentType: "text/plain; charset=utf-8", body: Buffer.from("Forbidden") };
  try {
    return { status: 200, contentType: types[extname(path)] ?? "application/octet-stream", body: await readFile(path) };
  } catch {
    // Not one of the app's files: the address is a screen inside the app, which index.html opens.
    return { status: 200, contentType: types[".html"]!, body: await readFile(resolve(root, "index.html")) };
  }
}

// Issue #349: the same headers and time limits as the API, on the page and every file it loads.
export const webServer = applyTimeouts(createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname.startsWith('/api/')) return serveApi(request, response);
  applySecurityHeaders(response);
  const asset = await loadWebAsset(url.pathname);
  response.writeHead(asset.status, { "content-type": asset.contentType, "cache-control": "no-store" });
  response.end(asset.body);
}));

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installErrorReporting();
  webServer.listen(port, "127.0.0.1", () => log.info("The web preview is listening", { url: `http://127.0.0.1:${port}` }));
}
