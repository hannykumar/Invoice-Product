/**
 * Issue #11 [E11] — the one call a till makes while a bill is being written.
 *
 * It answers three questions at once and writes nothing. That matters: a quote can be asked for on
 * every keystroke without consequence, and the decision to accept it stays with the person and
 * with #9's sales service, which is the only thing that may issue a bill.
 */
import { forbidden, invalid, money, sum, type IsoDate, type Money, type PartyId } from '@invoice/kernel';
import type { ActorContext, AuditPort, PermissionPort } from '@invoice/ledger';
import type { RulesEngine } from '@invoice/rules-engine';
import {
  TRADE_TERMS_PERMISSIONS,
  creditToQuoteOutcome,
  worstOf,
  type Bilingual,
  type LineTerms,
  type QuoteOutcome,
  type TradeTermsQuote,
} from './model.ts';
import { decideCredit } from './credit.ts';
import { discountDecision, marginWarning, requireQuantity, suggestPrice } from './pricing.ts';
import { DEFAULT_TRADE_TERMS_POLICY, type TradeTermsPolicy } from './policy.ts';
import type { CreditPositionPort, PartyTermsPort, PriceListPort, SalesHistoryPort, StockCostPort } from './ports.ts';

export interface TradeTermsDeps {
  readonly priceList: PriceListPort;
  readonly history: SalesHistoryPort;
  readonly positions: CreditPositionPort;
  readonly parties: PartyTermsPort;
  readonly cost: StockCostPort;
  readonly engine: RulesEngine;
  readonly permissions: PermissionPort;
  readonly audit: AuditPort;
  readonly clock: { now(): Date };
  readonly policy?: TradeTermsPolicy;
}

export interface QuoteLineRequest {
  readonly lineId: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly unit: string;
  readonly quantity: string;
  /** What the person actually typed. Omit to be told what to charge rather than to check it. */
  readonly unitPrice?: Money;
}

export interface QuoteRequest {
  readonly partyId: PartyId;
  readonly documentDate: IsoDate;
  readonly documentId?: string | null;
  readonly lines: readonly QuoteLineRequest[];
  /** Supplied only when a person has decided to go ahead anyway, and says why. */
  readonly override?: { readonly reason: string };
}

export class TradeTermsService {
  readonly #deps: TradeTermsDeps;
  readonly #policy: TradeTermsPolicy;

  constructor(deps: TradeTermsDeps) {
    this.#deps = deps;
    this.#policy = deps.policy ?? DEFAULT_TRADE_TERMS_POLICY;
  }

  get policy(): TradeTermsPolicy {
    return this.#policy;
  }

  /**
   * Prices the lines, checks the discounts and the customer's credit, and says what should happen.
   * Reading a quote needs no permission: it decides nothing. Acting on one does.
   */
  async quote(actor: ActorContext, request: QuoteRequest): Promise<TradeTermsQuote> {
    const lines: LineTerms[] = [];
    for (const line of request.lines) {
      const quantity = requireQuantity(line.quantity);
      const price = await suggestPrice(
        { priceList: this.#deps.priceList, history: this.#deps.history },
        actor.companyId,
        { itemId: line.itemId, itemName: line.itemName, unit: line.unit, quantity: line.quantity, partyId: request.partyId, asOf: request.documentDate },
      );

      // Only a price the person actually typed can be discounted or sell below cost. Asking what
      // to charge is not the same as proposing a figure.
      const charged = line.unitPrice;
      const discount =
        charged === undefined || price.amount === null
          ? null
          : discountDecision({
              listPrice: price.amount,
              chargedPrice: charged,
              quantity,
              allowedWithoutApprovalBasisPoints: this.#policy.discountWithoutApprovalBasisPoints,
            });

      const margin =
        charged === undefined || this.#policy.warnBelowCost === false
          ? null
          : await marginWarning({ cost: this.#deps.cost }, actor, {
              itemId: line.itemId,
              itemName: line.itemName,
              sellingPrice: charged,
              quantity,
            });

      lines.push({ lineId: line.lineId, itemId: line.itemId, price, discount, margin });
    }

    const saleValue = sum(
      request.lines.map((line, index) => {
        const quantity = requireQuantity(line.quantity);
        const unit = line.unitPrice ?? lines[index]?.price.amount ?? money(0n);
        return money(unit.minor * quantity);
      }),
    );

    const credit = await decideCredit(
      { parties: this.#deps.parties, positions: this.#deps.positions, history: this.#deps.history, engine: this.#deps.engine, policy: this.#policy },
      actor,
      { partyId: request.partyId, saleValue, documentDate: request.documentDate, documentId: request.documentId ?? null },
    );

    const discountOutcomes: QuoteOutcome[] = lines
      .filter((line) => line.discount?.outcome === 'NEEDS_APPROVAL')
      .map(() => 'NEEDS_APPROVAL');
    let outcome = worstOf([creditToQuoteOutcome(credit.outcome, this.#policy.warnNeedsApproval), ...discountOutcomes]);

    const reasons: Bilingual[] = [];
    if (credit.outcome !== 'ALLOW') reasons.push(credit.sentence);
    for (const line of lines) {
      if (line.discount?.outcome === 'NEEDS_APPROVAL') reasons.push(line.discount.sentence);
      if (line.margin !== null) reasons.push(line.margin.sentence);
    }

    let applied: TradeTermsQuote['override'] = null;
    if (request.override !== undefined && outcome !== 'ALLOW') {
      applied = await this.#applyOverride(actor, request.override, outcome, credit, lines);
      outcome = 'ALLOW';
      reasons.push({
        'en-IN': `Allowed anyway, because: ${request.override.reason}`,
        'hi-IN': `Phir bhi ijaazat di gayi, kyunki: ${request.override.reason}`,
      });
    }

    return { lines, credit, outcome, reasons, override: applied };
  }

  /**
   * Overriding is a real decision, so it needs the permission for the thing being overridden and a
   * reason in the person's own words. Both go to the audit trail with the figures they overrode.
   */
  async #applyOverride(
    actor: ActorContext,
    override: { reason: string },
    outcome: QuoteOutcome,
    credit: TradeTermsQuote['credit'],
    lines: readonly LineTerms[],
  ): Promise<{ reason: string; by: string }> {
    const reason = override.reason.trim();
    if (reason === '') {
      throw invalid(
        'TRADE_TERMS_OVERRIDE_REASON_REQUIRED',
        'Please say why this is being allowed, so anyone looking at the bill later understands.',
      );
    }

    const needsCredit = credit.outcome !== 'ALLOW';
    const needsDiscount = lines.some((line) => line.discount?.outcome === 'NEEDS_APPROVAL');
    const required = needsCredit ? TRADE_TERMS_PERMISSIONS.overrideCreditLimit : TRADE_TERMS_PERMISSIONS.approveDiscount;
    if (!actor.permissions.includes(required)) {
      throw forbidden(
        'TRADE_TERMS_OVERRIDE_NOT_ALLOWED',
        needsCredit
          ? 'You cannot allow a bill past this customer’s credit limit. Someone with that permission has to.'
          : 'You cannot approve a discount this large. Someone with that permission has to.',
        { details: { permission: required } },
      );
    }
    // A discount override on top of a credit override needs its own permission too: they are
    // different decisions and one does not stand in for the other.
    if (needsCredit && needsDiscount && !actor.permissions.includes(TRADE_TERMS_PERMISSIONS.approveDiscount)) {
      throw forbidden(
        'TRADE_TERMS_OVERRIDE_NOT_ALLOWED',
        'You cannot approve a discount this large. Someone with that permission has to.',
        { details: { permission: TRADE_TERMS_PERMISSIONS.approveDiscount } },
      );
    }

    await this.#deps.audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at: this.#deps.clock.now().toISOString(),
      action: 'trade_terms.overridden',
      subjectType: 'party',
      subjectId: credit.partyId,
      summary: `Allowed a sale that would otherwise have been ${outcome === 'BLOCK' ? 'stopped' : 'held for approval'}.`,
      details: {
        outcome,
        creditOutcome: credit.outcome,
        limit: credit.limit === null ? '' : String(credit.limit.minor),
        exposure: String(credit.exposure.minor),
        excess: String(credit.excess.minor),
        oldestDaysOverdue: String(credit.oldestDaysOverdue),
      },
      overrideReason: reason,
    });

    return { reason, by: actor.userId };
  }
}
