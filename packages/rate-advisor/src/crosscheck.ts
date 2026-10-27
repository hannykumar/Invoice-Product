/**
 * Issue #59 [E59] — holding the rate on the paper against the rate in the register.
 *
 * The user example is the whole specification: a bill charges 18% on cement, the register says 28%,
 * and the product says *one of them is wrong*. Not "corrected to 28%", and not silence.
 *
 * That wording is deliberate and it is the hard part. It is tempting to treat the register as the
 * truth and quietly restate the supplier — but the register is the business's own record, it may be
 * out of date, and a supplier who was right would be overruled by a shopkeeper's old note. So the
 * finding names both figures and neither wins.
 */
import { agree, percent, rateFrom } from './resolve.ts';
import type { IsoDate, TaxDefault } from '../../masters/src/types.ts';
import type { Bilingual, RateCrossCheck, RateFinding, RegisterRate } from './types.ts';

const field = (index: number): string => `lines[${index}].gstRateBasisPoints`;

const disagreementFinding = (
  index: number,
  printed: number,
  register: RegisterRate,
): RateFinding => ({
  code: 'GST_RATE_DISAGREES_WITH_REGISTER',
  // Material: a wrong rate is wrong tax, on the bill, on the return and in the books. It is not
  // something to note and carry on past.
  severity: 'MATERIAL',
  field: field(index),
  message: {
    'en-IN':
      `This bill charges ${percent(printed)}, but your records say ${percent(register.gstRateBasisPoints)} `
      + `for this (${register.citation.source}). One of them is wrong.`,
    'hi-IN':
      `इस बिल पर ${percent(printed)} लगा है, पर आपके रिकॉर्ड में इसका ${percent(register.gstRateBasisPoints)} है `
      + `(${register.citation.source})। दोनों में से एक ग़लत है।`,
  },
  documentSays: String(printed),
  registerSays: String(register.gstRateBasisPoints),
});

const conflictedFinding = (index: number, printed: number, candidates: readonly RegisterRate[]): RateFinding => ({
  code: 'GST_RATE_REGISTER_CONFLICTED',
  severity: 'SIGNIFICANT',
  field: field(index),
  message: {
    'en-IN':
      `Your records hold more than one GST rate for this — `
      + `${[...new Set(candidates.map((rate) => percent(rate.gstRateBasisPoints)))].join(' and ')} — `
      + `so the ${percent(printed)} on this bill could not be checked. The records need fixing first.`,
    'hi-IN':
      `आपके रिकॉर्ड में इसके एक से ज़्यादा GST रेट हैं — `
      + `${[...new Set(candidates.map((rate) => percent(rate.gstRateBasisPoints)))].join(' और ')} — `
      + `इसलिए इस बिल का ${percent(printed)} जाँचा नहीं जा सका। पहले रिकॉर्ड ठीक करना होगा।`,
  },
  documentSays: String(printed),
  registerSays: null,
});

const notInRegisterFinding = (index: number, printed: number): RateFinding => ({
  code: 'GST_RATE_NOT_IN_REGISTER',
  // Minor, and it is a finding rather than nothing on purpose: the bill has not been checked, and
  // "we did not check this" must never be shown in the same way as "this is fine".
  severity: 'MINOR',
  field: field(index),
  message: {
    'en-IN':
      `This bill charges ${percent(printed)}. Your records have no rate for this yet, so nothing was checked against it.`,
    'hi-IN':
      `इस बिल पर ${percent(printed)} लगा है। आपके रिकॉर्ड में इसका रेट अभी नहीं है, इसलिए जाँच नहीं हो पाई।`,
  },
  documentSays: String(printed),
  registerSays: null,
});

const agreementMessage = (printed: number, register: RegisterRate): Bilingual => ({
  'en-IN': `${percent(printed)} matches your records (${register.citation.source}).`,
  'hi-IN': `${percent(printed)} आपके रिकॉर्ड से मिलता है (${register.citation.source})।`,
});

export const crossCheck = (input: {
  readonly asOf: IsoDate;
  readonly printedRateBasisPoints: number;
  readonly lineIndex: number;
  readonly entries: readonly { readonly entry: TaxDefault; readonly effectiveFrom: IsoDate }[];
  readonly item: { readonly name: string; readonly hsnSac: string | null } | null;
}): RateCrossCheck => {
  const printed = input.printedRateBasisPoints;
  const base = { asOf: input.asOf, documentSaysBasisPoints: printed } as const;

  if (input.entries.length === 0) {
    return {
      ...base,
      verdict: 'NOT_IN_REGISTER',
      registerSays: null,
      candidates: [],
      message: {
        'en-IN': `Nothing in your records to check ${percent(printed)} against.`,
        'hi-IN': `${percent(printed)} को जाँचने के लिए रिकॉर्ड में कुछ नहीं है।`,
      },
      finding: notInRegisterFinding(input.lineIndex, printed),
    };
  }

  const item = input.entries.filter(({ entry }) => entry.itemId !== undefined);
  const level = item.length > 0 ? item : input.entries;
  const rates = level.map(({ entry, effectiveFrom }) => rateFrom(entry, effectiveFrom, input.item));
  const first = rates[0] as RegisterRate;

  if (!rates.every((rate) => agree(first, rate))) {
    return {
      ...base,
      verdict: 'REGISTER_CONFLICTED',
      registerSays: null,
      candidates: rates,
      message: {
        'en-IN': 'Your records disagree with themselves about this rate, so the bill could not be checked.',
        'hi-IN': 'आपके अपने रिकॉर्ड इस रेट पर एक दूसरे से अलग हैं, इसलिए बिल जाँचा नहीं जा सका।',
      },
      finding: conflictedFinding(input.lineIndex, printed, rates),
    };
  }

  // Only the GST percentage is compared. Cess and reverse charge are shown alongside a suggestion
  // but they are not what the tax column on a bill states, and treating a missing cess column as a
  // rate disagreement would cry wolf on every bill of cess-bearing goods.
  if (first.gstRateBasisPoints === printed) {
    return { ...base, verdict: 'AGREES', registerSays: first, candidates: rates, message: agreementMessage(printed, first), finding: null };
  }

  return {
    ...base,
    verdict: 'DISAGREES',
    registerSays: first,
    candidates: rates,
    message: {
      'en-IN':
        `This bill charges ${percent(printed)}, but your records say ${percent(first.gstRateBasisPoints)}. One of them is wrong.`,
      'hi-IN':
        `इस बिल पर ${percent(printed)} लगा है, पर आपके रिकॉर्ड ${percent(first.gstRateBasisPoints)} कहते हैं। एक ग़लत है।`,
    },
    finding: disagreementFinding(input.lineIndex, printed, first),
  };
};
