/**
 * Issue #34 [E34] — answering a question about a rule.
 *
 * The chain is fixed and every link is somebody else's module: the rules engine (#7) decides, its
 * rule names a source, and the compliance-source register (#54) holds that source with its
 * provision, its publisher, the words relied on and the date it took effect. This file only carries
 * the result across, and refuses to carry it when a link is missing.
 *
 * Three ways an answer can come out, and only three:
 *
 *  - `THE_RULE_SAYS` — an APPROVED rule, resting on a legal source, decided it. This is the only
 *    level at which the answer may use the language of obligation (see `citations.ts`).
 *  - `THE_RULE_IS_UNCLEAR` — we have a rule but it could not decide, usually because something it
 *    needs is missing. The answer says what is missing.
 *  - `WE_CANNOT_SAY` — no approved rule, or no usable source. Nothing is asserted at all.
 */
import type { IsoDate } from '@invoice/kernel';
import type { ComplianceRegister } from '@invoice/compliance-register';
import { LEGAL_AUTHORITIES } from '@invoice/compliance-register';
import type { Decision } from '@invoice/rules-engine';
import { labelForTopic } from './language.ts';
import type { Bilingual, Certainty, ComplianceCitation } from './model.ts';

const NOTHING_ASSERTED: Bilingual = {
  'en-IN': 'We do not have an approved rule for this, so we will not tell you what the position is. Your accountant can.',
  'hi-IN': 'Iske liye hamare paas manzoor kiya hua niyam nahin hai, isliye hum kuch nahin batayenge. Aapke accountant bata sakte hain.',
};

/**
 * Turns one decision into something an answer can quote.
 *
 * A decision whose rule cites a source the register does not hold is downgraded to
 * `WE_CANNOT_SAY` rather than quoted, because a citation nobody can open is not a citation.
 */
export const citeCompliance = (
  decision: Decision,
  register: ComplianceRegister,
  asOfDate: IsoDate,
): ComplianceCitation => {
  const missing = decision.missingFacts.map((fact) => ({ label: fact.label, whyNeeded: fact.whyNeeded }));

  const base = {
    topic: decision.topic,
    outcome: decision.outcome,
    asOfDate,
    ruleId: decision.ruleId,
    ruleVersion: decision.ruleVersion,
    effectiveFrom: decision.effectiveFrom,
    missing,
  };

  if (decision.outcome === 'CANNOT_DECIDE') {
    return {
      ...base,
      certainty: 'THE_RULE_IS_UNCLEAR',
      explanation: decision.explanation,
      source: null,
    };
  }

  const approved = decision.ruleReviewState === 'APPROVED';
  const sourceRef = decision.sourceRef;
  if (!approved || sourceRef === null || !register.has(sourceRef)) {
    return {
      ...base,
      certainty: 'WE_CANNOT_SAY',
      explanation: NOTHING_ASSERTED,
      source: null,
    };
  }

  const source = register.source(sourceRef);
  const legal = LEGAL_AUTHORITIES.includes(source.authority);
  return {
    ...base,
    // A circular or an FAQ is the administration's reading of the law, not the law. It is worth
    // quoting and it is not worth being certain about, which is exactly this distinction.
    certainty: legal ? 'THE_RULE_SAYS' : 'THE_RULE_IS_UNCLEAR',
    explanation: decision.explanation,
    source: {
      id: source.id,
      title: source.title,
      publisher: source.publisher,
      provision: source.provision,
      url: source.url,
      quotedText: source.quotedText,
      authority: source.authority,
      effectiveFrom: source.effectiveFrom,
    },
  };
};

/** Whether a sentence built on this citation may use the language of obligation. */
export const supportOf = (citation: ComplianceCitation): { backedByApprovedRule: boolean; certainty: Certainty } => ({
  backedByApprovedRule: citation.certainty === 'THE_RULE_SAYS' && citation.source !== null,
  certainty: citation.certainty,
});

/** A rule id in a sentence is a leak of our own plumbing, so it is said in words instead. */
const inWords = (text: string, topic: string): string => text.replace(topic, labelForTopic(topic));

/** How a citation reads to a shopkeeper: the position, then where it comes from, then the date. */
export const describeCitation = (citation: ComplianceCitation): Bilingual => {
  const explanation: Bilingual = {
    'en-IN': inWords(citation.explanation['en-IN'], citation.topic),
    'hi-IN': inWords(citation.explanation['hi-IN'], citation.topic),
  };
  citation = { ...citation, explanation };
  if (citation.certainty === 'WE_CANNOT_SAY') return citation.explanation;
  if (citation.certainty === 'THE_RULE_IS_UNCLEAR') {
    const needs = citation.missing.map((fact) => fact.label).join(', ');
    return {
      'en-IN':
        needs === ''
          ? `${citation.explanation['en-IN']} We are not certain enough about this one to leave it there — check it with your accountant.`
          : `${citation.explanation['en-IN']} To settle it we still need: ${needs}.`,
      'hi-IN':
        needs === ''
          ? `${citation.explanation['hi-IN']} Is baare mein hum poori tarah nishchit nahin hain — apne accountant se jaanch lein.`
          : `${citation.explanation['hi-IN']} Ise tay karne ke liye abhi chahiye: ${needs}.`,
    };
  }
  const source = citation.source;
  return {
    'en-IN': `${citation.explanation['en-IN']} This comes from ${source?.title ?? ''}${source?.provision === undefined || source.provision === '' ? '' : `, ${source.provision}`}, in force from ${citation.effectiveFrom ?? source?.effectiveFrom ?? ''}.`,
    'hi-IN': `${citation.explanation['hi-IN']} Yeh ${source?.title ?? ''}${source?.provision === undefined || source.provision === '' ? '' : `, ${source.provision}`} se hai, jo ${citation.effectiveFrom ?? source?.effectiveFrom ?? ''} se laagu hai.`,
  };
};
