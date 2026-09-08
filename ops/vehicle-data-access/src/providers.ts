/**
 * Issue #53 [X05] — who can lawfully answer "tell me about this lorry", and what we do not know
 * about any of them yet.
 *
 * The choice here is unlike the GSP choice in #50. There, several commercial providers sell the
 * same regulated service and the question is which one. Here there is one underlying source — the
 * registering authorities' VAHAN database, held by the Ministry of Road Transport and Highways —
 * and the question is which authorised route to it a small software company is actually allowed to
 * use, at what price, with what field narrowing and under what permitted-use terms.
 *
 * Two things are disqualifiers rather than low scores, because no price makes them acceptable:
 *
 *   1. **A provider that scrapes.** Several services offer "vehicle RC APIs" that are a screen
 *      scrape of the public VAHAN or mParivahan pages behind a REST façade. Using one is this
 *      issue's own stated non-goal, it breaches those portals' terms, and it gives a customer
 *      evidence with no authority behind it — which for a product whose promise is accuracy is
 *      worse than having no evidence at all.
 *   2. **A provider that will only sell the whole record.** Not because holding it would be
 *      technically hard — #29 drops unrequested fields at the boundary and would drop these too —
 *      but because we would have obtained the owner's address and chassis number, which is a thing
 *      we did, whether or not we then deleted it.
 *
 * **Nothing below was told to us by a provider.** Every commercial and operational fact is
 * `UNKNOWN`, with the question to ask written next to it.
 */
import { unknown } from './model.ts';
import type { Assessment, Bilingual } from './model.ts';

/** What stands between us and the authority's database. */
export type Route =
  /** The Government of India's own API exchange, publishing the ministry's data to onboarded entities. */
  | 'GOVERNMENT_EXCHANGE'
  /** A direct arrangement with the ministry or a state transport department. */
  | 'DIRECT_WITH_AUTHORITY'
  /** A commercial company reselling authorised access under its own agreement. */
  | 'AUTHORISED_RESELLER'
  /** A service that reads the public portals and re-serves them. Never acceptable. */
  | 'SCRAPER'
  /** No provider at all: the vehicle facts come from paper, typed in by the business. */
  | 'NONE';

/** Whether a provider will let us ask for some fields rather than all of them. */
export type FieldNarrowing =
  /** The request names the fields and the response contains only those. What we are asking for. */
  | 'PER_REQUEST'
  /** The fields are fixed once, at onboarding, for our whole account. Acceptable. */
  | 'AT_ONBOARDING'
  /** Everything comes back every time. We would drop the rest, having received it. */
  | 'NONE';

export interface ProviderCandidate {
  readonly id: string;
  readonly name: string;
  readonly route: Route;
  readonly summary: Bilingual;
  /** Whether a use case has to be registered and approved before any call is possible. */
  readonly requiresUseCaseApproval: Assessment<boolean>;
  readonly fieldNarrowing: Assessment<FieldNarrowing>;
  /** A test environment with sample vehicles, before any real record is read. */
  readonly sandboxAvailable: Assessment<boolean>;
  /** Per-lookup price in paise. Vehicle-record services are almost always priced per call. */
  readonly perLookupPaise: Assessment<bigint>;
  readonly monthlyMinimumPaise: Assessment<bigint>;
  /** The response time they commit to, and the availability. Both matter at a loading bay. */
  readonly responseSlaSeconds: Assessment<number>;
  readonly availabilitySlaPercent: Assessment<number>;
  /** How long their terms allow a reading to be kept. This is the constraint on #29's caching. */
  readonly permittedCacheHours: Assessment<number>;
  /** Who has to be asked what, before this candidate can be assessed at all. */
  readonly openQuestions: readonly string[];
}

/** A provider we will not use whatever it costs, and the reason, stated once. */
export const disqualification = (candidate: ProviderCandidate): string | null => {
  if (candidate.route === 'SCRAPER') {
    return 'It reads the public portals rather than holding authorised access, which this issue rules out and which would give a customer evidence with no authority behind it.';
  }
  if (candidate.fieldNarrowing.value === 'NONE') {
    return 'It will only return the whole record, so using it would mean receiving the owner’s address and the chassis number in order to throw them away.';
  }
  return null;
};

export const CANDIDATES: readonly ProviderCandidate[] = Object.freeze<ProviderCandidate[]>([
  {
    id: 'api_setu_vahan',
    name: 'API Setu — vehicle registration record (MoRTH/NIC source)',
    route: 'GOVERNMENT_EXCHANGE',
    summary: {
      'en-IN': 'The government’s own API exchange, publishing the ministry’s vehicle record to entities it has onboarded. The route the product was built against.',
      'hi-IN': 'Sarkar ka apna API exchange, jo mantralaya ka vaahan record onboarded sansthaon ko deta hai. Product isi ke hisaab se banaya gaya hai.',
    },
    requiresUseCaseApproval: unknown<boolean>('Ask: is onboarding open to a private company, and does it need a stated use case and a signed undertaking?'),
    fieldNarrowing: unknown<FieldNarrowing>('Ask: can the request name the fields, or is the field set fixed for the account?'),
    sandboxAvailable: unknown<boolean>('Ask: is there a test environment with sample vehicles before any real record is read?'),
    perLookupPaise: unknown<bigint>('Ask: what is charged per lookup, and is there a free tier for testing?'),
    monthlyMinimumPaise: unknown<bigint>('Ask: is there a monthly minimum irrespective of usage?'),
    responseSlaSeconds: unknown<number>('Ask: what response time is committed to, and what happens when it is missed?'),
    availabilitySlaPercent: unknown<number>('Ask: what availability is committed to, and is there a published status page?'),
    permittedCacheHours: unknown<number>('Ask: how long may a response be stored, and must it be deleted on customer request?'),
    openQuestions: [
      'Is onboarding open to a private limited company that is not a government body?',
      'Does the use case have to be approved before any call, and how long does approval take?',
      'Can the request name the fields we want, so the response never contains the owner address or chassis number?',
      'How long may a response be cached, and does that permission survive the agreement ending?',
      'What is the escalation path when the service is down at four in the afternoon on a working day?',
    ],
  },
  {
    id: 'morth_direct',
    name: 'Direct arrangement with MoRTH / a state transport department',
    route: 'DIRECT_WITH_AUTHORITY',
    summary: {
      'en-IN': 'Going to the authority itself. The cleanest permitted-use position, and the slowest and least likely to be available to a small company.',
      'hi-IN': 'Seedhe pradhikaran se. Sabse saaf anumati, lekin sabse dheemi aur ek chhoti company ke liye milne ki sambhavna kam.',
    },
    requiresUseCaseApproval: unknown<boolean>('Almost certainly yes. Ask what the application actually consists of and who signs it.'),
    fieldNarrowing: unknown<FieldNarrowing>('Ask whether a restricted field set can be agreed in the arrangement itself.'),
    sandboxAvailable: unknown<boolean>('Ask whether test data exists at all on this route.'),
    perLookupPaise: unknown<bigint>('Ask whether access is charged per call or under an annual arrangement.'),
    monthlyMinimumPaise: unknown<bigint>('Ask whether there is a floor.'),
    responseSlaSeconds: unknown<number>('Ask what, if anything, is committed to.'),
    availabilitySlaPercent: unknown<number>('Ask what, if anything, is committed to.'),
    permittedCacheHours: unknown<number>('Ask what the arrangement permits.'),
    openQuestions: [
      'Is this route available to a private company at all, or only to government and enforcement bodies?',
      'What does the application consist of, and how long has it taken others?',
      'Would a single arrangement cover vehicles registered in every state?',
    ],
  },
  {
    id: 'authorised_reseller',
    name: 'A commercial provider reselling authorised access',
    route: 'AUTHORISED_RESELLER',
    summary: {
      'en-IN': 'A company that holds its own authorised access and sells lookups on top of it. Faster to start with, and the agreement has to be read carefully for where the data actually comes from.',
      'hi-IN': 'Aisi company jo khud adhikrit pahunch rakhti hai aur uske upar lookup bechti hai. Shuru karna aasan, par samjhauta dhyaan se padhna zaroori hai.',
    },
    requiresUseCaseApproval: unknown<boolean>('Ask, and ask to see the authority’s permission behind their permission.'),
    fieldNarrowing: unknown<FieldNarrowing>('Ask: many resellers return the full record by default. A full record is a disqualifier.'),
    sandboxAvailable: unknown<boolean>('Ask: resellers usually have one, which makes this the likely route for building against.'),
    perLookupPaise: unknown<bigint>('Ask for a written per-lookup price at 500, 2,000 and 10,000 lookups a month.'),
    monthlyMinimumPaise: unknown<bigint>('Ask: the minimum is what hurts at ten customers.'),
    responseSlaSeconds: unknown<number>('Ask for the committed response time in writing, not the observed one in a demo.'),
    availabilitySlaPercent: unknown<number>('Ask for the committed availability and the remedy when it is missed.'),
    permittedCacheHours: unknown<number>('Ask: this is where a reseller’s terms most often conflict with our six-hour reuse.'),
    openQuestions: [
      'Where does the data actually come from — is there authorised access behind this, or is it a scrape? Ask for the authority’s permission in writing.',
      'Can the response be narrowed to our twelve fields, in the request or at onboarding?',
      'Do the terms permit caching for six hours and retention for the audit period?',
      'What happens to the records we have already read if we stop paying?',
      'Is the price per lookup or per successful lookup? A "no such vehicle" answer is still work.',
    ],
  },
  {
    id: 'manual_only',
    name: 'No provider — the registration certificate, typed in',
    route: 'NONE',
    summary: {
      'en-IN': 'What every business has today: the paper certificate the driver carries, entered by a person. Slower, always available, and never blocked by an outage or an approval.',
      'hi-IN': 'Jo har vyavsaay ke paas aaj hai: driver ke paas ka kaagaz, jise koi vyakti bhar deta hai. Dheema, par hamesha uplabdh.',
    },
    requiresUseCaseApproval: unknown<boolean>('Not applicable. Nobody’s permission is needed to read the paper in front of you.'),
    fieldNarrowing: unknown<FieldNarrowing>('Not applicable.'),
    sandboxAvailable: unknown<boolean>('Not applicable.'),
    perLookupPaise: unknown<bigint>('Free, and paid for in a person’s time.'),
    monthlyMinimumPaise: unknown<bigint>('Not applicable.'),
    responseSlaSeconds: unknown<number>('As fast as somebody types.'),
    availabilitySlaPercent: unknown<number>('It does not go down.'),
    permittedCacheHours: unknown<number>('The business’s own vehicle list, kept for as long as the business wants it.'),
    openQuestions: [],
  },
]);

export const candidate = (id: string): ProviderCandidate => {
  const found = CANDIDATES.find((item) => item.id === id);
  if (found === undefined) throw new Error(`no vehicle-data provider called ${id}`);
  return found;
};

/** Everything nobody has been asked yet, gathered into the list somebody works through. */
export const stillToAsk = (): readonly { readonly provider: string; readonly question: string }[] =>
  Object.freeze(
    CANDIDATES.flatMap((item) => item.openQuestions.map((question) => ({ provider: item.name, question }))),
  );
