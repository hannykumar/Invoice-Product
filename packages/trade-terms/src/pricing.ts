/**
 * Issue #11 [E11] — what to charge, and how we know.
 *
 * The order is: what this customer actually paid last time, then the business's own price list,
 * then nothing. Their own last price wins because it is what was agreed with them — a shopkeeper
 * who quoted ₹800 last week will be asked about ₹800 this week, and a standard rate that ignores
 * that is a suggestion the person has to argue with.
 *
 * Every answer carries its evidence. "Price source is visible" is an acceptance criterion of this
 * issue, and it is met by construction here rather than by remembering to display it.
 */
import { formatDate, formatINR, invalid, money, mulDiv, subtract, type CompanyId, type IsoDate, type Money, type PartyId } from '@invoice/kernel';
import type { Bilingual, DiscountDecision, MarginWarning, PriceSource, PriceSuggestion } from './model.ts';
import type { PriceListPort, SalesHistoryPort, StockCostPort } from './ports.ts';
import type { ActorContext } from '@invoice/ledger';

const BASIS_POINTS = 10_000n;

export interface PriceRequest {
  readonly itemId: string;
  readonly itemName: string;
  readonly unit: string;
  readonly quantity: string;
  readonly partyId: PartyId;
  readonly asOf: IsoDate;
}

/**
 * Resolves one line's price.
 *
 * `asOf` is the document's own date, not today: back-dating a bill to March must suggest what was
 * agreed by March. A price agreed afterwards is not evidence for that bill, and the history port
 * is asked to honour that.
 */
export const suggestPrice = async (
  deps: { readonly priceList: PriceListPort; readonly history: SalesHistoryPort },
  companyId: CompanyId,
  request: PriceRequest,
): Promise<PriceSuggestion> => {
  const agreed = await deps.history.lastAgreedPrice(companyId, {
    partyId: request.partyId,
    itemId: request.itemId,
    asOf: request.asOf,
  });
  if (agreed !== null) {
    return {
      itemId: request.itemId,
      unit: request.unit,
      amount: agreed.amount,
      source: 'LAST_AGREED',
      evidence: { documentNumber: agreed.documentNumber, on: agreed.on },
      asOf: request.asOf,
      sentence: {
        'en-IN': `Last time you charged them ${formatINR(agreed.amount)} for ${request.itemName}, on bill ${agreed.documentNumber} of ${formatDate(agreed.on)}.`,
        'hi-IN': `Pichhli baar aapne inse ${request.itemName} ke ${formatINR(agreed.amount)} liye the, ${formatDate(agreed.on)} ke bill ${agreed.documentNumber} par.`,
      },
    };
  }

  const listed = await deps.priceList.standardPrice(companyId, {
    itemId: request.itemId,
    unit: request.unit,
    quantity: request.quantity,
  });
  if (listed !== null) {
    const slab = listed.appliesFromQuantity;
    return {
      itemId: request.itemId,
      unit: request.unit,
      amount: listed.amount,
      source: 'PRICE_LIST',
      evidence: {
        priceListName: listed.priceListName,
        ...(slab === undefined ? {} : { appliesFromQuantity: slab }),
      },
      asOf: request.asOf,
      sentence: {
        'en-IN': slab === undefined
          ? `Your ${listed.priceListName} rate for ${request.itemName} is ${formatINR(listed.amount)}.`
          : `Your ${listed.priceListName} rate for ${request.itemName} is ${formatINR(listed.amount)} when buying ${slab} or more.`,
        'hi-IN': slab === undefined
          ? `Aapki ${listed.priceListName} mein ${request.itemName} ka rate ${formatINR(listed.amount)} hai.`
          : `Aapki ${listed.priceListName} mein ${slab} ya usse zyada par ${request.itemName} ka rate ${formatINR(listed.amount)} hai.`,
      },
    };
  }

  return {
    itemId: request.itemId,
    unit: request.unit,
    amount: null,
    source: 'NONE',
    evidence: {},
    asOf: request.asOf,
    sentence: {
      'en-IN': `You have not sold ${request.itemName} to them before and it is not on a price list, so please type what you agreed.`,
      'hi-IN': `Aapne inhe ${request.itemName} pehle nahin becha aur yeh kisi price list mein bhi nahin hai, isliye jo tay hua wo likhein.`,
    },
  };
};

/**
 * Basis points off, so 1250 is 12.5%. Negative or absurd asks are refused rather than clamped.
 *
 * Issue #301 — a price below what this customer was last charged is said as exactly that, "lower
 * than the last price you charged them (₹250.00)", not as a discount nobody gave; and a sentence
 * that asks for approval says who may give it.
 */
export const discountDecision = (
  input: {
    readonly listPrice: Money;
    readonly chargedPrice: Money;
    readonly quantity: bigint;
    readonly allowedWithoutApprovalBasisPoints: number;
    /** Where `listPrice` came from, so the sentence names it. A price list when omitted. */
    readonly source?: PriceSource;
  },
): DiscountDecision | null => {
  if (input.listPrice.minor <= 0n) return null;
  const off = subtract(input.listPrice, input.chargedPrice);
  if (off.minor <= 0n) return null;

  const basisPoints = Number((off.minor * BASIS_POINTS) / input.listPrice.minor);
  const amountOff = money(off.minor * input.quantity);
  const needsApproval = basisPoints > input.allowedWithoutApprovalBasisPoints;
  const percent = (basisPoints / 100).toFixed(basisPoints % 100 === 0 ? 0 : 1);
  const allowed = (input.allowedWithoutApprovalBasisPoints / 100).toFixed(0);
  const was = formatINR(input.listPrice);
  const charged = formatINR(input.chargedPrice);
  const lastTime = input.source === 'LAST_AGREED';
  const what = lastTime
    ? bilingual(`${charged} is ${percent}% lower than the last price you charged them (${was})`, `${charged} unke pichhle rate (${was}) se ${percent}% kam hai`)
    : bilingual(`${charged} is ${percent}% off the price list rate (${was})`, `${charged} price list rate (${was}) se ${percent}% kam hai`);

  return {
    requestedBasisPoints: basisPoints,
    allowedWithoutApprovalBasisPoints: input.allowedWithoutApprovalBasisPoints,
    outcome: needsApproval ? 'NEEDS_APPROVAL' : 'ALLOW',
    amountOff,
    sentence: needsApproval
      ? bilingual(
          `${what['en-IN']}. A price more than ${allowed}% lower needs approval: the owner, or someone allowed to approve discounts, has to approve it before the bill is issued.`,
          `${what['hi-IN']}. ${allowed}% se zyada kam rate ke liye manzoori chahiye: owner ya discount manzoor karne wala koi vyakti bill jaari hone se pehle manzoori de.`,
        )
      : bilingual(
          `${what['en-IN']}: ${formatINR(amountOff)} less on this line.`,
          `${what['hi-IN']}: is line par ${formatINR(amountOff)} kam.`,
        ),
  };
};

/**
 * Says so when a line sells below what the goods cost. A warning, never a block: clearing old
 * stock at a loss is an ordinary decision, and it is the owner's to make.
 */
export const marginWarning = async (
  deps: { readonly cost: StockCostPort },
  actor: ActorContext,
  input: { readonly itemId: string; readonly itemName: string; readonly sellingPrice: Money; readonly quantity: bigint },
): Promise<MarginWarning | null> => {
  const unitCost = await deps.cost.averageUnitCost(actor, input.itemId);
  if (unitCost === null || unitCost.minor <= 0n) return null;
  if (input.sellingPrice.minor >= unitCost.minor) return null;

  const shortfallPerUnit = subtract(unitCost, input.sellingPrice);
  const shortfallOnLine = money(shortfallPerUnit.minor * input.quantity);
  return {
    unitCost,
    sellingPrice: input.sellingPrice,
    shortfallPerUnit,
    shortfallOnLine,
    sentence: {
      'en-IN': `${input.itemName} costs you ${formatINR(unitCost)} each, so at this price you lose ${formatINR(shortfallOnLine)} on this line.`,
      'hi-IN': `${input.itemName} aapko ${formatINR(unitCost)} ka padta hai, is rate par is line mein ${formatINR(shortfallOnLine)} ka nuksaan hai.`,
    },
  };
};

/** Quantity as an integer of the smallest unit the caller counts in. Zero has no price. */
export const requireQuantity = (raw: string): bigint => {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw invalid('TRADE_TERMS_QUANTITY_INVALID', 'How many are you selling? A price needs a quantity of at least one.');
  }
  return BigInt(Math.round(value));
};

export const percentOf = (amount: Money, basisPoints: number): Money =>
  mulDiv(amount, BigInt(basisPoints), BASIS_POINTS);

export const bilingual = (en: string, hi: string): Bilingual => ({ 'en-IN': en, 'hi-IN': hi });
