/**
 * Issue #48 [E48] — running every gate and deciding whether a release may ship.
 *
 * The runner **fails closed**. A gate that throws while being evaluated is reported as failed, not
 * skipped, because the moment a check cannot run is exactly the moment something is wrong enough
 * to matter. A gate that examined nothing is also treated as a failure: a check that silently had
 * no data to look at gives the same green tick as a check that passed, and the two are not the
 * same thing.
 */
import {
  approvedRulesCiteASource,
  everyVoucherBalances,
  finalRecordsAreImmutable,
  goldenDatasetStillMatches,
  retriesAreIdempotent,
  stockNeverSilentlyNegative,
  taxPartsSumToTotal,
  trialBalanceIsLevel,
  uncertainModelOutputIsAskedAbout,
  type GateResult,
} from './invariants.ts';
import type { Observations } from './observe.ts';

export interface GateReport {
  readonly results: readonly GateResult[];
  readonly failures: readonly GateResult[];
  /** True when nothing critical failed, which is the only condition under which a release ships. */
  readonly mayRelease: boolean;
}

/** Wraps one gate so that a check which explodes counts against the release rather than for it. */
const evaluate = (id: string, title: string, run: () => GateResult): GateResult => {
  try {
    const result = run();
    if (result.passed && result.examined === 0) {
      return {
        ...result,
        passed: false,
        detail: `${result.detail} — but nothing was actually examined, so this proves nothing.`,
      };
    }
    return result;
  } catch (error) {
    return {
      id,
      title,
      severity: 'CRITICAL',
      passed: false,
      examined: 0,
      detail: `The check itself could not be completed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

export const runGates = (observations: Observations): GateReport => {
  const results: GateResult[] = [
    evaluate('LEDGER_VOUCHERS_BALANCE', 'Every recorded entry puts the same amount on both sides', () =>
      everyVoucherBalances(observations.vouchers)),
    evaluate('LEDGER_TRIAL_BALANCE', 'The two sides of the books come to the same figure', () =>
      trialBalanceIsLevel(observations.totalDebits, observations.totalCredits, observations.vouchers.length)),
    evaluate('STOCK_NEVER_SILENTLY_NEGATIVE', 'Stock never goes below zero without someone allowing it', () =>
      stockNeverSilentlyNegative(observations.stock)),
    evaluate('TAX_PARTS_SUM_TO_TOTAL', 'The parts of the GST add up to the GST charged', () =>
      taxPartsSumToTotal(observations.tax)),
    evaluate('RETRY_IS_IDEMPOTENT', 'Doing the same thing twice records it once', () =>
      retriesAreIdempotent(observations.retries)),
    evaluate('APPROVED_RULES_CITE_A_SOURCE', 'Every settled compliance rule names its source', () =>
      approvedRulesCiteASource(observations.rules)),
    evaluate('FINAL_RECORDS_ARE_IMMUTABLE', 'A finished record is never quietly changed', () =>
      finalRecordsAreImmutable(observations.immutability)),
    evaluate('GOLDEN_DATASET_MATCHES', 'The example businesses still produce the right figures', () =>
      goldenDatasetStillMatches(observations.golden)),
    evaluate('UNCERTAIN_MODEL_OUTPUT_IS_ASKED_ABOUT', 'Anything the app was unsure it heard is asked about', () =>
      uncertainModelOutputIsAskedAbout(observations.modelFields, observations.materialConfidence)),
  ];

  const failures = results.filter((result) => !result.passed);
  const mayRelease = failures.every((failure) => failure.severity !== 'CRITICAL');
  return { results, failures, mayRelease };
};

/** The report as a person reads it in a CI log. */
export const renderReport = (report: GateReport): string => {
  const lines = ['Financial correctness gates (issue #48)', ''];
  for (const result of report.results) {
    lines.push(`${result.passed ? 'pass' : 'FAIL'}  ${result.title}`);
    lines.push(`      ${result.detail}`);
  }
  lines.push('');
  lines.push(
    report.mayRelease
      ? 'All critical gates passed. This build may be released.'
      : `${report.failures.length} gate(s) failed. This build must not be released.`,
  );
  return lines.join('\n');
};
