/**
 * Issue #53 [X05] — the application itself: what we tell the authority, and whether we may send it.
 *
 * An application for vehicle-record access is an argument about necessity written down by a company
 * that exists. Both halves matter, and only one of them is a software problem.
 *
 * The dossier below is the half a repository can hold: who is asking, for what single purpose, for
 * which fields, on whose behalf, at what volume, kept for how long, protected how, and what we do
 * when the answer is no. It is assembled from the code rather than typed out, so the sentence "we
 * request twelve fields" cannot become false without a test failing.
 *
 * The other half is a certificate of incorporation, a board resolution and a signatory — and #49
 * already tracks those. So `readyToSubmit` does not re-ask for them; it reads #49's register and
 * refuses to call the application sendable while the company that would sign it does not exist.
 */
import { assessVendor } from '@invoice/vendor-onboarding';
import { CURRENT_STATE } from '@invoice/vendor-onboarding';
import { DEFAULT_VEHICLE_RECORD_FRESHNESS } from '../../../packages/transport/src/vehicle-record-types.ts';
import { DECLINED_FIELDS, REQUESTED_FIELDS } from './fields.ts';
import { reviewNecessity } from './necessity.ts';
import { applicationProblems, DECLARED_PURPOSE } from './model.ts';
import { RETENTION, permittedUseTerms } from './permitted-use.ts';
import { MANUAL_FALLBACK } from './fallback.ts';
import type { ApplicationRecord, Bilingual } from './model.ts';

/**
 * One question on the application, and our answer.
 *
 * `answer` is null where the answer is a fact about a company that does not exist yet. That is not
 * a gap to be filled in with something plausible before sending; it is the reason the application
 * cannot be sent, and `readyToSubmit` says so by name.
 */
export interface DossierEntry {
  readonly question: string;
  readonly answer: string | null;
  /** Where the answer comes from, so a reviewer can check it rather than believe it. */
  readonly derivedFrom: string;
}

const list = (items: readonly string[]): string => items.join('; ');

/**
 * The use case, assembled from what the product actually does.
 *
 * Every answer here is derived: the field count from #29's allow-list, the retention from the
 * policy the code enforces, the fallback from the workflow #28 already supports. An application
 * whose answers are typed out separately from the system it describes is an application that
 * becomes a lie the first time somebody changes the system.
 */
export const dossier = (): readonly DossierEntry[] => {
  const company = CURRENT_STATE;
  const necessity = reviewNecessity(new Date().toISOString().slice(0, 10));
  return Object.freeze([
    {
      question: 'Who is applying?',
      answer: company.legalName,
      derivedFrom: '#49’s company register. Null until the company is incorporated.',
    },
    {
      question: 'What is the product, in one sentence?',
      answer: 'Accounting and GST software for small Indian businesses, which prepares e-way bills and checks before dispatch that the vehicle named on one can lawfully carry the consignment.',
      derivedFrom: 'The product specification (#1).',
    },
    {
      question: 'For what purpose will vehicle records be read?',
      answer: `Exactly one: ${DECLARED_PURPOSE.toLowerCase().replace(/_/g, ' ')} — deciding whether a specific consignment may be dispatched on a specific vehicle. The purpose is held as a value in code and checked on every lookup, so a second use would be a deliberate change and would appear in the audit trail as one.`,
      derivedFrom: '`VehicleLookupPurpose` in #29.',
    },
    {
      question: 'Which fields are requested?',
      answer: `${REQUESTED_FIELDS.length}: ${list(REQUESTED_FIELDS.map((request) => `${request.field} (${request.plainName})`))}.`,
      derivedFrom: '#29’s `PERMITTED_VEHICLE_FIELDS`, which the code enforces at the boundary before storage.',
    },
    {
      question: 'Which fields are deliberately not requested?',
      answer: `${DECLINED_FIELDS.length}, including ${list(DECLINED_FIELDS.slice(0, 4).map((field) => field.describedAs))}. Any of these arriving in a response is discarded at the boundary before storage.`,
      derivedFrom: 'The declined list in this package, tested against a full provider response.',
    },
    {
      question: 'Is any personal information requested?',
      answer: 'One field names a person: the registered owner’s name. It is stored masked to initials, no rule reads it, it is shown only so that a person at a loading bay can check the lorry belongs to the transporter who was booked, and the product works without it if the field is refused.',
      derivedFrom: '`maskOwnerName` in #29, and the necessity review in this package.',
    },
    {
      question: 'Has the field list been reviewed for necessity?',
      answer: necessity.summary['en-IN'],
      derivedFrom: 'The necessity review, which reads #28’s rule source rather than accepting a claim.',
    },
    {
      question: 'On whose behalf is each lookup made?',
      answer: 'A specific business, which has given dated, recorded consent naming the purpose and the fields, and which can withdraw it. A lookup with no live consent is not attempted at all.',
      derivedFrom: '`VehicleRecordConsent` in #29.',
    },
    {
      question: 'What volume is expected?',
      answer: null,
      derivedFrom: 'Unknown until the product has customers. It must be estimated honestly before submission, not guessed here.',
    },
    {
      question: 'How long is a response kept?',
      answer: `A reading is reused for ${DEFAULT_VEHICLE_RECORD_FRESHNESS.reuseWithinHours} hours rather than asking again, shown as stale after ${DEFAULT_VEHICLE_RECORD_FRESHNESS.staleAfterDays} days, and the stored reading is kept for ${RETENTION.auditYears} years because it is the evidence behind a dispatch decision. ${RETENTION.why}`,
      derivedFrom: '`DEFAULT_VEHICLE_RECORD_FRESHNESS` in #29 and the retention terms in this package.',
    },
    {
      question: 'How is the data protected?',
      answer: 'Credentials are held in the platform’s vault and never in application code or the vehicle record; every lookup is recorded with the actor, the vehicle, the time and the outcome, and without secrets; each business’s records are isolated from every other business’s.',
      derivedFrom: '#8’s connector gateway and credential vault, and #29’s audit entries.',
    },
    {
      question: 'What happens when the service cannot be reached?',
      answer: `The product does not guess. It records that it could not ask, which is a different answer from the authority saying the vehicle does not exist, and falls back to ${MANUAL_FALLBACK.steps.length} steps in which a person types in the facts from the registration certificate the driver carries — clearly marked as typed in rather than read from the authority.`,
      derivedFrom: '`VehicleRecordUnavailableCode` in #29 and the manual fallback in this package.',
    },
    {
      question: 'What restrictions do you accept?',
      answer: list(permittedUseTerms().map((term) => term.rule)),
      derivedFrom: 'The permitted-use terms in this package.',
    },
  ]);
};

/** A dossier question nobody can answer yet. Each one is a reason the application is not sendable. */
export const unanswered = (): readonly DossierEntry[] => dossier().filter((entry) => entry.answer === null);

export interface SubmissionReadiness {
  readonly ready: boolean;
  /** What stops it being sent today, in the order somebody would work through them. */
  readonly blockers: readonly string[];
  readonly summary: Bilingual;
}

/**
 * Whether the application could actually be sent.
 *
 * Three things have to hold, and the first is not ours: the company has to exist and hold the
 * document pack a vehicle-data provider asks for. The second is that the necessity review passes,
 * because sending an application asking for a field we cannot justify is worse than sending none.
 * The third is that no question is unanswered.
 */
export const readyToSubmit = (): SubmissionReadiness => {
  const blockers: string[] = [];

  const vendor = assessVendor(CURRENT_STATE, 'VEHICLE_DATA');
  if (!vendor.ready) {
    blockers.push(
      `#49: ${vendor.missing.length} company documents a vehicle-data provider asks for are not in hand (${list([...vendor.missing])}).`,
    );
  }

  const necessity = reviewNecessity(new Date().toISOString().slice(0, 10));
  if (!necessity.passed) blockers.push(`Necessity review: ${necessity.summary['en-IN']}`);

  for (const entry of unanswered()) blockers.push(`Unanswered: ${entry.question} — ${entry.derivedFrom}`);

  const ready = blockers.length === 0;
  return {
    ready,
    blockers: Object.freeze(blockers),
    summary: ready
      ? {
        'en-IN': 'The application is complete and the company documents behind it are in hand. It can be sent.',
        'hi-IN': 'Aavedan poora hai aur uske peeche ke kaagaz haath mein hain. Isse bheja ja sakta hai.',
      }
      : {
        'en-IN': `The application cannot be sent yet: ${blockers.length} things are outstanding, starting with the company itself.`,
        'hi-IN': `Aavedan abhi nahi bheja ja sakta: ${blockers.length} cheezein baaki hain, sabse pehle company khud.`,
      },
  };
};

// ------------------------------------------------------------------ reading the tracker back

export interface TrackerReport {
  readonly asOf: string;
  readonly records: readonly ApplicationRecord[];
  /** Records whose state does not carry the evidence its name implies. Any at all is a failure. */
  readonly problems: readonly string[];
  /** Applications waiting on the authority, oldest first — the chasing list. */
  readonly awaitingAnswer: readonly ApplicationRecord[];
  readonly approved: readonly ApplicationRecord[];
  readonly summary: Bilingual;
}

/**
 * Fields the authority approved that we never asked for, and fields we asked for that it refused.
 *
 * The first should be impossible and is checked anyway. The second is the useful one: it is the
 * list somebody has to act on, because the code's allow-list must be narrowed to what was actually
 * granted before a single real lookup is made.
 */
export const approvalGaps = (record: ApplicationRecord): {
  readonly refused: readonly string[];
  readonly grantedButNotRequested: readonly string[];
} => {
  const requested = new Set(REQUESTED_FIELDS.map((request) => request.field));
  const granted = new Set(record.approval?.approvedFields ?? []);
  return {
    refused: Object.freeze([...requested].filter((field) => !granted.has(field))),
    grantedButNotRequested: Object.freeze([...granted].filter((field) => !requested.has(field))),
  };
};

export const trackerReport = (records: readonly ApplicationRecord[], asOf: string): TrackerReport => {
  const problems = records.flatMap((record) => applicationProblems(record));
  const awaitingAnswer = records
    .filter((record) => record.state === 'SUBMITTED' || record.state === 'CLARIFICATION_REQUESTED')
    .sort((left, right) => (left.submittedOn ?? '').localeCompare(right.submittedOn ?? ''));
  const approved = records.filter((record) => record.state === 'APPROVED');

  return {
    asOf,
    records,
    problems: Object.freeze(problems),
    awaitingAnswer: Object.freeze(awaitingAnswer),
    approved: Object.freeze(approved),
    summary: approved.length > 0
      ? {
        'en-IN': `${approved.length} approved, ${awaitingAnswer.length} awaiting an answer.`,
        'hi-IN': `${approved.length} manzoor, ${awaitingAnswer.length} javaab ka intezaar.`,
      }
      : {
        'en-IN': `Nothing approved. ${awaitingAnswer.length} applications are with the authority; ${records.length - awaitingAnswer.length} have not been sent.`,
        'hi-IN': `Kuch bhi manzoor nahi. ${awaitingAnswer.length} aavedan pradhikaran ke paas hain; ${records.length - awaitingAnswer.length} bheje hi nahi gaye.`,
      },
  };
};
