/**
 * The bits of WhiteBooks that every lane shares: how they shape a reply, and how a failure is told
 * apart from a refusal.
 *
 * This exists because the e-invoice and e-way bill lanes are the same service wearing two hats.
 * They differ in their routes, in whether a token is wanted, and — awkwardly — in how they spell an
 * error, but the envelope and the failure handling are identical, and writing that twice is how the
 * two copies drift apart.
 *
 * Everything here was confirmed against `https://apisandbox.whitebooks.in`, not from a document.
 */
import { ConnectorError } from "../../platform/src/connectors.ts";

export interface WhitebooksCredentials {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** The taxpayer whose documents these are. Sandbox GSTINs are issued, not invented. */
  readonly gstin: string;
  readonly username: string;
  readonly password: string;
  /** NIC ties a session to the calling address; in production it must also be whitelisted. */
  readonly ipAddress: string;
}

export type Envelope = {
  readonly status_cd?: string | number;
  readonly status_desc?: string;
  readonly data?: unknown;
  readonly error?: unknown;
  readonly errorCode?: string;
  readonly message?: string;
  /** Where the sentence a person can read actually lives, when there is one. */
  readonly info?: string;
};

/**
 * Retryable means "the same call might work later": we could not reach them, or they broke. A
 * refused document is not retryable and is not an error here at all — it travels back as payload so
 * the layer above can tell the shopkeeper which field the government objected to.
 */
export const networkFailure = (error: unknown): ConnectorError => {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return new ConnectorError("TIMEOUT", true);
  return new ConnectorError("OUTAGE", true);
};

/** Numbers arrive as numbers — `AckNo` and `ewayBillNo` both — and are read above as text. */
const asText = (value: unknown): unknown => (typeof value === "number" ? String(value) : value);

const parseErrors = (description: string): { readonly code: string; readonly message: string } | undefined => {
  const text = description.trim();
  if (!text.startsWith("[") && !text.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    const first = (Array.isArray(parsed) ? parsed[0] : parsed) as { errorCode?: unknown; errorMessage?: unknown } | undefined;
    if (first?.errorCode === undefined) return undefined;
    return { code: String(first.errorCode), message: typeof first.errorMessage === "string" ? first.errorMessage : "" };
  } catch {
    return undefined;
  }
};

/**
 * Pull the government's own field names out of whatever WhiteBooks wrapped them in.
 *
 * Failures arrive as HTTP 200 with `status_cd: "0"`, so the status line tells us nothing. Errors
 * appear in three different places depending on the lane, which is why all three are read here.
 */
export const unwrap = (body: Envelope): Record<string, unknown> => {
  if (String(body.status_cd) !== "1") {
    const described = parseErrors(body.status_desc ?? "");
    if (described !== undefined) return { ErrorCode: described.code, ErrorMessage: described.message };

    // Two spellings are in use: `error_cd`/`message` on e-invoice, `errorCode`/`errorMessage` on
    // e-way bill — where `errorMessage` merely repeats the code and the readable sentence sits in
    // `info` ("The distance between the pincodes given is too high or low"). Take whichever speaks.
    const errors = Array.isArray(body.error) ? body.error : [];
    const first = errors[0] as { error_cd?: unknown; errorCode?: unknown; message?: unknown; errorMessage?: unknown } | undefined;
    const code = first?.error_cd ?? first?.errorCode;
    if (code !== undefined) {
      const stated = [first?.message, first?.errorMessage].find((value) => typeof value === "string" && value !== "" && value !== String(code));
      const readable = (body.info ?? "").replace(/^[,\s]+/, "");
      return { ErrorCode: String(code), ErrorMessage: (stated as string | undefined) ?? readable };
    }

    // A refusal we cannot itemise is still a refusal. A blank success would look registered.
    return {
      ErrorCode: body.errorCode ?? "UNKNOWN",
      ErrorMessage: body.message ?? body.status_desc ?? "The service refused this request.",
    };
  }

  const data = body.data;
  const object = typeof data === "string"
    ? (() => { try { return JSON.parse(data) as Record<string, unknown>; } catch { return { ErrorCode: "UNREADABLE", ErrorMessage: data }; } })()
    : ((data ?? {}) as Record<string, unknown>);
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, asText(value)]));
};

export interface CallerOptions {
  readonly credentials: WhitebooksCredentials;
  /** Their portal wants one on every call. Not used for anything but their own records. */
  readonly email: string;
  readonly fetch?: typeof globalThis.fetch;
}

export type Caller = (method: "GET" | "POST", path: string, extraHeaders: Readonly<Record<string, string>>, body?: unknown) => Promise<Envelope>;

/** One HTTP shape for every lane: their headers, their query string, their failure modes. */
export const makeCaller = (options: CallerOptions): Caller => {
  const { credentials: creds } = options;
  const doFetch = options.fetch ?? globalThis.fetch;

  return async (method, path, extraHeaders, body) => {
    const url = `${creds.baseUrl}${path}${path.includes("?") ? "&" : "?"}email=${encodeURIComponent(options.email)}`;
    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        headers: {
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          gstin: creds.gstin,
          ip_address: creds.ipAddress,
          username: creds.username,
          ...extraHeaders,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw networkFailure(error);
    }
    if (response.status === 401 || response.status === 403) throw new ConnectorError("UNAUTHORIZED", false, response.headers.get("x-request-id") ?? undefined);
    if (response.status >= 500) throw new ConnectorError("OUTAGE", true);
    try {
      return (await response.json()) as Envelope;
    } catch {
      throw new ConnectorError("OUTAGE", true);
    }
  };
};
