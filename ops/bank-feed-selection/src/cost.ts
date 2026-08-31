/**
 * Issue #52 [X04] — the cost model.
 *
 * The acceptance criterion asks for a cost model, and the only honest one is arithmetic over
 * numbers a provider has given us. So this computes; it does not estimate. Feed it a quotation and
 * it says what the feed costs per business per month, and — the number that actually decides
 * anything — what that leaves of the subscription those businesses pay us.
 *
 * Money is paise in `bigint`, like everywhere else in this product.
 */
import type { CostShape } from './model.ts';

export interface Scale {
  /** How many businesses have a live feed. */
  readonly connections: number;
  /** How often each one is fetched, per month. Daily is about 30. */
  readonly syncsPerConnectionPerMonth: number;
  /** Spread the one-off cost over this many months when judging the monthly figure. */
  readonly amortiseOneOffOverMonths: number;
}

export interface MonthlyCost {
  readonly platform: bigint;
  readonly connections: bigint;
  readonly syncs: bigint;
  readonly amortisedOneOff: bigint;
  readonly total: bigint;
  readonly perConnection: bigint;
}

export const monthlyCost = (cost: CostShape, scale: Scale): MonthlyCost => {
  const connections = BigInt(Math.max(0, scale.connections));
  const syncs = connections * BigInt(Math.max(0, scale.syncsPerConnectionPerMonth));
  const months = BigInt(Math.max(1, scale.amortiseOneOffOverMonths));
  const platform = cost.monthlyPlatformFeePaise;
  const perConnections = cost.perConnectionPaise * connections;
  const perSyncs = cost.perSyncPaise * syncs;
  const amortisedOneOff = cost.oneOffPaise / months;
  const total = platform + perConnections + perSyncs + amortisedOneOff;
  return {
    platform,
    connections: perConnections,
    syncs: perSyncs,
    amortisedOneOff,
    total,
    perConnection: connections === 0n ? total : total / connections,
  };
};

export interface Margin {
  readonly revenuePerConnection: bigint;
  readonly costPerConnection: bigint;
  readonly marginPerConnection: bigint;
  readonly sustainable: boolean;
  readonly sentence: { readonly 'en-IN': string; readonly 'hi-IN': string };
}

/**
 * What the feed leaves of the plan it sits under.
 *
 * This is the number that decides the route. #42's starter plan is ₹499 a month; a feed costing
 * more than that per business is not a pricing problem to be solved later, it is the wrong route.
 */
export const marginAgainstPlan = (cost: MonthlyCost, planPricePaise: bigint): Margin => {
  const margin = planPricePaise - cost.perConnection;
  const rupees = (value: bigint): string => `₹${(Number(value) / 100).toFixed(2)}`;
  return {
    revenuePerConnection: planPricePaise,
    costPerConnection: cost.perConnection,
    marginPerConnection: margin,
    sustainable: margin > 0n,
    sentence: margin > 0n
      ? {
          'en-IN': `The feed costs ${rupees(cost.perConnection)} per business per month against a ${rupees(planPricePaise)} plan, leaving ${rupees(margin)} for everything else the product does.`,
          'hi-IN': `Har business par har mahine feed ka kharch ${rupees(cost.perConnection)} hai aur plan ${rupees(planPricePaise)} ka, yaani baaki sab kaam ke liye ${rupees(margin)} bachta hai.`,
        }
      : {
          'en-IN': `The feed costs ${rupees(cost.perConnection)} per business per month against a ${rupees(planPricePaise)} plan. This route cannot pay for itself at this price.`,
          'hi-IN': `Har business par feed ka kharch ${rupees(cost.perConnection)} hai aur plan sirf ${rupees(planPricePaise)} ka. Is keemat par yeh rasta apna kharch nahin nikal sakta.`,
        },
  };
};
