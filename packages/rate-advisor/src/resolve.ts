/**
 * Issue #59 [E59] — turning register entries into an answer, or into a question.
 *
 * Pure: entries in, advice out. No clock, no storage, no network. The date it resolves as of is
 * handed to it, which is what makes the back-dated-document test possible to write and impossible
 * to get accidentally right.
 *
 * The interesting logic is not the matching — item beats HSN, and that is one line. It is deciding
 * when *not* to answer, and there are three of those: nothing matched, several things matched and
 * disagreed, and something matched but only because a model guessed what the goods were.
 */
import { formatINR } from '@invoice/kernel';
import type { Id, IsoDate, TaxDefault } from '../../masters/src/types.ts';
import type {
  Bilingual, ProposedClassification, RateAdvice, RateSubject, RegisterRate,
} from './types.ts';

/** A percentage a person can read. 1800 basis points is "18%"; 250 is "2.5%". */
export const percent = (basisPoints: number): string => {
  const whole = Math.trunc(basisPoints / 100);
  const fraction = Math.abs(basisPoints % 100);
  return fraction === 0 ? `${whole}%` : `${whole}.${fraction.toString().padStart(2, '0').replace(/0$/, '')}%`;
};

const subjectOf = (
  entry: TaxDefault,
  item: { readonly name: string; readonly hsnSac: string | null } | null,
): RateSubject =>
  entry.itemId !== undefined
    ? { kind: 'ITEM', itemId: entry.itemId, itemName: item?.name ?? null, hsnSac: item?.hsnSac ?? null }
    : { kind: 'HSN', hsnSac: entry.hsnSac ?? '', describedAs: item?.name ?? null };

/**
 * One register entry as a rate this module can talk about.
 *
 * `effectiveFrom` comes from the register row's own effective date, which the registry port
 * supplies alongside the entry — an entry with no effective date is not evidence of anything, and
 * the port is expected to refuse rather than pass one on.
 */
export const rateFrom = (
  entry: TaxDefault,
  effectiveFrom: IsoDate,
  item: { readonly name: string; readonly hsnSac: string | null } | null,
): RegisterRate => ({
  gstRateBasisPoints: entry.gstRateBasisPoints,
  ...(entry.cessRateBasisPoints === undefined ? {} : { cessRateBasisPoints: entry.cessRateBasisPoints }),
  ...(entry.cessPerUnitPaise === undefined ? {} : { cessPerUnitPaise: entry.cessPerUnitPaise }),
  reverseCharge: entry.reverseCharge,
  basis: entry.itemId !== undefined ? 'ITEM_DEFAULT' : 'HSN_DEFAULT',
  subject: subjectOf(entry, item),
  citation: { source: entry.source, effectiveFrom, registerEntryId: entry.id },
});

/** Two entries agree when every figure a bill depends on is the same. Cess included. */
export const agree = (left: RegisterRate, right: RegisterRate): boolean =>
  left.gstRateBasisPoints === right.gstRateBasisPoints &&
  (left.cessRateBasisPoints ?? 0) === (right.cessRateBasisPoints ?? 0) &&
  (left.cessPerUnitPaise ?? 0n) === (right.cessPerUnitPaise ?? 0n) &&
  left.reverseCharge === right.reverseCharge;

/**
 * A citation, ready to sit inside a sentence.
 *
 * Register sources are written as standalone sentences and often end in a full stop, which reads as
 * "per Notification 1/2017-CTR., in force from…" once it is quoted mid-sentence. The stop is
 * trimmed for display only; what is stored is untouched.
 */
const cite = (source: string): string => source.trim().replace(/\.$/, '');

const describeSubject = (subject: RateSubject, hi: boolean): string =>
  subject.kind === 'ITEM'
    ? `${subject.itemName ?? (hi ? 'यह आइटम' : 'this item')}${subject.hsnSac === null ? '' : ` (HSN ${subject.hsnSac})`}`
    : `HSN ${subject.hsnSac}${subject.describedAs === null ? '' : `, ${subject.describedAs}`}`;

/** The extra clause a rate with cess or reverse charge needs, so a suggestion never under-bills. */
const extras = (rate: RegisterRate, hi: boolean): string => {
  const parts: string[] = [];
  if (rate.cessRateBasisPoints !== undefined && rate.cessRateBasisPoints > 0) {
    parts.push(hi ? `और ${percent(rate.cessRateBasisPoints)} की दर से सेस` : `plus cess at ${percent(rate.cessRateBasisPoints)}`);
  }
  if (rate.cessPerUnitPaise !== undefined && rate.cessPerUnitPaise > 0n) {
    parts.push(hi
      ? `और हर यूनिट पर ${formatINR({ currency: 'INR', minor: rate.cessPerUnitPaise })} का सेस`
      : `plus cess of ${formatINR({ currency: 'INR', minor: rate.cessPerUnitPaise })} a unit`);
  }
  if (rate.reverseCharge) {
    parts.push(hi
      ? 'और इसका टैक्स ख़रीदने वाला देता है, सप्लायर नहीं वसूलता'
      : 'and the tax on this is paid by the buyer, not charged by the supplier');
  }
  return parts.length === 0 ? '' : ` — ${parts.join(', ')}`;
};

export const reasonFor = (rate: RegisterRate, asOf: IsoDate): Bilingual => ({
  'en-IN':
    `${percent(rate.gstRateBasisPoints)} — because this is ${describeSubject(rate.subject, false)}, `
    + `per ${cite(rate.citation.source)}, in force from ${rate.citation.effectiveFrom} and on ${asOf}${extras(rate, false)}.`,
  'hi-IN':
    `${percent(rate.gstRateBasisPoints)} — क्योंकि यह ${describeSubject(rate.subject, true)} है, `
    + `${cite(rate.citation.source)} के अनुसार, जो ${rate.citation.effectiveFrom} से लागू है${extras(rate, true)}।`,
});

const askToUse = (rate: RegisterRate): Bilingual => ({
  'en-IN': `Use ${percent(rate.gstRateBasisPoints)}?`,
  'hi-IN': `${percent(rate.gstRateBasisPoints)} लगाइए?`,
});

/**
 * The resolution itself.
 *
 * Item-level entries are considered first and, when they agree with each other, answer. Only if
 * there are none does it fall to the HSN, which is the ordinary case for goods nobody has set up
 * yet. Entries that disagree never resolve at either level — a register holding both 18% and 28%
 * for one code is a register with a mistake in it, and picking one would bury the mistake in a bill.
 */
export const resolve = (input: {
  readonly asOf: IsoDate;
  readonly entries: readonly { readonly entry: TaxDefault; readonly effectiveFrom: IsoDate }[];
  readonly item: { readonly name: string; readonly hsnSac: string | null } | null;
  readonly hadSomethingToMatchOn: boolean;
  readonly proposed?: ProposedClassification;
}): RateAdvice => {
  const proposal = input.proposed;
  // A model's reading of what the goods are is a starting point, not a fact. Until a person has
  // confirmed it, no figure may rest on it — so the question is asked before the rate is offered,
  // not after.
  if (proposal !== undefined && proposal.confirmedBy === undefined) {
    return {
      kind: 'ASK',
      reason: 'CLASSIFICATION_UNCONFIRMED',
      candidates: input.entries.map(({ entry, effectiveFrom }) => rateFrom(entry, effectiveFrom, input.item)),
      question: {
        'en-IN':
          `We read "${proposal.fromText}" as ${proposal.hsnSac === undefined ? 'an item in your list' : `HSN ${proposal.hsnSac}`}. `
          + 'That was worked out by the app, not read off the bill. Is it right?',
        'hi-IN':
          `हमने "${proposal.fromText}" को ${proposal.hsnSac === undefined ? 'आपकी सूची का आइटम' : `HSN ${proposal.hsnSac}`} समझा। `
          + 'यह ऐप ने सोचा है, बिल पर लिखा नहीं था। क्या यह सही है?',
      },
      whatWouldHelp: {
        'en-IN': 'Confirm what these goods are, and the rate for them follows from your register.',
        'hi-IN': 'बताइए यह सामान क्या है, फिर रेट आपके रजिस्टर से आ जाएगा।',
      },
      awaitingConfirmationOf: proposal,
    };
  }

  if (input.entries.length === 0) {
    return {
      kind: 'ASK',
      reason: input.hadSomethingToMatchOn ? 'NO_ENTRY' : 'NOTHING_TO_MATCH_ON',
      candidates: [],
      question: input.hadSomethingToMatchOn
        ? {
          'en-IN': 'Your records do not have a GST rate for this yet. What rate should it use?',
          'hi-IN': 'आपके रिकॉर्ड में इसका GST रेट अभी नहीं है। कौनसा रेट लगाना चाहिए?',
        }
        : {
          'en-IN': 'We could not tell what these goods are, so there is nothing to look the rate up by. What are they?',
          'hi-IN': 'यह सामान क्या है, यह समझ नहीं आया, इसलिए रेट ढूंढने का कोई ज़रिया नहीं। यह क्या है?',
        },
      whatWouldHelp: input.hadSomethingToMatchOn
        ? {
          'en-IN': 'Set a rate for this item or its HSN code once, and every later bill will use it.',
          'hi-IN': 'इस आइटम या इसके HSN का रेट एक बार सेट कर दीजिए, आगे के सभी बिल उसे लेंगे।',
        }
        : {
          'en-IN': 'Add the HSN code from the bill, or pick the item from your list.',
          'hi-IN': 'बिल से HSN कोड भरिए, या अपनी सूची से आइटम चुनिए।',
        },
    };
  }

  const item = input.entries.filter(({ entry }) => entry.itemId !== undefined);
  const hsn = input.entries.filter(({ entry }) => entry.itemId === undefined);
  const level = item.length > 0 ? item : hsn;
  const rates = level.map(({ entry, effectiveFrom }) => rateFrom(entry, effectiveFrom, input.item));
  const first = rates[0] as RegisterRate;

  if (!rates.every((rate) => agree(first, rate))) {
    return {
      kind: 'ASK',
      reason: 'CONFLICTING_ENTRIES',
      candidates: rates,
      question: {
        'en-IN':
          `Your records hold ${rates.length} different GST rates for this — `
          + `${[...new Set(rates.map((rate) => percent(rate.gstRateBasisPoints)))].join(' and ')}. Which one is right?`,
        'hi-IN':
          `आपके रिकॉर्ड में इसके लिए ${rates.length} अलग GST रेट हैं — `
          + `${[...new Set(rates.map((rate) => percent(rate.gstRateBasisPoints)))].join(' और ')}। सही कौनसा है?`,
      },
      whatWouldHelp: {
        'en-IN': 'Remove the entries that are wrong, so there is one answer for this in your records.',
        'hi-IN': 'ग़लत एंट्री हटा दीजिए, ताकि रिकॉर्ड में इसका एक ही जवाब रहे।',
      },
    };
  }

  return {
    kind: 'SUGGESTED',
    suggestion: {
      rate: first,
      asOf: input.asOf,
      reason: reasonFor(first, input.asOf),
      question: askToUse(first),
      ...(proposal === undefined ? {} : { restingOn: proposal }),
    },
  };
};
