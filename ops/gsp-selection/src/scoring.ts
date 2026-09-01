/**
 * Issue #50 [X02] — turning what we know into a recommendation, or into an honest refusal.
 *
 * Four rules the arithmetic cannot override.
 *
 *   1. **A provider that wants the customer's GST portal password is `DISQUALIFIED`** before
 *      anything is scored. Not a low score to be outweighed by coverage or price.
 *   2. **A missing critical capability is not a deduction, it is a stop.** A provider that cannot
 *      register an IRN cannot be the primary at any price, because the feature it breaks is one we
 *      have already built and sold.
 *   3. **A candidate missing an essential criterion is `CANNOT_SAY_YET`.** Not scored, not ranked,
 *      not quietly given the average of the criteria that were answered.
 *   4. **Fewer than two written quotations means no recommendation at all**, whatever the scores
 *      say. That is the issue's own acceptance criterion, and a comparison of one is not a
 *      comparison.
 *
 * The output when the evidence is thin is a deferral naming exactly what to ask and of whom — which
 * is the useful artefact today, since nobody has been approached yet.
 */
import { CAPABILITIES, CRITICAL_CAPABILITIES } from './capabilities.ts';
import { CRITERIA } from './criteria.ts';
import { REQUIRED_WRITTEN_PROPOSALS, evidenceState, proposalFor, stillToApproach } from './proposals.ts';
import {
  requiresPortalPassword,
  type Candidate,
  type CandidateScore,
  type Criterion,
  type CriterionId,
  type ProposalRecord,
  type Recommendation,
} from './model.ts';

const scoreOf = (candidate: Candidate, id: CriterionId): number | null => {
  const assessment = candidate.assessments[id];
  if (assessment === undefined || assessment.confidence === 'UNKNOWN' || assessment.value === null) return null;
  return assessment.value;
};

/** Critical capabilities this candidate has not shown. An unknown counts as not shown. */
export const missingCritical = (candidate: Candidate): readonly string[] =>
  CRITICAL_CAPABILITIES.filter((capability) => {
    const assessment = candidate.capabilities[capability.id];
    return assessment === undefined || assessment.confidence === 'UNKNOWN' || assessment.value !== true;
  }).map((capability) => capability.id);

export const scoreCandidate = (candidate: Candidate, criteria: readonly Criterion[] = CRITERIA): CandidateScore => {
  if (requiresPortalPassword(candidate.authModel)) {
    return {
      candidate,
      verdict: 'DISQUALIFIED',
      score: null,
      known: [],
      missing: [],
      missingCritical: [],
      reason: {
        'en-IN': 'Their integration needs the customer’s own GST portal password. This product has nowhere to keep one and will not grow somewhere, at any price.',
        'hi-IN': 'Unke integration ko customer ka GST portal password chahiye. Is product mein use rakhne ki jagah hi nahin hai, aur kisi bhi keemat par banayi nahin jaayegi.',
      },
    };
  }

  const known = criteria.filter((criterion) => scoreOf(candidate, criterion.id) !== null);
  const missing = criteria.filter((criterion) => scoreOf(candidate, criterion.id) === null);
  const missingEssential = missing.filter((criterion) => criterion.essential);
  const gaps = missingCritical(candidate);

  if (missingEssential.length > 0) {
    return {
      candidate,
      verdict: 'CANNOT_SAY_YET',
      score: null,
      known: known.map((criterion) => criterion.id),
      missing: missing.map((criterion) => criterion.id),
      missingCritical: gaps,
      reason: {
        'en-IN': `Nobody has answered ${missingEssential.map((criterion) => criterion.label['en-IN'].toLowerCase()).join('; ')}. Scoring around that would be inventing an answer.`,
        'hi-IN': `Abhi tak yeh nahin pata: ${missingEssential.map((criterion) => criterion.label['hi-IN']).join('; ')}. Iske bina number dena apne aap jawab bana lena hoga.`,
      },
    };
  }

  const weight = known.reduce((total, criterion) => total + criterion.weight, 0);
  const earned = known.reduce((total, criterion) => total + criterion.weight * (scoreOf(candidate, criterion.id) ?? 0), 0);
  const score = weight === 0 ? 0 : Math.round((earned / (weight * 5)) * 100);

  if (gaps.length > 0) {
    return {
      candidate,
      verdict: 'CANNOT_SAY_YET',
      score,
      known: known.map((criterion) => criterion.id),
      missing: missing.map((criterion) => criterion.id),
      missingCritical: gaps,
      reason: {
        'en-IN': `${gaps.length} critical ${gaps.length === 1 ? 'capability is' : 'capabilities are'} unproven: ${gaps.map(labelOf).join('; ')}. A sandbox run settles this in an afternoon.`,
        'hi-IN': `${gaps.length} zaroori kaam abhi saabit nahin hue: ${gaps.map(labelOf).join('; ')}. Sandbox par chala kar yeh ek din mein pata chal jaata hai.`,
      },
    };
  }

  return {
    candidate,
    verdict: 'VIABLE',
    score,
    known: known.map((criterion) => criterion.id),
    missing: missing.map((criterion) => criterion.id),
    missingCritical: [],
    reason: {
      'en-IN': `Every critical capability is proven and every essential question answered. Scored ${score} out of 100 on the weights in criteria.ts.`,
      'hi-IN': `Har zaroori kaam saabit hai aur har zaroori sawaal ka jawab hai. Weights ke hisaab se 100 mein ${score}.`,
    },
  };
};

const labelOf = (capabilityId: string): string =>
  CAPABILITIES.find((capability) => capability.id === capabilityId)?.label['en-IN'] ?? capabilityId;

export const recommend = (
  candidates: readonly Candidate[],
  proposals: readonly ProposalRecord[],
  asOf: string,
  criteria: readonly Criterion[] = CRITERIA,
): Recommendation => {
  const scores = candidates
    .map((candidate) => scoreCandidate(candidate, criteria))
    .sort((left, right) => (right.score ?? -1) - (left.score ?? -1));
  const evidence = evidenceState(proposals);

  // Only providers compete for the recommendation. "No provider" is the baseline we are measured
  // against, not a GSP we can sign, and naming it the primary would answer a different question.
  const viable = scores.filter((score) => score.verdict === 'VIABLE' && score.candidate.id !== 'no_provider');

  if (!evidence.enough || viable.length < 2) {
    const toAsk = [
      ...(evidence.written < REQUIRED_WRITTEN_PROPOSALS
        ? [`Send the requirement in REQUEST_FOR_PROPOSAL to: ${stillToApproach(candidates, proposals).join(', ') || 'the remaining providers'}. Two written quotations are needed; ${evidence.written} received.`]
        : []),
      ...(evidence.sandboxes === 0 ? ['Ask for sandbox access before any commitment, then run `npm run gsp:route -- --conformance` against it.'] : []),
      ...scores
        .filter((score) => score.candidate.id !== 'no_provider' && score.candidate.openQuestions.length > 0)
        .slice(0, 1)
        .flatMap((score) => score.candidate.openQuestions.map((question) => `Ask every provider: ${question}`)),
    ];
    return Object.freeze({
      asOf,
      scores,
      primary: null,
      fallback: null,
      writtenProposals: evidence.written,
      deferral: {
        why: evidence.missing ?? {
          'en-IN': 'Two providers must be viable before one can be named primary and another fallback. A single-provider plan is not a plan.',
          'hi-IN': 'Ek ko primary aur doosre ko fallback kehne se pehle do provider viable hone chahiye. Sirf ek provider wali yojana yojana nahin hai.',
        },
        toAsk,
      },
      summary: {
        'en-IN': 'No provider can be recommended yet, and the honest output is the list of what to ask rather than a ranking of guesses.',
        'hi-IN': 'Abhi kisi provider ki sifarish nahin ki ja sakti; sahi jawab yeh hai ki kya poochna hai, na ki andazon ki ranking.',
      },
    });
  }

  const [primary, fallback] = viable as [CandidateScore, CandidateScore, ...CandidateScore[]];
  return Object.freeze({
    asOf,
    scores: scores.map((score) =>
      score === primary ? { ...score, verdict: 'RECOMMENDED' as const } : score === fallback ? { ...score, verdict: 'FALLBACK' as const } : score,
    ),
    primary: { ...primary, verdict: 'RECOMMENDED' as const },
    fallback: { ...fallback, verdict: 'FALLBACK' as const },
    writtenProposals: evidence.written,
    deferral: null,
    summary: {
      'en-IN': `Build on ${primary.candidate.name}, and keep ${fallback.candidate.name} as the fallback. Both proved every critical capability in a sandbox, and both quoted in writing.`,
      'hi-IN': `${primary.candidate.name} par banayein, aur ${fallback.candidate.name} ko fallback rakhein. Dono ne sandbox mein har zaroori kaam saabit kiya aur dono ne likhit quotation diya.`,
    },
  });
};
