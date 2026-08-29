// Issue #17 [E17] — turning an approved bill into ledger lines.
//
// Deciding that a purchase debits stock and input tax and credits the supplier belongs to the
// module that owns the document, exactly as issue #9 owns the sale template. The ledger only
// checks that what it is given balances.

import { invalid, money, zero, type AccountId, type CompanyId, type Money } from "@invoice/kernel";
import type { AccountRepository } from "@invoice/ledger";
import { formatPaise } from "./money.ts";
// The same half-up arithmetic #16 checks the bill with, so the two can never disagree.
import { divideRoundHalfUp, taxOn } from "./recompute.ts";
import type { ApprovedPurchase, ApprovedPurchaseLine, PurchaseTaxSummary } from "./posting-types.ts";
import type { Paise } from "../../masters/src/types.ts";

/**
 * How far the recomputed total may sit from the printed total before the bill is refused.
 * Indian bills routinely round the payable figure to the nearest rupee; a larger gap is a real
 * disagreement and goes back to a person. #16 uses the same ₹1 default for the same reason.
 */
export const ROUND_OFF_TOLERANCE_PAISE = 100n;

export interface LineTax {
  readonly cgst: Paise;
  readonly sgst: Paise;
  readonly igst: Paise;
  readonly cess: Paise;
  readonly total: Paise;
}

/**
 * The GST on one line. Intra-state supplies are split into halves as "half, and whatever is
 * left", so an odd paise is never lost and CGST + SGST always equals the GST that was charged.
 */
export const splitLineTax = (taxableValuePaise: Paise, line: ApprovedPurchaseLine, intraState: boolean): LineTax => {
  const gst = taxOn(taxableValuePaise, line.gstRateBasisPoints);
  const cess = taxOn(taxableValuePaise, line.cessRateBasisPoints ?? 0);
  if (!intraState) return { cgst: 0n, sgst: 0n, igst: gst, cess, total: gst + cess };
  const cgst = divideRoundHalfUp(gst, 2n);
  return { cgst, sgst: gst - cgst, igst: 0n, cess, total: gst + cess };
};

export interface PurchaseTotals {
  readonly tax: PurchaseTaxSummary;
  /** Landed cost of goods lines: taxable value plus any tax that cannot be claimed. */
  readonly goodsCostPaise: Paise;
  readonly servicesCostPaise: Paise;
  /** Per line, the landed cost, in the order the lines arrived. */
  readonly lineCostPaise: readonly Paise[];
  readonly roundOffPaise: Paise;
  readonly warnings: readonly string[];
}

/**
 * Works out every figure the posting needs, and refuses rather than guessing.
 *
 * The split between CGST/SGST and IGST is taken from the verdict, which got it from the rules
 * engine (#7). When the rules engine could not decide, this refuses: rule 4 of the brief says a
 * compliance decision is never invented, and a purchase posted under the wrong head is a wrong
 * return three weeks later.
 */
export const computePurchaseTotals = (approved: ApprovedPurchase): PurchaseTotals => {
  const problems: string[] = [];
  const warnings: string[] = [];

  const intraState = approved.verdict.taxCheck.intraState;
  if (intraState === undefined) {
    throw invalid(
      "PURCHASE_TAX_SPLIT_UNDECIDED",
      "We could not work out whether this purchase is within your state or from outside it, so the GST cannot be recorded under the right head. Please confirm the supplier's state and the place of supply, then approve it again.",
      { details: { reason: approved.verdict.taxCheck.explanation } },
    );
  }

  const reverseCharge = approved.taxLiability === "REVERSE_CHARGE";
  let goodsCost = 0n;
  let servicesCost = 0n;
  let taxable = 0n;
  let cgst = 0n;
  let sgst = 0n;
  let igst = 0n;
  let cess = 0n;
  let ineligible = 0n;
  const lineCost: Paise[] = [];

  for (const line of approved.lines) {
    const label = `Line ${line.lineNumber} (${line.description})`;
    if (line.quantity.scaled <= 0n) problems.push(`${label} has a quantity of zero or less, which cannot be received.`);
    if (line.ratePaise < 0n) problems.push(`${label} has a price below zero.`);
    if (line.supplyKind === "GOODS" && line.warehouseId === undefined) {
      problems.push(`${label} is goods, but no godown was chosen, so the stock cannot be received. Please pick where it was delivered.`);
    }
    if (line.supplyKind === "SERVICES" && line.warehouseId !== undefined) {
      warnings.push(`${label} is a service, so it has been recorded as a cost and no stock was received for it.`);
    }

    const tax = splitLineTax(line.taxableValuePaise, line, intraState);
    const blocked = line.itcEligibility === "INELIGIBLE" ? tax.total : 0n;
    if (blocked > 0n) {
      warnings.push(`${label}: the ${formatPaise(blocked)} of GST on this line cannot be claimed back, so it has been added to what the goods cost you.`);
    }

    taxable += line.taxableValuePaise;
    ineligible += blocked;
    if (blocked === 0n) {
      cgst += tax.cgst;
      sgst += tax.sgst;
      igst += tax.igst;
      cess += tax.cess;
    }

    const cost = line.taxableValuePaise + blocked;
    lineCost.push(cost);
    if (line.supplyKind === "GOODS") goodsCost += cost;
    else servicesCost += cost;
  }

  if (problems.length > 0) {
    throw invalid("PURCHASE_NOT_POSTABLE", problems[0] as string, { details: { problems: problems.join(" ") } });
  }

  const claimable = cgst + sgst + igst + cess;
  // Debits are what the business received; credits are what it owes. Round-off closes the gap
  // between the recomputed figures and the rupee-rounded total printed on the bill.
  const debits = goodsCost + servicesCost + claimable;
  const credits = approved.invoiceTotalPaise + (reverseCharge ? claimable : 0n);
  const roundOff = credits - debits;
  const gap = roundOff < 0n ? -roundOff : roundOff;
  if (gap > ROUND_OFF_TOLERANCE_PAISE) {
    throw invalid(
      "PURCHASE_TOTAL_DISAGREES",
      `The parts of this bill come to ${formatPaise(debits - (reverseCharge ? claimable : 0n))}, but the bill asks for ${formatPaise(approved.invoiceTotalPaise)}. That difference of ${formatPaise(gap)} is too big to be rounding, so nothing has been recorded.`,
      { messageId: "purchase.total_disagrees", details: { difference: formatPaise(gap) } },
    );
  }
  if (roundOff !== 0n) {
    warnings.push(`${formatPaise(gap)} of rounding has been recorded on its own so the books match the bill exactly.`);
  }
  if (reverseCharge) {
    warnings.push(`This purchase is under reverse charge, so ${approved.supplierName} has not charged GST. The ${formatPaise(claimable)} of tax is yours to pay the government directly, and has been recorded that way.`);
  }

  const summary: PurchaseTaxSummary = {
    taxableValuePaise: taxable,
    cgstPaise: cgst,
    sgstPaise: sgst,
    igstPaise: igst,
    cessPaise: cess,
    ineligibleItcPaise: ineligible,
    intraState,
    reverseCharge,
    ...(approved.verdict.taxCheck.ruleSetVersion === undefined ? {} : { ruleSetVersion: approved.verdict.taxCheck.ruleSetVersion }),
    ...(approved.verdict.taxCheck.ruleId === undefined ? {} : { ruleId: approved.verdict.taxCheck.ruleId }),
  };

  return { tax: summary, goodsCostPaise: goodsCost, servicesCostPaise: servicesCost, lineCostPaise: lineCost, roundOffPaise: roundOff, warnings };
};

export interface PurchasePostingLine {
  readonly accountId: AccountId;
  readonly partyId: string | null;
  readonly debit: Money;
  readonly credit: Money;
  readonly narration: string | null;
}

/** Account codes a company may nominate when its chart has no system role for these yet. */
export interface PurchaseAccountCodes {
  /** Cost of services bought. Falls back to the `PURCHASES_SERVICES` role when it exists. */
  readonly servicesCost?: string;
  /** GST the business owes the government itself on a reverse-charge purchase. */
  readonly reverseChargePayable?: string;
}

const nil = (): Money => zero("INR");

/**
 * Builds the entry for a posted purchase:
 *
 * ```
 *   Purchases of goods            debit   what the goods cost, landed
 *   Other business costs          debit   what the services cost
 *   Input CGST / SGST / IGST / cess       the tax that can be claimed
 *   Rounding difference                   the few paise either way
 *     Supplier                   credit   what the bill asks for
 *     GST payable under reverse charge    tax the business owes directly
 * ```
 */
export const buildPurchasePosting = async (
  accounts: AccountRepository,
  companyId: CompanyId,
  approved: ApprovedPurchase,
  totals: PurchaseTotals,
  codes: PurchaseAccountCodes = {},
): Promise<PurchasePostingLine[]> => {
  const byRole = async (role: string): Promise<AccountId | null> => {
    const account = await accounts.findBySystemRole(companyId, role);
    return account === null ? null : account.id;
  };
  const needRole = async (role: string): Promise<AccountId> => {
    const found = await byRole(role);
    if (found === null) {
      throw invalid(
        "PURCHASE_ACCOUNT_MISSING",
        `This business has no account set up for ${role.toLowerCase().replace(/_/g, " ")}, so the bill cannot be recorded.`,
        { details: { role } },
      );
    }
    return found;
  };
  const byCode = async (code: string | undefined): Promise<AccountId | null> => {
    if (code === undefined) return null;
    const account = await accounts.findByCode(companyId, code);
    return account === null || account.isGroup ? null : account.id;
  };

  const supplierAccount = await accounts.findByPartyId(companyId, approved.supplierPartyId);
  if (supplierAccount === null) {
    throw invalid(
      "PURCHASE_SUPPLIER_ACCOUNT_MISSING",
      `${approved.supplierName} does not have an account in your books yet, so this bill cannot be recorded.`,
    );
  }

  const lines: PurchasePostingLine[] = [];
  const push = (accountId: AccountId, partyId: string | null, debit: Paise, credit: Paise, narration: string): void => {
    if (debit === 0n && credit === 0n) return;
    lines.push({ accountId, partyId, debit: debit === 0n ? nil() : money(debit), credit: credit === 0n ? nil() : money(credit), narration });
  };

  if (totals.goodsCostPaise !== 0n) {
    push(await needRole("PURCHASES_GOODS"), null, totals.goodsCostPaise, 0n, "Goods bought");
  }
  if (totals.servicesCostPaise !== 0n) {
    // GPT 1's chart has no `PURCHASES_SERVICES` role yet; see the contract's open proposal.
    const servicesAccount = (await byRole("PURCHASES_SERVICES")) ?? (await byCode(codes.servicesCost));
    if (servicesAccount === null) {
      throw invalid(
        "PURCHASE_SERVICES_ACCOUNT_MISSING",
        "This bill charges for a service, and there is no account set up to record what services cost. Please choose one and try again.",
      );
    }
    push(servicesAccount, null, totals.servicesCostPaise, 0n, "Services bought");
  }

  push(await needRole("INPUT_CGST"), null, totals.tax.cgstPaise, 0n, "Central GST you can claim back");
  push(await needRole("INPUT_SGST"), null, totals.tax.sgstPaise, 0n, "State GST you can claim back");
  push(await needRole("INPUT_IGST"), null, totals.tax.igstPaise, 0n, "Integrated GST you can claim back");
  push(await needRole("INPUT_CESS"), null, totals.tax.cessPaise, 0n, "Cess you can claim back");

  if (totals.roundOffPaise > 0n) {
    push(await needRole("ROUND_OFF"), null, totals.roundOffPaise, 0n, "Rounding on the bill");
  }

  push(supplierAccount.id, approved.supplierPartyId, 0n, approved.invoiceTotalPaise, `Amount owed to ${approved.supplierName}`);

  if (totals.tax.reverseCharge) {
    const claimable = totals.tax.cgstPaise + totals.tax.sgstPaise + totals.tax.igstPaise + totals.tax.cessPaise;
    const rcmAccount = (await byRole("REVERSE_CHARGE_PAYABLE")) ?? (await byCode(codes.reverseChargePayable));
    if (rcmAccount === null) {
      throw invalid(
        "PURCHASE_REVERSE_CHARGE_ACCOUNT_MISSING",
        "This purchase is under reverse charge, which means you owe the GST to the government yourself, and there is no account set up to hold that. Please choose one and try again.",
      );
    }
    push(rcmAccount, null, 0n, claimable, "GST you must pay the government yourself on this purchase");
  }

  if (totals.roundOffPaise < 0n) {
    push(await needRole("ROUND_OFF"), null, 0n, -totals.roundOffPaise, "Rounding on the bill");
  }

  return lines;
};
