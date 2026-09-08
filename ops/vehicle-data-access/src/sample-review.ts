/**
 * Issue #53 [X05] — reviewing a provider's sample response against what #28 actually needs.
 *
 * This is the check to run on the day a provider sends a sample payload, before anybody signs
 * anything, and it answers two questions that a demo call never does.
 *
 * **Can the rules decide with this?** A response can be complete, well-formed and useless: a record
 * that gives a class and no weights cannot answer "can this lorry carry five tonnes", and a product
 * whose promise is accuracy would have to say "cannot decide" on every movement. The review names
 * which of #28's checks the sample can and cannot feed.
 *
 * **Does anything we did not ask for get through?** The review runs the real boundary — #29's
 * `normaliseVehicleRecord` with the requested field list — over the provider's own payload, and
 * looks for any declined field surviving into the stored evidence. A provider that returns the
 * owner's address is a fact about that provider worth knowing before signing, even though our
 * boundary drops it.
 */
import { normaliseVehicleRecord } from '../../../packages/transport/src/vehicle-record.ts';
import type { PermittedVehicleField } from '../../../packages/transport/src/vehicle-record-types.ts';
import type { VehicleEvidence } from '../../../packages/transport/src/suitability-types.ts';
import { DECLINED_FIELDS, REQUESTED_FIELDS } from './fields.ts';
import type { Bilingual } from './model.ts';

/**
 * What each of #28's checks needs off the record to be able to run at all.
 *
 * A check with none of its fields present does not fail safe by returning "fine"; #28 returns
 * `CANNOT_DECIDE`, which is honest and is also a check that is not doing anything. That is the
 * thing to discover from a sample response rather than from a customer.
 */
export const E28_NEEDS: Readonly<Record<string, readonly PermittedVehicleField[]>> = Object.freeze({
  'VEHICLE.CLASS.NOT_GOODS_CARRYING': ['vehicleClass'],
  'VEHICLE.CLASS.OVER_CEILING': ['vehicleClass'],
  'VEHICLE.CAPACITY.EXCEEDED': ['ratedPayloadKg', 'grossVehicleWeightKg', 'unladenWeightKg'],
  'VEHICLE.CAPACITY.NEAR_LIMIT': ['ratedPayloadKg', 'grossVehicleWeightKg', 'unladenWeightKg'],
  'VEHICLE.BODY.NOT_REFRIGERATED': ['bodyType'],
  'VEHICLE.BODY.NOT_TANKER': ['bodyType'],
  'VEHICLE.BODY.HAZARDOUS': ['bodyType'],
  'VEHICLE.PERMIT.WRONG_KIND': ['permitType'],
  'VEHICLE.PERMIT.EXPIRED': ['permitValidUpto'],
  'VEHICLE.FITNESS.EXPIRED': ['fitnessValidUpto'],
  'VEHICLE.INSURANCE.EXPIRED': ['insuranceValidUpto'],
  'VEHICLE.REGISTRATION.NOT_ACTIVE': ['registrationStatus'],
});

export interface CheckCoverage {
  readonly code: string;
  /** True when at least one field the check reads came through. */
  readonly canRun: boolean;
  readonly present: readonly string[];
  readonly absent: readonly string[];
}

export interface SampleReview {
  readonly provider: string;
  readonly registrationNumber: string;
  readonly evidence: VehicleEvidence;
  /** #29’s own plain sentences about what the record did not say or could not be read. */
  readonly gaps: readonly string[];
  readonly coverage: readonly CheckCoverage[];
  /** Checks that could not run at all on this sample. The reason to go back to the provider. */
  readonly checksThatCannotRun: readonly string[];
  /** Declined fields the provider sent anyway. Not a failure — a fact about them. */
  readonly declinedFieldsOffered: readonly string[];
  /**
   * Declined fields that survived into the stored evidence.
   *
   * This must always be empty. If it ever is not, the boundary has stopped working and the review
   * fails outright, whatever else the sample showed.
   */
  readonly declinedFieldsLeaked: readonly string[];
  readonly passed: boolean;
  readonly summary: Bilingual;
}

const evidenceHas = (evidence: VehicleEvidence, field: string): boolean =>
  (evidence as unknown as Readonly<Record<string, unknown>>)[field] !== undefined;

/**
 * Runs a provider's sample payload through the real boundary and reports what it can support.
 *
 * `keys` is how a provider that does not use VAHAN's own field names is reviewed: the mapping is
 * part of what we are assessing, because a provider whose field names cannot be mapped is a
 * provider whose adapter is a bigger job than it looks.
 */
export const reviewSampleResponse = (
  provider: string,
  payload: Readonly<Record<string, unknown>>,
  options: {
    readonly registrationNumber: string;
    readonly retrievedAt: string;
    readonly keys?: Parameters<typeof normaliseVehicleRecord>[1]['keys'];
  },
): SampleReview => {
  const requested = REQUESTED_FIELDS.map((request) => request.field) as readonly PermittedVehicleField[];
  const { evidence, gaps } = normaliseVehicleRecord(payload, {
    registrationNumber: options.registrationNumber,
    retrievedAt: options.retrievedAt,
    allowedFields: requested,
    ...(options.keys === undefined ? {} : { keys: options.keys }),
  });

  const coverage: CheckCoverage[] = Object.entries(E28_NEEDS).map(([code, needs]) => {
    const present = needs.filter((field) => evidenceHas(evidence, field));
    return {
      code,
      canRun: present.length > 0,
      present: Object.freeze(present),
      absent: Object.freeze(needs.filter((field) => !evidenceHas(evidence, field))),
    };
  });

  const offered = DECLINED_FIELDS
    .filter((field) => payload[field.providerKey] !== undefined)
    .map((field) => field.providerKey);
  // The stored evidence is a fixed shape, so a declined field can only "leak" by having been mapped
  // onto one of our own field names. Checked by value as well as by key, because a provider that
  // put the owner's address into the owner-name field would pass a key check and fail a person.
  const stored = JSON.stringify(evidence);
  const leaked = DECLINED_FIELDS
    .filter((field) => {
      const value = payload[field.providerKey];
      return typeof value === 'string' && value.trim() !== '' && stored.includes(value.trim());
    })
    .map((field) => field.providerKey);

  const cannotRun = coverage.filter((item) => !item.canRun).map((item) => item.code);
  const passed = leaked.length === 0;

  return {
    provider,
    registrationNumber: options.registrationNumber,
    evidence,
    gaps,
    coverage: Object.freeze(coverage),
    checksThatCannotRun: Object.freeze(cannotRun),
    declinedFieldsOffered: Object.freeze(offered),
    declinedFieldsLeaked: Object.freeze(leaked),
    passed,
    summary: !passed
      ? {
        'en-IN': `${provider} sent ${leaked.length} fields we did not ask for and they reached the stored record. Nothing else about this sample matters until that is fixed.`,
        'hi-IN': `${provider} ne ${leaked.length} aise field bheje jo hamne maange hi nahi the, aur woh record tak pahunch gaye. Pehle yahi theek karna hoga.`,
      }
      : cannotRun.length === 0
        ? {
          'en-IN': `${provider}’s sample supports all ${coverage.length} vehicle checks, and the ${offered.length} fields it offered that we did not ask for were dropped at the boundary.`,
          'hi-IN': `${provider} ka namoona sabhi ${coverage.length} jaanchon ke liye kaafi hai, aur ${offered.length} bin maange field seema par hata diye gaye.`,
        }
        : {
          'en-IN': `${provider}’s sample cannot support ${cannotRun.length} of ${coverage.length} vehicle checks: ${cannotRun.join(', ')}. Ask whether those fields are available on a different plan before assuming they are not.`,
          'hi-IN': `${provider} ka namoona ${coverage.length} mein se ${cannotRun.length} jaanchon ke liye kaafi nahi: ${cannotRun.join(', ')}. Poochhein ki kya yeh field kisi aur plan mein milte hain.`,
        },
  };
};
