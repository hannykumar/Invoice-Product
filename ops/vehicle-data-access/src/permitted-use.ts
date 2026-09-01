/**
 * Issue #53 [X05] — what we promise the authority we will do with the data, and what the code has
 * to enforce for that promise to be true.
 *
 * Permitted use is where an application is usually won or lost, and where a product usually starts
 * lying without meaning to. The terms are agreed once, by a person, in a document — and then the
 * software is changed a dozen times by people who never read it. So each term here carries the
 * thing in the code that keeps it true, and the ones that can be checked automatically are.
 */
import { DEFAULT_VEHICLE_RECORD_FRESHNESS } from '../../../packages/transport/src/vehicle-record-types.ts';
import type { VehicleRecordFreshnessPolicy } from '../../../packages/transport/src/vehicle-record-types.ts';
import type { Bilingual } from './model.ts';

export interface PermittedUseTerm {
  readonly id: string;
  /** The undertaking, in the words that go on the application. */
  readonly rule: string;
  /** What in the product makes it true, rather than a promise somebody has to remember. */
  readonly enforcedBy: string;
}

/**
 * The undertakings.
 *
 * The last two are the ones an authority actually worries about — bulk enumeration and secondary
 * use — and they are the two most software gets wrong by growing into them: a lookup screen becomes
 * a spreadsheet upload, a suitability check becomes a background "vehicle enrichment" job, and
 * nobody ever decided to do either.
 */
export const permittedUseTerms = (): readonly PermittedUseTerm[] => Object.freeze([
  {
    id: 'purpose',
    rule: 'A vehicle record is read for one purpose only: deciding whether a specific consignment may be dispatched on a specific vehicle.',
    enforcedBy: 'The purpose is a single-valued type in #29 and travels on every request. A second purpose is a code change and an audit entry.',
  },
  {
    id: 'consent',
    rule: 'A record is read only on behalf of a business that has given dated consent naming the purpose and the fields, and only while that consent is live.',
    enforcedBy: '#29 refuses the lookup with `NOT_CONNECTED` or `CONSENT_EXPIRED` rather than calling the provider.',
  },
  {
    id: 'fields',
    rule: 'Only the approved fields are requested, and anything else in a response is discarded before storage.',
    enforcedBy: 'The allow-list is applied inside `normaliseVehicleRecord`, at the boundary, not in the caller.',
  },
  {
    id: 'owner_name',
    rule: 'The registered owner’s name is stored only as initials.',
    enforcedBy: '`maskOwnerName` runs before the evidence object is built, so the full name never enters storage or memory beyond the parse.',
  },
  {
    id: 'no_bulk',
    rule: 'No bulk enumeration. A lookup is made for a vehicle a business has entered on a movement it is about to dispatch — never for a list, a file of numbers, or a range.',
    enforcedBy: 'The service takes one registration number per call, from a movement. There is no batch entry point, and adding one would be a visible change.',
  },
  {
    id: 'no_secondary_use',
    rule: 'Vehicle data is not used to build a vehicle database, is not sold, is not shared between businesses on the platform, and is not used for any analysis about the owner.',
    enforcedBy: 'Records are stored per company and read back per company; there is no cross-tenant read path.',
  },
  {
    id: 'no_scraping',
    rule: 'The public VAHAN and mParivahan portals are not read by this product, with or without a provider.',
    enforcedBy: 'The only vehicle connector goes through #8’s gateway to an authorised provider. A scraping route would be a new connector, reviewed as one.',
  },
  {
    id: 'deletion',
    rule: 'When a business leaves, or asks, its stored readings are deleted.',
    enforcedBy: '#29’s cache exposes a per-company forget, and the readings are keyed by company.',
  },
]);

/**
 * How long a reading is kept, and why it is not simply deleted when it goes stale.
 *
 * A stale reading is not evidence of today, and #29 refuses to present it as such. It is still the
 * evidence somebody dispatched on, and a dispatch that was later questioned — by a check post, by a
 * buyer, by an insurer — has to be explainable in terms of what was known at the time. Deleting it
 * would be a privacy gesture that destroys the audit trail the same authority would expect us to
 * have.
 */
export const RETENTION = Object.freeze({
  auditYears: 8,
  why: 'A dispatch decision has to remain explainable for as long as the underlying tax records are kept, so the reading behind it is retained as evidence — shown with its date and never as a current fact.',
});

/** A caching term is met when what the code does is inside what the provider allows. */
export interface CachingReview {
  readonly permittedHours: number | null;
  readonly reuseHours: number;
  readonly withinTerms: boolean;
  readonly note: Bilingual;
}

/**
 * Compares #29's reuse window against what a provider permits.
 *
 * A provider that allows no caching at all is not a disqualifier; it is a cost decision and a
 * change to the freshness policy, which is why the policy is data with an effective date rather
 * than a constant somebody would have to hunt for.
 */
export const reviewCaching = (
  permittedHours: number | null,
  policy: VehicleRecordFreshnessPolicy = DEFAULT_VEHICLE_RECORD_FRESHNESS,
): CachingReview => {
  if (permittedHours === null) {
    return {
      permittedHours: null,
      reuseHours: policy.reuseWithinHours,
      withinTerms: false,
      note: {
        'en-IN': `Nobody has told us how long a response may be kept, and the product reuses one for ${policy.reuseWithinHours} hours. Ask before the first real lookup, not after.`,
        'hi-IN': `Kisi ne nahi bataya ki javaab kitni der rakha ja sakta hai, aur product ${policy.reuseWithinHours} ghante tak use dobara istemal karta hai. Pehli asli lookup se pehle poochhein.`,
      },
    };
  }
  const withinTerms = policy.reuseWithinHours <= permittedHours;
  return {
    permittedHours,
    reuseHours: policy.reuseWithinHours,
    withinTerms,
    note: withinTerms
      ? {
        'en-IN': `The provider permits ${permittedHours} hours and the product reuses a reading for ${policy.reuseWithinHours}.`,
        'hi-IN': `Provider ${permittedHours} ghante ki anumati deta hai aur product ${policy.reuseWithinHours} ghante tak dobara istemal karta hai.`,
      }
      : {
        'en-IN': `The product reuses a reading for ${policy.reuseWithinHours} hours but the provider permits only ${permittedHours}. The freshness policy has to be narrowed before going live, which means more calls and a higher bill.`,
        'hi-IN': `Product ${policy.reuseWithinHours} ghante tak dobara istemal karta hai, par provider sirf ${permittedHours} ghante ki anumati deta hai. Live jaane se pehle policy badalni hogi.`,
      },
  };
};
