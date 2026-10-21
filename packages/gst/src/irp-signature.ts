// Issue #400 — checking the Invoice Registration Portal's signature on an e-invoice.
//
// When the IRP registers an invoice it returns `SignedInvoice` and `SignedQRCode`. Each is a
// compact JWS (a JWT): `base64url(header).base64url(payload).base64url(signature)`, header
// `{"alg":"RS256","kid":…,"typ":"JWT"}`, payload `{"data":"<the invoice as a JSON string>",
// "iss":"NIC"}`. The IRP signs with its private key; anyone can check the signature with the
// public key the IRP publishes. Only a file whose signature checks out with that key proves the
// government registered *this* invoice, with *this* buyer GSTIN, unchanged.
//
// Law: Rule 48(4) CGST Rules (inserted by Notification 68/2019-Central Tax, 13.12.2019; in force
// for notified taxpayers by Notification 13/2020-Central Tax, 21.03.2020, as amended) requires
// the invoice to be prepared by uploading it to the IRP; Rule 48(5) says an invoice issued any
// other way is not an invoice. The signed reply is how the IRP evidences that registration.
//
// NOT VERIFIED here, and said plainly: the JWS shape and RS256 algorithm above come from GSP
// documentation (ClearTax, "Learn e-invoicing API basics") because the NIC portal
// (einvoice1.gst.gov.in, einv-apisandbox.nic.in) refused connections when this was written. The
// NIC public key itself is not in this repository: it is downloaded from the IRP portal and
// supplied as configuration. With no key configured, nothing is ever reported as verified — every
// file is treated as unsigned. The government may rotate keys, so more than one can be supplied.
//
// No dependency is added: node:crypto verifies RSASSA-PKCS1-v1_5 with SHA-256 natively.

import { createPublicKey, verify as verifySignature } from "node:crypto";
import type { KeyObject } from "node:crypto";

export type IrpSignatureCheck =
  /** The signature is the IRP's. `data` is the signed invoice, parsed from the payload. */
  | { readonly status: "verified"; readonly data: Record<string, unknown>; readonly keyId?: string }
  /** The signature was checked and is wrong, or the token is malformed. Treat as tampered. */
  | { readonly status: "invalid"; readonly reason: string }
  /** It could not be checked (no key configured, unknown key). Treat as unsigned, not as forged. */
  | { readonly status: "unverifiable"; readonly reason: string };

/** The port. Production supplies the IRP's published key; tests supply a key pair they made. */
export interface IrpSignatureVerifier {
  verify(jws: string): IrpSignatureCheck;
}

export interface IrpPublicKey {
  /** The `kid` the IRP puts in the JWS header for this key, when known. */
  readonly keyId?: string;
  /** PEM, SPKI or X.509 certificate, as downloaded from the IRP portal. */
  readonly pem: string;
}

const decodeJson = (part: string): unknown => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Verifies the IRP's RS256 signature with the configured public key(s). */
export class Rs256IrpSignatureVerifier implements IrpSignatureVerifier {
  readonly #keys: readonly { readonly keyId?: string; readonly key: KeyObject }[];

  constructor(keys: readonly IrpPublicKey[]) {
    this.#keys = keys.map((entry) => ({ ...(entry.keyId === undefined ? {} : { keyId: entry.keyId }), key: createPublicKey(entry.pem) }));
  }

  verify(jws: string): IrpSignatureCheck {
    const parts = jws.trim().split(".");
    if (parts.length !== 3 || !parts.every((part) => BASE64URL.test(part))) return { status: "invalid", reason: "The signed invoice is not in the government's signed format." };
    const [headerPart = "", payloadPart = "", signaturePart = ""] = parts;
    let header: unknown;
    try { header = decodeJson(headerPart); } catch { return { status: "invalid", reason: "The signed invoice's header cannot be read." }; }
    const alg = header && typeof header === "object" ? (header as Record<string, unknown>).alg : undefined;
    // Only RS256. "none", HS256 (which would let a forger "sign" with the public key as an HMAC
    // secret) and anything else are refused outright.
    if (alg !== "RS256") return { status: "invalid", reason: "The signed invoice does not use the government's signing method." };
    if (this.#keys.length === 0) return { status: "unverifiable", reason: "No government signing key is configured, so the signature could not be checked." };
    const kid = (header as Record<string, unknown>).kid;
    const named = typeof kid === "string" ? this.#keys.filter((entry) => entry.keyId === kid) : [];
    const candidates = named.length > 0 ? named : this.#keys;
    const signed = Buffer.from(`${headerPart}.${payloadPart}`, "ascii");
    const signature = Buffer.from(signaturePart, "base64url");
    const match = candidates.find((entry) => {
      try { return verifySignature("sha256", signed, entry.key, signature); } catch { return false; }
    });
    if (!match) return { status: "invalid", reason: "The government's signature on this invoice does not match its contents." };

    let payload: unknown;
    try { payload = decodeJson(payloadPart); } catch { return { status: "invalid", reason: "The signed invoice's contents cannot be read." }; }
    const rawData = payload && typeof payload === "object" ? (payload as Record<string, unknown>).data : undefined;
    let data: unknown = rawData;
    if (typeof rawData === "string") {
      try { data = JSON.parse(rawData); } catch { return { status: "invalid", reason: "The signed invoice's contents cannot be read." }; }
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return { status: "invalid", reason: "The signed invoice carries no invoice." };
    return { status: "verified", data: data as Record<string, unknown>, ...(match.keyId === undefined ? {} : { keyId: match.keyId }) };
  }
}

/**
 * Reads the invoice inside a JWS **without** checking the signature. Only for a token that could
 * not be checked (no key configured), so its values can still be shown for review at unsigned
 * confidence. Never use the result as proof of anything.
 */
export const readUnverifiedPayload = (jws: string): Record<string, unknown> | null => {
  try {
    const payload = decodeJson(jws.trim().split(".")[1] ?? "") as Record<string, unknown>;
    const data: unknown = typeof payload?.data === "string" ? JSON.parse(payload.data) : payload?.data;
    return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

/** The default when no key is configured: never verified, never forged. */
export const NO_IRP_SIGNING_KEY: IrpSignatureVerifier = new Rs256IrpSignatureVerifier([]);
