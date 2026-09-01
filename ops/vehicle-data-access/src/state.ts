/**
 * Issue #53 [X05] — where the application actually stands, today.
 *
 * Nowhere. No application has been made, because there is no company to make one: #49's register is
 * deliberately empty until somebody incorporates one, and a registering authority does not grant
 * vehicle-record access to a repository.
 *
 * Keeping the truthful empty state here, rather than a plausible-looking filled-in one, is the
 * whole point of the file. `npm run vehicle:access` prints exactly what is missing and what it
 * holds up, so nobody discovers at integration time that the vehicle checking in #28 and #29 has
 * been running against a synthetic authority for months and has never once been proved against a
 * real record.
 *
 * As each step happens, edit this file — and only with what somebody was actually sent, in writing,
 * on a date. The register refuses states that do not carry their own evidence.
 */
import type { ApplicationRecord } from './model.ts';

export const APPLICATIONS: readonly ApplicationRecord[] = Object.freeze([
  {
    providerId: 'api_setu_vahan',
    state: 'NOT_STARTED',
    preparedOn: null,
    submittedOn: null,
    acknowledgementRef: null,
    outstandingQuestions: [],
    approval: null,
    rejectedReason: null,
    note: 'The intended route, and the one #29 was built against. Blocked on the company existing.',
  },
  {
    providerId: 'authorised_reseller',
    state: 'NOT_STARTED',
    preparedOn: null,
    submittedOn: null,
    acknowledgementRef: null,
    outstandingQuestions: [],
    approval: null,
    rejectedReason: null,
    note: 'Worth approaching in parallel: likely to have a sandbox sooner, and the sandbox is what the sample review needs.',
  },
  {
    providerId: 'morth_direct',
    state: 'NOT_STARTED',
    preparedOn: null,
    submittedOn: null,
    acknowledgementRef: null,
    outstandingQuestions: [],
    approval: null,
    rejectedReason: null,
    note: 'Probably not open to a private company. Ask before spending time on it.',
  },
]);

/**
 * What the product does while all of the above says NOT_STARTED.
 *
 * It checks vehicles, against the business's own list and against facts typed off the certificate
 * in the driver's hand, and it says on every screen that the registering authority was not asked.
 * That is a working product with weaker evidence, not a broken one — and saying so plainly here
 * stops the absence of an approval from being read as a feature that does not exist.
 */
export const WITHOUT_APPROVAL = Object.freeze({
  works: [
    'Every vehicle-suitability check in #28 runs, on the business’s own vehicle list and on facts typed in for the movement.',
    'The e-way bill lifecycle in #27 is unaffected: it never needed the registering authority.',
    'A scooter carrying five tonnes is still blocked, because that is arithmetic on facts somebody typed, not a lookup.',
  ],
  doesNot: [
    'No check against the registering authority, so a lorry the business has recorded wrongly stays wrongly recorded.',
    'No `VEHICLE.REGISTRATION.NOT_ACTIVE`: a scrapped or cancelled registration is invisible without the authority’s record.',
    'Fitness, insurance and permit expiry are only as current as what somebody last typed.',
  ],
});
