// Issue #19 [E19] — the words this product is not allowed to use about a supplier.
//
// "Every warning names its evidence" and "the product never labels a party fraudulent" are
// acceptance criteria, and a wording review that lives only in someone's head fails the first
// time a message is edited in a hurry. So the rule is machinery: every risk message is built
// through `safeMessage`, which refuses to return a sentence containing an accusation.
//
// The distinction being drawn is between a fact and a judgement:
//
//   allowed:     "The GST portal shows this number was cancelled on 12 March 2026."
//   not allowed: "This supplier is fraudulent."      — a judgement we cannot support
//   not allowed: "This supplier is blacklisted."     — we run no blacklist (an explicit non-goal)
//   not allowed: "This is a fake company."           — defamatory, and not what the evidence says
//
// The buyer is left to draw their own conclusion from facts that carry a date and a source. That
// is both the honest thing and the defensible one.

/**
 * Words that turn a fact into an accusation.
 *
 * Matched as whole words, case-insensitively. The list is deliberately blunt: a false positive
 * costs one reworded sentence, while a false negative is a letter from a supplier's lawyer.
 */
export const FORBIDDEN_RISK_WORDS: readonly string[] = Object.freeze([
  "fraud", "frauds", "fraudulent", "fraudster",
  "fake", "bogus", "sham", "phoney", "phony",
  "scam", "scammer", "cheat", "cheater", "cheating", "swindle", "swindler",
  "criminal", "crook", "thief", "theft", "stealing",
  "blacklist", "blacklisted", "blocklist",
  "dishonest", "untrustworthy", "disreputable", "shady", "dodgy",
  "launder", "laundering", "shell company", "fly-by-night",
  "guilty", "illegal", "illegitimate", "evader", "evasion",
]);

/**
 * Phrases that assert a conclusion the evidence cannot carry, even without a forbidden word.
 *
 * "Do not deal with them" is advice we are not entitled to give from a cancelled registration; the
 * honest form is "check with them before you pay", which is what the messages actually say.
 */
/**
 * Multi-word accusations no single word catches.
 *
 * Deliberately not here: the ordinary copula. "This supplier is required to issue e-invoices" is a
 * plain fact, and a rule broad enough to block it pushes messages into worse English rather than
 * safer claims. The accusation lives in the predicate, and the word list catches that.
 */
export const FORBIDDEN_RISK_PHRASES: readonly string[] = Object.freeze([
  "do not deal",
  "do not trade",
  "avoid this supplier",
  "cannot be trusted",
  "not to be trusted",
  "stop dealing",
  "they are lying",
  "we recommend you stop",
  "report them",
]);

export class UnsafeWordingError extends Error {
  readonly offending: string;
  readonly text: string;
  constructor(offending: string, text: string) {
    super(`Supplier wording must state facts, not accusations. "${offending}" is not allowed in: ${text}`);
    this.name = "UnsafeWordingError";
    this.offending = offending;
    this.text = text;
  }
}

const wordPattern = (word: string): RegExp =>
  // Whole words only, so "cancelled" is fine and "fake" inside "fakery" is still caught.
  new RegExp(`(^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i");

/** The first accusation found in a piece of text, or null when it is safe to show. */
export const unsafeTermIn = (text: string): string | null => {
  const lower = text.toLowerCase();
  for (const phrase of FORBIDDEN_RISK_PHRASES) if (lower.includes(phrase)) return phrase;
  for (const word of FORBIDDEN_RISK_WORDS) if (wordPattern(word).test(lower)) return word;
  return null;
};

/**
 * Returns the message, or throws rather than let an accusation reach a screen.
 *
 * Throwing looks harsh for a wording problem, but the alternative is shipping a sentence that
 * calls a real business a fraud, and there is no safe way to degrade that.
 */
export const safeMessage = (text: string): string => {
  const offending = unsafeTermIn(text);
  if (offending !== null) throw new UnsafeWordingError(offending, text);
  return text;
};

/** How old a reading is, in whole days, on the day it is being read. */
export const ageInDays = (observedAt: string, on: string): number => {
  const then = new Date(observedAt).getTime();
  const now = new Date(`${on}T23:59:59Z`).getTime();
  if (Number.isNaN(then) || Number.isNaN(now)) return 0;
  return Math.max(0, Math.floor((now - then) / 86_400_000));
};

/** "12 March 2026" — how a date is written to someone who is not reading a database. */
export const readableDate = (date: string): string => {
  const parsed = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${parsed.getUTCDate()} ${months[parsed.getUTCMonth()]} ${parsed.getUTCFullYear()}`;
};

/** Last four digits only. A full account number never leaves this module. */
export const maskAccount = (accountNumber: string): string => {
  const digits = accountNumber.replace(/\s/g, "");
  return digits.length <= 4 ? "****" : `****${digits.slice(-4)}`;
};
