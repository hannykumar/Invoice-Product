/**
 * Issue #11 [E11] — a wholesaler, a customer with a limit, and a history of agreed prices.
 *
 * The ports are stubs with real data in them rather than mocks that assert they were called: what
 * matters is that the decisions come out right, not that a particular function ran.
 */
import { asId, isoDate, rupees, type CompanyId, type IsoDate, type Money, type PartyId } from '@invoice/kernel';
import { InMemoryAuditPort, permissionPortFromActor, type ActorContext } from '@invoice/ledger';
import { RulesEngine, shippedRegistry } from '@invoice/rules-engine';
import { TradeTermsService, type TradeTermsDeps } from '../src/service.ts';
import { DEFAULT_TRADE_TERMS_POLICY, type TradeTermsPolicy } from '../src/policy.ts';
import type { CreditPositionPort, PartyTermsPort, PriceListPort, SalesHistoryPort, StockCostPort } from '../src/ports.ts';

export const COMPANY: CompanyId = asId<'Company'>('tt-co');
export const ABC: PartyId = asId<'Party'>('abc-traders');
export const PRIYA = asId<'User'>('tt-priya');

export const ALL_PERMISSIONS = ['sales.draft.write', 'sales.override_credit_limit', 'sales.approve_discount'];

export const actorWith = (permissions: readonly string[], companyId: CompanyId = COMPANY): ActorContext => ({
  companyId,
  branchId: asId<'Branch'>('main'),
  userId: PRIYA,
  permissions,
});

export const on = (date: string): IsoDate => isoDate(date);
export const inr = (whole: number, paise = 0): Money => rupees(whole, paise);

/** What this customer was charged before, with the dates that make effective dating testable. */
export interface AgreedPrice {
  readonly partyId: PartyId;
  readonly itemId: string;
  readonly amount: Money;
  readonly documentNumber: string;
  readonly on: IsoDate;
}

export class FakeHistory implements SalesHistoryPort {
  #agreed: AgreedPrice[] = [];
  #pending = new Map<string, Money>();

  setAgreed(prices: AgreedPrice[]): this {
    this.#agreed = prices;
    return this;
  }

  /** Bills started and not yet issued, keyed by the draft's own id so it can exclude itself. */
  setPending(entries: { documentId: string; partyId: PartyId; value: Money }[]): this {
    this.#pending = new Map(entries.map((e) => [`${e.partyId}:${e.documentId}`, e.value]));
    return this;
  }

  async lastAgreedPrice(_companyId: CompanyId, request: { partyId: PartyId; itemId: string; asOf: IsoDate }) {
    const candidates = this.#agreed
      .filter((a) => a.partyId === request.partyId && a.itemId === request.itemId && a.on <= request.asOf)
      .sort((a, b) => b.on.localeCompare(a.on));
    const best = candidates[0];
    return best === undefined ? null : { amount: best.amount, documentNumber: best.documentNumber, on: best.on };
  }

  async pendingValue(_companyId: CompanyId, partyId: PartyId, excludingDocumentId: string | null) {
    let total = 0n;
    for (const [key, value] of this.#pending) {
      const [party, documentId] = key.split(':') as [string, string];
      if (party !== partyId) continue;
      if (excludingDocumentId !== null && documentId === excludingDocumentId) continue;
      total += value.minor;
    }
    return { currency: 'INR' as const, minor: total };
  }
}

export class FakePriceList implements PriceListPort {
  #rates: { itemId: string; amount: Money; name: string; fromQuantity?: number }[] = [];
  set(rates: { itemId: string; amount: Money; name: string; fromQuantity?: number }[]): this {
    this.#rates = rates;
    return this;
  }
  async standardPrice(_companyId: CompanyId, request: { itemId: string; unit: string; quantity: string }) {
    const quantity = Number(request.quantity);
    const matches = this.#rates
      .filter((r) => r.itemId === request.itemId && (r.fromQuantity === undefined || quantity >= r.fromQuantity))
      .sort((a, b) => (b.fromQuantity ?? 0) - (a.fromQuantity ?? 0));
    const best = matches[0];
    if (best === undefined) return null;
    return {
      amount: best.amount,
      priceListName: best.name,
      ...(best.fromQuantity === undefined ? {} : { appliesFromQuantity: String(best.fromQuantity) }),
    };
  }
}

export class FakePositions implements CreditPositionPort {
  #total: Money = inr(0);
  #days = 0;
  set(total: Money, oldestDaysOverdue = 0): this {
    this.#total = total;
    this.#days = oldestDaysOverdue;
    return this;
  }
  async outstanding() {
    return { total: this.#total, oldestDaysOverdue: this.#days };
  }
}

export class FakeParties implements PartyTermsPort {
  #limit: Money | null = null;
  setLimit(limit: Money | null): this {
    this.#limit = limit;
    return this;
  }
  async creditLimit() {
    return this.#limit;
  }
  async nameOf() {
    return 'ABC Traders';
  }
}

export class FakeCost implements StockCostPort {
  #costs = new Map<string, Money>();
  set(costs: Record<string, Money>): this {
    this.#costs = new Map(Object.entries(costs));
    return this;
  }
  async averageUnitCost(_actor: ActorContext, itemId: string) {
    return this.#costs.get(itemId) ?? null;
  }
}

export interface Desk {
  readonly service: TradeTermsService;
  readonly history: FakeHistory;
  readonly priceList: FakePriceList;
  readonly positions: FakePositions;
  readonly parties: FakeParties;
  readonly cost: FakeCost;
  readonly audit: InMemoryAuditPort;
  readonly actor: ActorContext;
}

export const makeDesk = (policy: Partial<TradeTermsPolicy> = {}): Desk => {
  const history = new FakeHistory();
  const priceList = new FakePriceList();
  const positions = new FakePositions();
  const parties = new FakeParties();
  const cost = new FakeCost();
  const audit = new InMemoryAuditPort();
  const deps: TradeTermsDeps = {
    priceList,
    history,
    positions,
    parties,
    cost,
    engine: new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.policy', mode: 'development' }),
    permissions: permissionPortFromActor,
    audit,
    clock: { now: () => new Date('2026-08-29T10:00:00.000Z') },
    policy: { ...DEFAULT_TRADE_TERMS_POLICY, ...policy },
  };
  return { service: new TradeTermsService(deps), history, priceList, positions, parties, cost, audit, actor: actorWith(ALL_PERMISSIONS) };
};
