/**
 * Issue #7 [E07] — turning "we cannot decide" into a piece of work for a person.
 *
 * The engine never resolves its own uncertainty. When it cannot decide, it produces an exception
 * draft: what was being decided, what was known, what is still needed, and in whose words. The
 * exception queue itself belongs to GPT 2's issue #6; this is the payload handed to it.
 */
import type { Decision } from './decision.ts';

export interface ExceptionDraft {
  /** Stable for one decision, so handing the same decision over twice does not queue two items. */
  readonly idempotencyKey: string;
  readonly kind: 'RULE_CANNOT_DECIDE';
  readonly topic: string;
  readonly documentDate: string;
  readonly ruleSetId: string;
  readonly ruleSetVersion: string;
  readonly ruleId: string | null;
  readonly ruleVersion: string | null;
  /** One plain sentence, ready for a screen. */
  readonly summary: { readonly 'en-IN': string; readonly 'hi-IN': string };
  /** What a person must supply or confirm, in their words. */
  readonly needs: readonly { factId: string; label: string; whyNeeded: string }[];
  /** What we already knew, so the person is not asked to repeat themselves. */
  readonly known: readonly { factId: string; label: string; value: string; source: string }[];
}

/**
 * Builds the exception draft for a decision that could not be made.
 *
 * Returns `null` for a decision that *was* made, so a caller can pipe every decision through this
 * without branching, and cannot accidentally queue an exception for a successful answer.
 */
export const toExceptionDraft = (decision: Decision, source: { kind: string; id: string }): ExceptionDraft | null => {
  if (decision.outcome !== 'CANNOT_DECIDE') return null;
  return {
    idempotencyKey: `rules:${source.kind}:${source.id}:${decision.topic}:${decision.decisionFingerprint}`,
    kind: 'RULE_CANNOT_DECIDE',
    topic: decision.topic,
    documentDate: decision.documentDate,
    ruleSetId: decision.ruleSetId,
    ruleSetVersion: decision.ruleSetVersion,
    ruleId: decision.ruleId,
    ruleVersion: decision.ruleVersion,
    summary: decision.explanation,
    needs: decision.missingFacts.map((m) => ({ factId: m.factId, label: m.label, whyNeeded: m.whyNeeded })),
    known: decision.evidence.map((e) => ({ factId: e.factId, label: e.label, value: e.value, source: e.source })),
  };
};
