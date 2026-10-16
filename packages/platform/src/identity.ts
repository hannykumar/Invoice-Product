/**
 * Issue #342, ADR D1 — who a person is. A phone number or an email address is proved by a one-time
 * code that the identity provider sends and checks; this repository holds no password and no code.
 *
 * The provider sits behind this adapter (rule 5): Supabase Auth in Mumbai in production, a mock
 * everywhere else. What the person may do — companies, branches, permissions, sessions — stays in
 * `packages/platform` (auth.ts, postgres-platform.ts), never with the provider.
 */
import { createPublicKey, verify as verifySignature, type JsonWebKey, type KeyObject } from "node:crypto";
import { ConnectorError } from "./connectors.ts";

/** A phone number (E.164, `+91…`) or an email address (lower case): what the person typed, made canonical. */
export type SignInAddress = { readonly kind: "phone"; readonly value: string } | { readonly kind: "email"; readonly value: string };

/** Someone the provider has just checked: its own id for them, and the address the code went to. */
export interface VerifiedIdentity { readonly subject: string; readonly email?: string; readonly phone?: string; }

export interface IdentityProvider {
  readonly kind: "mock" | "supabase";
  /** Sends a code. Says the same thing whether or not the address is known, so nobody can probe for accounts. */
  sendCode(address: SignInAddress): Promise<{ readonly hint?: string }>;
  /** Checks the code. Throws `CodeNotAccepted` for a wrong, expired or unknown one — never says which. */
  checkCode(address: SignInAddress, code: string): Promise<VerifiedIdentity>;
}

export class CodeNotAccepted extends Error {
  constructor() { super("CODE_NOT_ACCEPTED"); }
}

export class AddressNotReadable extends Error {
  constructor() { super("Type a 10-digit mobile number or an email address."); }
}

/** "98765 43210", "+91-98765-43210" and "098765 43210" are one number; an email is matched in lower case. */
export const readSignInAddress = (typed: string): SignInAddress => {
  const text = typed.trim();
  if (text.includes("@")) {
    const email = text.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new AddressNotReadable();
    return { kind: "email", value: email };
  }
  const digits = text.replace(/[\s()-]/g, "");
  const national = /^(?:\+91|91|0)?([6-9]\d{9})$/.exec(digits)?.[1];
  if (national === undefined) throw new AddressNotReadable();
  return { kind: "phone", value: `+91${national}` };
};

const addressOf = (identity: VerifiedIdentity): string | undefined => identity.email ?? identity.phone;

/**
 * Development and tests only: every address gets the same code, from the seed. `runtime.ts` refuses
 * to start with it outside development (`identityProviderFor`), so no shop can ever sign in with it.
 */
export class MockIdentityProvider implements IdentityProvider {
  readonly kind = "mock" as const;
  readonly #code: string;
  constructor(code: string) { this.#code = code; }
  async sendCode(): Promise<{ hint: string }> {
    return { hint: `Demo sign-in: the code is ${this.#code}. This is not a real message; nothing was sent.` };
  }
  async checkCode(address: SignInAddress, code: string): Promise<VerifiedIdentity> {
    if (code.trim() !== this.#code) throw new CodeNotAccepted();
    return { subject: `mock:${address.value}`, [address.kind]: address.value };
  }
}

interface Jwk extends JsonWebKey { kid?: string; alg?: string; }
const JWKS_FOR_MS = 10 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 30;
const TIMEOUT_MS = 10_000;
const decodeJson = (part: string): Record<string, unknown> => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

/**
 * Supabase Auth (ADR D1): the server asks Supabase to send the code and to check it, so the browser
 * never holds a Supabase token and the page's content policy stays `connect-src 'self'`. The access
 * token Supabase returns is then verified here against Supabase's published keys — signature, issuer,
 * audience, expiry — before its subject is believed. Only asymmetric keys (ES256, RS256) are accepted:
 * a token signed with a shared secret could have been made by anyone holding that secret.
 */
export class SupabaseIdentityProvider implements IdentityProvider {
  readonly kind = "supabase" as const;
  readonly #url: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #keys: { at: number; byKid: Map<string, { key: KeyObject; alg: string }> } | undefined;

  constructor(url: string, apiKey: string, fetcher: typeof fetch = fetch, now: () => number = Date.now) {
    this.#url = url.replace(/\/+$/, "");
    this.#apiKey = apiKey;
    this.#fetch = fetcher;
    this.#now = now;
  }

  async sendCode(address: SignInAddress): Promise<Record<string, never>> {
    await this.#call("/auth/v1/otp", { [address.kind]: address.value, create_user: true });
    return {};
  }

  async checkCode(address: SignInAddress, code: string): Promise<VerifiedIdentity> {
    const reply = await this.#call("/auth/v1/verify", { type: address.kind === "phone" ? "sms" : "email", [address.kind]: address.value, token: code.trim() }, true);
    const token = typeof reply.access_token === "string" ? reply.access_token : "";
    const claims = await this.verifyAccessToken(token);
    // The address the code went to is the one proved. The token must agree, or nothing is believed.
    const claimed = address.kind === "phone" ? `+${String(claims.phone ?? "").replace(/^\+/, "")}` : String(claims.email ?? "").toLowerCase();
    if (claimed !== address.value) throw new ConnectorError("UNAUTHORIZED", false);
    const identity: VerifiedIdentity = { subject: String(claims.sub), [address.kind]: address.value };
    if (addressOf(identity) === undefined) throw new ConnectorError("UNAUTHORIZED", false);
    return identity;
  }

  /** Exported for tests: the checks a Supabase access token must pass before its subject is used. */
  async verifyAccessToken(token: string): Promise<Record<string, unknown>> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new ConnectorError("UNAUTHORIZED", false);
    const [head, body, signature] = parts as [string, string, string];
    let header: Record<string, unknown>; let claims: Record<string, unknown>;
    try { header = decodeJson(head); claims = decodeJson(body); } catch { throw new ConnectorError("UNAUTHORIZED", false); }
    if (header.alg !== "ES256" && header.alg !== "RS256") throw new ConnectorError("UNAUTHORIZED", false);
    const found = await this.#key(String(header.kid ?? ""));
    if (found === undefined || found.alg !== header.alg) throw new ConnectorError("UNAUTHORIZED", false);
    const valid = verifySignature("sha256", Buffer.from(`${head}.${body}`), header.alg === "ES256" ? { key: found.key, dsaEncoding: "ieee-p1363" } : found.key, Buffer.from(signature, "base64url"));
    if (!valid) throw new ConnectorError("UNAUTHORIZED", false);
    const nowSeconds = Math.floor(this.#now() / 1000);
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== `${this.#url}/auth/v1` || !audience.includes("authenticated") || claims.role !== "authenticated"
      || typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS <= nowSeconds
      || (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_SECONDS > nowSeconds)
      || typeof claims.sub !== "string" || claims.sub === "") throw new ConnectorError("UNAUTHORIZED", false);
    return claims;
  }

  async #key(kid: string): Promise<{ key: KeyObject; alg: string } | undefined> {
    const fresh = this.#keys !== undefined && this.#now() - this.#keys.at < JWKS_FOR_MS;
    if (!fresh || !this.#keys!.byKid.has(kid)) {
      // A key not seen yet may be a rotation: read the published keys again, at most once per call.
      const reply = await this.#request(`${this.#url}/auth/v1/.well-known/jwks.json`, { method: "GET" });
      const byKid = new Map<string, { key: KeyObject; alg: string }>();
      for (const jwk of (Array.isArray(reply.keys) ? reply.keys : []) as Jwk[]) {
        if (typeof jwk.kid !== "string" || (jwk.alg !== "ES256" && jwk.alg !== "RS256")) continue;
        try { byKid.set(jwk.kid, { key: createPublicKey({ key: jwk, format: "jwk" }), alg: jwk.alg }); } catch { /* a key we cannot read is a key we do not trust */ }
      }
      this.#keys = { at: this.#now(), byKid };
    }
    return this.#keys!.byKid.get(kid);
  }

  async #call(path: string, body: Record<string, unknown>, codeCheck = false): Promise<Record<string, unknown>> {
    return this.#request(`${this.#url}${path}`, { method: "POST", body: JSON.stringify(body) }, codeCheck);
  }

  async #request(url: string, init: RequestInit, codeCheck = false): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(url, { ...init, headers: { apikey: this.#apiKey, "content-type": "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new ConnectorError((error as Error).name === "TimeoutError" ? "TIMEOUT" : "OUTAGE", true);
    }
    // A wrong or expired code is the person's to fix; Supabase answers it with a 4xx.
    if (codeCheck && response.status >= 400 && response.status < 500 && response.status !== 429) throw new CodeNotAccepted();
    if (!response.ok) throw new ConnectorError(response.status >= 500 || response.status === 429 ? "OUTAGE" : "INVALID_REQUEST", response.status >= 500 || response.status === 429, response.headers.get("x-request-id") ?? undefined);
    try { return await response.json() as Record<string, unknown>; } catch { throw new ConnectorError("OUTAGE", true); }
  }
}

const DEVELOPMENT = new Set(["", "development", "test"]);

/**
 * The provider for this process. With `SUPABASE_URL` set, Supabase; without it, the mock — and only
 * on a developer's machine or in a test run, the same rule `createDatabase` uses for its fallback.
 */
export const identityProviderFor = (env: Readonly<Record<string, string | undefined>>, demoCode: string): IdentityProvider => {
  const url = env.SUPABASE_URL?.trim();
  if (url) {
    const key = env.SUPABASE_ANON_KEY?.trim();
    if (!key) throw new Error("SUPABASE_ANON_KEY is not set. Sign-in cannot reach Supabase without it.");
    if (!url.startsWith("https://")) throw new Error("SUPABASE_URL must be an https:// address.");
    return new SupabaseIdentityProvider(url, key);
  }
  if (!DEVELOPMENT.has((env.NODE_ENV ?? "").trim().toLowerCase())) {
    throw new Error("SUPABASE_URL is not set. The demo sign-in only runs on a developer's machine, so the server will not start.");
  }
  return new MockIdentityProvider(demoCode);
};
