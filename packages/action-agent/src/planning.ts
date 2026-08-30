/**
 * Issue #47 [E47] — reading what was asked for, without letting the asking decide anything.
 *
 * A lexicon, not a model. A model may later be allowed to suggest **which of this fixed list** was
 * meant, and nothing else — the same rule #34 works under. What a request can never do is name a
 * tool, a company, a permission or an amount that the product then trusts: those come from the
 * registry, the authenticated actor, the platform and the books.
 */
import type { AgentIntent, Bilingual } from './model.ts';

export type RequestLanguage = 'en-IN' | 'hi-IN';

export interface UnderstoodRequest {
  readonly intent: AgentIntent;
  readonly confidence: number;
  /** The words the intent was read from. Shown, so a person can see why this was planned. */
  readonly evidence: string;
  readonly language: RequestLanguage;
  readonly partyText: string | null;
  readonly documentRef: string | null;
  readonly amountText: string | null;
}

/** Below this the agent asks what was meant instead of planning. Same threshold idea as #10. */
export const ASK_INSTEAD = 0.55;

interface Pattern {
  readonly intent: AgentIntent;
  readonly match: RegExp;
  readonly confidence: number;
}

/**
 * Order is the design. "Stop reminding them" contains "remind"; "send reminders" contains "send".
 * The narrower, more consequential reading is tried first, so an ambiguous sentence lands on the
 * safer intent rather than on the one that sends messages.
 */
const PATTERNS: readonly Pattern[] = [
  { intent: 'STOP_REMINDING', confidence: 0.9, match: /\b(?:stop|don'?t|do not|no more|band kar|mat bhej|na bhej)\b[^.?!]{0,30}\b(?:remind|reminder|message|yaad|taqaza)/i },
  { intent: 'FILE_RETURN', confidence: 0.9, match: /\b(?:file|submit|bhar\s?do|jama kar)\b[^.?!]{0,20}\b(?:gstr[-\s]?\d[ab]?|return|returns|3b)\b/i },
  { intent: 'CANCEL_INVOICE', confidence: 0.9, match: /\b(?:cancel|radd|rad+ ?kar)\b[^.?!]{0,20}\b(?:invoice|bill|inv|credit note)\b/i },
  { intent: 'MOVE_MONEY', confidence: 0.9, match: /\b(?:transfer|remit|wire|pay out|payout|paisa bhej|paise bhej|bhej do)\b[^.?!]{0,30}(?:₹|rs\.?|rupees|\d)/i },
  { intent: 'CHASE_UNPAID', confidence: 0.88, match: /\b(?:remind|reminders?|chase|follow[-\s]?up|taqaza|yaad dila)\b/i },
  { intent: 'SHOW_WHO_OWES', confidence: 0.8, match: /\b(?:who owes|unpaid|outstanding|overdue|pending bills?|kaun.{0,12}baaki|kitna baaki|udhaar)\b/i },
];

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'for', 'to', 'of', 'their', 'his', 'her', 'them', 'please', 'send',
  'reminders', 'reminder', 'remind', 'unpaid', 'invoices', 'invoice', 'bills', 'bill', 'all',
  'overdue', 'outstanding', 'money', 'ko', 'ka', 'ki', 'ke', 'se', 'aur', 'wale',
]);

/**
 * The words that look like a customer's name.
 *
 * Deliberately conservative: a run of capitalised words, or whatever follows "from"/"for". It
 * returns text, never a party — resolving that text against the company's real customers happens
 * later, and an unresolvable name is a refusal with a question rather than a nearest match.
 */
export const readParty = (text: string): string | null => {
  const after = /\b(?:from|for|to|remind(?:ing)?)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*)*)/.exec(text);
  if (after?.[1] !== undefined) {
    const words = after[1].split(/\s+/).filter((word) => !STOP_WORDS.has(word.toLowerCase()));
    if (words.length > 0) return words.join(' ');
  }
  const capitalised = /\b([A-Z][a-z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*)+)\b/.exec(text);
  if (capitalised?.[1] !== undefined) {
    const words = capitalised[1].split(/\s+/).filter((word) => !STOP_WORDS.has(word.toLowerCase()));
    if (words.length > 0) return words.join(' ');
  }
  return null;
};

const DOCUMENT = /\b([A-Z]{2,}[/\-][\w/\-]{2,})\b/;
const AMOUNT = /(?:₹\s?|rs\.?\s?)([\d,]+(?:\.\d{1,2})?)/i;
const HINDI = /\b(?:yaad|dila|baaki|udhaar|bhej|karo|kar do|band|radd|paisa|paise|kitna|kaun)\b/i;

export const understandRequest = (text: string): UnderstoodRequest => {
  const trimmed = text.trim();
  const language: RequestLanguage = HINDI.test(trimmed) ? 'hi-IN' : 'en-IN';
  const found = PATTERNS.map((pattern) => ({ pattern, hit: pattern.match.exec(trimmed) })).find((candidate) => candidate.hit !== null);
  const base = {
    language,
    partyText: readParty(trimmed),
    documentRef: DOCUMENT.exec(trimmed)?.[1] ?? null,
    amountText: AMOUNT.exec(trimmed)?.[1] ?? null,
  };
  if (found === undefined || found.hit === null) {
    return { intent: 'NOT_MY_REQUEST', confidence: 0, evidence: '', ...base };
  }
  return { intent: found.pattern.intent, confidence: found.pattern.confidence, evidence: found.hit[0], ...base };
};

export const WHAT_I_CAN_DO: Bilingual = {
  'en-IN': 'I can show who owes you money, send reminders about overdue bills, and stop reminding a customer. Anything that moves money, files a return or cancels a bill I can only prepare for you.',
  'hi-IN': 'Main bata sakta hoon kisse paisa lena baaki hai, late bill ke liye reminder bhej sakta hoon, aur kisi grahak ko reminder bhejna band kar sakta hoon. Paisa bhejna, return file karna ya bill radd karna — yeh sirf taiyar kar sakta hoon, karna aapko hoga.',
};
