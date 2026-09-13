/**
 * Issue #51 [X03] — which government endpoint this build is allowed to talk to.
 *
 * "Production access is active" is an acceptance criterion, and a sentence in a document cannot
 * satisfy it: the thing that decides whether a real IRN is requested for a real taxpayer is a base
 * URL in a configuration file, and a base URL is one careless copy away from being the live portal.
 *
 * So the switch lives here, in code, on the path every call already goes through, and it is off.
 * While it is off, only endpoints this repository has actually probed — plus the unreachable hosts
 * tests use — can be called at all. Everything else is refused before a single credential is sent,
 * with a sentence naming the go-live gate rather than a stack trace.
 *
 * Turning it on is not an edit somebody makes to get a call working. It is the last step of
 * `ops/gsp-production`, after a signed agreement, a security review and a pilot customer who
 * consented — see `docs/compliance/x03-gsp-production-onboarding.md`.
 */
import { invalid } from "@invoice/kernel";

export type GovernmentEnvironment = "SANDBOX" | "PRODUCTION" | "UNKNOWN";

export interface ProductionAccess {
  /** Whether this build may call a government endpoint that is not a sandbox. */
  readonly active: boolean;
  /** When the state below was last decided, and by which issue's process. */
  readonly decidedOn: string;
  /** Why it stands where it stands, in words the next person can act on. */
  readonly reason: string;
}

/**
 * Where production access stands today.
 *
 * It is off, and not because the work merely has not been done: the owner's standing instruction is
 * that this product integrates against free sandbox APIs only. A sandbox proves the integration
 * works; it issues no legally valid IRN or e-way bill. Both halves of that are true at once and the
 * register says so rather than implying we are one merge away from going live.
 */
export const PRODUCTION_ACCESS: ProductionAccess = Object.freeze({
  active: false,
  decidedOn: "2026-09-13",
  reason:
    "This product runs against free GST sandbox APIs only. No production GSP agreement has been " +
    "signed, no pilot GSTIN has consented, and nothing here may call the live portal. See " +
    "docs/compliance/x03-gsp-production-onboarding.md for what turning this on requires.",
});

/**
 * The hosts we have actually probed, with the date.
 *
 * Deliberately not "every host with `sandbox` in the name": a host earns its place here by somebody
 * having called it and written down what it answered. `docs/contracts/whitebooks-sandbox.md` is
 * that record for the one entry below.
 */
export const CONFIRMED_SANDBOX_HOSTS: readonly string[] = Object.freeze(["apisandbox.whitebooks.in"]);

/** `.invalid` can never resolve (RFC 2606), so a fixture pointed at one reaches no portal, ever. */
const isUnreachableTestHost = (host: string): boolean =>
  host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".invalid");

export const environmentOf = (baseUrl: string): GovernmentEnvironment => {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "UNKNOWN";
  }
  if (CONFIRMED_SANDBOX_HOSTS.includes(host) || isUnreachableTestHost(host)) return "SANDBOX";
  return "PRODUCTION";
};

export type EndpointVerdict =
  | { readonly allowed: true; readonly environment: GovernmentEnvironment }
  | { readonly allowed: false; readonly code: string; readonly message: string };

/**
 * Whether one endpoint may be called.
 *
 * A refusal says which address was refused and what would have to be true for it to be allowed,
 * because the person reading it is a developer who has just pasted a URL, not an attacker.
 */
export const checkGovernmentEndpoint = (
  baseUrl: string,
  access: ProductionAccess = PRODUCTION_ACCESS,
): EndpointVerdict => {
  const environment = environmentOf(baseUrl);
  if (environment === "UNKNOWN") {
    return { allowed: false, code: "GOVERNMENT_ENDPOINT_UNREADABLE", message: `"${baseUrl}" is not a web address, so nothing was sent.` };
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { allowed: false, code: "GOVERNMENT_ENDPOINT_UNREADABLE", message: `"${baseUrl}" is not a web address, so nothing was sent.` };
  }
  if (url.protocol !== "https:" && !isUnreachableTestHost(url.hostname.toLowerCase())) {
    return {
      allowed: false,
      code: "GOVERNMENT_ENDPOINT_NOT_ENCRYPTED",
      message: `${url.hostname} was asked for over ${url.protocol.replace(":", "")}. A GST credential is never sent unencrypted.`,
    };
  }
  if (environment === "PRODUCTION" && !access.active) {
    return {
      allowed: false,
      code: "GOVERNMENT_PRODUCTION_NOT_ACTIVE",
      message:
        `${url.hostname} is not one of the sandbox addresses this build is allowed to call, and production access is not active. ` +
        access.reason,
    };
  }
  return { allowed: true, environment };
};

/** The same check as a guard, for the one place every provider call is built. */
export const assertGovernmentEndpoint = (baseUrl: string, access: ProductionAccess = PRODUCTION_ACCESS): void => {
  const verdict = checkGovernmentEndpoint(baseUrl, access);
  if (!verdict.allowed) throw invalid(verdict.code, verdict.message);
};
