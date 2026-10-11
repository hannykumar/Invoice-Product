/**
 * Issue #349 — what every response and every request goes through, on both servers: the browser
 * headers that stop the page being framed or a stray script running, a ceiling on how much one
 * request may send, a refusal for a form posted from someone else's site, and time limits.
 *
 * One module, so `apps/api/src/server.ts` and `apps/web/server.ts` cannot drift apart.
 */
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';

/**
 * The page's content policy. There is no inline script anywhere in `apps/web`, so scripts come
 * from this site only. Styles need `'unsafe-inline'`: every printed bill is an `srcdoc` frame (which
 * inherits this policy) built from `<style>` and `style=` by `packages/invoice-templates`, and six
 * frames on the page carry a `style=` attribute. Fonts come from Google Fonts. Images are this
 * site, the `data:` logos and signatures, and `blob:` downloads.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  // Ignored by browsers over plain http (local development); binding once the site is on https.
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  // The camera stays allowed for this site only: the Sale screen scans barcodes with it.
  'permissions-policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
};

export const applySecurityHeaders = (response: ServerResponse): void => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
};

/** An ordinary request: a form, a bill, a setting. Pictures are capped well below this already. */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;
/**
 * The two screens that send a whole file as text — books from another program, and the
 * government's purchase record — may send more, until #341 moves files to storage.
 */
export const MAX_FILE_BODY_BYTES = 5 * 1024 * 1024;
const FILE_ROUTES: ReadonlySet<string> = new Set(['/api/migration/analyse', '/api/itc/import']);

export const bodyLimitFor = (pathname: string): number => FILE_ROUTES.has(pathname) ? MAX_FILE_BODY_BYTES : MAX_JSON_BODY_BYTES;

export class BodyTooLarge extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`More than ${limit} bytes were sent.`);
    this.limit = limit;
  }
}

/**
 * Reads the body, and stops as soon as it passes `limit`: a declared length that is too big is
 * refused before a byte is read, and a body sent without one is cut off at the limit.
 */
export const readLimitedBody = async (request: IncomingMessage, limit: number): Promise<Buffer> => {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLarge(limit);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new BodyTooLarge(limit);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
};

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Sites other than this one that may post to the API, as full origins (`https://app.example.in`),
 * comma separated. Empty by default: the page and the API are served from the same host.
 */
const extraOrigins = (): ReadonlySet<string> => new Set(
  (process.env.KAROBAR_ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter((origin) => origin !== ''),
);

/**
 * True when a state-changing request came from another website. A browser always sends `Origin`
 * on a cross-site POST, and modern ones send `Sec-Fetch-Site`; a request with neither did not come
 * from a browser page (a script, a test, the command line) and carries its own bearer token, so it
 * is let through. `Origin: null` (a sandboxed frame, a file on disk) is refused.
 *
 * The session today is a bearer token the page adds itself, which another site cannot read; this
 * check is what keeps state-changing routes safe once #342 moves the session into a cookie.
 */
export const isCrossSiteWrite = (method: string, headers: IncomingHttpHeaders): boolean => {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  const origin = headers.origin;
  if (typeof origin === 'string' && origin !== '') {
    if (extraOrigins().has(origin)) return false;
    let host: string;
    try { host = new URL(origin).host; } catch { return true; }
    return host === '' || host !== headers.host;
  }
  return headers['sec-fetch-site'] === 'cross-site';
};

/**
 * Slow clients cannot hold a connection open for ever. A request must finish arriving within
 * thirty seconds and its headers within ten.
 */
export const REQUEST_TIMEOUT_MS = 30_000;
export const HEADERS_TIMEOUT_MS = 10_000;

export const applyTimeouts = <T extends Server>(server: T): T => {
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;
};
