// Deciding which company an inbound document belongs to (issues #15 and #400).
//
// Getting this wrong is a tenant leak, so only facts the sender cannot write decide:
//   1. an authenticated upload: the company comes from the uploader's `RequestContext`;
//   2. the channel binding: the email alias or WhatsApp number the document was delivered
//      to, as reported by the channel adapter, belongs to exactly one company.
// Nothing else routes. In particular the buyer GSTIN printed inside the file does **not**:
// a GSTIN is printed on every bill, so it is public, and anyone can type it into a JSON file
// (#400, threat-model I1). The printed GSTIN is still used, after reading, as a cross-check
// that can hold a document in the company it was routed to (inbox.ts) — never to move it to
// another company.

import type { Id } from "../../masters/src/types.ts";
import type { RequestContext } from "../../platform/src/types.ts";
import type { InboundSender, IntakeChannel, QuarantineReason, RoutingDecision } from "./inbox-types.ts";

export interface CompanyRoutingProfile {
  readonly companyId: Id;
  readonly legalName: string;
  /** Every GSTIN this company is registered under, across states. */
  readonly gstins: readonly string[];
  /** Inbound email aliases, e.g. bills-sampoorna@invoices.example. */
  readonly emailAliases: readonly string[];
  /** WhatsApp Business numbers this company receives documents on. */
  readonly whatsappNumbers: readonly string[];
}

export type RoutingResult =
  | { readonly ok: true; readonly companyId: Id; readonly decision: RoutingDecision }
  | {
    readonly ok: false;
    readonly reason: QuarantineReason;
    readonly message: string;
    /**
     * Companies whose channel the document arrived on. Only these may later claim it with
     * `assignCompany`; a document that arrived on nobody's channel can be claimed by nobody.
     */
    readonly channelOwners: readonly Id[];
  };

const digits = (value: string): string => value.replace(/\D/g, "").slice(-10);

/** The companies a delivery address belongs to, for the channel it arrived through. */
export function channelOwners(companies: readonly CompanyRoutingProfile[], channel: IntakeChannel, deliveredTo: string | undefined): readonly CompanyRoutingProfile[] {
  const target = deliveredTo?.trim();
  if (!target) return [];
  // An alias only binds email, a number only binds WhatsApp: the same text arriving through
  // another channel proves nothing about where it was sent.
  if (channel === "email") return companies.filter((company) => company.emailAliases.some((alias) => alias.trim().toLowerCase() === target.toLowerCase()));
  if (channel === "whatsapp") {
    const wanted = digits(target);
    if (wanted.length < 10) return [];
    return companies.filter((company) => company.whatsappNumbers.some((number) => digits(number) === wanted));
  }
  return [];
}

export function routeDocument(input: {
  readonly companies: readonly CompanyRoutingProfile[];
  readonly channel: IntakeChannel;
  readonly sender: InboundSender;
  /**
   * The recipient alias or number the document arrived on, as reported by the channel
   * adapter from the provider's own delivery record (the SMTP envelope recipient, the
   * WhatsApp Business phone-number id) — never from a header the sender wrote.
   */
  readonly deliveredTo?: string;
  /** Set when an authenticated user uploaded into the company they are signed in to. */
  readonly uploader?: RequestContext;
}): RoutingResult {
  if (input.uploader) {
    const company = input.companies.find((candidate) => candidate.companyId === input.uploader?.companyId);
    if (!company) return { ok: false, reason: "COMPANY_NOT_IDENTIFIED", message: "The business this was uploaded into is not set up to receive bills.", channelOwners: [] };
    return { ok: true, companyId: company.companyId, decision: { basis: "explicit_company", evidence: `Uploaded into ${company.legalName}`, confidence: 1 } };
  }

  const bound = channelOwners(input.companies, input.channel, input.deliveredTo);
  if (bound.length === 1) {
    const only = bound[0] as CompanyRoutingProfile;
    return {
      ok: true,
      companyId: only.companyId,
      // The destination is proven by the provider; what the document says is not, so #16 and
      // the buyer-GSTIN cross-check still confirm it before anything is approved.
      decision: { basis: "channel_binding", evidence: `Received on ${input.deliveredTo?.trim()}, which belongs to ${only.legalName}`, confidence: 0.7 },
    };
  }
  if (bound.length > 1) {
    return {
      ok: false,
      reason: "COMPANY_NOT_IDENTIFIED",
      message: "This address is shared by more than one of your businesses. Please choose which one this invoice belongs to.",
      channelOwners: bound.map((company) => company.companyId),
    };
  }

  return {
    ok: false,
    reason: "COMPANY_NOT_IDENTIFIED",
    message: "This did not arrive on an address or number linked to any business, so it has been held. A GST number printed inside a file is not enough to file it in anyone's books.",
    channelOwners: [],
  };
}
