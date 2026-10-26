/**
 * Issue #341 — files kept privately, outside the database: a supplier's bill as scanned, the
 * business's logo. Only the key and the facts about a file are in PostgreSQL (`stored_files`).
 *
 * A file never passes through our server on its way in or out. The browser is given a signed
 * address that works for one file, one method and a few minutes, and nothing else. Every address
 * is issued only after the server has checked who is asking (`apps/api/src/files-application.ts`).
 * No object is ever public.
 *
 * Two adapters behind one port (CLAUDE.md rule 5): `LocalObjectStore` keeps files in a folder and
 * signs addresses the API itself answers, for development and tests; `SpacesObjectStore` signs
 * S3 v4 pre-signed URLs for DigitalOcean Spaces in BLR1 (decision 0003), with `node:crypto` only.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface SignedRequest {
  readonly url: string;
  readonly method: "PUT" | "GET";
  /** Headers the browser must send exactly, because they are part of the signature. */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: string;
}

export interface ObjectStore {
  /** An address the browser can put this one file at, of this type, until it expires. */
  presignUpload(key: string, file: { readonly contentType: string; readonly expiresInSeconds: number }): Promise<SignedRequest>;
  /** An address the browser can fetch this one file from, until it expires. */
  presignDownload(key: string, file: { readonly fileName: string; readonly expiresInSeconds: number }): Promise<SignedRequest>;
  /**
   * The stored file, for screening: its whole content when it is at most `maxBytes`, and always its
   * real size; null when nothing is there. A larger file is not read past `maxBytes`.
   */
  read(key: string, maxBytes: number): Promise<{ readonly bytes: Uint8Array; readonly sizeBytes: number } | null>;
}

/** A storage key is ours, never the caller's: `<company>/<purpose>/<uuid>`. */
const KEY = /^[0-9a-f-]{36}\/[a-z_]+\/[0-9a-f-]{36}$/;
const checkKey = (key: string): string => {
  if (!KEY.test(key)) throw new Error("STORAGE_KEY_INVALID");
  return key;
};
const attachment = (fileName: string): string => `attachment; filename="${fileName.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120) || "file"}"`;

// ------------------------------------------------------------------------------- local (mock)

interface LocalGrant { readonly key: string; readonly method: "PUT" | "GET"; readonly contentType: string; readonly fileName: string; readonly expires: number }

/**
 * Files in a local folder. Addresses are `<baseUrl>?token=…`, a grant signed with HMAC-SHA256 that
 * names the key, the method, the content type and the expiry; the API's `/api/files/blob` route
 * hands the token to `accept` and does exactly what the grant allows.
 */
export class LocalObjectStore implements ObjectStore {
  readonly #dir: string;
  readonly #secret: Buffer;
  readonly #baseUrl: string;
  readonly #now: () => number;

  constructor(options: { readonly dir: string; readonly baseUrl: string; readonly secret?: Buffer; readonly now?: () => number }) {
    this.#dir = resolve(options.dir);
    this.#secret = options.secret ?? randomBytes(32);
    this.#baseUrl = options.baseUrl;
    this.#now = options.now ?? Date.now;
  }

  #sign(grant: LocalGrant): string {
    const body = Buffer.from(JSON.stringify(grant)).toString("base64url");
    return `${body}.${createHmac("sha256", this.#secret).update(body).digest("base64url")}`;
  }

  #grant(token: string): LocalGrant | null {
    const [body, mac] = token.split(".");
    if (body === undefined || mac === undefined) return null;
    const expected = createHmac("sha256", this.#secret).update(body).digest();
    const given = Buffer.from(mac, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const grant = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as LocalGrant;
    return grant.expires > this.#now() ? grant : null;
  }

  #path(key: string): string { return join(this.#dir, checkKey(key)); }

  async presignUpload(key: string, file: { readonly contentType: string; readonly expiresInSeconds: number }): Promise<SignedRequest> {
    const expires = this.#now() + file.expiresInSeconds * 1000;
    const token = this.#sign({ key: checkKey(key), method: "PUT", contentType: file.contentType, fileName: "", expires });
    return { url: `${this.#baseUrl}?token=${token}`, method: "PUT", headers: { "content-type": file.contentType }, expiresAt: new Date(expires).toISOString() };
  }

  async presignDownload(key: string, file: { readonly fileName: string; readonly expiresInSeconds: number }): Promise<SignedRequest> {
    const expires = this.#now() + file.expiresInSeconds * 1000;
    const token = this.#sign({ key: checkKey(key), method: "GET", contentType: "", fileName: file.fileName, expires });
    return { url: `${this.#baseUrl}?token=${token}`, method: "GET", headers: {}, expiresAt: new Date(expires).toISOString() };
  }

  async read(key: string, maxBytes: number): Promise<{ readonly bytes: Uint8Array; readonly sizeBytes: number } | null> {
    try {
      const handle = await open(this.#path(key), "r");
      try {
        const { size } = await handle.stat();
        const bytes = Buffer.alloc(Math.min(maxBytes, size));
        await handle.read(bytes, 0, bytes.length, 0);
        // A plain Uint8Array, as a reader of the bytes (the PDF parser) may refuse a Node Buffer.
        return { bytes: new Uint8Array(bytes), sizeBytes: size };
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw error;
    }
  }

  /**
   * What the signed address does. Refuses anything the grant does not name: another method, another
   * content type, an expired or altered token. An upload over `maxBytes` is refused unwritten.
   */
  async accept(token: string, request: { readonly method: string; readonly contentType: string; readonly body: Uint8Array; readonly maxBytes: number }):
    Promise<{ readonly status: 200 | 403 | 404 | 413; readonly body?: Buffer; readonly headers?: Readonly<Record<string, string>> }> {
    const grant = this.#grant(token);
    if (grant === null || grant.method !== request.method) return { status: 403 };
    if (grant.method === "PUT") {
      if (request.contentType.split(";")[0]!.trim().toLowerCase() !== grant.contentType.toLowerCase()) return { status: 403 };
      if (request.body.length > request.maxBytes) return { status: 413 };
      const path = this.#path(grant.key);
      await mkdir(dirname(path), { recursive: true });
      // An address is good for one file: a second upload to it never replaces the first.
      try { await writeFile(path, request.body, { flag: "wx" }); } catch (error) {
        if ((error as { code?: string }).code === "EEXIST") return { status: 403 };
        throw error;
      }
      return { status: 200 };
    }
    try {
      await stat(this.#path(grant.key));
    } catch { return { status: 404 }; }
    return { status: 200, body: await readFile(this.#path(grant.key)), headers: { "content-type": "application/octet-stream", "content-disposition": attachment(grant.fileName), "cache-control": "private, no-store" } };
  }
}

// ------------------------------------------------------------------------- DigitalOcean Spaces

export interface SpacesConfig {
  /** e.g. `https://blr1.digitaloceanspaces.com` */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly now?: () => Date;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const hmac = (key: Buffer | string, value: string): Buffer => createHmac("sha256", key).update(value).digest();
/** RFC 3986 encoding, as S3 signs it: everything but unreserved characters; `/` kept in paths. */
const encode = (value: string, keepSlash = false): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(keepSlash ? /%2F/g : /$^/, "/");

/**
 * An S3 signature version 4 pre-signed URL (query-string authentication). `signedHeaders` are
 * headers the client must send unchanged; `host` is always signed.
 */
export function presignS3(config: SpacesConfig, request: {
  readonly method: "PUT" | "GET" | "HEAD";
  readonly key: string;
  readonly expiresInSeconds: number;
  readonly signedHeaders?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  /** Path-style (`/<bucket>/<key>`) or virtual-host style (`<bucket>.<host>/<key>`). */
  readonly virtualHost?: boolean;
}): string {
  const now = (config.now ?? (() => new Date()))();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const endpoint = new URL(config.endpoint);
  const host = request.virtualHost === false ? endpoint.host : `${config.bucket}.${endpoint.host}`;
  const path = `${request.virtualHost === false ? `/${config.bucket}` : ""}/${encode(request.key, true)}`;
  const scope = `${day}/${config.region}/s3/aws4_request`;
  const headers = Object.fromEntries(Object.entries({ host, ...request.signedHeaders }).map(([name, value]) => [name.toLowerCase(), value.trim()]));
  const headerNames = Object.keys(headers).sort();
  const query: Record<string, string> = {
    ...request.query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${config.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(request.expiresInSeconds),
    "X-Amz-SignedHeaders": headerNames.join(";"),
  };
  const canonicalQuery = Object.keys(query).sort().map((name) => `${encode(name)}=${encode(query[name]!)}`).join("&");
  const canonical = [request.method, path, canonicalQuery, headerNames.map((name) => `${name}:${headers[name]}\n`).join(""), headerNames.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, day), config.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return `${endpoint.protocol}//${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** Spaces in BLR1 (decision 0003). The bucket is private; every address is signed and short-lived. */
export class SpacesObjectStore implements ObjectStore {
  readonly #config: SpacesConfig;
  constructor(config: SpacesConfig) { this.#config = config; }

  #expiresAt(seconds: number): string { return new Date((this.#config.now ?? (() => new Date()))().getTime() + seconds * 1000).toISOString(); }

  async presignUpload(key: string, file: { readonly contentType: string; readonly expiresInSeconds: number }): Promise<SignedRequest> {
    const headers = { "content-type": file.contentType, "x-amz-acl": "private" };
    return { url: presignS3(this.#config, { method: "PUT", key: checkKey(key), expiresInSeconds: file.expiresInSeconds, signedHeaders: headers }), method: "PUT", headers, expiresAt: this.#expiresAt(file.expiresInSeconds) };
  }

  async presignDownload(key: string, file: { readonly fileName: string; readonly expiresInSeconds: number }): Promise<SignedRequest> {
    const query = { "response-content-disposition": attachment(file.fileName), "response-cache-control": "private, no-store" };
    return { url: presignS3(this.#config, { method: "GET", key: checkKey(key), expiresInSeconds: file.expiresInSeconds, query }), method: "GET", headers: {}, expiresAt: this.#expiresAt(file.expiresInSeconds) };
  }

  async read(key: string, maxBytes: number): Promise<{ readonly bytes: Uint8Array; readonly sizeBytes: number } | null> {
    const response = await fetch(presignS3(this.#config, { method: "GET", key: checkKey(key), expiresInSeconds: 60 }), { headers: { range: `bytes=0-${maxBytes - 1}` } });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`STORAGE_UNAVAILABLE_${response.status}`);
    const total = /\/(\d+)$/.exec(response.headers.get("content-range") ?? "")?.[1] ?? response.headers.get("content-length");
    return { bytes: new Uint8Array(await response.arrayBuffer()), sizeBytes: Number(total) };
  }
}
