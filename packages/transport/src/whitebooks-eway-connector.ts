/**
 * WhiteBooks as the `eway_bill` connector behind `connector-v1`, for issue #27.
 *
 * `ewayBillAdapter` above this never learns who the provider is: it sends `eway.generate`,
 * `eway.fetch`, `eway.vehicle` and the rest, and reads back the portal's own field names
 * (`ewayBillNo`, `ewayBillDate`, `validUpto`, `alert`). This file maps those operations onto the
 * routes and hands the reply back unchanged in shape.
 *
 * **This lane wants no token.** `/ewaybillapi/v1.03/authenticate` answers with the placeholder text
 * "If authentication succeeds" and no token at all, because none is used: the password travels as a
 * header on the call itself. That is confirmed by a real e-way bill raised this way, not assumed —
 * and it is on the list of things to have WhiteBooks confirm in writing, since it is the sort of
 * thing a provider tightens later.
 *
 * Every route below returns a real NIC validation error rather than `WB_ERR_9404`, which is how
 * each was confirmed to exist. **The names are lower case**, and that matters: `GENEWAYBILL` is not
 * configured and `genewaybill` is.
 */
import {
  ConnectorError, type ConnectorRequest, type ConnectorResponse, type ExternalConnector,
} from "../../platform/src/connectors.ts";
import { makeCaller, unwrap, type Caller, type WhitebooksCredentials } from "../../gst/src/whitebooks-http.ts";

export interface WhitebooksEwayDeps {
  readonly credentials: WhitebooksCredentials;
  readonly email: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Which NIC instance to route to. The portal defaults to NIC1 when unasked. */
  readonly irp?: "NIC1" | "NIC2";
}

const BASE = "/ewaybillapi/v1.03/ewayapi";

const ROUTES: Readonly<Record<string, { readonly method: "GET" | "POST"; readonly path: string }>> = Object.freeze({
  "eway.generate": { method: "POST", path: `${BASE}/genewaybill` },
  "eway.fetch": { method: "GET", path: `${BASE}/getewaybill` },
  "eway.vehicle": { method: "POST", path: `${BASE}/vehewb` },
  "eway.transporter": { method: "POST", path: `${BASE}/updatetransporter` },
  "eway.extend": { method: "POST", path: `${BASE}/extendvalidity` },
  "eway.cancel": { method: "POST", path: `${BASE}/canewb` },
  "eway.reject": { method: "POST", path: `${BASE}/rejewb` },
  "eway.consolidate": { method: "POST", path: `${BASE}/gencewb` },
});

/**
 * The portal answers a fetch with `ewbNo` and a generation with `ewayBillNo` — the same number
 * under two names. The layer above knows one name, so the fetch is given it. Without this a bill
 * that exists reads as NOT_FOUND, which is worse than an error: it invites raising a second bill
 * for goods that already have one.
 */
const named = (payload: Record<string, unknown>): Record<string, unknown> =>
  payload.ewayBillNo === undefined && payload.ewbNo !== undefined
    ? { ...payload, ewayBillNo: payload.ewbNo }
    : payload;

/** The portal's "this consignment already has a bill" code. */
const DUPLICATE_CODE = "604";

export const whitebooksEwayConnector = (deps: WhitebooksEwayDeps): ExternalConnector => {
  const call: Caller = makeCaller({ credentials: deps.credentials, email: deps.email, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) });
  const irp = deps.irp ?? "NIC1";

  // No token, so the password rides on every call. It is a header and never reaches a body, a log
  // or an audit payload — `connector-v1` forbids raw secrets in any of those.
  const headers = { password: deps.credentials.password } as const;

  return {
    kind: "eway_bill",

    async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
      const route = ROUTES[request.operation];
      if (route === undefined) throw new ConnectorError("INVALID_REQUEST", false);

      // A fetch identifies the bill in the query string; everything else sends a body.
      const number = request.payload.ewbNo;
      const query = route.method === "GET" && number !== undefined ? `?ewbNo=${encodeURIComponent(String(number))}&irp=${irp}` : `?irp=${irp}`;

      const body = await call(route.method, `${route.path}${query}`, headers, route.method === "POST" ? request.payload : undefined);
      const payload = named(unwrap(body));

      // Like the e-invoice lane, "already exists" must arrive as payload and not as a thrown error:
      // a retry after a timeout has to end with the caller holding the number the portal issued.
      return Object.freeze({
        providerRequestId: `whitebooks-ewb:${request.idempotencyKey}`,
        status: "completed" as const,
        payload: Object.freeze(payload),
      });
    },

    async health(): Promise<"healthy" | "degraded" | "unavailable"> {
      try {
        // There is no login to check, so ask for a bill that cannot exist. A reply of any shape
        // means the portal is answering; only a transport failure means it is not.
        await call("GET", `${BASE}/getewaybill?ewbNo=1&irp=${irp}`, headers);
        return "healthy";
      } catch (error) {
        return error instanceof ConnectorError && error.code === "UNAUTHORIZED" ? "degraded" : "unavailable";
      }
    },
  };
};

export { DUPLICATE_CODE as EWAY_DUPLICATE_CODE };
