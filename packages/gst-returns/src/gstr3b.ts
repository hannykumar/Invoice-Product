/**
 * Issue #30 [E30] — the GSTR-3B summary.
 *
 * GSTR-3B is the short return that decides how much money actually moves. It has two sides. The
 * sales side is built from the *same documents* GSTR-1 was built from — not from a second read of
 * the books — because the commonest and most expensive filing mistake an MSME makes is a 3B that
 * does not agree with its own GSTR-1. Building both from one snapshot makes that disagreement
 * impossible by construction rather than by a checklist.
 *
 * The purchase side comes from what the purchase postings (#17) put in the input-tax accounts for
 * the period, handed in as an `InwardTaxSummary`. This module does not decide what may be claimed;
 * eligibility and the reconciliation against the government's own GSTR-2B are issue #31's work,
 * and inventing an answer here would be doing that job badly and invisibly.
 *
 * **What this file deliberately does not do:** it does not decide the order in which leftover IGST
 * credit is set against CGST and SGST. The law fixes part of that order and leaves part of it to
 * the taxpayer, so it is a decision a person makes when the payment is prepared, with the split in
 * front of them. Guessing it to produce a tidier "amount payable" would be exactly the silent
 * compliance decision the product forbids. Every 3B prepared here therefore reports liability and
 * credit head by head, and says so on its face.
 */
import { formatINR, type Money } from '@invoice/kernel';
import { carriesNoTax, isExport } from './classify.ts';
import {
  addAmounts,
  emptyAmounts,
  formatTaxPeriod,
  negateAmounts,
  sumAmounts,
  totalTaxOf,
  type Bilingual,
  type Gstr3bHead,
  type Gstr3bLine,
  type Gstr3bReturn,
  type InwardTaxSummary,
  type OutwardDocument,
  type SourceRef,
  type TaxAmounts,
  type TaxPeriod,
} from './types.ts';
import { sourceRefOf } from './classify.ts';

export interface Gstr3bBuildInput {
  readonly period: TaxPeriod;
  readonly gstin: string;
  readonly supplierStateCode: string;
  /** The same documents GSTR-1 was built from. Passing a different set is the bug this prevents. */
  readonly documents: readonly OutwardDocument[];
  readonly inward: InwardTaxSummary;
}

const line = (
  boxId: string,
  english: string,
  hindi: string,
  amounts: TaxAmounts,
  sources: readonly SourceRef[],
): Gstr3bLine => ({ boxId, label: { 'en-IN': english, 'hi-IN': hindi }, amounts, sources });

const signed = (document: OutwardDocument, amounts: TaxAmounts): TaxAmounts =>
  document.kind === 'CREDIT_NOTE' || document.kind === 'REFUND_VOUCHER' ? negateAmounts(amounts) : amounts;

const documentAmounts = (document: OutwardDocument): TaxAmounts =>
  signed(document, sumAmounts(document.lines.map((l) => l.amounts)));

/**
 * Builds the summary return.
 *
 * The classification here is coarser than GSTR-1's on purpose: 3B does not care who bought, only
 * what kind of supply it was. So the questions are only "did tax apply", "did it leave India", and
 * "did the buyer pay the tax instead of us".
 */
export const buildGstr3b = (input: Gstr3bBuildInput): Gstr3bReturn => {
  let taxable = emptyAmounts();
  let zeroRated = emptyAmounts();
  let nilExempt = emptyAmounts();
  let reverseChargeOutward = emptyAmounts();
  const taxableSources: SourceRef[] = [];
  const zeroRatedSources: SourceRef[] = [];
  const nilExemptSources: SourceRef[] = [];
  const reverseChargeSources: SourceRef[] = [];

  /** Table 3.2: of the consumer sales, how much went to each other state. */
  const toUnregistered = new Map<string, { taxableValue: Money; igst: Money; sources: SourceRef[] }>();

  for (const document of input.documents) {
    const amounts = documentAmounts(document);
    const source = sourceRefOf(document);

    if (carriesNoTax(document.treatment)) {
      nilExempt = addAmounts(nilExempt, amounts);
      nilExemptSources.push(source);
    } else if (isExport(document.treatment) || document.treatment === 'SEZ_WITH_TAX' || document.treatment === 'SEZ_WITHOUT_TAX') {
      // "Zero rated" is the form's phrase for a supply that is taxed at nothing rather than left
      // out of GST: the seller still gets the credit on what went into it.
      zeroRated = addAmounts(zeroRated, amounts);
      zeroRatedSources.push(source);
    } else if (document.reverseCharge) {
      reverseChargeOutward = addAmounts(reverseChargeOutward, amounts);
      reverseChargeSources.push(source);
    } else {
      taxable = addAmounts(taxable, amounts);
      taxableSources.push(source);
    }

    const outOfState = document.placeOfSupplyStateCode !== null && document.placeOfSupplyStateCode !== input.supplierStateCode;
    if (document.counterpartyGstin === null && outOfState && !carriesNoTax(document.treatment)) {
      const state = document.placeOfSupplyStateCode as string;
      const existing = toUnregistered.get(state);
      toUnregistered.set(state, {
        taxableValue: { currency: 'INR', minor: (existing?.taxableValue.minor ?? 0n) + amounts.taxableValue.minor },
        igst: { currency: 'INR', minor: (existing?.igst.minor ?? 0n) + amounts.igst.minor },
        sources: [...(existing?.sources ?? []), source],
      });
    }
  }

  const outward: Gstr3bLine[] = [
    line('3.1(a)', 'Ordinary sales you charged GST on', 'Aam bikri jis par aapne GST liya', taxable, taxableSources),
    line('3.1(b)', 'Sales outside India and to special economic zones', 'India ke bahar aur special economic zone ki bikri', zeroRated, zeroRatedSources),
    line('3.1(c)', 'Sales that carried no GST', 'Bina GST wali bikri', nilExempt, nilExemptSources),
    line('3.1(d)', 'Purchases where you owe the tax yourself', 'Kharid jis par tax aapko hi bharna hai', input.inward.reverseChargeLiability, input.inward.contributions),
    line('3.1(e)', 'Sales where the buyer pays the tax', 'Bikri jis par tax buyer bharega', reverseChargeOutward, reverseChargeSources),
  ];

  const availableItc = sumAmounts([input.inward.allOtherItc, input.inward.reverseChargeItc, input.inward.importItc]);
  const netItc = addAmounts(availableItc, negateAmounts(input.inward.reversedItc));

  const credit: Gstr3bLine[] = [
    line('4A(3)', 'GST you already paid on purchases where you owe the tax yourself', 'Aisi kharid par diya GST jis ka tax aapko bharna tha', input.inward.reverseChargeItc, input.inward.contributions),
    line('4A(4)', 'GST you already paid on goods brought in from outside India', 'Bahar se mangaye saaman par diya GST', input.inward.importItc, input.inward.contributions),
    line('4A(5)', 'GST you already paid on all other purchases', 'Baaki sab kharid par diya GST', input.inward.allOtherItc, input.inward.contributions),
    line('4B', 'Credit you have to give back', 'Credit jo wapas karna hai', input.inward.reversedItc, input.inward.contributions),
    line('4C', 'Credit left with you after that', 'Uske baad bacha hua credit', netItc, input.inward.contributions),
  ];

  const liability = sumAmounts([taxable, zeroRated, input.inward.reverseChargeLiability]);

  const heads: Gstr3bHead[] = [
    head('IGST', liability.igst, netItc.igst),
    head('CGST', liability.cgst, netItc.cgst),
    head('SGST', liability.sgst, netItc.sgst),
    head('CESS', liability.cess, netItc.cess),
  ];

  const totalLiability = totalTaxOf(liability);
  const totalCredit = totalTaxOf(netItc);

  return {
    period: input.period,
    gstin: input.gstin,
    outward,
    interStateToUnregistered: [...toUnregistered.entries()]
      .map(([stateCode, entry]) => ({ stateCode, taxableValue: entry.taxableValue, igst: entry.igst, sources: entry.sources }))
      .sort((a, b) => a.stateCode.localeCompare(b.stateCode)),
    credit,
    exemptInwardValue: input.inward.exemptInwardValue,
    heads,
    sentence: {
      'en-IN': `${formatTaxPeriod(input.period)}: you owe ${formatINR(totalLiability)} of GST on your sales, and you have ${formatINR(totalCredit)} of GST already paid on purchases to set against it.`,
      'hi-IN': `${formatTaxPeriod(input.period)}: bikri par ${formatINR(totalLiability)} GST banta hai, aur kharid par pehle diya hua ${formatINR(totalCredit)} GST uske against hai.`,
    },
    caution: {
      'en-IN':
        'These are the two sides, head by head. How much you finally pay in cash depends on the order the credit is used in, and part of that order is your choice — so it is decided when the payment is prepared, not here.',
      'hi-IN':
        'Yeh dono taraf ka hisaab hai, head ke hisaab se. Aakhir me nakad kitna dena hai, yeh credit lagane ke kram par hai, aur us kram ka kuch hissa aapki marzi hai — isliye woh payment banate waqt tay hoga, yahan nahi.',
    },
  };
};

const head = (name: Gstr3bHead['head'], liability: Money, credit: Money): Gstr3bHead => ({
  head: name,
  liability,
  credit,
  difference: { currency: 'INR', minor: liability.minor - credit.minor },
});

/** An inward summary with nothing in it, for a business with no purchases in the month. */
export const emptyInward = (period: TaxPeriod): InwardTaxSummary => ({
  period,
  allOtherItc: emptyAmounts(),
  reverseChargeItc: emptyAmounts(),
  importItc: emptyAmounts(),
  reversedItc: emptyAmounts(),
  reverseChargeLiability: emptyAmounts(),
  exemptInwardValue: { currency: 'INR', minor: 0n },
  contributions: [],
});

/** One plain sentence per head, for the screen that shows a shopkeeper where they stand. */
export const describeHead = (entry: Gstr3bHead): Bilingual => {
  if (entry.difference.minor > 0n) {
    return {
      'en-IN': `${entry.head}: ${formatINR(entry.difference)} more is owed than you have credit for.`,
      'hi-IN': `${entry.head}: credit se ${formatINR(entry.difference)} zyada dena banta hai.`,
    };
  }
  if (entry.difference.minor < 0n) {
    const spare: Money = { currency: 'INR', minor: -entry.difference.minor };
    return {
      'en-IN': `${entry.head}: ${formatINR(spare)} of credit is left over.`,
      'hi-IN': `${entry.head}: ${formatINR(spare)} ka credit bach gaya.`,
    };
  }
  return { 'en-IN': `${entry.head}: nothing owed and nothing left over.`, 'hi-IN': `${entry.head}: na kuch dena, na kuch bacha.` };
};
