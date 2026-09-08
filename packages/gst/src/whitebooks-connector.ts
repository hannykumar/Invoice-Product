/**
 * WhiteBooks (formerly MasterGST) as the `irp` connector behind `connector-v1`.
 *
 * Everything provider-shaped lives here. `irpAdapter` above it never learns who the GSP is: it
 * sends `einvoice.generate` / `.fetch` / `.cancel` and reads back the government's own field names
 * (`Irn`, `AckNo`, `SignedQRCode`, `ErrorCode`), so this file's whole job is to turn WhiteBooks'
 * envelope into those names and its failures into `ConnectorError`.
 *
 * Endpoint shapes below were confirmed against https://apisandbox.whitebooks.in by probing, not
 * from a document — the service answers an unknown path with `WB_ERR_9404` and a known one with a
 * list of the headers it still wants, which is how each was pinned down.
 */
import {
  ConnectorError, type ConnectorRequest, type ConnectorResponse, type ExternalConnector,
} from "../../platform/src/connectors.ts";

export interface WhitebooksCredentials {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** The taxpayer whose invoices these are. Sandbox GSTINs are issued by GSTN, not invented. */
  readonly gstin: string;
  readonly username: string;
  readonly password: string;
  /** NIC ties a session to the calling address; in production it must also be whitelisted. */
  readonly ipAddress: string;
}

export interface WhitebooksDeps {
  readonly credentials: WhitebooksCredentials;
  /** Their portal wants one on every call. Not used for anything but their own records. */
  readonly email: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => Date;
}

/** Operations this connector answers, and where each one lives. */
const ROUTES: Readonly<Record<string, { readonly method: "GET" | "POST"; readonly path: string }>> = Object.freeze({
  "einvoice.generate": { method: "POST", path: "/einvoice/type/GENERATE/version/V1_03" },
  "einvoice.fetch": { method: "GET", path: "/einvoice/type/GETIRN/version/V1_03" },
  "einvoice.cancel": { method: "POST", path: "/einvoice/type/CANCEL/version/V1_03" },
});

/** A token is good for a few hours; we keep it until it is nearly stale, then get another. */
const TOKEN_SAFETY_MARGIN_MS = 60_000;

type Envelope = {
  readonly status_cd?: string | number;
  readonly status_desc?: string;
  readonly data?: unknown;
  readonly error?: unknown;
  readonly errorCode?: string;
};

/**
 * Their failures arrive as HTTP 200 with `status_cd: "0"`, so the status line tells us nothing.
 * Retryable means "the same call might work later": we could not reach them, or they broke. A
 * refused document is not retryable and is not an error here at all — it travels back as payload
 * so `irpAdapter` can tell the shopkeeper which field the government objected to.
 */
const networkFailure = (error: unknown): ConnectorError => {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return new ConnectorError("TIMEOUT", true);
  return new ConnectorError("OUTAGE", true);
};

/** Pull the government's own field names out of whatever WhiteBooks wrapped them in. */
const unwrap = (body: Envelope): Record<string, unknown> => {
  const errors = Array.isArray(body.error) ? body.error : [];
  const first = errors[0] as { error_cd?: string; message?: string } | undefined;
  if (first?.error_cd !== undefined) return { ErrorCode: String(first.error_cd), ErrorMessage: first.message ?? "" };

  // A refusal with no itemised error still has to reach the caller as a refusal, or a rejected
  // bill would look like a registered one with every field blank.
  if (String(body.status_cd) !== "1") {
    return { ErrorCode: body.errorCode ?? "UNKNOWN", ErrorMessage: body.status_desc ?? "The e-invoice service refused this request." };
  }
  const data = body.data;
  if (typeof data === "string") {
    try { return JSON.parse(data) as Record<string, unknown>; } catch { return { ErrorCode: "UNREADABLE", ErrorMessage: data }; }
  }
  return (data ?? {}) as Record<string, unknown>;
};

export const whitebooksIrpConnector = (deps: WhitebooksDeps): ExternalConnector => {
  const { credentials: creds, email } = deps;
  const doFetch = deps.fetch ?? globalThis.fetch;
  const now = deps.clock ?? (() => new Date());
  let token: { readonly value: string; readonly expiresAt: number } | undefined;

  const headers = (extra: Readonly<Record<string, string>> = {}): Record<string, string> => ({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    gstin: creds.gstin,
    ip_address: creds.ipAddress,
    username: creds.username,
    ...extra,
  });

  const call = async (method: "GET" | "POST", path: string, extraHeaders: Readonly<Record<string, string>>, body?: unknown): Promise<Envelope> => {
    const url = `${creds.baseUrl}${path}${path.includes("?") ? "&" : "?"}email=${encodeURIComponent(email)}`;
    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        headers: { ...headers(extraHeaders), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
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

  const authenticate = async (): Promise<string> => {
    const current = token;
    if (current && current.expiresAt - TOKEN_SAFETY_MARGIN_MS > now().getTime()) return current.value;

    const body = await call("GET", "/einvoice/authenticate", { password: creds.password });
    const data = unwrap(body);
    const value = typeof data.AuthToken === "string" ? data.AuthToken : "";
    // A blank token means they rejected the login, not that the login is blank. Not retryable:
    // trying the same wrong password again is how an account gets locked.
    if (value === "") throw new ConnectorError("UNAUTHORIZED", false);
    const validMinutes = typeof data.TokenExpiry === "string" ? Date.parse(data.TokenExpiry) - now().getTime() : 6 * 60 * 60_000;
    token = { value, expiresAt: now().getTime() + (Number.isFinite(validMinutes) && validMinutes > 0 ? validMinutes : 6 * 60 * 60_000) };
    return value;
  };

  return {
    kind: "irp",

    async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
      const route = ROUTES[request.operation];
      if (route === undefined) throw new ConnectorError("INVALID_REQUEST", false);
      const authToken = await authenticate();

      const query = route.method === "GET" && typeof request.payload.Irn === "string" ? `?irn=${encodeURIComponent(request.payload.Irn)}` : "";
      const body = await call(
        route.method,
        `${route.path}${query}`,
        { "auth-token": authToken },
        route.method === "POST" ? request.payload : undefined,
      );

      // Their duplicate reply is a 200 carrying the existing IRN; `irpAdapter` turns code 2150
      // into a success, so it must arrive as payload rather than as a thrown error.
      return Object.freeze({
        providerRequestId: typeof body.status_desc === "string" && body.status_desc !== "" ? `whitebooks:${request.idempotencyKey}` : `whitebooks:${request.correlationId}`,
        status: "completed" as const,
        payload: Object.freeze(unwrap(body)),
      });
    },

    async health(): Promise<"healthy" | "degraded" | "unavailable"> {
      try {
        await authenticate();
        return "healthy";
      } catch (error) {
        return error instanceof ConnectorError && error.code === "UNAUTHORIZED" ? "degraded" : "unavailable";
      }
    },
  };
};
