/**
 * Issue #53 [X05] — the privacy-minimisation review, run against the source rather than a slide.
 *
 * The claim on the application is that every field we ask for is one the product cannot do its job
 * without. A reviewer at the authority has no way to check that, and neither would we in six months
 * — so the review is a program. It reads the deterministic rules in #28 and asks, field by field,
 * whether anything actually looks at it.
 *
 * Four answers are possible and each means something different:
 *
 *   * **A rule reads it.** The justification is the rule, and it is checkable.
 *   * **It is the number we send.** Necessary by construction.
 *   * **No rule reads it, and the application says in writing what a person does with it.** Allowed,
 *     once, and it should be the field the application offers to drop first.
 *   * **No rule reads it and nobody wrote down why we want it.** The application must not ask for it.
 *     There is no state in which this passes.
 *
 * There is a fifth thing the review looks for, and it is the one that matters most: a field the
 * *code* reads that the application never asked for. That is not over-collection, it is collection
 * without permission, and it fails the review outright.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REQUESTED_FIELDS } from './fields.ts';
import type { Bilingual, NecessityFinding, NecessityReview, NecessityVerdict } from './model.ts';

/**
 * The files that decide things about a vehicle.
 *
 * Deliberately narrow. A field mentioned only in a demo script, a screen or a test is not a field a
 * decision depends on, and counting those would let the review pass on the strength of a
 * `console.log`.
 */
export const RULE_SOURCES: readonly string[] = Object.freeze([
  '../../../packages/transport/src/suitability.ts',
  '../../../packages/transport/src/rules.ts',
  '../../../packages/transport/src/plate.ts',
]);

const readSource = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

/**
 * Every field the rules read off a vehicle record, taken from the source itself.
 *
 * A property read is `something.fieldName`, which is crude and is meant to be: the review's job is
 * to be impossible to satisfy by accident, and a regular expression that occasionally counts a
 * comment is a review that errs towards "this field is used" — the safe direction for the
 * `TAKEN_WITHOUT_ASKING` check and the strict direction for nothing. So the two checks are separated:
 * a claimed field must be read in code, and a read field must be claimed.
 */
export const fieldsReadByRules = (sources: readonly string[] = RULE_SOURCES): ReadonlySet<string> => {
  const read = new Set<string>();
  for (const source of sources) {
    const text = readSource(source);
    // Strip comments first, so a field named only in a docstring is not mistaken for one a rule uses.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const match of code.matchAll(/\.([a-zA-Z][a-zA-Z0-9]*)\b/g)) read.add(match[1] as string);
  }
  return read;
};

/** The finding codes the rule source actually raises, so a claimed rule cannot be an invented one. */
export const ruleCodesInSource = (sources: readonly string[] = RULE_SOURCES): ReadonlySet<string> => {
  const codes = new Set<string>();
  for (const source of sources) {
    for (const match of readSource(source).matchAll(/code:\s*"([A-Z][A-Z0-9_.]+)"/g)) codes.add(match[1] as string);
  }
  return codes;
};

const verdictOf = (
  request: (typeof REQUESTED_FIELDS)[number],
  readByRules: ReadonlySet<string>,
): { readonly verdict: NecessityVerdict; readonly note: string } => {
  if (request.isRequestKey) {
    return {
      verdict: 'IS_THE_QUESTION',
      note: 'This is the number sent to the authority. There is no lookup without it.',
    };
  }
  if (readByRules.has(request.field)) {
    return {
      verdict: 'DECIDES_A_RULE',
      note: `A deterministic check reads this field: ${request.decidesRules.join(', ')}.`,
    };
  }
  if (request.humanUseOnly !== null && request.humanUseOnly.trim() !== '') {
    return {
      verdict: 'SHOWN_TO_A_PERSON',
      note: `No rule reads this field. ${request.humanUseOnly}`,
    };
  }
  return {
    verdict: 'UNJUSTIFIED',
    note: 'No rule reads this field and nothing says what a person does with it. It must come off the application.',
  };
};

/**
 * The review.
 *
 * `passed` is false while any field is unjustified or taken without asking. Nothing averages, and
 * there is no score: a single field we cannot justify is a field we must stop requesting, and no
 * amount of good justification elsewhere changes that.
 */
export const reviewNecessity = (asOf: string, sources: readonly string[] = RULE_SOURCES): NecessityReview => {
  const readByRules = fieldsReadByRules(sources);
  const requested = new Set(REQUESTED_FIELDS.map((request) => request.field));
  const findings: NecessityFinding[] = [];

  for (const request of REQUESTED_FIELDS) {
    const { verdict, note } = verdictOf(request, readByRules);
    findings.push({
      field: request.field,
      verdict,
      readBy: verdict === 'DECIDES_A_RULE' ? request.decidesRules : [],
      note,
    });
  }

  // The other direction: something the rules read off a vehicle record that we never asked for.
  // #29's allow-list makes this impossible today by construction, and the check is here so that it
  // stays impossible if somebody widens the evidence type without widening the application.
  for (const field of evidenceFieldsInSource()) {
    if (requested.has(field)) continue;
    if (!readByRules.has(field)) continue;
    findings.push({
      field,
      verdict: 'TAKEN_WITHOUT_ASKING',
      readBy: [],
      note: 'A rule reads this off the vehicle record, but the application never asked the authority for it.',
    });
  }

  const failing = findings.filter(
    (finding) => finding.verdict === 'UNJUSTIFIED' || finding.verdict === 'TAKEN_WITHOUT_ASKING',
  );
  const shown = findings.filter((finding) => finding.verdict === 'SHOWN_TO_A_PERSON');
  const summary: Bilingual = failing.length === 0
    ? {
      'en-IN': `${findings.length} fields requested. Every one is either the number we send or a field a deterministic check reads, except ${shown.length} shown to a person and named as such.`,
      'hi-IN': `${findings.length} field maange gaye. Har ek ya to bheja gaya number hai ya kisi jaanch dwara padha jaata hai; ${shown.length} sirf kisi vyakti ko dikhaye jaate hain.`,
    }
    : {
      'en-IN': `${failing.length} of ${findings.length} fields cannot be justified: ${failing.map((finding) => finding.field).join(', ')}. The application must not be submitted as it stands.`,
      'hi-IN': `${findings.length} me se ${failing.length} field ka koi kaaran nahi hai: ${failing.map((finding) => finding.field).join(', ')}. Aavedan aise nahi bheja ja sakta.`,
    };

  return { asOf, findings: Object.freeze(findings), passed: failing.length === 0, summary };
};

/**
 * The vehicle-record fields #28's evidence type can carry, read out of its own declaration.
 *
 * `source`, `retrievedAt` and `reference` describe the reading rather than the vehicle, so they are
 * not fields anybody applies to the authority for.
 */
export const evidenceFieldsInSource = (): readonly string[] => {
  const text = readSource('../../../packages/transport/src/suitability-types.ts');
  const block = /export interface VehicleEvidence \{([\s\S]*?)\n\}/.exec(text);
  if (block === null) throw new Error('VehicleEvidence is no longer declared where the necessity review looks for it');
  const about = new Set(['source', 'retrievedAt', 'reference']);
  return Object.freeze(
    [...(block[1] as string).matchAll(/readonly ([a-zA-Z][a-zA-Z0-9]*)\??:/g)]
      .map((match) => match[1] as string)
      .filter((field) => !about.has(field)),
  );
};
