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

const describeSubject = (subject: RateSubject): string =>
  subject.kind === 'ITEM'
    ? `${subject.itemName ?? 'this item'}${subject.hsnSac === null ? '' : ` (HSN ${subject.hsnSac})`}`
    : `HSN ${subject.hsnSac}${subject.describedAs === null ? '' : `, ${subject.describedAs}`}`;

/** The extra clause a rate with cess or reverse charge needs, so a suggestion never under-bills. */
const extras = (rate: RegisterRate): string => {
  const parts: string[] = [];
  if (rate.cessRateBasisPoints !== undefined && rate.cessRateBasisPoints > 0) {
    parts.push(`plus cess at ${percent(rate.cessRateBasisPoints)}`);
  }
  if (rate.cessPerUnitPaise !== undefined && rate.cessPerUnitPaise > 0n) {
    parts.push(`plus cess of ₹${(Number(rate.cessPerUnitPaise) / 100).toFixed(2)} a unit`);
  }
  if (rate.reverseCharge) {
    parts.push('and the tax on this is paid by the buyer, not charged by the supplier');
  }
  return parts.length === 0 ? '' : ` — ${parts.join(', ')}`;
};

export const reasonFor = (rate: RegisterRate, asOf: IsoDate): Bilingual => ({
  'en-IN':
    `${percent(rate.gstRateBasisPoints)} — because this is ${describeSubject(rate.subject)}, `
    + `per ${cite(rate.citation.source)}, in force from ${rate.citation.effectiveFrom} and on ${asOf}${extras(rate)}.`,
  'hi-IN':
    `${percent(rate.gstRateBasisPoints)} — kyunki yeh ${describeSubject(rate.subject)} hai, `
    + `${cite(rate.citation.source)} ke anusaar, jo ${rate.citation.effectiveFrom} se laagu hai${extras(rate)}.`,
});

const askToUse = (rate: RegisterRate): Bilingual => ({
  'en-IN': `Use ${percent(rate.gstRateBasisPoints)}?`,
  'hi-IN': `${percent(rate.gstRateBasisPoints)} lagayein?`,
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
          `Humne "${proposal.fromText}" ko ${proposal.hsnSac === undefined ? 'aapki suchi ka item' : `HSN ${proposal.hsnSac}`} samjha. `
          + 'Yeh app ne socha hai, bill par likha nahi tha. Kya yeh sahi hai?',
      },
      whatWouldHelp: {
        'en-IN': 'Confirm what these goods are, and the rate for them follows from your register.',
        'hi-IN': 'Bataiye yeh saamaan kya hai, phir rate aapke register se aa jaayega.',
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
          'hi-IN': 'Aapke record mein iska GST rate abhi nahi hai. Kaunsa rate lagana chahiye?',
        }
        : {
          'en-IN': 'We could not tell what these goods are, so there is nothing to look the rate up by. What are they?',
          'hi-IN': 'Yeh saamaan kya hai, yeh samajh nahi aaya, isliye rate dhoondhne ka koi zariya nahi. Yeh kya hai?',
        },
      whatWouldHelp: input.hadSomethingToMatchOn
        ? {
          'en-IN': 'Set a rate for this item or its HSN code once, and every later bill will use it.',
          'hi-IN': 'Is item ya iske HSN ka rate ek baar set kar dein, aage ke sabhi bill use lenge.',
        }
        : {
          'en-IN': 'Add the HSN code from the bill, or pick the item from your list.',
          'hi-IN': 'Bill se HSN code bharein, ya apni suchi se item chunein.',
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
          `Aapke record mein iske liye ${rates.length} alag GST rate hain — `
          + `${[...new Set(rates.map((rate) => percent(rate.gstRateBasisPoints)))].join(' aur ')}. Sahi kaunsa hai?`,
      },
      whatWouldHelp: {
        'en-IN': 'Remove the entries that are wrong, so there is one answer for this in your records.',
        'hi-IN': 'Galat entry hata dein, taaki record mein iska ek hi jawaab rahe.',
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
