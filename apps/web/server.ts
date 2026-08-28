import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.WEB_PORT ?? 4173);
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
    return { status: 200, contentType: types[".html"]!, body: await readFile(resolve(root, "index.html")) };
  }
}

export const webServer = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const asset = await loadWebAsset(url.pathname);
  response.writeHead(asset.status, { "content-type": asset.contentType, "cache-control": "no-store" });
  response.end(asset.body);
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  webServer.listen(port, "127.0.0.1", () => console.log(`Karobar web preview: http://127.0.0.1:${port}`));
}
