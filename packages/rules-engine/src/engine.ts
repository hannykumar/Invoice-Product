/**
 * Issue #7 [E07] — the engine.
 *
 * Given facts, a topic and a document date, it picks exactly one rule, applies it, and returns an
 * answer that carries its own evidence. Three properties hold, and each has a test:
 *
 *  1. **Determinism.** The same facts and the same rule-set version always produce the same
 *     decision, down to the explanation and the fingerprint.
 *  2. **Replay.** A decision made in April is reproduced in August by loading the rule-set version
 *     it recorded, not today's.
 *  3. **No silent guessing.** A missing fact, an unresolvable conflict between rules, an
 *     unapproved rule or no rule at all all produce `CANNOT_DECIDE` with an explanation, never a
 *     plausible answer.
 */
import { invalid, type IsoDate } from '@invoice/kernel';
import {
  describeFactValue,
  type ConsideredRule,
  type Decision,
  type DecisionWithTrace,
  type Evidence,
  type MissingFact,
  type Trace,
} from './decision.ts';
import { fingerprintFacts, hashString, type FactDefinition, type FactSet } from './facts.ts';
import type { RuleRegistry, RuleSet } from './registry.ts';
import { appliesInState, isEffectiveOn, specificity, type Rule } from './rule.ts';

/**
 * `production` refuses any rule that is not APPROVED, so an unreviewed rule can never produce a
 * compliance answer for a real business. `development` allows DRAFT rules and says so in every
 * decision it returns.
 */
export type EngineMode = 'production' | 'development';

export interface EvaluateInput {
  readonly topic: string;
  readonly facts: FactSet;
  /** The date the decision is about. Never `new Date()`. */
  readonly documentDate: IsoDate;
  /** Used to pick a state-specific rule over an all-India one. */
  readonly stateCode?: string;
  /** Omit to use the newest rule set published on or before `documentDate`. */
  readonly ruleSetVersion?: string;
}

export interface RulesEngineOptions {
  readonly registry: RuleRegistry;
  readonly ruleSetId: string;
  readonly mode: EngineMode;
}

const CANNOT_DECIDE_TEMPLATES = {
  noRule: {
    'en-IN': 'We do not have a rule for {topic} yet, so we will not put a figure on this.',
    'hi-IN': '{topic} ke liye abhi hamare paas niyam nahin hai, isliye hum koi aankda nahin lagayenge.',
  },
  conflict: {
    'en-IN': 'Two rules for {topic} disagree and neither takes precedence, so a person must decide.',
    'hi-IN': '{topic} ke do niyam alag kehte hain aur koi bhi upar nahin hai, isliye faisla ek vyakti karega.',
  },
  missing: {
    'en-IN': 'We cannot decide {topic} yet. We still need: {missing}.',
    'hi-IN': '{topic} abhi tay nahin ho sakta. Abhi chahiye: {missing}.',
  },
} as const;

const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_whole, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw invalid('RULES_EXPLANATION_PLACEHOLDER', `A rule explanation needs a value for {${name}} and did not get one.`);
    }
    return value;
  });

export class RulesEngine {
  readonly #registry: RuleRegistry;
  readonly #ruleSetId: string;
  readonly #mode: EngineMode;

  constructor(options: RulesEngineOptions) {
    this.#registry = options.registry;
    this.#ruleSetId = options.ruleSetId;
    this.#mode = options.mode;
  }

  /** Decide, with the full trace of what was considered and why. */
  evaluate(input: EvaluateInput): DecisionWithTrace {
    // The newest published rulebook, not the one that existed on the document date. Effective
    // dating is a property of each *rule*, so a correction published today must still apply to a
    // bill dated in April. Reproducing what we would have said in April is `replay`, which
    // reloads the rule-set version the original decision recorded.
    const set =
      input.ruleSetVersion === undefined
        ? this.#registry.latest(this.#ruleSetId)
        : this.#registry.get(this.#ruleSetId, input.ruleSetVersion);
    return this.#decide(set, input);
  }

  /**
   * The simulation entry point. Identical to `evaluate` and guaranteed side-effect free, so a
   * screen may run "what if the value were ₹60,000?" without touching anything.
   */
  simulate(input: EvaluateInput): DecisionWithTrace {
    return this.evaluate(input);
  }

  /**
   * Reproduces a past decision under the rules it actually used.
   *
   * `matches` is false when the same facts and the same rule-set version now produce a different
   * answer, which means a released rule set was edited. That is a release-blocking defect under
   * issue #48, so this returns it rather than throwing.
   */
  replay(previous: Decision, facts: FactSet, stateCode?: string): { matches: boolean; decision: Decision } {
    const set = this.#registry.get(previous.ruleSetId, previous.ruleSetVersion);
    const { decision } = this.#decide(set, {
      topic: previous.topic,
      facts,
      documentDate: previous.documentDate,
      ...(stateCode === undefined ? {} : { stateCode }),
    });
    return { matches: decision.decisionFingerprint === previous.decisionFingerprint, decision };
  }

  #decide(set: RuleSet, input: EvaluateInput): DecisionWithTrace {
    const considered: ConsideredRule[] = [];
    const factDefs = new Map<string, FactDefinition>(set.facts.map((f) => [f.id, f]));

    const eligible: Rule[] = [];
    for (const rule of [...set.rules].sort((a, b) => `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`))) {
      if (rule.topic !== input.topic) {
        continue; // A different topic is not "considered"; it was never in the running.
      }
      if (!isEffectiveOn(rule, input.documentDate)) {
        considered.push({ ruleId: rule.id, ruleVersion: rule.version, used: false, reason: 'not-effective-on-this-date' });
        continue;
      }
      if (!appliesInState(rule, input.stateCode)) {
        considered.push({ ruleId: rule.id, ruleVersion: rule.version, used: false, reason: 'different-state' });
        continue;
      }
      if (this.#mode === 'production' && rule.reviewState !== 'APPROVED') {
        considered.push({ ruleId: rule.id, ruleVersion: rule.version, used: false, reason: 'not-approved' });
        continue;
      }
      if (rule.reviewState === 'WITHDRAWN' || rule.reviewState === 'SUPERSEDED') {
        considered.push({ ruleId: rule.id, ruleVersion: rule.version, used: false, reason: 'not-approved' });
        continue;
      }
      if (rule.appliesWhen !== undefined && !rule.appliesWhen(input.facts)) {
        considered.push({ ruleId: rule.id, ruleVersion: rule.version, used: false, reason: 'does-not-apply' });
        continue;
      }
      eligible.push(rule);
    }

    if (eligible.length === 0) {
      return this.#cannotDecide(set, input, considered, 'noRule', { topic: input.topic }, []);
    }

    // More specific beats less specific; then higher priority; then the rule that came into force
    // most recently. Anything still tied is a genuine conflict and is never broken arbitrarily.
    const ranked = [...eligible].sort((a, b) => {
      const bySpecificity = specificity(b) - specificity(a);
      if (bySpecificity !== 0) return bySpecificity;
      const byPriority = b.priority - a.priority;
      if (byPriority !== 0) return byPriority;
      return b.effectiveFrom.localeCompare(a.effectiveFrom);
    });

    const best = ranked[0] as Rule;
    const tied = ranked.filter(
      (r) => specificity(r) === specificity(best) && r.priority === best.priority && r.effectiveFrom === best.effectiveFrom,
    );
    if (tied.length > 1) {
      for (const r of ranked) {
        considered.push({ ruleId: r.id, ruleVersion: r.version, used: false, reason: 'lower-priority' });
      }
      const names = tied.map((r) => `${r.id}@${r.version}`).sort();
      const result = this.#cannotDecide(set, input, considered, 'conflict', { topic: input.topic }, []);
      return { decision: result.decision, trace: { considered, unresolvedConflict: names } };
    }

    for (const r of ranked.slice(1)) {
      considered.push({
        ruleId: r.id,
        ruleVersion: r.version,
        used: false,
        reason: specificity(r) < specificity(best) ? 'less-specific' : 'lower-priority',
      });
    }

    const missingIds = best.requires.filter((id) => !input.facts.has(id));
    if (missingIds.length > 0) {
      considered.push({ ruleId: best.id, ruleVersion: best.version, used: false, reason: 'used' });
      return this.#cannotDecide(set, input, considered, 'missing', { topic: input.topic }, missingIds, best, factDefs);
    }

    const outcome = best.evaluate(input.facts);
    considered.push({ ruleId: best.id, ruleVersion: best.version, used: true, reason: 'used' });

    const declaredMissing = outcome.missingFacts ?? [];
    if (declaredMissing.length > 0) {
      return this.#cannotDecide(set, input, considered, 'missing', { topic: input.topic }, [...declaredMissing], best, factDefs);
    }

    const evidence = this.#evidenceFor(input.facts, outcome.usedFacts, factDefs);
    const explanation = {
      'en-IN': fill(best.explanation['en-IN'], outcome.explanationValues),
      'hi-IN': fill(best.explanation['hi-IN'], outcome.explanationValues),
    };

    const decision = this.#seal({
      topic: input.topic,
      outcome: outcome.outcome,
      documentDate: input.documentDate,
      ruleSetId: set.id,
      ruleSetVersion: set.version,
      ruleId: best.id,
      ruleVersion: best.version,
      ruleKind: best.kind,
      ruleReviewState: best.reviewState,
      effectiveFrom: best.effectiveFrom,
      sourceRef: best.sourceRef,
      evidence,
      missingFacts: [],
      explanation,
      computed: outcome.computed ?? {},
      factsFingerprint: fingerprintFacts(input.facts),
    });

    return { decision, trace: { considered } };
  }

  #evidenceFor(
    facts: FactSet,
    usedFacts: readonly string[],
    defs: ReadonlyMap<string, FactDefinition>,
  ): Evidence[] {
    return usedFacts.flatMap((id) => {
      const known = facts.get(id);
      if (known === undefined) return [];
      const label = defs.get(id)?.label['en-IN'] ?? id;
      const base: Evidence = { factId: id, label, value: describeFactValue(known.value), source: known.source };
      return [known.confidence === undefined ? base : { ...base, confidence: known.confidence }];
    });
  }

  #cannotDecide(
    set: RuleSet,
    input: EvaluateInput,
    considered: ConsideredRule[],
    template: keyof typeof CANNOT_DECIDE_TEMPLATES,
    values: Readonly<Record<string, string>>,
    missingIds: readonly string[],
    rule?: Rule,
    defs?: ReadonlyMap<string, FactDefinition>,
  ): DecisionWithTrace {
    const missingFacts: MissingFact[] = missingIds.map((id) => {
      const def = defs?.get(id);
      return {
        factId: id,
        label: def?.label['en-IN'] ?? id,
        whyNeeded: def?.whyNeeded['en-IN'] ?? 'This rule cannot be applied without it.',
      };
    });
    const withMissing = {
      ...values,
      missing: missingFacts.map((m) => m.label).join(', '),
    };
    const decision = this.#seal({
      topic: input.topic,
      outcome: 'CANNOT_DECIDE',
      documentDate: input.documentDate,
      ruleSetId: set.id,
      ruleSetVersion: set.version,
      ruleId: rule?.id ?? null,
      ruleVersion: rule?.version ?? null,
      ruleKind: rule?.kind ?? null,
      ruleReviewState: rule?.reviewState ?? null,
      effectiveFrom: rule?.effectiveFrom ?? null,
      sourceRef: rule?.sourceRef ?? null,
      evidence: this.#evidenceFor(input.facts, rule?.requires.filter((id) => input.facts.has(id)) ?? [], defs ?? new Map()),
      missingFacts,
      explanation: {
        'en-IN': fill(CANNOT_DECIDE_TEMPLATES[template]['en-IN'], withMissing),
        'hi-IN': fill(CANNOT_DECIDE_TEMPLATES[template]['hi-IN'], withMissing),
      },
      computed: {},
      factsFingerprint: fingerprintFacts(input.facts),
    });
    return { decision, trace: { considered } };
  }

  /** Adds the fingerprint last, over everything else, so a decision cannot be altered unnoticed. */
  #seal(partial: Omit<Decision, 'decisionFingerprint'>): Decision {
    const canonical = [
      partial.topic,
      partial.outcome,
      partial.documentDate,
      partial.ruleSetId,
      partial.ruleSetVersion,
      partial.ruleId ?? '',
      partial.ruleVersion ?? '',
      partial.sourceRef ?? '',
      partial.factsFingerprint,
      partial.evidence.map((e) => `${e.factId}=${e.value}@${e.source}`).join(','),
      partial.missingFacts.map((m) => m.factId).join(','),
      Object.keys(partial.computed).sort().map((k) => `${k}=${partial.computed[k]}`).join(','),
      partial.explanation['en-IN'],
    ].join('§');
    return { ...partial, decisionFingerprint: hashString(canonical) };
  }
}
