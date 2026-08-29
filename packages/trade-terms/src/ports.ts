/**
 * Issue #11 [E11] — the facts a quote needs, and where each one comes from.
 *
 * Every port here is owned by a module that already knows the answer: price lists and credit
 * limits by master data (#5), what this customer was actually charged by sales (#9), what they owe
 * by receivables (#20), what stock cost by inventory (#12). This package asks; it never keeps a
 * second copy, because a second copy is a figure that can disagree with the first.
 */
import type { CompanyId, IsoDate, Money, PartyId } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';

/** What the business normally charges for an item. GPT 3's #5 owns price lists. */
export interface PriceListPort {
  standardPrice(
    companyId: CompanyId,
    request: { itemId: string; unit: string; quantity: string },
  ): Promise<{ amount: Money; priceListName: string; appliesFromQuantity?: string } | null>;
}

/** What this customer was actually charged before, and what is on their unfinished bills. */
export interface SalesHistoryPort {
  /**
   * The last price this customer paid for this item **on or before** `asOf`. A price agreed after
   * the document's own date is not evidence for that document.
   */
  lastAgreedPrice(
    companyId: CompanyId,
    request: { partyId: PartyId; itemId: string; asOf: IsoDate },
  ): Promise<{ amount: Money; documentNumber: string; on: IsoDate } | null>;

  /**
   * The value of bills started for this customer and not yet issued, excluding the one being
   * written. This is what stops two tills spending the same credit limit twice.
   */
  pendingValue(companyId: CompanyId, partyId: PartyId, excludingDocumentId: string | null): Promise<Money>;
}

/** What the customer owes now, and how late the oldest bill is. `@invoice/receivables` (#20). */
export interface CreditPositionPort {
  outstanding(
    actor: ActorContext,
    partyId: PartyId,
    asOn: IsoDate,
  ): Promise<{ total: Money; oldestDaysOverdue: number }>;
}

/** The credit limit the business set for this customer. Master data (#5). */
export interface PartyTermsPort {
  creditLimit(companyId: CompanyId, partyId: PartyId): Promise<Money | null>;
  nameOf(companyId: CompanyId, partyId: PartyId): Promise<string>;
}

/** What a unit of this item cost, on average. `@invoice/inventory` (#12). Null when unknown. */
export interface StockCostPort {
  averageUnitCost(actor: ActorContext, itemId: string): Promise<Money | null>;
}

/** Nothing on record. Used where a business keeps no price list at all. */
export const noPriceList: PriceListPort = {
  async standardPrice() {
    return null;
  },
};

/** No cost known, so no margin claim is made. Honest for a business whose purchases are not in yet. */
export const noStockCost: StockCostPort = {
  async averageUnitCost() {
    return null;
  },
};

/** A customer with no history and nothing unfinished. */
export const noSalesHistory: SalesHistoryPort = {
  async lastAgreedPrice() {
    return null;
  },
  async pendingValue() {
    return { currency: 'INR', minor: 0n };
  },
};
