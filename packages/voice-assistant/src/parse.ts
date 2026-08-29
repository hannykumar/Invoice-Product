/**
 * Issue #10 [E10] — reading an instruction, and being honest about what was read.
 *
 * The parser is deterministic. It matches words against a lexicon and records, for every field,
 * **what it found, where in the sentence it found it, and how sure it is**. A model may transcribe
 * speech into text; it never decides a quantity, a rate or a customer. That division is the whole
 * design, and it is why every field carries its evidence.
 */
import { MULTIPLIERS, NUMBER_WORDS, RATE_MARKERS, SELL_VERBS, TO_MARKERS, UNIT_WORDS, EXCLUSIVE_WORDS, INCLUSIVE_WORDS, detectLanguage, normaliseDigits, type Language } from './lexicon.ts';

/** Where a value came from. A model-produced value is always shown before it is acted on. */
export type FieldSource = 'DIGITS' | 'WORDS' | 'MODEL' | 'USER_CONFIRMED';

export interface Field<T> {
  readonly value: T | null;
  /** 0 to 1. Below the material threshold, the product asks rather than assumes. */
  readonly confidence: number;
  /** The words this came from, so a person can see why we read it that way. */
  readonly evidence: string;
  readonly source: FieldSource;
  /** Other readings worth offering, most likely first. */
  readonly alternatives: readonly { value: T; confidence: number; evidence: string }[];
}

const field = <T>(
  value: T | null,
  confidence: number,
  evidence: string,
  source: FieldSource,
  alternatives: { value: T; confidence: number; evidence: string }[] = [],
): Field<T> => ({ value, confidence, evidence, source, alternatives });

export const missing = <T>(): Field<T> => field<T>(null, 0, '', 'WORDS');

export interface ParsedLine {
  readonly quantity: Field<string>;
  readonly unit: Field<string>;
  readonly itemText: Field<string>;
  readonly rate: Field<string>;
}

export interface ParsedInstruction {
  readonly language: Language;
  readonly isSale: boolean;
  readonly partyText: Field<string>;
  readonly lines: readonly ParsedLine[];
  readonly priceBasis: Field<'INCLUSIVE' | 'EXCLUSIVE'>;
  /** Exactly what was said or typed. Evidence, never the source of truth. */
  readonly transcript: string;
}

const tokenise = (text: string): string[] =>
  normaliseDigits(text)
    .replace(/[₹]/g, ' ₹ ')
    .replace(/@/g, ' @ ')
    .replace(/[,.;!?]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);

const isDigits = (token: string): boolean => /^\d+$/.test(token);

/**
 * Reads a run of number words: "aath sau" is 800, "do hazaar paanch sau" is 2,500.
 *
 * Returns `null` rather than a partial reading, because half-understanding a price is worse than
 * admitting we did not understand it.
 */
export const readNumber = (
  tokens: readonly string[],
  start: number,
): { value: number; end: number; source: FieldSource; evidence: string } | null => {
  let i = start;
  let total = 0;
  let current = 0;
  let sawAny = false;
  let sawWord = false;
  const used: string[] = [];

  while (i < tokens.length) {
    const token = (tokens[i] as string).toLowerCase();
    if (isDigits(token)) {
      if (sawAny && !sawWord) break;
      current += Number(token);
      sawAny = true;
      used.push(token);
      i += 1;
      continue;
    }
    const digitValue = NUMBER_WORDS[token];
    if (digitValue !== undefined) {
      current += digitValue;
      sawAny = true;
      sawWord = true;
      used.push(token);
      i += 1;
      continue;
    }
    const multiplier = MULTIPLIERS[token];
    if (multiplier !== undefined && sawAny) {
      if (multiplier >= 1000) {
        total += (current === 0 ? 1 : current) * multiplier;
        current = 0;
      } else {
        current = (current === 0 ? 1 : current) * multiplier;
      }
      sawWord = true;
      used.push(token);
      i += 1;
      continue;
    }
    break;
  }

  if (!sawAny) return null;
  return {
    value: total + current,
    end: i,
    // A digit typed by a person is not the same as a word we matched; both are recorded as such.
    source: sawWord ? 'WORDS' : 'DIGITS',
    evidence: used.join(' '),
  };
};

const CONFIDENCE = {
  digits: 1,
  words: 0.95,
  /** A customer or item name is only ever a guess at this stage; #5 resolves it properly. */
  nameGuess: 0.6,
  basisStated: 0.95,
  /** Nobody said whether the rate includes tax. That is a question, not a default. */
  basisUnstated: 0.3,
} as const;

/**
 * Parses one sale instruction.
 *
 * Deliberately conservative: it recognises "sell <qty> <unit> <item> to <party> at <rate>" and the
 * Hindi word order "<party> ko <qty> <unit> <item> <rate> per <unit> becho", and refuses the rest
 * rather than improvising.
 */
export const parseInstruction = (text: string): ParsedInstruction => {
  const tokens = tokenise(text);
  const lower = tokens.map((t) => t.toLowerCase());
  const language = detectLanguage(text);
  const isSale = lower.some((t) => SELL_VERBS.includes(t));

  // Price basis: only when someone actually said so.
  let priceBasis: Field<'INCLUSIVE' | 'EXCLUSIVE'> = field<'INCLUSIVE' | 'EXCLUSIVE'>(
    null,
    CONFIDENCE.basisUnstated,
    '',
    'WORDS',
  );
  const inclusiveAt = lower.findIndex((t) => INCLUSIVE_WORDS.includes(t));
  const exclusiveAt = lower.findIndex((t) => EXCLUSIVE_WORDS.includes(t));
  if (inclusiveAt >= 0 && exclusiveAt < 0) {
    priceBasis = field('INCLUSIVE', CONFIDENCE.basisStated, lower[inclusiveAt] as string, 'WORDS');
  } else if (exclusiveAt >= 0 && inclusiveAt < 0) {
    priceBasis = field('EXCLUSIVE', CONFIDENCE.basisStated, lower[exclusiveAt] as string, 'WORDS');
  } else if (inclusiveAt >= 0 && exclusiveAt >= 0) {
    // Both said. That is a contradiction, not a preference.
    priceBasis = field<'INCLUSIVE' | 'EXCLUSIVE'>(null, 0, `${lower[inclusiveAt]} / ${lower[exclusiveAt]}`, 'WORDS');
  }

  // The customer: "to ABC Traders" in English, "ABC ko" in Hindi.
  let partyText = missing<string>();
  const toAt = lower.findIndex((t) => TO_MARKERS.includes(t));
  if (toAt >= 0) {
    const isHindiMarker = lower[toAt] === 'ko';
    const words = isHindiMarker
      ? // "ABC Traders ko" — the name is what comes before.
        tokens.slice(Math.max(0, toAt - 3), toAt).filter((t) => !isDigits(t) && !(t.toLowerCase() in UNIT_WORDS))
      : // "to ABC Traders" — the name is what follows, until a number or a known word.
        (() => {
          const collected: string[] = [];
          for (let i = toAt + 1; i < tokens.length; i += 1) {
            const t = tokens[i] as string;
            const l = t.toLowerCase();
            if (isDigits(t) || l in NUMBER_WORDS || l in UNIT_WORDS || RATE_MARKERS.includes(l) || SELL_VERBS.includes(l)) break;
            collected.push(t);
          }
          return collected;
        })();
    if (words.length > 0) {
      partyText = field(words.join(' '), CONFIDENCE.nameGuess, words.join(' '), 'WORDS');
    }
  }

  // Quantity, unit, item and rate. One line for now: multi-line dictation is a later wave.
  let quantity = missing<string>();
  let unit = missing<string>();
  let itemText = missing<string>();
  let rate = missing<string>();

  let index = 0;
  const itemWords: string[] = [];
  let rateSeen = false;

  while (index < tokens.length) {
    const token = tokens[index] as string;
    const l = token.toLowerCase();

    if (CURRENCY_MARKER(l)) {
      index += 1;
      continue;
    }

    const number = readNumber(tokens, index);
    if (number !== null) {
      const confidence = number.source === 'DIGITS' ? CONFIDENCE.digits : CONFIDENCE.words;
      const afterIndex = number.end;
      const after = (tokens[afterIndex] ?? '').toLowerCase();
      const before = (tokens[index - 1] ?? '').toLowerCase();
      const looksLikeRate = rateSeen || RATE_MARKERS.includes(before) || before === '₹' || CURRENCY_MARKER(before);

      if (looksLikeRate && rate.value === null) {
        rate = field(String(number.value), confidence, number.evidence, number.source);
        rateSeen = false;
      } else if (quantity.value === null) {
        quantity = field(String(number.value), confidence, number.evidence, number.source);
        const unitCode = UNIT_WORDS[after];
        if (unitCode !== undefined) {
          unit = field(unitCode, CONFIDENCE.digits, after, 'WORDS');
        }
      } else if (rate.value === null) {
        rate = field(String(number.value), confidence, number.evidence, number.source);
      }
      index = number.end;
      continue;
    }

    if (RATE_MARKERS.includes(l) || l === '@') {
      rateSeen = true;
      index += 1;
      continue;
    }
    if (l in UNIT_WORDS) {
      if (unit.value === null) unit = field(UNIT_WORDS[l] as string, CONFIDENCE.digits, l, 'WORDS');
      index += 1;
      continue;
    }
    if (SELL_VERBS.includes(l) || TO_MARKERS.includes(l) || INCLUSIVE_WORDS.includes(l) || EXCLUSIVE_WORDS.includes(l)) {
      index += 1;
      continue;
    }
    // Anything left that is not part of the customer's name is part of the item's name.
    if (partyText.value === null || !partyText.value.toLowerCase().split(' ').includes(l)) {
      itemWords.push(token);
    }
    index += 1;
  }

  if (itemWords.length > 0) {
    const joined = itemWords.join(' ');
    itemText = field(joined, CONFIDENCE.nameGuess, joined, 'WORDS');
  }

  return {
    language,
    isSale,
    partyText,
    lines: [{ quantity, unit, itemText, rate }],
    priceBasis,
    transcript: text,
  };
};

const CURRENCY_MARKER = (token: string): boolean =>
  token === '₹' || token === 'rs' || token === 'rupees' || token === 'rupee' || token === 'rupaye' || token === 'rupay';

/**
 * Folds several transcriptions of the same speech into one reading.
 *
 * When the readings disagree about a field — the seventeen-or-seventy problem — the disagreement
 * is kept as alternatives and the confidence drops to what the top reading actually earned. That
 * is what turns an ambiguity into a question instead of a coin toss.
 */
export const mergeAlternatives = (
  readings: readonly { parsed: ParsedInstruction; confidence: number }[],
): ParsedInstruction => {
  const first = readings[0];
  if (first === undefined) throw new Error('mergeAlternatives needs at least one reading');
  if (readings.length === 1) return withSource(first.parsed, first.confidence);

  const base = first.parsed;
  /**
   * Uncertainty belongs to the field it is about.
   *
   * A provider's confidence is about the whole utterance, but the doubt is usually in one word.
   * When every reading agrees a rate was "800", the rate is not what the provider was unsure of,
   * and dragging it below the bar would make someone re-confirm the customer, the item and the
   * rate to fix a quantity. So agreement keeps the parser's own confidence, and only a genuine
   * disagreement drops to what the top reading actually earned.
   */
  const mergeField = <T>(pick: (p: ParsedInstruction) => Field<T>): Field<T> => {
    const top = pick(base);
    const others = readings.slice(1).map((r) => ({ f: pick(r.parsed), c: r.confidence }));
    const differing = others.filter((o) => o.f.value !== null && o.f.value !== top.value);
    if (differing.length === 0) return top.value === null ? top : { ...top, source: 'MODEL' };
    return {
      ...top,
      confidence: Math.min(top.confidence, first.confidence),
      source: 'MODEL',
      alternatives: differing.map((o) => ({
        value: o.f.value as T,
        confidence: o.c,
        evidence: o.f.evidence,
      })),
    };
  };

  const line = base.lines[0] as ParsedLine;
  return {
    ...base,
    partyText: mergeField((p) => p.partyText),
    priceBasis: mergeField((p) => p.priceBasis),
    lines: [
      {
        quantity: mergeField((p) => (p.lines[0] as ParsedLine).quantity),
        unit: mergeField((p) => (p.lines[0] as ParsedLine).unit),
        itemText: mergeField((p) => (p.lines[0] as ParsedLine).itemText),
        rate: mergeField((p) => (p.lines[0] as ParsedLine).rate),
      },
    ],
    transcript: line === undefined ? base.transcript : base.transcript,
  };
};

/**
 * Marks every field as model-produced and caps its confidence at the transcription's.
 *
 * Used when there is only one reading: with nothing to compare against, the provider's doubt is
 * all we know, so it applies to everything it produced.
 */
const withSource = (parsed: ParsedInstruction, confidence: number): ParsedInstruction => {
  const cap = <T>(f: Field<T>): Field<T> =>
    f.value === null ? f : { ...f, confidence: Math.min(f.confidence, confidence), source: 'MODEL' };
  const line = parsed.lines[0] as ParsedLine;
  return {
    ...parsed,
    partyText: cap(parsed.partyText),
    priceBasis: cap(parsed.priceBasis),
    lines: [{ quantity: cap(line.quantity), unit: cap(line.unit), itemText: cap(line.itemText), rate: cap(line.rate) }],
  };
};
