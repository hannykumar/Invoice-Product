// Issue #400 — the IRP signature check. The key pair is generated here: it stands in for the
// IRP's, so no government key or credential is needed to run this.

import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { NO_IRP_SIGNING_KEY, Rs256IrpSignatureVerifier } from "../src/irp-signature.ts";

const irp = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
const irpPublicPem = irp.publicKey.export({ type: "spki", format: "pem" }).toString();

const b64 = (value: unknown): string => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
const jws = (data: unknown, key = irp.privateKey, header: Record<string, unknown> = { alg: "RS256", kid: "irp-1", typ: "JWT" }): string => {
  const signingInput = `${b64(header)}.${b64({ data: JSON.stringify(data), iss: "NIC" })}`;
  return `${signingInput}.${sign("sha256", Buffer.from(signingInput), key).toString("base64url")}`;
};
const invoice = { Irn: "x".repeat(64), DocDtls: { No: "A-1" }, BuyerDtls: { Gstin: "29AAAAA0000A1Z5" } };
const verifier = new Rs256IrpSignatureVerifier([{ keyId: "irp-1", pem: irpPublicPem }]);

test("a token signed with the IRP's key is verified and its invoice returned", () => {
  const check = verifier.verify(jws(invoice));
  assert.equal(check.status, "verified");
  assert.deepEqual(check.status === "verified" && check.data, invoice);
});

test("a token signed with someone else's key is invalid", () => {
  assert.equal(verifier.verify(jws(invoice, stranger.privateKey)).status, "invalid");
});

test("changing the invoice after signing breaks the signature", () => {
  const [header, , signature] = jws(invoice).split(".");
  const forged = `${header}.${b64({ data: JSON.stringify({ ...invoice, BuyerDtls: { Gstin: "27BBBBB1111B1Z5" } }), iss: "NIC" })}.${signature}`;
  assert.equal(verifier.verify(forged).status, "invalid");
});

test("alg none and HS256 signed with the public key are refused", () => {
  const none = `${b64({ alg: "none", typ: "JWT" })}.${b64({ data: JSON.stringify(invoice) })}.`;
  assert.equal(verifier.verify(none).status, "invalid");
  const input = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ data: JSON.stringify(invoice) })}`;
  const hs = `${input}.${createHmac("sha256", irpPublicPem).update(input).digest("base64url")}`;
  assert.equal(verifier.verify(hs).status, "invalid");
});

test("an unknown kid still checks every configured key, so a rotated header does not let a forgery through", () => {
  assert.equal(verifier.verify(jws(invoice, irp.privateKey, { alg: "RS256", kid: "other" })).status, "verified");
  assert.equal(verifier.verify(jws(invoice, stranger.privateKey, { alg: "RS256", kid: "other" })).status, "invalid");
});

test("with no key configured nothing is verified, and nothing is called forged either", () => {
  assert.equal(NO_IRP_SIGNING_KEY.verify(jws(invoice)).status, "unverifiable");
  assert.equal(verifier.verify("not-a-token").status, "invalid");
});
