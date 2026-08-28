/**
 * Issue #46 [E46] — the plain-language rules, as code.
 *
 * "Accounting terms have plain explanations" and "safety confirmations remain understandable"
 * are acceptance criteria, so they are enforced by a linter that runs over every user-facing
 * string in the catalogue, not by review alone.
 */
import { loadVocabulary, type Locale } from './catalogue.ts';

export interface LintIssue {
  rule: string;
  detail: string;
}

/** Terms the product never shows a business owner, gathered from the vocabulary's `avoid` lists. */
export const bannedTerms = (): string[] => {
  const fromVocabulary = loadVocabulary().entries.flatMap((e) => e.avoid);
  const extra = [
    'sundry debtors',
    'sundry creditors',
    'general ledger',
    'subledger',
    'contra',
    'narration',
    'suspense account',
    'nominal account',
    'bifurcation',
    'as per books',
    'kindly do the needful',
    'revert back',
    'prepone',
  ];
  return [...new Set([...fromVocabulary, ...extra].map((t) => t.toLowerCase()))];
};

/** Words that describe a computer's problem rather than the person's problem. */
const TECHNICAL_LEAKS = [
  'null',
  'undefined',
  'exception',
  'stack trace',
  'timeout',
  'http',
  '500',
  '404',
  'nan',
  'foreign key',
  'constraint',
  'deadlock',
  'rollback',
  'transaction aborted',
  'invalid input',
  'bad request',
];

const MAX_WORDS_PER_SENTENCE = 25;

const sentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const wordsOf = (sentence: string): string[] => sentence.split(/\s+/).filter((w) => w.length > 0);

/**
 * Checks one user-facing string. `allow` lets a message keep a word deliberately, for example
 * a screen that teaches the term "GST" on purpose.
 */
export const lintUserFacingText = (
  text: string,
  options: { locale: Locale; allow?: readonly string[] } = { locale: 'en-IN' },
): LintIssue[] => {
  const issues: LintIssue[] = [];
  const allow = new Set((options.allow ?? []).map((a) => a.toLowerCase()));
  const lower = text.toLowerCase();

  for (const term of bannedTerms()) {
    if (allow.has(term)) continue;
    const pattern = new RegExp(`(^|[^a-z])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i');
    if (pattern.test(lower)) {
      issues.push({ rule: 'banned-term', detail: `uses "${term}", which a non-accountant does not read` });
    }
  }

  for (const leak of TECHNICAL_LEAKS) {
    if (allow.has(leak)) continue;
    const pattern = new RegExp(`(^|[^a-z0-9])${leak}([^a-z0-9]|$)`, 'i');
    if (pattern.test(lower)) {
      issues.push({ rule: 'technical-leak', detail: `mentions "${leak}", which describes the computer, not the business` });
    }
  }

  for (const s of sentences(text)) {
    const count = wordsOf(s).length;
    if (count > MAX_WORDS_PER_SENTENCE) {
      issues.push({ rule: 'sentence-too-long', detail: `a sentence has ${count} words (limit ${MAX_WORDS_PER_SENTENCE})` });
    }
  }

  if (/\b[A-Z]{3,}(_[A-Z]{2,})+\b/.test(text)) {
    issues.push({ rule: 'raw-state-name', detail: 'shows an internal state name instead of its plain wording' });
  }

  if (/\{[a-zA-Z0-9_]+\}/.test(text) === false && text.includes('{')) {
    issues.push({ rule: 'broken-placeholder', detail: 'has an unclosed placeholder' });
  }

  return issues;
};
