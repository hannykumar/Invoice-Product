/**
 * Issue #50 [X02] — the providers, and what is honestly known about each.
 *
 * Almost everything below is `UNKNOWN`, and that is the deliverable rather than a gap. The four
 * provider names come from the issue itself. **Nobody has sent us a quotation, granted us a
 * sandbox, or told us what they keep of a customer's invoice data**, so nothing here claims they
 * did. Writing in plausible prices would produce a confident recommendation resting on nothing, and
 * the confident recommendation is precisely the failure this issue exists to prevent — its own
 * objective says "rather than marketing claims".
 *
 * The one candidate that *is* known is the way the product works today: the shopkeeper takes the
 * file we generate to the portal themselves. We know that one because we wrote it and it has tests,
 * and it is in the list because "what happens if we sign nobody" is a real option with a real cost,
 * and comparing against it is how the value of a GSP is measured at all.
 *
 * **To record a real answer**, replace an `unknown()` with
 * `known(value, 'CONFIRMED', '<who sent it and where the document is>', '<date>')`. The scoring will
 * start using it immediately, and `proposals.ts` decides whether it counts as one of the two
 * written proposals the acceptance criterion demands.
 */
import { CAPABILITIES } from './capabilities.ts';
import { known, unknown, type Assessment, type Candidate } from './model.ts';

const BUILT = 'packages/gst, packages/gst-returns and packages/itc in this repository';
const TODAY = '2026-09-01';

/** Nobody has been asked yet, so every capability is an open question rather than a no. */
const allUnknown = (): Readonly<Record<string, Assessment<boolean>>> =>
  Object.freeze(Object.fromEntries(CAPABILITIES.map((capability) => [capability.id, unknown<boolean>('Nobody has asked yet.')])));

const CAPABILITY_QUESTIONS = CAPABILITIES.map(
  (capability) => `Which endpoint provides "${capability.label['en-IN']}"${capability.critical ? ' (we treat this as critical)' : ''}, and is it in the sandbox?`,
);

const COMMERCIAL_QUESTIONS: readonly string[] = [
  'A written quotation for 10, 25 and 50 GSTINs: monthly platform fee, per-GSTIN fee, per-IRN, per-e-way-bill, per-return-filing, per-GSTR-2B fetch, and any monthly minimum.',
  'One-off onboarding, integration or certification charges.',
  'What of our customers’ data do you store, where, and for how long? Can invoice payloads be discarded after acknowledgement?',
  'Support hours and response times — specifically on the 11th, 20th and month end, when every customer files at once.',
  'On termination: what do we get back, in what format, and how long do we keep API access while migrating?',
  'Sandbox access before any commitment, with credentials for a test GSTIN.',
  'Do you post signed callbacks for asynchronous acknowledgements, and how is the signature verified?',
  'Is an API user with an OTP to the signatory sufficient, or does your integration require the taxpayer’s portal password?',
];

const OPEN_QUESTIONS: readonly string[] = Object.freeze([...CAPABILITY_QUESTIONS, ...COMMERCIAL_QUESTIONS]);

const approach = (id: string, name: string, en: string, hi: string): Candidate => ({
  id,
  name,
  // Not an assumption about them: it is what we will require, and the question is on the list
  // above. A provider that answers "portal password" is disqualified by `scoring.ts` on the spot.
  authModel: 'API_USER_WITH_OTP',
  summary: { 'en-IN': en, 'hi-IN': hi },
  capabilities: allUnknown(),
  assessments: {},
  cost: unknown<never>('No quotation has been requested or received.'),
  openQuestions: OPEN_QUESTIONS,
});

export const CANDIDATES: readonly Candidate[] = Object.freeze([
  {
    id: 'no_provider',
    name: 'No provider — the shopkeeper uses the portal themselves',
    authModel: 'NONE',
    summary: {
      'en-IN': 'We generate the file and the shopkeeper uploads it on the government portal. Built, tested and running today.',
      'hi-IN': 'File hum banate hain, dukaandar khud portal par upload karta hai. Yeh ban chuka hai, jaancha ja chuka hai aur aaj chal raha hai.',
    },
    capabilities: Object.freeze({
      // Known because we wrote them, not because anybody claimed them.
      api_user_otp: known(false, 'CONFIRMED', BUILT, TODAY, 'There is nothing to authorise: nobody acts for the business but the business.'),
      irn_generate: known(false, 'CONFIRMED', BUILT, TODAY, 'The offline JSON is correct and complete; a person still has to upload it and type the IRN back.'),
      irn_cancel: known(false, 'CONFIRMED', BUILT, TODAY, 'Done on the portal, inside the same twenty-four hours, by a person watching the clock.'),
      irn_fetch: known(false, 'CONFIRMED', BUILT, TODAY, 'A person reads it off the portal and types it in — which #31 already accepts as evidence.'),
      eway_generate: known(false, 'CONFIRMED', BUILT, TODAY, 'The portal, by hand, while the lorry waits.'),
      eway_update: known(false, 'CONFIRMED', BUILT, TODAY, 'Same, and this is the one that happens at nine at night after a breakdown.'),
      eway_cancel: known(false, 'CONFIRMED', BUILT, TODAY, ''),
      eway_fetch: known(false, 'CONFIRMED', BUILT, TODAY, ''),
      return_file: known(false, 'CONFIRMED', BUILT, TODAY, 'Everything up to the last button works: the return is prepared, checked and exported as the portal’s own JSON.'),
      return_status: known(false, 'CONFIRMED', BUILT, TODAY, 'The acknowledgement number is typed in by whoever filed it.'),
      gstr2b_fetch: known(false, 'CONFIRMED', BUILT, TODAY, 'The downloaded file is imported instead, which #31 supports as a first-class path.'),
      ims_actions: known(false, 'CONFIRMED', BUILT, TODAY, ''),
      taxpayer_lookup: known(false, 'CONFIRMED', BUILT, TODAY, ''),
      callbacks: known(false, 'CONFIRMED', BUILT, TODAY, 'Nothing calls us, because nothing calls out.'),
    }),
    assessments: {
      endpoint_coverage: known(1, 'CONFIRMED', BUILT, TODAY, 'Every automated capability is missing by definition. The manual paths all work.'),
      sandbox_access: known(5, 'CONFIRMED', BUILT, TODAY, 'It is our own code and it has tests.'),
      cost: known(5, 'CONFIRMED', BUILT, TODAY, 'Nothing per business, nothing per document.'),
      data_storage: known(5, 'CONFIRMED', BUILT, TODAY, 'No third party sees a customer’s invoice at all.'),
      portability_and_exit: known(5, 'CONFIRMED', BUILT, TODAY, 'Nothing to exit.'),
      startup_terms: known(5, 'CONFIRMED', BUILT, TODAY, 'Nothing to sign.'),
      support_and_sla: known(3, 'CONFIRMED', BUILT, TODAY, 'Ours, and the portal’s own uptime, which nobody can improve on.'),
      callbacks: known(1, 'CONFIRMED', BUILT, TODAY, ''),
    },
    cost: known(
      {
        monthlyPlatformFeePaise: 0n, perGstinPerMonthPaise: 0n, perIrnPaise: 0n, perEwayBillPaise: 0n,
        perReturnFilingPaise: 0n, perGstr2bFetchPaise: 0n, monthlyMinimumPaise: 0n, oneOffOnboardingPaise: 0n,
      },
      'CONFIRMED', BUILT, TODAY, 'Already built and paid for. The cost is the shopkeeper’s time, and it is not zero.',
    ),
    openQuestions: [],
  },
  approach(
    'iris', 'IRIS',
    'Named in the issue as a candidate. Nothing has been requested or received.',
    'Issue mein sujhaya gaya vikalp. Abhi na kuch maanga gaya hai na mila hai.',
  ),
  approach(
    'finagg', 'FinAGG',
    'Named in the issue as a candidate. Nothing has been requested or received.',
    'Issue mein sujhaya gaya vikalp. Abhi na kuch maanga gaya hai na mila hai.',
  ),
  approach(
    'mastergst', 'MasterGST',
    'Named in the issue as a candidate. Nothing has been requested or received.',
    'Issue mein sujhaya gaya vikalp. Abhi na kuch maanga gaya hai na mila hai.',
  ),
  approach(
    'clear', 'Clear',
    'Named in the issue as a candidate. Nothing has been requested or received.',
    'Issue mein sujhaya gaya vikalp. Abhi na kuch maanga gaya hai na mila hai.',
  ),
]);

/** The identical requirement every provider is sent, so the answers are comparable at all. */
export const REQUEST_FOR_PROPOSAL: readonly string[] = OPEN_QUESTIONS;
