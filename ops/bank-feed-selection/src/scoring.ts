/**
 * Issue #52 [X04] — turning what we know into a recommendation, or into an honest refusal.
 *
 * Two rules the arithmetic cannot override:
 *
 *  1. A credential-sharing route is `DISQUALIFIED` before anything is scored. It is not a low
 *     score to be outweighed by price or coverage.
 *  2. A candidate missing an **essential** criterion is `CANNOT_SAY_YET`, and if that leaves no
 *     candidate scorable the whole thing defers, naming what to ask and of whom. "Never silently
 *     guess a missing fact" applies to our own decisions as much as to a customer's books.
 */
import { CRITERIA } from './criteria.ts';
import {
  isCredentialScraping,
  type Candidate,
  type CandidateScore,
  type Criterion,
  type CriterionId,
  type Recommendation,
} from './model.ts';

const known = (candidate: Candidate, id: CriterionId): number | null => {
  const assessment = candidate.assessments[id];
  if (assessment === undefined || assessment.confidence === 'UNKNOWN' || assessment.value === null) return null;
  return assessment.value;
};

export const scoreCandidate = (candidate: Candidate, criteria: readonly Criterion[] = CRITERIA): CandidateScore => {
  if (isCredentialScraping(candidate.accessModel)) {
    return {
      candidate,
      verdict: 'DISQUALIFIED',
      score: null,
      known: [],
      missing: [],
      reason: {
        'en-IN': 'This works by holding the shopkeeper’s own banking password. We will not build that, at any price, however convenient it is.',
        'hi-IN': 'Yeh dukaandar ka apna banking password rakh kar chalta hai. Hum aisa nahin banayenge — kisi bhi keemat par, chahe kitna hi aasan ho.',
      },
    };
  }

  const scored = criteria.filter((criterion) => known(candidate, criterion.id) !== null);
  const missing = criteria.filter((criterion) => known(candidate, criterion.id) === null);
  const missingEssential = missing.filter((criterion) => criterion.essential);

  if (missingEssential.length > 0) {
    return {
      candidate,
      verdict: 'CANNOT_SAY_YET',
      score: null,
      known: scored.map((criterion) => criterion.id),
      missing: missing.map((criterion) => criterion.id),
      reason: {
        'en-IN': `Nobody has confirmed ${missingEssential.map((criterion) => criterion.label['en-IN'].toLowerCase()).join(', ')}. Until they do, any score would be a guess dressed as arithmetic.`,
        'hi-IN': `${missingEssential.map((criterion) => criterion.label['hi-IN']).join(', ')} — inki pushti kisi ne nahin ki. Jab tak nahin hoti, koi bhi number sirf andaza hoga jise ginti ka roop de diya gaya ho.`,
      },
    };
  }

  // Scored over the criteria that are actually known, so a candidate is never punished for a
  // non-essential fact nobody has looked up yet.
  const weight = scored.reduce((sum, criterion) => sum + criterion.weight, 0);
  const earned = scored.reduce((sum, criterion) => sum + criterion.weight * ((known(candidate, criterion.id) as number) / 5), 0);
  const score = Math.round((earned / weight) * 100);

  return {
    candidate,
    verdict: 'VIABLE',
    score,
    known: scored.map((criterion) => criterion.id),
    missing: missing.map((criterion) => criterion.id),
    reason: {
      'en-IN': `${score} out of 100 across ${scored.length} of ${criteria.length} criteria.`,
      'hi-IN': `${criteria.length} mein se ${scored.length} baaton par ${score} out of 100.`,
    },
  };
};

export const recommend = (candidates: readonly Candidate[], asOf: string, criteria: readonly Criterion[] = CRITERIA): Recommendation => {
  const scores = candidates
    .map((candidate) => scoreCandidate(candidate, criteria))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const viable = scores.filter((score) => score.verdict === 'VIABLE');

  if (viable.length === 0) {
    const toAsk = [...new Set(scores.flatMap((score) => score.candidate.openQuestions))];
    return {
      asOf,
      scores,
      chosen: null,
      deferral: {
        why: {
          'en-IN': 'No route can be recommended yet, because the things that decide it are things only the providers can tell us. This is the documented reason to defer, not a gap in the comparison.',
          'hi-IN': 'Abhi koi rasta chuna nahin ja sakta, kyunki jo baatein faisla karti hain woh sirf provider hi bata sakte hain. Yeh talne ka likhit karan hai, tulna ki kami nahin.',
        },
        toAsk,
      },
      summary: {
        'en-IN': `${scores.filter((score) => score.verdict === 'DISQUALIFIED').length} route ruled out on principle, ${scores.filter((score) => score.verdict === 'CANNOT_SAY_YET').length} waiting on answers from the providers.`,
        'hi-IN': `${scores.filter((score) => score.verdict === 'DISQUALIFIED').length} rasta usool par hataya gaya, ${scores.filter((score) => score.verdict === 'CANNOT_SAY_YET').length} provider ke jawab ka intezar kar rahe hain.`,
      },
    };
  }

  const best = viable[0] as CandidateScore;
  const chosen: CandidateScore = { ...best, verdict: 'RECOMMENDED' };
  return {
    asOf,
    scores: scores.map((score) => (score === best ? chosen : score)),
    chosen,
    deferral: null,
    summary: {
      'en-IN': `${chosen.candidate.name} scores highest at ${chosen.score} out of 100, on the weights in criteria.ts.`,
      'hi-IN': `${chosen.candidate.name} sabse aage hai — 100 mein se ${chosen.score}, criteria.ts mein likhe vazan ke hisaab se.`,
    },
  };
};
