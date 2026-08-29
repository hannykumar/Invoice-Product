/**
 * Issue #48 [E48] — the things that must be true before a release ships.
 *
 * Each gate is a **pure function over an observation**, not a test that pokes a live system. That
 * shape is deliberate and it is what makes the whole exercise honest:
 *
 *  - the runner collects the observation from the real modules, so the gate checks reality;
 *  - a test can hand the same function a deliberately corrupted observation and require it to fail,
 *    which is how we know the gate has teeth rather than merely a name.
 *
 * A gate that cannot be evaluated **fails**. Anything else is a gate that goes quiet exactly when
 * something has gone wrong enough to break the check itself.
 */

export type Severity = 'CRITICAL' | 'MAJOR';

export interface GateResult {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  readonly passed: boolean;
  /** What a person reads when this fails. Names the figure, not the function. */
  readonly detail: string;
  /** How many things the gate actually looked at. Zero is suspicious and the runner says so. */
  readonly examined: number;
}

const pass = (id: string, title: string, severity: Severity, examined: number, detail: string): GateResult => ({
  id, title, severity, passed: true, detail, examined,
});
const fail = (id: string, title: string, severity: Severity, examined: number, detail: string): GateResult => ({
  id, title, severity, passed: false, detail, examined,
});

// ------------------------------------------------------------------------------ what a gate sees

export interface VoucherObservation {
  readonly id: string;
  readonly number: string;
  readonly state: string;
  /** Paise, so no float ever touches the comparison. */
  readonly debits: bigint;
  readonly credits: bigint;
}

export interface StockObservation {
  readonly itemId: string;
  readonly warehouseId: string;
  /** Micro-units. Negative is only allowed with a recorded override. */
  readonly physical: bigint;
  readonly overrideReason: string | null;
  readonly overrideAllowedBy: string | null;
}

export interface TaxObservation {
  readonly documentNumber: string;
  readonly cgst: bigint;
  readonly sgst: bigint;
  readonly utgst: bigint;
  readonly igst: bigint;
  readonly cess: bigint;
  readonly totalTax: bigint;
}

export interface RetryObservation {
  readonly idempotencyKey: string;
  readonly firstResultId: string;
  readonly secondResultId: string;
  readonly documentsCreated: number;
}

export interface RuleObservation {
  readonly ruleSetId: string;
  readonly ruleId: string;
  readonly kind: string;
  readonly reviewState: string;
  readonly sourceRef: string | null;
  readonly effectiveFrom: string | null;
}

export interface ModelFieldObservation {
  readonly field: string;
  readonly source: string;
  readonly confidence: number;
  /** True when the value was taken as decided rather than turned into a question. */
  readonly acceptedWithoutAsking: boolean;
}

export interface ImmutabilityObservation {
  readonly voucherId: string;
  readonly state: string;
  /** Whether an attempt to change it after it was final was refused. */
  readonly editRefused: boolean;
}

export interface GoldenObservation {
  readonly fixtureId: string;
  readonly mismatches: readonly string[];
}

// ------------------------------------------------------------------------------------- the gates

/**
 * Every posted voucher puts the same amount on both sides.
 *
 * This is the first rule of the product and the one every other financial figure rests on. A
 * single unbalanced voucher means something wrote to storage without going through the ledger.
 */
export const everyVoucherBalances = (vouchers: readonly VoucherObservation[]): GateResult => {
  const id = 'LEDGER_VOUCHERS_BALANCE';
  const title = 'Every recorded entry puts the same amount on both sides';
  const posted = vouchers.filter((voucher) => voucher.state !== 'DRAFT');
  const broken = posted.filter((voucher) => voucher.debits !== voucher.credits);
  if (broken.length > 0) {
    const worst = broken[0] as VoucherObservation;
    return fail(id, title, 'CRITICAL', posted.length,
      `${broken.length} entries do not balance. ${worst.number} has ${worst.debits} paise on one side and ${worst.credits} on the other.`);
  }
  return pass(id, title, 'CRITICAL', posted.length, `${posted.length} recorded entries all balance.`);
};

/** The two sides of the whole book meet. */
export const trialBalanceIsLevel = (totalDebits: bigint, totalCredits: bigint, examined: number): GateResult => {
  const id = 'LEDGER_TRIAL_BALANCE';
  const title = 'The two sides of the books come to the same figure';
  if (totalDebits !== totalCredits) {
    return fail(id, title, 'CRITICAL', examined,
      `The books are out by ${totalDebits - totalCredits} paise: ${totalDebits} against ${totalCredits}.`);
  }
  return pass(id, title, 'CRITICAL', examined, `Both sides come to ${totalDebits} paise.`);
};

/**
 * Stock never goes below zero without somebody authorising it and saying why.
 *
 * Negative stock itself is not the defect. Negative stock that nobody allowed and nobody explained
 * is, because it means goods left the godown with no record of the decision.
 */
export const stockNeverSilentlyNegative = (balances: readonly StockObservation[]): GateResult => {
  const id = 'STOCK_NEVER_SILENTLY_NEGATIVE';
  const title = 'Stock never goes below zero without someone allowing it and saying why';
  const unexplained = balances.filter(
    (balance) => balance.physical < 0n && (balance.overrideReason === null || balance.overrideReason.trim() === '' || balance.overrideAllowedBy === null),
  );
  if (unexplained.length > 0) {
    const worst = unexplained[0] as StockObservation;
    return fail(id, title, 'CRITICAL', balances.length,
      `${worst.itemId} at ${worst.warehouseId} is ${worst.physical} with nobody recorded as having allowed it.`);
  }
  return pass(id, title, 'CRITICAL', balances.length, `${balances.length} stock positions checked, none unexplained.`);
};

/** The parts of the tax add up to the tax. */
export const taxPartsSumToTotal = (documents: readonly TaxObservation[]): GateResult => {
  const id = 'TAX_PARTS_SUM_TO_TOTAL';
  const title = 'The parts of the GST on a bill add up to the GST charged';
  const broken = documents.filter(
    (doc) => doc.cgst + doc.sgst + doc.utgst + doc.igst + doc.cess !== doc.totalTax,
  );
  if (broken.length > 0) {
    const worst = broken[0] as TaxObservation;
    const parts = worst.cgst + worst.sgst + worst.utgst + worst.igst + worst.cess;
    return fail(id, title, 'CRITICAL', documents.length,
      `${worst.documentNumber} shows ${worst.totalTax} paise of GST, but its parts come to ${parts}.`);
  }
  return pass(id, title, 'CRITICAL', documents.length, `${documents.length} bills checked, every split adds up.`);
};

/**
 * Pressing the button twice records one thing.
 *
 * This is the gate the issue's own example names: a duplicated posting on retry. It is checked by
 * actually retrying, not by inspecting a key.
 */
export const retriesAreIdempotent = (retries: readonly RetryObservation[]): GateResult => {
  const id = 'RETRY_IS_IDEMPOTENT';
  const title = 'Doing the same thing twice records it once';
  const broken = retries.filter((retry) => retry.firstResultId !== retry.secondResultId || retry.documentsCreated !== 1);
  if (broken.length > 0) {
    const worst = broken[0] as RetryObservation;
    return fail(id, title, 'CRITICAL', retries.length,
      `Retrying "${worst.idempotencyKey}" produced ${worst.documentsCreated} records (${worst.firstResultId} then ${worst.secondResultId}).`);
  }
  return pass(id, title, 'CRITICAL', retries.length, `${retries.length} retries each recorded one thing.`);
};

/**
 * A rule the product treats as settled law must say where it came from and when it took effect.
 *
 * An APPROVED rule with no source is a number somebody typed. This is the release-time half of
 * #54's compliance register: the register refuses to approve without a source, and this refuses to
 * ship if one ever slips through.
 */
export const approvedRulesCiteASource = (rules: readonly RuleObservation[]): GateResult => {
  const id = 'APPROVED_RULES_CITE_A_SOURCE';
  const title = 'Every settled compliance rule names its source and the date it took effect';
  const approved = rules.filter((rule) => rule.reviewState === 'APPROVED' && rule.kind === 'COMPLIANCE');
  const unsourced = approved.filter(
    (rule) => rule.sourceRef === null || rule.sourceRef.trim() === '' || rule.effectiveFrom === null,
  );
  if (unsourced.length > 0) {
    const worst = unsourced[0] as RuleObservation;
    return fail(id, title, 'CRITICAL', approved.length,
      `${worst.ruleId} in ${worst.ruleSetId} is treated as settled but names no source.`);
  }
  return pass(id, title, 'CRITICAL', approved.length, `${approved.length} settled rules all name a source and a date.`);
};

/**
 * What a model heard is never taken as decided while it is unsure.
 *
 * The product's line is that a model may turn sound into text and nothing more. Below the material
 * threshold the product must ask rather than assume, and a release that starts assuming has
 * crossed the line quietly.
 */
export const uncertainModelOutputIsAskedAbout = (
  fields: readonly ModelFieldObservation[],
  materialConfidence: number,
): GateResult => {
  const id = 'UNCERTAIN_MODEL_OUTPUT_IS_ASKED_ABOUT';
  const title = 'Anything the app was unsure it heard is asked about, not assumed';
  const assumed = fields.filter((field) => field.confidence < materialConfidence && field.acceptedWithoutAsking);
  if (assumed.length > 0) {
    const worst = assumed[0] as ModelFieldObservation;
    return fail(id, title, 'CRITICAL', fields.length,
      `"${worst.field}" was taken as decided at ${worst.confidence} confidence, below the ${materialConfidence} the product requires.`);
  }
  return pass(id, title, 'CRITICAL', fields.length, `${fields.length} heard fields checked, none assumed while unsure.`);
};

/** A final record is never edited. Corrections are reversals, and both entries stay visible. */
export const finalRecordsAreImmutable = (attempts: readonly ImmutabilityObservation[]): GateResult => {
  const id = 'FINAL_RECORDS_ARE_IMMUTABLE';
  const title = 'A finished record is never quietly changed';
  const allowed = attempts.filter((attempt) => attempt.state !== 'DRAFT' && !attempt.editRefused);
  if (allowed.length > 0) {
    return fail(id, title, 'CRITICAL', attempts.length,
      `${allowed.length} finished records could be changed after the fact, starting with ${allowed[0]?.voucherId}.`);
  }
  return pass(id, title, 'CRITICAL', attempts.length, `${attempts.length} attempts to change a finished record were all refused.`);
};

/** The golden dataset still produces exactly the figures it says it should. */
export const goldenDatasetStillMatches = (results: readonly GoldenObservation[]): GateResult => {
  const id = 'GOLDEN_DATASET_MATCHES';
  const title = 'The example businesses still produce the figures they are supposed to';
  const drifted = results.filter((result) => result.mismatches.length > 0);
  if (drifted.length > 0) {
    const worst = drifted[0] as GoldenObservation;
    return fail(id, title, 'CRITICAL', results.length,
      `${worst.fixtureId} no longer matches: ${worst.mismatches.slice(0, 3).join('; ')}`);
  }
  return pass(id, title, 'CRITICAL', results.length, `${results.length} example businesses replay exactly.`);
};
