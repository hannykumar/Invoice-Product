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

// Issue #286 — an advance used against this month's bill was already taxed when it arrived, so it
// comes off what is owed now (the bill itself is counted in full).
const signed = (document: OutwardDocument, amounts: TaxAmounts): TaxAmounts =>
  document.kind === 'CREDIT_NOTE' || document.kind === 'REFUND_VOUCHER' || document.kind === 'ADVANCE_ADJUSTED' ? negateAmounts(amounts) : amounts;

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
  let nonGst = emptyAmounts();
  let reverseChargeOutward = emptyAmounts();
  const taxableSources: SourceRef[] = [];
  const zeroRatedSources: SourceRef[] = [];
  const nilExemptSources: SourceRef[] = [];
  const nonGstSources: SourceRef[] = [];
  const reverseChargeSources: SourceRef[] = [];

  /** Table 3.2: of the consumer sales, how much went to each other state. */
  const toUnregistered = new Map<string, { taxableValue: Money; igst: Money; sources: SourceRef[] }>();

  for (const document of input.documents) {
    const amounts = documentAmounts(document);
    const source = sourceRefOf(document);

    if (document.treatment === 'NON_GST') {
      // Issue #286 — outside GST altogether is its own line, 3.1(e), not part of nil and exempt.
      nonGst = addAmounts(nonGst, amounts);
      nonGstSources.push(source);
    } else if (carriesNoTax(document.treatment)) {
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
    line('3.1(a)', 'Ordinary sales you charged GST on', 'आम बिक्री जिस पर आपने GST लिया', taxable, taxableSources),
    line('3.1(b)', 'Sales outside India and to special economic zones', 'भारत के बाहर और स्पेशल इकोनॉमिक ज़ोन की बिक्री', zeroRated, zeroRatedSources),
    line('3.1(c)', 'Sales that carried no GST (nil-rated or exempt)', 'बिना GST वाली बिक्री (नील-रेटेड या एग्ज़ेम्प्ट)', nilExempt, nilExemptSources),
    line('3.1(d)', 'Purchases where you owe the tax yourself', 'ख़रीद जिस पर टैक्स आपको ही भरना है', input.inward.reverseChargeLiability, input.inward.contributions),
    // Issue #286 — 3.1(e) on the form is supplies outside GST altogether. It had been labelled
    // "the buyer pays the tax", which is a different thing with no box of its own in 3.1.
    line('3.1(e)', 'Sales outside GST altogether', 'GST के बाहर की बिक्री', nonGst, nonGstSources),
    line('RCM-OUT', 'Sales where the buyer pays the tax (for your record: the buyer reports this tax, not you)', 'बिक्री जिस पर टैक्स ख़रीदार भरेगा (आपके रिकॉर्ड के लिए: यह टैक्स ख़रीदार रिपोर्ट करता है)', reverseChargeOutward, reverseChargeSources),
  ];

  const availableItc = sumAmounts([input.inward.allOtherItc, input.inward.reverseChargeItc, input.inward.importItc]);
  const netItc = addAmounts(availableItc, negateAmounts(input.inward.reversedItc));

  const credit: Gstr3bLine[] = [
    line('4A(3)', 'GST you already paid on purchases where you owe the tax yourself', 'ऐसी ख़रीद पर दिया GST जिसका टैक्स आपको भरना था', input.inward.reverseChargeItc, input.inward.contributions),
    line('4A(4)', 'GST you already paid on goods brought in from outside India', 'बाहर से मँगाए सामान पर दिया GST', input.inward.importItc, input.inward.contributions),
    line('4A(5)', 'GST you already paid on all other purchases', 'बाक़ी सब ख़रीद पर दिया GST', input.inward.allOtherItc, input.inward.contributions),
    // Issue #289, part 3 — Table 4(B)(1): credit the law does not allow (CGST s.17(5)), taken back out of 4(A).
    line('4B', 'Credit the law does not allow (CGST s.17(5)), taken back out — Table 4(B)(1)', 'जो क्रेडिट क़ानून नहीं देता (CGST s.17(5)), वापस निकाला — Table 4(B)(1)', input.inward.reversedItc, input.inward.contributions),
    line('4C', 'Credit left with you after that', 'उसके बाद बचा हुआ क्रेडिट', netItc, input.inward.contributions),
  ];

  const liability = sumAmounts([taxable, zeroRated, input.inward.reverseChargeLiability]);

  const rcm = input.inward.reverseChargeLiability;
  const heads: Gstr3bHead[] = [
    head('IGST', liability.igst, netItc.igst, rcm.igst),
    head('CGST', liability.cgst, netItc.cgst, rcm.cgst),
    head('SGST', liability.sgst, netItc.sgst, rcm.sgst),
    head('CESS', liability.cess, netItc.cess, rcm.cess),
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
      'hi-IN': `${formatTaxPeriod(input.period)}: बिक्री पर ${formatINR(totalLiability)} GST बनता है, और ख़रीद पर पहले दिया हुआ ${formatINR(totalCredit)} GST उसमें से काटने के लिए है.`,
    },
    caution: {
      'en-IN':
        'These are the two sides, head by head. How much you finally pay in cash depends on the order the credit is used in, and part of that order is your choice — so it is decided when the payment is prepared, not here.',
      'hi-IN':
        'यह दोनों तरफ़ का हिसाब है, हेड के हिसाब से. आख़िर में नक़द कितना देना है, यह क्रेडिट लगाने के क्रम पर है, और उस क्रम का कुछ हिस्सा आपकी मर्ज़ी है — इसलिए वह पेमेंट बनाते वक़्त तय होगा, यहाँ नहीं.',
    },
  };
};

/**
 * Issue #289, part 2 — tax under reverse charge is not "output tax" (CGST s.2(82)), and credit may be
 * used only against output tax (s.49(4)); so it is paid in cash, and the credit it gives (4(A)(3))
 * is used against the rest (Circular 172/04/2022-GST). Within a head, the cash due is that tax plus
 * whatever of the rest the credit does not cover.
 */
const head = (name: Gstr3bHead['head'], liability: Money, credit: Money, reverseCharge: Money): Gstr3bHead => {
  const rest = liability.minor - reverseCharge.minor;
  return {
    head: name,
    liability,
    credit,
    difference: { currency: 'INR', minor: liability.minor - credit.minor },
    reverseChargeCash: reverseCharge,
    cashToPay: { currency: 'INR', minor: reverseCharge.minor + (rest > credit.minor ? rest - credit.minor : 0n) },
    creditLeft: { currency: 'INR', minor: credit.minor > rest ? credit.minor - rest : 0n },
  };
};

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
      'hi-IN': `${entry.head}: क्रेडिट से ${formatINR(entry.difference)} ज़्यादा देना बनता है.`,
    };
  }
  if (entry.difference.minor < 0n) {
    const spare: Money = { currency: 'INR', minor: -entry.difference.minor };
    return {
      'en-IN': `${entry.head}: ${formatINR(spare)} of credit is left over.`,
      'hi-IN': `${entry.head}: ${formatINR(spare)} का क्रेडिट बच गया.`,
    };
  }
  return { 'en-IN': `${entry.head}: nothing owed and nothing left over.`, 'hi-IN': `${entry.head}: न कुछ देना, न कुछ बचा.` };
};
