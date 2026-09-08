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
      `Is bill par ${percent(printed)} laga hai, par aapke record mein iska ${percent(register.gstRateBasisPoints)} hai `
      + `(${register.citation.source}). Dono mein se ek galat hai.`,
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
      `Aapke record mein iske ek se zyaada GST rate hain — `
      + `${[...new Set(candidates.map((rate) => percent(rate.gstRateBasisPoints)))].join(' aur ')} — `
      + `isliye is bill ka ${percent(printed)} jaancha nahi ja saka. Pehle record theek karna hoga.`,
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
      `Is bill par ${percent(printed)} laga hai. Aapke record mein iska rate abhi nahi hai, isliye jaanch nahi ho payi.`,
  },
  documentSays: String(printed),
  registerSays: null,
});

const agreementMessage = (printed: number, register: RegisterRate): Bilingual => ({
  'en-IN': `${percent(printed)} matches your records (${register.citation.source}).`,
  'hi-IN': `${percent(printed)} aapke record se milta hai (${register.citation.source}).`,
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
        'hi-IN': `${percent(printed)} ko jaanchne ke liye record mein kuch nahi hai.`,
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
        'hi-IN': 'Aapke apne record is rate par ek doosre se alag hain, isliye bill jaancha nahi ja saka.',
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
        `Is bill par ${percent(printed)} laga hai, par aapke record ${percent(first.gstRateBasisPoints)} kehte hain. Ek galat hai.`,
    },
    finding: disagreementFinding(input.lineIndex, printed, first),
  };
};
