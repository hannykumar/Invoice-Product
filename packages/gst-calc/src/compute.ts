/**
 * Issue #25 [E25] — the GST calculator.
 *
 * Deterministic arithmetic over facts, with every *treatment* decision delegated to the rules
 * engine (#7) so that no tax judgement is hard-coded here and none of it is made by a model.
 * This file knows how to multiply, apportion and round. It does not know the law.
 *
 * Two behaviours matter more than the arithmetic:
 *
 *  - **Nothing is defaulted.** An unclassified item, a missing HSN, an unknown place of supply or
 *    an unreviewed rate each stop the computation and produce an exception item. There is no
 *    "probably 18%" anywhere in this module.
 *  - **Everything is reported at once.** Blocking reasons are collected across all lines, so a
 *    person fixes four things in one pass instead of being told about them one at a time.
 */
import {
  add,
  allocateByWeight,
  isZero,
  money,
  mulDiv,
  quantity,
  roundToWholeUnits,
  subtract,
  sum,
  toDecimalString,
  zero,
  type IsoDate,
  type Money,
  type Quantity,
} from '@invoice/kernel';
import {
  FactSet,
  RulesEngine,
  toExceptionDraft,
  type Decision,
  type EngineMode,
  type ExceptionDraft,
  type ReviewState,
} from '@invoice/rules-engine';
// GPT 3's master data (#5). Imported by path because packages/masters declares no exports field,
// which is the convention their lane and GPT 2's already use for cross-package imports.
import { GST_STATE_CODES } from '../../masters/src/validation.ts';
import type { MasterDataReader, TaxTreatment } from './master-data-port.ts';
import type { RateTable } from './rate-table.ts';
import type { DeclaredRateReader } from './declared-rates.ts';
import { computeTcs, type TcsCharge, type TcsContext } from './tcs.ts';

export type PriceBasis = 'EXCLUSIVE' | 'INCLUSIVE';

/**
 * Where the rate on a line came from.
 *
 * `REGISTER` means a notification, checked and recorded under issue #54. `BUSINESS_DECLARED` means
 * the business told us. The difference is never hidden: it reaches the invoice, the reports and
 * the GST return working papers.
 */
export type RateBasis = 'REGISTER' | 'BUSINESS_DECLARED';
export type TaxSplit = 'CGST_SGST' | 'CGST_UTGST' | 'IGST';

/**
 * Issue #131 — a computed line is either something that was sold, or a charge added to the bill.
 *
 * They are kept apart because a customer checks a goods line by multiplying quantity by rate. If
 * freight is buried inside that line the multiplication fails and the whole bill looks wrong, which
 * is the first thing anyone notices. A charge is therefore a line of its own.
 */
export type LineKind = 'GOODS' | 'CHARGE';
export type ChargeKind = 'FREIGHT' | 'OTHER';

export type Discount =
  | { readonly kind: 'PERCENT'; readonly percentTimes100: bigint }
  | { readonly kind: 'AMOUNT'; readonly amount: Money };

export interface TaxLineInput {
  readonly lineId: string;
  readonly itemId: string;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly priceBasis: PriceBasis;
  readonly discount?: Discount;
}

export interface ComputeInput {
  readonly companyId: string;
  readonly documentDate: IsoDate;
  readonly partyId: string;
  readonly supplyKind: 'GOODS' | 'SERVICES';
  /** Where the goods are going. Used to work out the place of supply when it is not given. */
  readonly deliveryStateCode?: string | null;
  /** Supply it only when a person has confirmed it; otherwise let the rule decide. */
  readonly placeOfSupplyStateCode?: string | null;
  readonly lines: readonly TaxLineInput[];
  readonly freight?: Money;
  readonly otherCharges?: Money;
  readonly roundToWholeRupee?: boolean;
  /**
   * Issue #145 — what this customer has already been billed this financial year, so that tax
   * collected at source can be worked out. Left out when the business does not collect it.
   */
  readonly tcs?: TcsContext;
  /** Identifies the document, so an exception queued twice is one item. */
  readonly source: { readonly kind: string; readonly id: string };
}

export interface ComputedTaxLine {
  readonly lineId: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly hsnOrSac: string | null;
  /** `GOODS` for something that was sold, `CHARGE` for freight or another charge on the bill. */
  readonly kind: LineKind;
  /** Which charge this is, on a `CHARGE` line. `null` on everything that was sold. */
  readonly chargeKind: ChargeKind | null;
  readonly treatment: TaxTreatment;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly grossAmount: Money;
  readonly discountAmount: Money;
  /**
   * How much of the bill's freight and other charges sits inside this line's taxable value.
   *
   * Since issue #131 this is always zero on a goods line — a goods line is exactly quantity times
   * rate, less its own discount — and on a charge line it is the whole of that charge.
   */
  readonly chargesShare: Money;
  readonly taxableValue: Money;
  readonly ratePercentTimes100: bigint | null;
  readonly cgst: Money;
  readonly sgst: Money;
  readonly utgst: Money;
  readonly igst: Money;
  readonly cess: Money;
  readonly totalTax: Money;
  /** Taxable value plus tax, unless reverse charge applies, in which case tax is not billed. */
  readonly lineTotal: Money;
  readonly reverseCharge: boolean;
  readonly rateSourceRef: string | null;
  readonly rateReviewState: ReviewState | null;
  /** `null` on a line that carries no rate at all, such as a nil-rated or exempt supply. */
  readonly rateBasis: RateBasis | null;
  /** Set only when the business declared the rate itself: who said so, and on what footing. */
  readonly rateDeclaredBy: string | null;
  readonly rateDeclaredBasis: string | null;
  readonly explanation: { readonly 'en-IN': string; readonly 'hi-IN': string };
}

export interface TaxTotals {
  readonly taxableValue: Money;
  readonly cgst: Money;
  readonly sgst: Money;
  readonly utgst: Money;
  readonly igst: Money;
  readonly cess: Money;
  readonly totalTax: Money;
  /** Tax the recipient owes the government directly; not part of the invoice value. */
  readonly reverseChargeTax: Money;
  /**
   * Issue #145 — tax collected at source, an amount held for the government. It is part of what
   * the customer pays but is never part of any GST figure above.
   */
  readonly tcs: Money;
  readonly beforeRounding: Money;
  readonly roundOff: Money;
  readonly invoiceValue: Money;
}

export interface BlockedReason {
  readonly code:
    | 'COMPANY_NOT_FOUND'
    | 'PARTY_NOT_FOUND'
    | 'ITEM_NOT_FOUND'
    | 'GSTIN_STATE_MISMATCH'
    | 'PLACE_OF_SUPPLY_UNKNOWN'
    | 'TAX_SPLIT_UNKNOWN'
    | 'ITEM_NOT_CLASSIFIED'
    | 'HSN_MISSING'
    | 'RATE_NOT_FOUND'
    | 'RATE_NOT_REVIEWED'
    | 'INCLUSIVE_WITH_CESS_UNSUPPORTED'
    | 'COMPOSITION_UNDECIDED';
  readonly lineId?: string;
  /** Plain wording, from the issue #46 rules. */
  readonly message: { readonly 'en-IN': string; readonly 'hi-IN': string };
  /** The id from the issue #46 catalogue when there is a message for it. */
  readonly messageId?: string;
}

export type ComputeResult =
  | {
      readonly status: 'COMPUTED';
      readonly placeOfSupplyStateCode: string;
      readonly split: TaxSplit;
      readonly mayChargeGst: boolean;
      readonly lines: readonly ComputedTaxLine[];
      readonly totals: TaxTotals;
      /** Issue #145 — the working behind `totals.tcs`, or `null` when none was due. */
      readonly tcsCharge: TcsCharge | null;
      readonly decisions: readonly Decision[];
      readonly explanation: { readonly 'en-IN': string; readonly 'hi-IN': string };
      /** True when any line's rate came from the business rather than from a checked notification. */
      readonly usesBusinessDeclaredRates: boolean;
      /** One sentence for the bill and the screen, when the previous flag is true. */
      readonly declaredRateNotice: { readonly 'en-IN': string; readonly 'hi-IN': string } | null;
    }
  | {
      readonly status: 'CANNOT_COMPUTE';
      readonly reasons: readonly BlockedReason[];
      readonly decisions: readonly Decision[];
      readonly exceptions: readonly ExceptionDraft[];
      readonly explanation: { readonly 'en-IN': string; readonly 'hi-IN': string };
    };

export interface GstCalculatorDeps {
  readonly masterData: MasterDataReader;
  readonly rates: RateTable;
  readonly gstEngine: RulesEngine;
  readonly mode: EngineMode;
  /**
   * Rates the business set for itself. Consulted only when the register has nothing approved, and
   * every figure that comes from here is labelled all the way to the printed bill.
   */
  readonly declaredRates?: DeclaredRateReader;
}

const INR = 'INR' as const;
const nil = (): Money => zero(INR);

/** Exact quantity times price, rounded once. Quantities are scaled by 10^6. */
const extend = (unitPrice: Money, quantity: Quantity): Money => mulDiv(unitPrice, quantity.scaled, 1000000n);

/**
 * Splits GST on an exclusive-priced amount into the taxes that actually apply.
 *
 * CGST and SGST (or UTGST) are each half the rate, worked out separately rather than halving one
 * figure, because the two halves are claimed and reported separately.
 */
const applySplit = (
  base: Money,
  rate: bigint,
  split: TaxSplit,
): { cgst: Money; sgst: Money; utgst: Money; igst: Money } => {
  if (split === 'IGST') {
    return { cgst: nil(), sgst: nil(), utgst: nil(), igst: mulDiv(base, rate, 10000n) };
  }
  const half = mulDiv(base, rate / 2n, 10000n);
  return split === 'CGST_UTGST'
    ? { cgst: half, sgst: nil(), utgst: half, igst: nil() }
    : { cgst: half, sgst: half, utgst: nil(), igst: nil() };
};

/** What a charge is called on the bill. English, like every other line description here. */
const CHARGE_NAMES: Record<ChargeKind, string> = {
  FREIGHT: 'Freight',
  OTHER: 'Other charges',
};

const applyDiscount = (gross: Money, discount: Discount | undefined): Money => {
  if (discount === undefined) return nil();
  if (discount.kind === 'AMOUNT') return discount.amount;
  return mulDiv(gross, discount.percentTimes100, 10000n);
};

/**
 * Issue #145 — the sentence about TCS goes after the sentence about GST, never inside it. A person
 * reading the explanation must be able to see the two amounts as two separate things.
 */
const withTcsNote = (
  explanation: { readonly 'en-IN': string; readonly 'hi-IN': string },
  tcsCharge: TcsCharge | null,
): { readonly 'en-IN': string; readonly 'hi-IN': string } =>
  tcsCharge === null
    ? explanation
    : {
        'en-IN': `${explanation['en-IN']} ${tcsCharge.note['en-IN']}`,
        'hi-IN': `${explanation['hi-IN']} ${tcsCharge.note['hi-IN']}`,
      };

export class GstCalculator {
  readonly #masterData: MasterDataReader;
  readonly #rates: RateTable;
  readonly #engine: RulesEngine;
  readonly #mode: EngineMode;
  readonly #declaredRates: DeclaredRateReader | undefined;

  constructor(deps: GstCalculatorDeps) {
    this.#masterData = deps.masterData;
    this.#rates = deps.rates;
    this.#engine = deps.gstEngine;
    this.#mode = deps.mode;
    this.#declaredRates = deps.declaredRates;
  }

  compute(input: ComputeInput): ComputeResult {
    const reasons: BlockedReason[] = [];
    const decisions: Decision[] = [];

    const company = this.#masterData.company(input.companyId);
    const party = this.#masterData.party(input.companyId, input.partyId);
    if (company === undefined) {
      reasons.push(blocked('COMPANY_NOT_FOUND', 'We do not have your business details yet.', 'Aapke business ki jaankari abhi nahin hai.'));
    }
    if (party === undefined) {
      reasons.push(blocked('PARTY_NOT_FOUND', 'We do not have this customer’s details yet.', 'Is customer ki jaankari abhi nahin hai.'));
    }
    if (company !== undefined && company.gstin !== null && company.gstin.slice(0, 2) !== company.stateCode) {
      reasons.push(
        blocked(
          'GSTIN_STATE_MISMATCH',
          'Your GST number and your state do not agree, so we will not choose between them.',
          'Aapka GST number aur rajya aapas mein mel nahin khaate, isliye hum inmein se chunav nahin karenge.',
        ),
      );
    }
    if (company === undefined || party === undefined || reasons.length > 0) {
      return this.#refuse(input, reasons, decisions);
    }

    // 1. May this business charge GST at all? A rule decides, not this file.
    const composition = this.#engine.evaluate({
      topic: 'gst.composition.charging',
      facts: FactSet.of({ 'supply.supplierRegistration': company.registration }, 'MASTER_DATA'),
      documentDate: input.documentDate,
      stateCode: company.stateCode,
    }).decision;
    decisions.push(composition);
    if (composition.outcome === 'CANNOT_DECIDE') {
      reasons.push(
        blocked(
          'COMPOSITION_UNDECIDED',
          'We cannot tell yet whether your business may charge GST on this bill.',
          'Abhi pata nahin ki aapka business is bill par GST le sakta hai ya nahin.',
        ),
      );
      return this.#refuse(input, reasons, decisions);
    }
    const mayChargeGst = composition.computed.mayChargeGst === 'true';

    // 2. Where does this sale count?
    const placeOfSupply = this.#resolvePlaceOfSupply(input, party, decisions, reasons);
    if (placeOfSupply === null) return this.#refuse(input, reasons, decisions);

    // 3. Which taxes apply?
    // The name comes from GPT 3's master data (#5). The Union Territory GST Act names territories
    // rather than codes, so the rule needs the name, not the number.
    const placeOfSupplyName = GST_STATE_CODES[placeOfSupply]?.name;
    const splitDecision = this.#engine.evaluate({
      topic: 'gst.tax_split',
      facts: FactSet.of(
        {
          'supply.supplierStateCode': company.stateCode,
          'supply.placeOfSupplyStateCode': placeOfSupply,
          ...(placeOfSupplyName === undefined ? {} : { 'supply.placeOfSupplyStateName': placeOfSupplyName }),
        },
        'MASTER_DATA',
      ),
      documentDate: input.documentDate,
      stateCode: company.stateCode,
    }).decision;
    decisions.push(splitDecision);
    if (splitDecision.outcome === 'CANNOT_DECIDE') {
      reasons.push(
        blocked(
          'TAX_SPLIT_UNKNOWN',
          'We cannot work out which GST applies to this sale yet.',
          'Abhi tay nahin ho pa raha ki is bikri par kaunsa GST lagega.',
          'tax.scenario_not_supported',
        ),
      );
      return this.#refuse(input, reasons, decisions);
    }
    const split = splitDecision.computed.split as TaxSplit;

    // 4. Line arithmetic.
    const prepared = input.lines.map((line) => {
      const item = this.#masterData.item(input.companyId, line.itemId);
      if (item === undefined) {
        reasons.push(
          blocked('ITEM_NOT_FOUND', `We do not have details for one of the items on this bill.`, 'Is bill ke ek item ki jaankari nahin hai.', undefined, line.lineId),
        );
        return null;
      }
      if (item.treatment === 'UNKNOWN') {
        reasons.push(
          blocked(
            'ITEM_NOT_CLASSIFIED',
            `We do not know yet how "${item.name}" is taxed.`,
            `"${item.name}" par tax kaise lagta hai, yeh abhi pata nahin.`,
            undefined,
            line.lineId,
          ),
        );
        return null;
      }
      const gross = extend(line.unitPrice, line.quantity);
      const discount = applyDiscount(gross, line.discount);
      return { line, item, gross, discount, net: subtract(gross, discount) };
    });

    if (prepared.some((p) => p === null)) return this.#refuse(input, reasons, decisions);
    const ready = prepared as NonNullable<(typeof prepared)[number]>[];

    // 5. Goods lines carry nothing but their own arithmetic: quantity times rate, less their own
    //    discount. Issue #131 — folding freight in here made the printed bill fail the first check
    //    a customer makes, so charges are worked out separately in step 6.
    const goodsLines: ComputedTaxLine[] = [];
    for (const r of ready) {
      const line = this.#computeLine(input, r, split, mayChargeGst, reasons);
      if (line !== null) goodsLines.push(line);
    }
    if (reasons.length > 0) return this.#refuse(input, reasons, decisions);

    // 6. Freight and other charges are still part of the same supply and are still taxed — they
    //    are simply given lines of their own rather than hidden inside the goods.
    const computedLines = [
      ...goodsLines,
      ...this.#chargeLines(goodsLines, [
        { kind: 'FREIGHT', amount: input.freight ?? nil() },
        { kind: 'OTHER', amount: input.otherCharges ?? nil() },
      ], split),
    ];

    // Issue #145 — the higher TCS rate applies when the customer has given no tax number, which is
    // a fact this module already holds. The caller may still state it, and then that is used.
    const tcsContext: TcsContext | undefined =
      input.tcs === undefined
        ? undefined
        : { ...input.tcs, customerHasTaxNumber: input.tcs.customerHasTaxNumber ?? party.gstin !== null };
    const { totals, tcsCharge } = this.#totals(computedLines, input.roundToWholeRupee ?? true, tcsContext);
    const declaredLines = computedLines.filter((l) => l.rateBasis === 'BUSINESS_DECLARED');
    return {
      status: 'COMPUTED',
      tcsCharge,
      usesBusinessDeclaredRates: declaredLines.length > 0,
      declaredRateNotice:
        declaredLines.length === 0
          ? null
          : {
              'en-IN': 'The GST rates on this bill are the ones your business set. We have not checked them against a government notification.',
              'hi-IN': 'Is bill ke GST rate aapke business ne tay kiye hain. Humne inhe sarkari notification se nahin jaancha.',
            },
      placeOfSupplyStateCode: placeOfSupply,
      split,
      mayChargeGst,
      lines: computedLines,
      totals,
      decisions,
      explanation: withTcsNote(this.#explainDocument(split, placeOfSupply, totals, mayChargeGst), tcsCharge),
    };
  }

  #resolvePlaceOfSupply(
    input: ComputeInput,
    party: { stateCode: string | null; registration: import('./master-data-port.ts').PartyRegistration },
    decisions: Decision[],
    reasons: BlockedReason[],
  ): string | null {
    if (input.placeOfSupplyStateCode !== undefined && input.placeOfSupplyStateCode !== null) {
      return input.placeOfSupplyStateCode;
    }
    const deliveryState = input.deliveryStateCode ?? party.stateCode;
    const registered =
      party.registration === 'UNKNOWN' ? undefined : party.registration !== 'UNREGISTERED';
    const facts = FactSet.of(
      {
        'supply.type': input.supplyKind,
        ...(deliveryState === null || deliveryState === undefined ? {} : { 'supply.deliveryStateCode': deliveryState }),
        ...(registered === undefined ? {} : { 'supply.recipientRegistered': registered }),
        ...(party.stateCode === null ? {} : { 'supply.recipientStateCode': party.stateCode }),
      },
      'MASTER_DATA',
    );
    const decision = this.#engine.evaluate({
      topic: 'gst.place_of_supply',
      facts,
      documentDate: input.documentDate,
    }).decision;
    decisions.push(decision);
    if (decision.outcome === 'CANNOT_DECIDE') {
      reasons.push(
        blocked(
          'PLACE_OF_SUPPLY_UNKNOWN',
          'We cannot work out the GST yet. We do not know which state this sale counts in.',
          'GST abhi tay nahin ho sakta. Pata nahin yeh bikri kis rajya ki maani jayegi.',
          'tax.place_of_supply_missing',
        ),
      );
      return null;
    }
    return decision.computed.placeOfSupplyStateCode ?? null;
  }

  #computeLine(
    input: ComputeInput,
    prepared: { line: TaxLineInput; item: import('./master-data-port.ts').ItemTaxClassification; gross: Money; discount: Money; net: Money },
    split: TaxSplit,
    mayChargeGst: boolean,
    reasons: BlockedReason[],
  ): ComputedTaxLine | null {
    const { line, item } = prepared;
    const base = prepared.net;
    const notTaxed = item.treatment !== 'TAXABLE' || !mayChargeGst;

    if (notTaxed) {
      return this.#assemble(line, item, prepared, base, null, nil(), nil(), nil(), nil(), nil(), null, null, split, mayChargeGst, null, null, null);
    }

    if (item.hsnOrSac === null) {
      reasons.push(
        blocked('HSN_MISSING', `"${item.name}" has no government code yet, so we cannot find its rate.`,
          `"${item.name}" ka sarkari code abhi nahin hai, isliye rate nahin mil raha.`, undefined, line.lineId),
      );
      return null;
    }

    const resolved = this.#resolveRate(input, item);
    if (resolved === null) {
      const lookup = this.#rates.find(item.hsnOrSac, item.kind, input.documentDate, this.#mode);
      reasons.push(
        !lookup.found && lookup.reason === 'NOT_REVIEWED'
          ? blocked(
              'RATE_NOT_REVIEWED',
              `The GST rate we hold for "${item.name}" has not been checked against an official notification yet, so we will not use it. You can enter the rate you charge.`,
              `"${item.name}" ka GST rate abhi sarkari notification se jaancha nahin gaya, isliye hum use nahin karenge. Aap apna rate bhar sakte hain.`,
              undefined,
              line.lineId,
            )
          : blocked(
              'RATE_NOT_FOUND',
              `We do not have a GST rate for "${item.name}". You can enter the rate you charge.`,
              `"${item.name}" ka GST rate hamare paas nahin hai. Aap apna rate bhar sakte hain.`,
              undefined,
              line.lineId,
            ),
      );
      return null;
    }

    const entry = resolved.entry;
    const hasCess = entry.cess !== undefined;
    if (line.priceBasis === 'INCLUSIVE' && hasCess) {
      reasons.push(
        blocked(
          'INCLUSIVE_WITH_CESS_UNSUPPORTED',
          `"${item.name}" carries an extra tax, so a price that already includes tax is not supported here yet. Enter the price without tax.`,
          `"${item.name}" par extra tax lagta hai, isliye tax-shaamil rate abhi nahin chalega. Bina tax wala rate bharein.`,
          undefined,
          line.lineId,
        ),
      );
      return null;
    }

    const rate = entry.ratePercentTimes100;

    let taxableValue: Money;
    let cgst = nil();
    let sgst = nil();
    let utgst = nil();
    let igst = nil();

    if (line.priceBasis === 'INCLUSIVE') {
      // Work the tax back out of the price, then set the taxable value to whatever is left, so the
      // parts always add back to exactly the price the shopkeeper quoted.
      const candidate = mulDiv(base, 10000n, 10000n + rate);
      const halfRate = rate / 2n;
      if (split === 'IGST') {
        igst = mulDiv(candidate, rate, 10000n);
        taxableValue = subtract(base, igst);
      } else {
        const first = mulDiv(candidate, halfRate, 10000n);
        const second = first;
        if (split === 'CGST_UTGST') {
          cgst = first;
          utgst = second;
        } else {
          cgst = first;
          sgst = second;
        }
        taxableValue = subtract(base, add(first, second));
      }
    } else {
      taxableValue = base;
      ({ cgst, sgst, utgst, igst } = applySplit(taxableValue, rate, split));
    }

    const cess = this.#cess(entry.cess, taxableValue, line.quantity);
    return this.#assemble(
      line,
      item,
      prepared,
      taxableValue,
      rate,
      cgst,
      sgst,
      utgst,
      igst,
      cess,
      entry.sourceRef,
      entry.reviewState,
      split,
      mayChargeGst,
      resolved.basis,
      resolved.declaredBy,
      resolved.declaredBasis,
    );
  }

  /**
   * A checked notification first; the business's own declaration second; nothing third.
   *
   * The order matters. A rate the register vouches for always wins, so declaring a rate can never
   * override the law once we know it — a business's figure fills a gap, it does not replace a
   * source.
   */
  #resolveRate(
    input: ComputeInput,
    item: import('./master-data-port.ts').ItemTaxClassification,
  ): {
    entry: import('./rate-table.ts').RateEntry;
    basis: RateBasis;
    declaredBy: string | null;
    declaredBasis: string | null;
  } | null {
    const fromRegister = this.#rates.find(item.hsnOrSac, item.kind, input.documentDate, this.#mode);
    if (fromRegister.found) {
      return { entry: fromRegister.entry, basis: 'REGISTER', declaredBy: null, declaredBasis: null };
    }
    if (this.#declaredRates === undefined || item.hsnOrSac === null) return null;
    const declared = this.#declaredRates.find(input.companyId, item.hsnOrSac, item.kind, input.documentDate);
    if (declared === undefined) return null;
    return {
      entry: {
        code: declared.code,
        kind: declared.kind,
        description: `Rate set by the business on ${declared.declaredOn}`,
        ratePercentTimes100: declared.ratePercentTimes100,
        ...(declared.cess === undefined ? {} : { cess: declared.cess }),
        effectiveFrom: declared.effectiveFrom,
        effectiveTo: declared.effectiveTo,
        sourceRef: null,
        reviewState: 'DRAFT',
      },
      basis: 'BUSINESS_DECLARED',
      declaredBy: declared.declaredBy,
      declaredBasis: declared.basis,
    };
  }

  #cess(rule: import('./rate-table.ts').CessRule | undefined, taxableValue: Money, quantity: Quantity): Money {
    if (rule === undefined) return nil();
    const byPercent = rule.percentTimes100 === undefined ? nil() : mulDiv(taxableValue, rule.percentTimes100, 10000n);
    const perUnit =
      rule.perUnitPaise === undefined ? nil() : mulDiv(money(rule.perUnitPaise, INR), quantity.scaled, 1000000n);
    if (rule.percentTimes100 !== undefined && rule.perUnitPaise !== undefined) {
      return rule.takeHigher === true
        ? (byPercent.minor >= perUnit.minor ? byPercent : perUnit)
        : add(byPercent, perUnit);
    }
    return rule.percentTimes100 === undefined ? perUnit : byPercent;
  }

  /**
   * Turns freight and other charges into lines of their own.
   *
   * Freight on a sale of goods is not a service the customer bought separately — it is part of the
   * same supply, so it carries the rate of the goods it travelled with rather than a rate of its
   * own. When a bill has goods at more than one rate, the charge is divided between those rates by
   * value, and each part becomes its own line saying which goods it belongs to. That division is
   * the only apportionment left: no goods line's own amount is ever touched by it.
   *
   * A bill with no goods lines at all gets one untaxed charge line, because there is no rate to
   * borrow. That is visible on the bill rather than silently dropped.
   */
  #chargeLines(
    goodsLines: readonly ComputedTaxLine[],
    charges: readonly { kind: ChargeKind; amount: Money }[],
    split: TaxSplit,
  ): ComputedTaxLine[] {
    const billed = charges.filter((c) => !isZero(c.amount));
    if (billed.length === 0) return [];

    const groups = new Map<
      string,
      { rate: bigint | null; reverseCharge: boolean; treatment: TaxTreatment; weight: bigint }
    >();
    for (const l of goodsLines) {
      const key = `${l.ratePercentTimes100 ?? 'none'}|${l.reverseCharge}`;
      const weight = l.taxableValue.minor < 0n ? 0n : l.taxableValue.minor;
      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, { rate: l.ratePercentTimes100, reverseCharge: l.reverseCharge, treatment: l.treatment, weight });
      } else {
        existing.weight += weight;
      }
    }
    const buckets =
      groups.size === 0
        ? [{ rate: null, reverseCharge: false, treatment: 'NON_GST' as TaxTreatment, weight: 1n }]
        : [...groups.values()];

    const lines: ComputedTaxLine[] = [];
    for (const charge of billed) {
      const shares = allocateByWeight(charge.amount, buckets.map((b) => b.weight));
      for (const [index, bucket] of buckets.entries()) {
        const amount = shares[index] as Money;
        if (isZero(amount)) continue;
        lines.push(this.#chargeLine(charge.kind, amount, bucket, buckets.length > 1, index, split));
      }
    }
    return lines;
  }

  #chargeLine(
    kind: ChargeKind,
    amount: Money,
    bucket: { rate: bigint | null; reverseCharge: boolean; treatment: TaxTreatment },
    splitAcrossRates: boolean,
    index: number,
    split: TaxSplit,
  ): ComputedTaxLine {
    const { cgst, sgst, utgst, igst } =
      bucket.rate === null
        ? { cgst: nil(), sgst: nil(), utgst: nil(), igst: nil() }
        : applySplit(amount, bucket.rate, split);
    // No cess on a charge. Cess is defined per item — often per unit of that item — so there is no
    // honest way to read one off a freight amount, and inventing one would be a wrong bill.
    const totalTax = sum([cgst, sgst, utgst, igst]);
    const suffix = !splitAcrossRates
      ? ''
      : bucket.rate === null
        ? ' (on goods with no GST)'
        : ` (on goods at ${Number(bucket.rate) / 100}%)`;
    const name = `${CHARGE_NAMES[kind]}${suffix}`;
    return {
      lineId: `charge:${kind.toLowerCase()}:${index}`,
      itemId: `charge:${kind.toLowerCase()}`,
      itemName: name,
      // A charge that rides on a supply of goods has no code of its own; it takes the treatment of
      // the goods. Printing a transport SAC next to a 5% rate borrowed from fruit would be a lie.
      hsnOrSac: null,
      kind: 'CHARGE',
      chargeKind: kind,
      treatment: bucket.treatment,
      // One of it, priced at its own amount, so quantity times rate equals the amount here too.
      quantity: quantity(1, 'NOS'),
      unitPrice: amount,
      grossAmount: amount,
      discountAmount: nil(),
      chargesShare: amount,
      taxableValue: amount,
      ratePercentTimes100: bucket.rate,
      cgst,
      sgst,
      utgst,
      igst,
      cess: nil(),
      totalTax,
      lineTotal: bucket.reverseCharge ? amount : add(amount, totalTax),
      reverseCharge: bucket.reverseCharge,
      rateSourceRef: null,
      rateReviewState: null,
      // The rate is borrowed from the goods, so the goods line is where its source is stated. Left
      // null here so a borrowed rate never re-triggers the business-declared notice on its own.
      rateBasis: null,
      rateDeclaredBy: null,
      rateDeclaredBasis: null,
      explanation: {
        'en-IN':
          bucket.rate === null
            ? `${name} of ${toDecimalString(amount)} is added to the bill. No GST applies to it, because none applies to the goods it goes with.`
            : `${name} of ${toDecimalString(amount)} is part of the same supply, so it carries the same ${Number(bucket.rate) / 100}% GST as those goods: ${toDecimalString(totalTax)}.`,
        'hi-IN':
          bucket.rate === null
            ? `${name} ${toDecimalString(amount)} bill mein juda hai. Is par GST nahin lagta, kyunki jis maal ke saath yeh hai us par bhi nahin lagta.`
            : `${name} ${toDecimalString(amount)} usi supply ka hissa hai, isliye us maal jaisa hi ${Number(bucket.rate) / 100}% GST lagta hai: ${toDecimalString(totalTax)}.`,
      },
    };
  }

  #assemble(
    line: TaxLineInput,
    item: import('./master-data-port.ts').ItemTaxClassification,
    prepared: { gross: Money; discount: Money },
    taxableValue: Money,
    rate: bigint | null,
    cgst: Money,
    sgst: Money,
    utgst: Money,
    igst: Money,
    cess: Money,
    sourceRef: string | null,
    reviewState: ReviewState | null,
    split: TaxSplit,
    mayChargeGst: boolean,
    rateBasis: RateBasis | null,
    rateDeclaredBy: string | null,
    rateDeclaredBasis: string | null,
  ): ComputedTaxLine {
    const totalTax = sum([cgst, sgst, utgst, igst, cess]);
    const reverseCharge = item.reverseCharge;
    const lineTotal = reverseCharge ? taxableValue : add(taxableValue, totalTax);
    return {
      lineId: line.lineId,
      itemId: item.itemId,
      itemName: item.name,
      hsnOrSac: item.hsnOrSac,
      kind: 'GOODS',
      chargeKind: null,
      treatment: item.treatment,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      grossAmount: prepared.gross,
      discountAmount: prepared.discount,
      chargesShare: nil(),
      taxableValue,
      ratePercentTimes100: rate,
      cgst,
      sgst,
      utgst,
      igst,
      cess,
      totalTax,
      lineTotal,
      reverseCharge,
      rateSourceRef: sourceRef,
      rateReviewState: reviewState,
      rateBasis,
      rateDeclaredBy,
      rateDeclaredBasis,
      explanation: explainLine(item, taxableValue, rate, split, totalTax, reverseCharge, mayChargeGst, rateBasis),
    };
  }

  #totals(
    lines: readonly ComputedTaxLine[],
    roundToWholeRupee: boolean,
    tcsContext: TcsContext | undefined,
  ): { totals: TaxTotals; tcsCharge: TcsCharge | null } {
    const billable = lines.filter((l) => !l.reverseCharge);
    const taxableValue = sum(lines.map((l) => l.taxableValue));
    const cgst = sum(billable.map((l) => l.cgst));
    const sgst = sum(billable.map((l) => l.sgst));
    const utgst = sum(billable.map((l) => l.utgst));
    const igst = sum(billable.map((l) => l.igst));
    const cess = sum(billable.map((l) => l.cess));
    const totalTax = sum([cgst, sgst, utgst, igst, cess]);
    const reverseChargeTax = sum(lines.filter((l) => l.reverseCharge).map((l) => l.totalTax));
    // Issue #145 — TCS is worked out on what the customer is being charged for the supply,
    // including GST, and is then added on top. It is kept out of every GST figure above.
    const valueWithGst = add(taxableValue, totalTax);
    const tcsCharge = computeTcs(tcsContext, valueWithGst);
    const tcs = tcsCharge === null ? nil() : tcsCharge.amount;
    const beforeRounding = add(valueWithGst, tcs);
    // One rounding, at the very end, using the product-wide half-up rule from the kernel.
    const invoiceValue = roundToWholeRupee ? roundToWholeUnits(beforeRounding) : beforeRounding;
    return {
      totals: {
        taxableValue,
        cgst,
        sgst,
        utgst,
        igst,
        cess,
        totalTax,
        reverseChargeTax,
        tcs,
        beforeRounding,
        roundOff: subtract(invoiceValue, beforeRounding),
        invoiceValue,
      },
      tcsCharge,
    };
  }

  #refuse(input: ComputeInput, reasons: BlockedReason[], decisions: Decision[]): ComputeResult {
    const exceptions = decisions
      .map((d) => toExceptionDraft(d, input.source))
      .filter((e): e is ExceptionDraft => e !== null);
    return {
      status: 'CANNOT_COMPUTE',
      reasons,
      decisions,
      exceptions,
      explanation: {
        'en-IN': `We cannot work out the GST on this bill yet. ${reasons.map((r) => r.message['en-IN']).join(' ')}`,
        'hi-IN': `Is bill ka GST abhi tay nahin ho sakta. ${reasons.map((r) => r.message['hi-IN']).join(' ')}`,
      },
    };
  }

  #explainDocument(split: TaxSplit, placeOfSupply: string, totals: TaxTotals, mayChargeGst: boolean) {
    if (!mayChargeGst) {
      return {
        'en-IN': `Your business does not charge GST on its bills, so no GST has been added. The bill comes to ${toDecimalString(totals.invoiceValue)}.`,
        'hi-IN': `Aapka business bill par GST nahin leta, isliye GST nahin joda gaya. Bill ${toDecimalString(totals.invoiceValue)} ka hai.`,
      };
    }
    const words: Record<TaxSplit, { en: string; hi: string }> = {
      CGST_SGST: { en: 'two separate GST amounts apply', hi: 'do alag GST lagte hain' },
      CGST_UTGST: { en: 'two separate GST amounts apply', hi: 'do alag GST lagte hain' },
      IGST: { en: 'one combined GST applies', hi: 'ek hi GST lagta hai' },
    };
    return {
      'en-IN': `This sale counts in state ${placeOfSupply}, so ${words[split].en}. GST of ${toDecimalString(totals.totalTax)} has been added to ${toDecimalString(totals.taxableValue)}, and the bill comes to ${toDecimalString(totals.invoiceValue)}.`,
      'hi-IN': `Yeh bikri rajya ${placeOfSupply} ki hai, isliye ${words[split].hi}. ${toDecimalString(totals.taxableValue)} par ${toDecimalString(totals.totalTax)} GST joda gaya, aur bill ${toDecimalString(totals.invoiceValue)} ka hai.`,
    };
  }
}

const blocked = (
  code: BlockedReason['code'],
  en: string,
  hi: string,
  messageId?: string,
  lineId?: string,
): BlockedReason => ({
  code,
  message: { 'en-IN': en, 'hi-IN': hi },
  ...(messageId === undefined ? {} : { messageId }),
  ...(lineId === undefined ? {} : { lineId }),
});

const TREATMENT_WORDS: Record<TaxTreatment, { en: string; hi: string }> = {
  TAXABLE: { en: 'is taxed', hi: 'par tax lagta hai' },
  NIL_RATED: { en: 'is taxed at nothing', hi: 'par tax shoonya hai' },
  EXEMPT: { en: 'is free of tax', hi: 'tax se mukt hai' },
  NON_GST: { en: 'is outside GST', hi: 'GST ke bahar hai' },
  UNKNOWN: { en: 'has not been classified', hi: 'abhi classify nahin hua' },
};

const explainLine = (
  item: { name: string; treatment: TaxTreatment },
  taxableValue: Money,
  rate: bigint | null,
  split: TaxSplit,
  totalTax: Money,
  reverseCharge: boolean,
  mayChargeGst: boolean,
  rateBasis: RateBasis | null,
) => {
  if (!mayChargeGst) {
    return {
      'en-IN': `${item.name}: ${toDecimalString(taxableValue)}. Your business does not charge GST on its bills.`,
      'hi-IN': `${item.name}: ${toDecimalString(taxableValue)}. Aapka business bill par GST nahin leta.`,
    };
  }
  if (item.treatment !== 'TAXABLE' || rate === null) {
    return {
      'en-IN': `${item.name} ${TREATMENT_WORDS[item.treatment].en}, so nothing has been added to ${toDecimalString(taxableValue)}.`,
      'hi-IN': `${item.name} ${TREATMENT_WORDS[item.treatment].hi}, isliye ${toDecimalString(taxableValue)} par kuch nahin joda gaya.`,
    };
  }
  const percent = `${Number(rate) / 100}%`;
  const who = reverseCharge
    ? { en: ' You pay this GST to the government yourself, so it is not on the bill.', hi: ' Yeh GST aap khud sarkar ko bharenge, isliye bill par nahin hai.' }
    : { en: '', hi: '' };
  const kind = split === 'IGST' ? { en: 'one combined GST', hi: 'ek hi GST' } : { en: 'two separate GST amounts', hi: 'do alag GST' };
  const whose =
    rateBasis === 'BUSINESS_DECLARED'
      ? { en: ' This is the rate your business set.', hi: ' Yeh rate aapke business ne tay kiya hai.' }
      : { en: '', hi: '' };
  return {
    'en-IN': `${item.name}: ${toDecimalString(taxableValue)} at ${percent} gives ${toDecimalString(totalTax)} as ${kind.en}.${who.en}${whose.en}`,
    'hi-IN': `${item.name}: ${toDecimalString(taxableValue)} par ${percent} se ${toDecimalString(totalTax)} bana, ${kind.hi} ke roop mein.${who.hi}${whose.hi}`,
  };
};
