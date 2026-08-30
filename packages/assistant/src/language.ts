/**
 * Issue #34 [E34] — reading the question, without letting the question read us.
 *
 * Understanding here is a lexicon and a set of patterns, in the same spirit as the voice assistant
 * (#10): matching words against a table can be tested, corrected and explained, and it cannot be
 * talked into doing something else. That last part matters more here than anywhere, because the
 * text arrives from a person and may contain anything at all — including a sentence telling the
 * product to ignore its rules. **Nothing in a question can change what data is fetched or whose it
 * is**: the intent is chosen from this table, the company comes from the authenticated actor, and
 * the permissions come from the platform.
 *
 * A model may be plugged in behind `QuestionUnderstandingPort` to suggest an intent when the table
 * finds nothing. Its suggestion is accepted only if it names an intent that already exists here,
 * and it can never supply a number, a period or a company.
 */
import { detectLanguage, normaliseDigits, type Language } from '../../voice-assistant/src/lexicon.ts';
import type { Intent } from './model.ts';

export interface Slots {
  /** Words that look like an item name, for a stock question. */
  readonly itemText: string | null;
  /** Words that look like a customer or supplier name. */
  readonly partyText: string | null;
  /** A document number such as INV-1042, for "why is this blocked?". */
  readonly documentRef: string | null;
  /** The compliance topic a question is about, when it maps to one we hold rules for. */
  readonly topic: string | null;
}

export interface Understanding {
  readonly intent: Intent;
  /** 0 to 1. Below `ASK_INSTEAD`, the assistant asks what was meant rather than answering. */
  readonly confidence: number;
  /** The words the intent was read from, so the person can see why we answered what we did. */
  readonly evidence: string;
  readonly language: Language;
  readonly slots: Slots;
  /** Intents that also matched, best first. Shown when we have to ask. */
  readonly alternatives: readonly Intent[];
}

/** Below this the assistant asks rather than assumes. Same idea as #10's material threshold. */
export const ASK_INSTEAD = 0.55;

interface IntentPattern {
  readonly intent: Intent;
  /** Each entry is a set of words; a phrase matches when every word in the set is present. */
  readonly phrases: readonly (readonly string[])[];
  readonly weight?: number;
}

/**
 * The table.
 *
 * Hindi is in Latin script because that is how people type on a phone, exactly as #10's lexicon is.
 */
const PATTERNS: readonly IntentPattern[] = [
  {
    intent: 'MONEY_OWED_TO_ME',
    phrases: [
      ['who', 'owes'], ['owes', 'me'], ['money', 'owed', 'to', 'me'], ['customers', 'owe'],
      ['outstanding'], ['receivable'], ['receivables'], ['collect'], ['collections'], ['udhaar'],
      ['baki', 'lena'],
      ['kisse', 'lena'], ['lena', 'hai'], ['vasooli'], ['paisa', 'aana'],
    ],
  },
  {
    intent: 'MONEY_I_OWE',
    phrases: [
      ['i', 'owe'], ['we', 'owe'], ['owe', 'suppliers'], ['payable'], ['payables'],
      ['dena', 'hai'], ['kisko', 'dena'], ['supplier', 'baki'],
    ],
  },
  {
    intent: 'SALES_IN_PERIOD',
    phrases: [
      ['how', 'much', 'sold'], ['how', 'much', 'sell'], ['sales'], ['sale'], ['sold'], ['sell'],
      ['selling'], ['revenue'], ['turnover'], ['billed'], ['bikri'], ['becha'], ['bechi'],
      ['kitna', 'becha'],
    ],
  },
  {
    intent: 'PURCHASES_IN_PERIOD',
    phrases: [
      ['purchases'], ['purchase'], ['bought'], ['buy'], ['purchase', 'bills'], ['supplier', 'bills'],
      ['kharid'], ['khareeda'], ['kitna', 'khareeda'],
    ],
  },
  {
    intent: 'PROFIT_IN_PERIOD',
    phrases: [
      ['profit'], ['loss'], ['earn'], ['earned'], ['earning'], ['made', 'money'], ['make', 'money'],
      ['making', 'money'], ['munafa'], ['nafa'], ['kamaya'], ['kitna', 'bacha'], ['fayda'],
    ],
  },
  {
    intent: 'WHAT_I_OWN',
    phrases: [
      ['balance', 'sheet'], ['what', 'do', 'i', 'own'], ['assets'], ['net', 'worth'],
      ['business', 'ke', 'paas'], ['sampatti'],
    ],
  },
  {
    intent: 'STOCK_POSITION',
    phrases: [
      ['stock'], ['how', 'many', 'left'], ['inventory'], ['godown'], ['maal'], ['kitna', 'bacha', 'hai'],
      ['stock', 'kitna'], ['bacha', 'hua', 'maal'],
    ],
  },
  {
    intent: 'GST_IN_PERIOD',
    phrases: [
      ['gst', 'collected'], ['gst', 'paid'], ['how', 'much', 'gst'], ['input', 'credit'],
      ['gst', 'kitna'], ['gst', 'summary'], ['tax', 'collected'],
    ],
  },
  {
    intent: 'NEEDS_ATTENTION',
    phrases: [
      ['needs', 'attention'], ['what', 'should', 'i', 'look', 'at'], ['problems'], ['anything', 'wrong'],
      ['dhyan', 'dena'], ['kya', 'galat'], ['kya', 'dekhna'],
    ],
  },
  {
    intent: 'WHY_BLOCKED',
    phrases: [
      ['why', 'blocked'], ['why', 'is', 'this', 'blocked'], ['cannot', 'issue'], ['not', 'letting', 'me'],
      ['why', 'stuck'], ['blocked'], ['kyun', 'ruka'], ['ruk', 'gaya'], ['band', 'kyun'],
    ],
    weight: 1.15,
  },
  {
    intent: 'COMPLIANCE_QUESTION',
    phrases: [
      ['do', 'i', 'need'], ['e', 'way', 'bill'], ['eway', 'bill'], ['e-way'], ['is', 'it', 'required'],
      ['rule'], ['allowed'], ['reverse', 'charge'], ['place', 'of', 'supply'], ['e', 'invoice'],
      ['einvoice'], ['irn'], ['zaroori', 'hai', 'kya'], ['niyam'], ['kanoon'],
    ],
  },
];

/**
 * Compliance topics we hold rules for, the words that point at each, and how each is said to a
 * shopkeeper. The label matters: a rule id belongs in an audit trail, never in a sentence somebody
 * has to read.
 */
const TOPICS: readonly { readonly topic: string; readonly label: string; readonly words: readonly string[] }[] = [
  { topic: 'gst.place_of_supply', label: 'which state a sale counts in', words: ['place of supply', 'which state', 'interstate', 'inter state', 'igst or cgst'] },
  { topic: 'gst.tax_split', label: 'which kind of GST applies', words: ['cgst', 'sgst', 'igst', 'tax split', 'which tax'] },
  { topic: 'gst.eway.applicability', label: 'whether an e-way bill is needed', words: ['e way bill', 'eway bill', 'e-way', 'eway', 'transport limit'] },
  { topic: 'gst.einvoice.applicability', label: 'whether an e-invoice is needed', words: ['e invoice', 'e-invoice', 'einvoice', 'irn'] },
  { topic: 'gst.composition.charging', label: 'whether GST may be charged on the bill', words: ['composition', 'composition scheme'] },
];

/** How a topic is named in a sentence. Falls back to the id turned into words. */
export const labelForTopic = (topic: string): string =>
  TOPICS.find((candidate) => candidate.topic === topic)?.label ?? topic.replace(/^gst\./, '').replace(/[._]/g, ' ');

const DOCUMENT_REF = /\b([A-Z]{2,6}[-/][A-Z0-9-/]{2,20})\b/;

const tokenise = (question: string): string[] =>
  normaliseDigits(question)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0);

const phraseMatches = (tokens: readonly string[], phrase: readonly string[]): boolean =>
  phrase.every((word) => tokens.includes(word));

/** The words after "of", "for" or "ka", which is where an item or a party name usually sits. */
const nameAfter = (question: string, markers: readonly string[]): string | null => {
  const lowered = question.toLowerCase();
  for (const marker of markers) {
    const at = lowered.indexOf(` ${marker} `);
    if (at === -1) continue;
    const rest = question
      .slice(at + marker.length + 2)
      .replace(/[?.!]/g, ' ')
      .replace(/\b(left|remaining|bacha|hai|do|hain|now|today)\b/gi, ' ')
      .trim();
    if (rest !== '') return rest.replace(/\s+/g, ' ');
  }
  return null;
};

/**
 * Reads a question.
 *
 * Every intent that matches contributes its strongest phrase; the winner is the highest score, and
 * a tie leaves the confidence low so the assistant asks instead of picking one.
 */
export const understand = (question: string): Understanding => {
  const tokens = tokenise(question);
  const language = detectLanguage(question);

  const scored = PATTERNS.map((pattern) => {
    let best = 0;
    let evidence = '';
    for (const phrase of pattern.phrases) {
      if (!phraseMatches(tokens, phrase)) continue;
      // A longer phrase is a stronger signal than a single word: "how much gst" beats "gst".
      const score = (0.55 + Math.min(phrase.length, 4) * 0.12) * (pattern.weight ?? 1);
      if (score > best) {
        best = score;
        evidence = phrase.join(' ');
      }
    }
    return { intent: pattern.intent, score: Math.min(best, 1), evidence };
  })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);

  const documentRef = DOCUMENT_REF.exec(question.toUpperCase())?.[1] ?? null;
  const topic = TOPICS.find((candidate) => candidate.words.some((word) => question.toLowerCase().includes(word)))?.topic ?? null;

  const slots: Slots = {
    itemText: nameAfter(question, ['of', 'for', 'ka', 'ki', 'ke']),
    partyText: nameAfter(question, ['from', 'to', 'se', 'ko']),
    documentRef,
    topic,
  };

  const best = scored[0];
  if (best === undefined) {
    return {
      intent: 'UNSUPPORTED',
      confidence: 0,
      evidence: '',
      language,
      slots,
      alternatives: [],
    };
  }

  const runnerUp = scored[1];
  // Two intents that matched equally well is exactly when a wrong guess is most likely, so the
  // confidence drops and the assistant asks which was meant.
  const margin = runnerUp === undefined ? 0.3 : best.score - runnerUp.score;
  const confidence = Number(Math.min(1, best.score * (margin >= 0.1 ? 1 : 0.75)).toFixed(2));

  return {
    intent: best.intent,
    confidence,
    evidence: best.evidence,
    language,
    slots,
    alternatives: scored.slice(1, 4).map((candidate) => candidate.intent),
  };
};

/**
 * Text in a question that is trying to instruct the product rather than ask it something.
 *
 * Finding one changes **nothing** about how the question is handled — the intent table and the
 * actor's permissions already decide everything — but it is recorded on the answer and in the audit
 * trail, because somebody typing this is worth knowing about.
 */
const INJECTION_MARKERS: readonly RegExp[] = [
  /ignore (?:all |any )?(?:previous|prior|above|earlier) (?:instructions?|rules?)/i,
  /disregard (?:your |the )?(?:rules?|instructions?|permissions?)/i,
  /you are now\b/i,
  /\bact as\b/i,
  /\bsystem prompt\b/i,
  /\bdeveloper mode\b/i,
  /show me (?:all|every) (?:companies|company|businesses|tenants)/i,
  /\bother (?:company|companies|business|businesses)['’]?s? (?:data|books|sales|figures)/i,
  /\bbypass\b/i,
  /\breveal\b.*\b(?:prompt|instructions?|password|token)\b/i,
];

export const looksLikeAnInstruction = (question: string): string | null =>
  INJECTION_MARKERS.map((marker) => marker.exec(question)?.[0] ?? null).find((found) => found !== null) ?? null;
