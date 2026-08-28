// Deciding which company an inbound document belongs to (issue #15).
//
// Getting this wrong is a tenant leak, so the rules are conservative: an explicit
// company from an authenticated upload wins; a buyer GSTIN printed on the document is
// next; a channel binding (this email alias belongs to that company) is accepted but
// marked low confidence; anything else is quarantined for a human. A document is never
// routed to a company whose GSTIN contradicts the one printed on it.

import { normaliseIdentifier } from "../../masters/src/validation.ts";
import type { Id } from "../../masters/src/types.ts";
import type { InboundSender, QuarantineReason, RoutingDecision } from "./inbox-types.ts";

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
  | { readonly ok: false; readonly reason: QuarantineReason; readonly message: string; readonly decision?: RoutingDecision };

const clean = (value: string): string => normaliseIdentifier(value);
const digits = (value: string): string => value.replace(/\D/g, "").slice(-10);

export function routeDocument(input: {
  readonly companies: readonly CompanyRoutingProfile[];
  readonly sender: InboundSender;
  /** The recipient alias or number the document arrived on, when the channel has one. */
  readonly deliveredTo?: string;
  /** The buyer GSTIN read off the document, if one was found. */
  readonly buyerGstin?: string;
  /** Set when an authenticated user uploaded into a company they are already inside. */
  readonly explicitCompanyId?: Id;
}): RoutingResult {
  const byGstin = input.buyerGstin ? input.companies.filter((company) => company.gstins.some((gstin) => clean(gstin) === clean(input.buyerGstin as string))) : [];

  if (input.explicitCompanyId) {
    const company = input.companies.find((candidate) => candidate.companyId === input.explicitCompanyId);
    if (!company) return { ok: false, reason: "COMPANY_NOT_IDENTIFIED", message: "The company this was uploaded into no longer exists." };
    // An upload into the wrong company is the most likely tenant mistake, so a printed
    // GSTIN that belongs to a different company overrides the upload target.
    if (input.buyerGstin && byGstin.length > 0 && !byGstin.some((match) => match.companyId === company.companyId)) {
      return {
        ok: false,
        reason: "COMPANY_MISMATCH",
        message: `This invoice is addressed to ${byGstin[0]?.legalName ?? "another business"} (GST ${clean(input.buyerGstin)}), not to ${company.legalName}. It has been held instead of being filed in the wrong books.`,
      };
    }
    return { ok: true, companyId: company.companyId, decision: { basis: "explicit_company", evidence: `Uploaded into ${company.legalName}`, confidence: 1 } };
  }

  if (input.buyerGstin) {
    if (byGstin.length === 1) {
      const only = byGstin[0] as CompanyRoutingProfile;
      return { ok: true, companyId: only.companyId, decision: { basis: "buyer_gstin", evidence: `The invoice is addressed to GST number ${clean(input.buyerGstin)}`, confidence: 0.99 } };
    }
    if (byGstin.length > 1) {
      return { ok: false, reason: "COMPANY_NOT_IDENTIFIED", message: "More than one of your businesses is registered under this GST number. Please choose which one this invoice belongs to." };
    }
    return { ok: false, reason: "COMPANY_MISMATCH", message: `This invoice is addressed to GST number ${clean(input.buyerGstin)}, which is not one of yours. It has been held so it does not enter the wrong books.` };
  }

  const target = input.deliveredTo?.trim();
  if (target) {
    const boundByEmail = input.companies.filter((company) => company.emailAliases.some((alias) => alias.toLowerCase() === target.toLowerCase()));
    const boundByPhone = input.companies.filter((company) => company.whatsappNumbers.some((number) => digits(number) === digits(target)));
    const bound = boundByEmail.length > 0 ? boundByEmail : boundByPhone;
    if (bound.length === 1) {
      const only = bound[0] as CompanyRoutingProfile;
      return {
        ok: true,
        companyId: only.companyId,
        // No GSTIN was printed, so this is a plausible destination rather than a proven
        // one. #16 must confirm the supplier and buyer before anything is posted.
        decision: { basis: "channel_binding", evidence: `Received on ${target}, which belongs to ${only.legalName}`, confidence: 0.7 },
      };
    }
    if (bound.length > 1) return { ok: false, reason: "COMPANY_NOT_IDENTIFIED", message: "This address is shared by more than one of your businesses. Please choose which one this invoice belongs to." };
  }

  return {
    ok: false,
    reason: "COMPANY_NOT_IDENTIFIED",
    message: `No GST number was found on this document and ${input.sender.address} is not linked to any of your businesses, so it is waiting for you to say where it belongs.`,
  };
}
