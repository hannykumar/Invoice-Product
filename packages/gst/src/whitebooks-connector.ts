/**
 * WhiteBooks (formerly MasterGST) as the `irp` connector behind `connector-v1`.
 *
 * Everything provider-shaped lives here. `irpAdapter` above it never learns who the GSP is: it
 * sends `einvoice.generate` / `.fetch` / `.cancel` and reads back the government's own field names
 * (`Irn`, `AckNo`, `SignedQRCode`, `ErrorCode`), so this file's whole job is to turn WhiteBooks'
 * envelope into those names and its failures into `ConnectorError`.
 *
 * Routes were pinned down against `https://apisandbox.whitebooks.in` and then checked against the
 * reference inside their Developer Hub. The envelope handling is shared with the e-way bill lane in
 * `whitebooks-http.ts`.
 */
import { ConnectorError, type ConnectorRequest, type ConnectorResponse, type ExternalConnector } from "../../platform/src/connectors.ts";
import { makeCaller, unwrap, type Caller, type WhitebooksCredentials } from "./whitebooks-http.ts";
import { computeIrn } from "./irn.ts";
import type { EInvoiceDocumentType } from "./einvoice-types.ts";

export type { WhitebooksCredentials };

export interface WhitebooksDeps {
  readonly credentials: WhitebooksCredentials;
  readonly email: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => Date;
}

const ROUTES: Readonly<Record<string, { readonly method: "GET" | "POST"; readonly path: string }>> = Object.freeze({
  "einvoice.generate": { method: "POST", path: "/einvoice/type/GENERATE/version/V1_03" },
  "einvoice.fetch": { method: "GET", path: "/einvoice/type/GETIRN/version/V1_03" },
  "einvoice.cancel": { method: "POST", path: "/einvoice/type/CANCEL/version/V1_03" },
});

/** The schema's document codes, back to our own names. */
const DOCUMENT_TYPES: Readonly<Record<string, EInvoiceDocumentType>> = Object.freeze({
  INV: "INVOICE", CRN: "CREDIT_NOTE", DBN: "DEBIT_NOTE",
});

/** A token is good for a few hours; we keep it until it is nearly stale, then get another. */
const TOKEN_SAFETY_MARGIN_MS = 60_000;
const DEFAULT_TOKEN_LIFE_MS = 6 * 60 * 60_000;

/** The government's "already registered" code. */
const DUPLICATE_CODE = "2150";

export const whitebooksIrpConnector = (deps: WhitebooksDeps): ExternalConnector => {
  const call: Caller = makeCaller({ credentials: deps.credentials, email: deps.email, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) });
  const now = deps.clock ?? (() => new Date());
  let token: { readonly value: string; readonly expiresAt: number } | undefined;

  const authenticate = async (): Promise<string> => {
    const current = token;
    if (current && current.expiresAt - TOKEN_SAFETY_MARGIN_MS > now().getTime()) return current.value;

    const data = unwrap(await call("GET", "/einvoice/authenticate", { password: deps.credentials.password }));
    const value = typeof data.AuthToken === "string" ? data.AuthToken : "";
    // A blank token means they rejected the login, not that the login is blank. Not retryable:
    // trying the same wrong password again is how an account gets locked.
    if (value === "") throw new ConnectorError("UNAUTHORIZED", false);
    const life = typeof data.TokenExpiry === "string" ? Date.parse(data.TokenExpiry) - now().getTime() : Number.NaN;
    token = { value, expiresAt: now().getTime() + (Number.isFinite(life) && life > 0 ? life : DEFAULT_TOKEN_LIFE_MS) };
    return value;
  };

  /** Recover the acknowledgement for a bill the portal says it already has. */
  const fetchExisting = async (sent: Readonly<Record<string, unknown>>, authToken: string): Promise<Record<string, unknown> | undefined> => {
    const seller = sent.SellerDtls as { Gstin?: string } | undefined;
    const doc = sent.DocDtls as { Typ?: string; No?: string; Dt?: string } | undefined;
    if (seller?.Gstin === undefined || doc?.No === undefined || doc.Dt === undefined || doc.Typ === undefined) return undefined;

    const irn = computeIrn({
      supplierGstin: seller.Gstin,
      documentType: DOCUMENT_TYPES[doc.Typ] ?? "INVOICE",
      documentNumber: doc.No,
      // The schema sends dd/mm/yyyy; `computeIrn` works from the financial year of an ISO date.
      documentDate: doc.Dt.split("/").reverse().join("-"),
    });
    try {
      const found = unwrap(await call("GET", `/einvoice/type/GETIRN/version/V1_03?irn=${encodeURIComponent(irn)}`, { "auth-token": authToken }));
      return typeof found.Irn === "string" ? found : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    kind: "irp",

    async execute(request: ConnectorRequest): Promise<ConnectorResponse> {
      const route = ROUTES[request.operation];
      if (route === undefined) throw new ConnectorError("INVALID_REQUEST", false);
      const authToken = await authenticate();

      const query = route.method === "GET" && typeof request.payload.Irn === "string" ? `?irn=${encodeURIComponent(request.payload.Irn)}` : "";
      const body = await call(route.method, `${route.path}${query}`, { "auth-token": authToken }, route.method === "POST" ? request.payload : undefined);

      let payload = unwrap(body);

      // Their duplicate reply carries the code but *not* the IRN, and the layer above must end up
      // holding one — that is the whole point of a retry after a timeout. The IRN is a hash of four
      // fields we already sent, so we recompute it and ask the portal for its record.
      if (payload.ErrorCode === DUPLICATE_CODE && request.operation === "einvoice.generate") {
        const existing = await fetchExisting(request.payload, authToken);
        if (existing !== undefined) payload = { ...existing, ...payload };
      }

      return Object.freeze({
        providerRequestId: `whitebooks:${request.idempotencyKey}`,
        status: "completed" as const,
        payload: Object.freeze(payload),
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
