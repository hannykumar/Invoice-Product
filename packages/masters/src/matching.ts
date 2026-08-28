// Duplicate detection for parties and items.
//
// Two jobs, deliberately separated:
//   1. Stop a second "ABC Traders" being created next to the first one.
//   2. Resolve a spoken or typed name to exactly one master record, or admit that it
//      cannot. Acceptance criterion for issue #5 is that similar names must never
//      silently resolve to the wrong party or item, so an ambiguous result is a
//      first-class outcome here, not an error to be smoothed over.

import { normalisePhone } from "./validation.ts";

export type MatchReasonCode =
  | "SAME_GSTIN"
  | "SAME_PAN"
  | "SAME_PHONE"
  | "SAME_EMAIL"
  | "SAME_BANK_ACCOUNT"
  | "SAME_NORMALISED_NAME"
  | "SIMILAR_NAME"
  | "SAME_CODE";

export interface MatchReason {
  readonly code: MatchReasonCode;
  readonly detail: string;
  /** 0 to 1. Identity reasons are 1; name similarity carries its computed score. */
  readonly score: number;
}

export interface MatchCandidate<T> {
  readonly record: T;
  readonly score: number;
  readonly reasons: readonly MatchReason[];
}

export type DuplicateVerdict<T> =
  /** Nothing close enough to worry about. */
  | { readonly decision: "clear" }
  /** Close enough that a human should look, but creation may proceed with an acknowledgement. */
  | { readonly decision: "warn"; readonly candidates: readonly MatchCandidate<T>[] }
  /** Same identity or same name — creation is refused until the user merges or confirms. */
  | { readonly decision: "block"; readonly candidates: readonly MatchCandidate<T>[] };

export type ResolveOutcome<T> =
  | { readonly status: "resolved"; readonly record: T; readonly score: number; readonly reasons: readonly MatchReason[] }
  | { readonly status: "ambiguous"; readonly candidates: readonly MatchCandidate<T>[] }
  | { readonly status: "not_found" };

/** Legal-form words that carry no identity: "ABC Pvt Ltd" and "ABC" are the same shop. */
const LEGAL_SUFFIXES = [
  "PRIVATE", "PVT", "LIMITED", "LTD", "LLP", "LLC", "INC", "CORPORATION", "CORP",
  "COMPANY", "CO", "AND", "THE", "M/S", "MS", "HUF", "PROPRIETOR", "PROP", "ENTERPRISE",
  "ENTERPRISES", "INDIA", "INDIAN",
];

/** Uppercase and remove the "M/s" prefix before punctuation is stripped into letters. */
const stripLegalNoise = (raw: string): string => raw.toUpperCase().replace(/\bM\s*\/\s*S\.?\b/g, " ").replace(/[^A-Z0-9\s]/g, " ");

/**
 * Uppercase, strip punctuation, drop legal-form noise, sort the remaining tokens.
 * Sorting means "Kumar Traders" and "Traders Kumar" normalise identically, which is a
 * genuine duplicate risk when names arrive from OCR or speech.
 */
export function normaliseName(raw: string): string {
  const tokens = stripLegalNoise(raw)
    .split(/\s+/)
    .filter((token) => token.length > 0 && !LEGAL_SUFFIXES.includes(token));
  return tokens.sort().join(" ");
}

/** Token order preserved — used for the display-order comparison. */
export function normaliseNameOrdered(raw: string): string {
  return stripLegalNoise(raw).split(/\s+/).filter((token) => token.length > 0 && !LEGAL_SUFFIXES.includes(token)).join(" ");
}

/** Classic Levenshtein distance, iterative and allocation-light. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_value, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i, ...new Array<number>(b.length).fill(0)];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] as number) + 1;
      const deletion = (previous[j] as number) + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    previous = current;
  }
  return previous[b.length] as number;
}

/** 1 for identical strings, 0 for nothing in common. */
export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - editDistance(a, b) / longest;
}

/**
 * How well the tokens of two names line up, allowing a token to match a near-spelling
 * of itself. Exact set overlap would score "Shree Ram Steel" against "Shree Ram Steels"
 * as a partial miss, which is exactly the duplicate this check exists to catch. Every
 * token of the longer name must find a home, so a short name does not score highly
 * against a much longer one.
 */
export function tokenOverlap(a: string, b: string): number {
  const left = a.split(" ").filter(Boolean);
  const right = b.split(" ").filter(Boolean);
  if (left.length === 0 || right.length === 0) return 0;
  const longer = left.length >= right.length ? left : right;
  const shorter = left.length >= right.length ? right : left;
  let total = 0;
  for (const token of longer) total += Math.max(...shorter.map((other) => similarity(token, other)));
  return total / longer.length;
}

/**
 * Blended name score. Character similarity alone rates "Ram Traders" and "Ravi Traders"
 * too highly; token overlap alone misses simple typos. The blend leans on whichever
 * signal is stronger while keeping both in the result.
 */
export function nameScore(a: string, b: string): number {
  const left = normaliseName(a);
  const right = normaliseName(b);
  if (left === right) return 1;
  const characters = similarity(left, right);
  const tokens = tokenOverlap(left, right);
  return Number((0.55 * characters + 0.45 * tokens).toFixed(4));
}

/** Identity fields that make two records the same party beyond argument. */
export interface IdentityKeys {
  readonly gstins?: readonly string[];
  readonly pan?: string;
  readonly phones?: readonly string[];
  readonly emails?: readonly string[];
  readonly bankAccounts?: readonly string[];
  /** A user-assigned short code, unique inside a company. */
  readonly code?: string;
}

export interface MatchableRecord extends IdentityKeys {
  readonly name: string;
  /** Alternate spellings the user has already confirmed belong to this record. */
  readonly aliases?: readonly string[];
}

/** Above this, two names are treated as the same record and creation is blocked. */
export const BLOCK_THRESHOLD = 0.92;
/** Above this, the user is warned and must acknowledge before a new record is created. */
export const WARN_THRESHOLD = 0.75;

const set = (values: readonly string[] | undefined): Set<string> => new Set((values ?? []).map((value) => value.trim().toUpperCase()).filter(Boolean));

/** Phones are compared as bare 10-digit numbers so +91, 0 and spacing never hide a duplicate. */
const phoneSet = (values: readonly string[] | undefined): Set<string> => new Set((values ?? []).map((value) => normalisePhone(value) ?? value.replace(/\D/g, "")).filter(Boolean));

function identityReasons(candidate: MatchableRecord, subject: MatchableRecord): MatchReason[] {
  const reasons: MatchReason[] = [];
  const overlap = (left: readonly string[] | undefined, right: readonly string[] | undefined): string | null => {
    const a = set(left);
    for (const value of set(right)) if (a.has(value)) return value;
    return null;
  };
  const gstin = overlap(candidate.gstins, subject.gstins);
  if (gstin) reasons.push({ code: "SAME_GSTIN", detail: `Both use GST number ${gstin}.`, score: 1 });
  if (candidate.pan && subject.pan && candidate.pan.toUpperCase() === subject.pan.toUpperCase()) reasons.push({ code: "SAME_PAN", detail: `Both use PAN ${subject.pan.toUpperCase()}.`, score: 1 });
  const phone = ((): string | null => {
    const left = phoneSet(candidate.phones);
    for (const value of phoneSet(subject.phones)) if (left.has(value)) return value;
    return null;
  })();
  if (phone) reasons.push({ code: "SAME_PHONE", detail: `Both use phone number ${phone}.`, score: 1 });
  const email = overlap(candidate.emails, subject.emails);
  if (email) reasons.push({ code: "SAME_EMAIL", detail: `Both use email ${email.toLowerCase()}.`, score: 1 });
  const account = overlap(candidate.bankAccounts, subject.bankAccounts);
  if (account) reasons.push({ code: "SAME_BANK_ACCOUNT", detail: "Both use the same bank account.", score: 1 });
  if (candidate.code && subject.code && candidate.code.toUpperCase() === subject.code.toUpperCase()) reasons.push({ code: "SAME_CODE", detail: `Both use the code ${subject.code.toUpperCase()}.`, score: 1 });
  return reasons;
}

function nameReasons(candidateNames: readonly string[], subjectName: string): MatchReason | null {
  let best = 0;
  let bestName = "";
  for (const name of candidateNames) {
    const score = nameScore(name, subjectName);
    if (score > best) { best = score; bestName = name; }
  }
  if (best < WARN_THRESHOLD) return null;
  if (normaliseName(bestName) === normaliseName(subjectName)) return { code: "SAME_NORMALISED_NAME", detail: `"${bestName}" and "${subjectName}" are the same name once spelling and Pvt/Ltd are ignored.`, score: 1 };
  return { code: "SIMILAR_NAME", detail: `"${bestName}" is very close to "${subjectName}".`, score: best };
}

function scoreCandidate<T extends MatchableRecord>(candidate: T, subject: MatchableRecord): MatchCandidate<T> | null {
  const reasons = identityReasons(candidate, subject);
  const name = nameReasons([candidate.name, ...(candidate.aliases ?? [])], subject.name);
  if (name) reasons.push(name);
  if (reasons.length === 0) return null;
  const score = Math.max(...reasons.map((reason) => reason.score));
  return { record: candidate, score, reasons };
}

/** Everything that looks related to `subject`, strongest first. */
export function findMatches<T extends MatchableRecord>(existing: readonly T[], subject: MatchableRecord): readonly MatchCandidate<T>[] {
  return existing
    .map((candidate) => scoreCandidate(candidate, subject))
    .filter((candidate): candidate is MatchCandidate<T> => candidate !== null)
    .sort((left, right) => right.score - left.score);
}

/** The create-time gate. Identity overlap always blocks; name similarity blocks only when it is nearly exact. */
export function checkForDuplicates<T extends MatchableRecord>(existing: readonly T[], subject: MatchableRecord): DuplicateVerdict<T> {
  const candidates = findMatches(existing, subject);
  if (candidates.length === 0) return { decision: "clear" };
  const blocking = candidates.filter((candidate) => candidate.score >= BLOCK_THRESHOLD);
  if (blocking.length > 0) return { decision: "block", candidates: blocking };
  return { decision: "warn", candidates };
}

/**
 * Name-to-record resolution for voice and OCR. A single clearly-best match resolves;
 * two plausible matches return `ambiguous` so the caller can ask, and never guess.
 */
export function resolveByName<T extends MatchableRecord>(existing: readonly T[], spokenName: string, options: { readonly confident?: number; readonly margin?: number } = {}): ResolveOutcome<T> {
  const confident = options.confident ?? 0.85;
  const margin = options.margin ?? 0.08;
  const candidates = findMatches(existing, { name: spokenName });
  const best = candidates[0];
  if (!best || best.score < WARN_THRESHOLD) return { status: "not_found" };
  const runnerUp = candidates[1];
  const clearlyBest = !runnerUp || best.score - runnerUp.score >= margin;
  if (best.score >= confident && clearlyBest) return { status: "resolved", record: best.record, score: best.score, reasons: best.reasons };
  return { status: "ambiguous", candidates: candidates.slice(0, 5) };
}
