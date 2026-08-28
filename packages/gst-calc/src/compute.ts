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
import type { MasterDataReader, TaxTreatment } from './master-data-port.ts';
import type { RateTable } from './rate-table.ts';

export type PriceBasis = 'EXCLUSIVE' | 'INCLUSIVE';
export type TaxSplit = 'CGST_SGST' | 'CGST_UTGST' | 'IGST';

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
  /** Identifies the document, so an exception queued twice is one item. */
  readonly source: { readonly kind: string; readonly id: string };
}

export interface ComputedTaxLine {
  readonly lineId: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly hsnOrSac: string | null;
  readonly treatment: TaxTreatment;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  readonly grossAmount: Money;
  readonly discountAmount: Money;
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
      readonly decisions: readonly Decision[];
      readonly explanation: { readonly 'en-IN': string; readonly 'hi-IN': string };
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
}

const INR = 'INR' as const;
const nil = (): Money => zero(INR);

/** Exact quantity times price, rounded once. Quantities are scaled by 10^6. */
const extend = (unitPrice: Money, quantity: Quantity): Money => mulDiv(unitPrice, quantity.scaled, 1000000n);

const applyDiscount = (gross: Money, discount: Discount | undefined): Money => {
  if (discount === undefined) return nil();
  if (discount.kind === 'AMOUNT') return discount.amount;
  return mulDiv(gross, discount.percentTimes100, 10000n);
};

export class GstCalculator {
  readonly #masterData: MasterDataReader;
  readonly #rates: RateTable;
  readonly #engine: RulesEngine;
  readonly #mode: EngineMode;

  constructor(deps: GstCalculatorDeps) {
    this.#masterData = deps.masterData;
    this.#rates = deps.rates;
    this.#engine = deps.gstEngine;
    this.#mode = deps.mode;
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
    const splitDecision = this.#engine.evaluate({
      topic: 'gst.tax_split',
      facts: FactSet.of(
        { 'supply.supplierStateCode': company.stateCode, 'supply.placeOfSupplyStateCode': placeOfSupply },
        'DERIVED',
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

    // 5. Freight and other charges form part of the supply, so they are apportioned across the
    //    lines by value before tax is worked out — never taxed as a separate untaxed line.
    const charges = add(input.freight ?? nil(), input.otherCharges ?? nil());
    const weights = ready.map((r) => (r.net.minor < 0n ? 0n : r.net.minor));
    const shares = isZero(charges) ? ready.map(() => nil()) : allocateByWeight(charges, weights);

    const computedLines: ComputedTaxLine[] = [];
    for (const [index, r] of ready.entries()) {
      const chargesShare = shares[index] as Money;
      const line = this.#computeLine(input, r, chargesShare, split, mayChargeGst, reasons);
      if (line !== null) computedLines.push(line);
    }
    if (reasons.length > 0) return this.#refuse(input, reasons, decisions);

    const totals = this.#totals(computedLines, input.roundToWholeRupee ?? true);
    return {
      status: 'COMPUTED',
      placeOfSupplyStateCode: placeOfSupply,
      split,
      mayChargeGst,
      lines: computedLines,
      totals,
      decisions,
      explanation: this.#explainDocument(split, placeOfSupply, totals, mayChargeGst),
    };
  }

  #resolvePlaceOfSupply(
    input: ComputeInput,
    party: { stateCode: string | null },
    decisions: Decision[],
    reasons: BlockedReason[],
  ): string | null {
    if (input.placeOfSupplyStateCode !== undefined && input.placeOfSupplyStateCode !== null) {
      return input.placeOfSupplyStateCode;
    }
    const deliveryState = input.deliveryStateCode ?? party.stateCode;
    const facts =
      deliveryState === null || deliveryState === undefined
        ? FactSet.of({ 'supply.type': input.supplyKind }, 'USER')
        : FactSet.of({ 'supply.type': input.supplyKind, 'supply.deliveryStateCode': deliveryState }, 'MASTER_DATA');
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
    chargesShare: Money,
    split: TaxSplit,
    mayChargeGst: boolean,
    reasons: BlockedReason[],
  ): ComputedTaxLine | null {
    const { line, item } = prepared;
    const base = add(prepared.net, chargesShare);
    const notTaxed = item.treatment !== 'TAXABLE' || !mayChargeGst;

    if (notTaxed) {
      return this.#assemble(line, item, prepared, chargesShare, base, null, nil(), nil(), nil(), nil(), nil(), null, null, split, mayChargeGst);
    }

    if (item.hsnOrSac === null) {
      reasons.push(
        blocked('HSN_MISSING', `"${item.name}" has no government code yet, so we cannot find its rate.`,
          `"${item.name}" ka sarkari code abhi nahin hai, isliye rate nahin mil raha.`, undefined, line.lineId),
      );
      return null;
    }

    const lookup = this.#rates.find(item.hsnOrSac, item.kind, input.documentDate, this.#mode);
    if (!lookup.found) {
      reasons.push(
        lookup.reason === 'NOT_REVIEWED'
          ? blocked(
              'RATE_NOT_REVIEWED',
              `The GST rate we hold for "${item.name}" has not been checked against an official source yet, so we will not use it.`,
              `"${item.name}" ka GST rate abhi sarkari source se jaancha nahin gaya, isliye hum use nahin karenge.`,
              undefined,
              line.lineId,
            )
          : blocked(
              'RATE_NOT_FOUND',
              `We do not have a GST rate for "${item.name}".`,
              `"${item.name}" ka GST rate hamare paas nahin hai.`,
              undefined,
              line.lineId,
            ),
      );
      return null;
    }

    const entry = lookup.entry;
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
    const halfRate = rate / 2n;

    let taxableValue: Money;
    let cgst = nil();
    let sgst = nil();
    let utgst = nil();
    let igst = nil();

    if (line.priceBasis === 'INCLUSIVE') {
      // Work the tax back out of the price, then set the taxable value to whatever is left, so the
      // parts always add back to exactly the price the shopkeeper quoted.
      const candidate = mulDiv(base, 10000n, 10000n + rate);
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
      if (split === 'IGST') {
        igst = mulDiv(taxableValue, rate, 10000n);
      } else {
        const half = mulDiv(taxableValue, halfRate, 10000n);
        if (split === 'CGST_UTGST') {
          cgst = half;
          utgst = half;
        } else {
          cgst = half;
          sgst = half;
        }
      }
    }

    const cess = this.#cess(entry.cess, taxableValue, line.quantity);
    return this.#assemble(
      line,
      item,
      prepared,
      chargesShare,
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
    );
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

  #assemble(
    line: TaxLineInput,
    item: import('./master-data-port.ts').ItemTaxClassification,
    prepared: { gross: Money; discount: Money },
    chargesShare: Money,
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
  ): ComputedTaxLine {
    const totalTax = sum([cgst, sgst, utgst, igst, cess]);
    const reverseCharge = item.reverseCharge;
    const lineTotal = reverseCharge ? taxableValue : add(taxableValue, totalTax);
    return {
      lineId: line.lineId,
      itemId: item.itemId,
      itemName: item.name,
      hsnOrSac: item.hsnOrSac,
      treatment: item.treatment,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      grossAmount: prepared.gross,
      discountAmount: prepared.discount,
      chargesShare,
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
      explanation: explainLine(item, taxableValue, rate, split, totalTax, reverseCharge, mayChargeGst),
    };
  }

  #totals(lines: readonly ComputedTaxLine[], roundToWholeRupee: boolean): TaxTotals {
    const billable = lines.filter((l) => !l.reverseCharge);
    const taxableValue = sum(lines.map((l) => l.taxableValue));
    const cgst = sum(billable.map((l) => l.cgst));
    const sgst = sum(billable.map((l) => l.sgst));
    const utgst = sum(billable.map((l) => l.utgst));
    const igst = sum(billable.map((l) => l.igst));
    const cess = sum(billable.map((l) => l.cess));
    const totalTax = sum([cgst, sgst, utgst, igst, cess]);
    const reverseChargeTax = sum(lines.filter((l) => l.reverseCharge).map((l) => l.totalTax));
    const beforeRounding = add(taxableValue, totalTax);
    // One rounding, at the very end, using the product-wide half-up rule from the kernel.
    const invoiceValue = roundToWholeRupee ? roundToWholeUnits(beforeRounding) : beforeRounding;
    return {
      taxableValue,
      cgst,
      sgst,
      utgst,
      igst,
      cess,
      totalTax,
      reverseChargeTax,
      beforeRounding,
      roundOff: subtract(invoiceValue, beforeRounding),
      invoiceValue,
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
  return {
    'en-IN': `${item.name}: ${toDecimalString(taxableValue)} at ${percent} gives ${toDecimalString(totalTax)} as ${kind.en}.${who.en}`,
    'hi-IN': `${item.name}: ${toDecimalString(taxableValue)} par ${percent} se ${toDecimalString(totalTax)} bana, ${kind.hi} ke roop mein.${who.hi}`,
  };
};
