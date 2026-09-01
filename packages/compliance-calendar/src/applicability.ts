/**
 * Issue #32 [E32] — whose problem is this deadline?
 *
 * A calendar that shows every Indian GST deadline to every business is worse than no calendar. A
 * composition dealer does not file GSTR-1 and will learn to ignore a product that says otherwise; a
 * quarterly filer told the summary return is due on the 20th has been given a wrong date by a
 * confident machine. So applicability is decided from the company's own facts, one obligation at a
 * time, and the decision carries the reason in words.
 *
 * The important case is the third one. When a fact the rule needs is simply not recorded — nobody
 * ever wrote down whether this business files monthly or quarterly — the answer is neither "applies"
 * nor "does not apply". It is `CANNOT_DECIDE`, with the question to ask. That obligation then goes
 * to the exception queue instead of the calendar, where a person can see it and answer in one tap.
 *
 * The tempting alternative is to default to monthly, since most businesses are monthly. That would
 * be a compliance fact invented by a computer, which this product does not do — and the business it
 * is wrong for is precisely the one that needed the calendar.
 */
import { bilingual, type ApplicabilityCriteria, type ApplicabilityOutcome, type CompanyComplianceProfile, type MissingProfileFact, type ObligationDefinition, type ProfileFact, type ProfileFactName } from './types.ts';

/** The question to put to the owner for each fact, written for somebody who is not an accountant. */
const QUESTIONS: Readonly<Record<ProfileFactName, MissingProfileFact['question']>> = Object.freeze({
  registrationType: bilingual(
    'Is this business registered under GST in the normal way, or under the composition scheme?',
    'Yeh business GST mein normal tarike se registered hai ya composition scheme mein?',
  ),
  gstFilingFrequency: bilingual(
    'Do you file your GST returns every month, or once every three months?',
    'Aap GST return har mahine bharte hain ya teen maheene mein ek baar?',
  ),
  eInvoiceApplicable: bilingual(
    'Does this business have to make e-invoices with an IRN?',
    'Kya is business ko IRN wali e-invoice banani hoti hai?',
  ),
  movesGoods: bilingual(
    'Does this business send goods by vehicle, so e-way bills are needed?',
    'Kya yeh business gaadi se maal bhejta hai, jisme e-way bill lagta hai?',
  ),
  stateCode: bilingual(
    'Which state is this business registered in?',
    'Yeh business kis state mein registered hai?',
  ),
});

const factOf = (profile: CompanyComplianceProfile, name: ProfileFactName): ProfileFact<unknown> | null => {
  switch (name) {
    case 'registrationType':
      return profile.registrationType;
    case 'gstFilingFrequency':
      return profile.gstFilingFrequency;
    case 'eInvoiceApplicable':
      return profile.eInvoiceApplicable;
    case 'movesGoods':
      return profile.movesGoods;
    case 'stateCode':
      return profile.stateCode;
  }
};

/** The facts a rule needs and this company has not recorded. */
export const missingFacts = (
  criteria: ApplicabilityCriteria,
  profile: CompanyComplianceProfile,
): readonly MissingProfileFact[] =>
  criteria.requiredFacts
    .filter((name) => factOf(profile, name) === null)
    .map((name) => ({ fact: name, question: QUESTIONS[name] }));

/**
 * Whether one obligation applies to one company.
 *
 * Missing facts are checked before anything else, so a rule can never be decided on the half of the
 * profile that happens to be filled in.
 */
export const applicabilityOf = (
  definition: ObligationDefinition,
  profile: CompanyComplianceProfile,
): ApplicabilityOutcome => {
  const criteria = definition.applicability;
  const missing = missingFacts(criteria, profile);
  if (missing.length > 0) {
    return {
      kind: 'CANNOT_DECIDE',
      missing,
      question: bilingual(
        `We cannot tell yet whether ${definition.title['en-IN']} applies to you. ${missing.map((item) => item.question['en-IN']).join(' ')}`,
        `Abhi pata nahin chal raha ki ${definition.title['hi-IN']} aap par lagta hai ya nahin. ${missing.map((item) => item.question['hi-IN']).join(' ')}`,
      ),
    };
  }

  const registration = profile.registrationType?.value;
  if (registration !== undefined && !criteria.registrationTypes.includes(registration)) {
    return {
      kind: 'DOES_NOT_APPLY',
      because: bilingual(
        registration === 'COMPOSITION'
          ? 'This is filed by businesses registered in the normal way. Yours is registered under the composition scheme.'
          : 'This does not apply to a business registered the way yours is.',
        registration === 'COMPOSITION'
          ? 'Yeh normal registration wale business bharte hain. Aapka composition scheme mein hai.'
          : 'Aapke registration ke hisaab se yeh aap par nahin lagta.',
      ),
    };
  }

  const frequency = profile.gstFilingFrequency?.value;
  if (criteria.filingFrequencies !== undefined && frequency !== undefined && !criteria.filingFrequencies.includes(frequency)) {
    return {
      kind: 'DOES_NOT_APPLY',
      because: bilingual(
        frequency === 'QUARTERLY'
          ? 'You file once every three months, so the monthly version of this return is not yours.'
          : 'You file every month, so the quarterly version of this return is not yours.',
        frequency === 'QUARTERLY'
          ? 'Aap teen maheene mein ek baar bharte hain, isliye is return ka monthly wala aap par nahin.'
          : 'Aap har mahine bharte hain, isliye is return ka quarterly wala aap par nahin.',
      ),
    };
  }

  if (criteria.requiresEInvoice === true && profile.eInvoiceApplicable?.value !== true) {
    return {
      kind: 'DOES_NOT_APPLY',
      because: bilingual('E-invoices are not required for this business.', 'Is business par e-invoice zaroori nahin hai.'),
    };
  }

  if (criteria.requiresGoodsMovement === true && profile.movesGoods?.value !== true) {
    return {
      kind: 'DOES_NOT_APPLY',
      because: bilingual('This business does not move goods by vehicle.', 'Yeh business gaadi se maal nahin bhejta.'),
    };
  }

  return {
    kind: 'APPLIES',
    because: reasonFor(definition, profile),
  };
};

const reasonFor = (definition: ObligationDefinition, profile: CompanyComplianceProfile): MissingProfileFact['question'] => {
  const registration = profile.registrationType?.value ?? 'REGULAR';
  const frequency = profile.gstFilingFrequency?.value;
  const registrationWords =
    registration === 'COMPOSITION'
      ? { en: 'you are registered under the composition scheme', hi: 'aap composition scheme mein registered hain' }
      : { en: 'you are registered under GST in the normal way', hi: 'aap GST mein normal tarike se registered hain' };
  const frequencyWords =
    definition.applicability.filingFrequencies === undefined || frequency === undefined
      ? null
      : frequency === 'MONTHLY'
        ? { en: 'and you file every month', hi: 'aur aap har mahine bharte hain' }
        : { en: 'and you file once every three months', hi: 'aur aap teen maheene mein ek baar bharte hain' };
  return bilingual(
    `This applies because ${registrationWords.en}${frequencyWords === null ? '' : ` ${frequencyWords.en}`}.`,
    `Yeh isliye lagta hai kyunki ${registrationWords.hi}${frequencyWords === null ? '' : ` ${frequencyWords.hi}`}.`,
  );
};

/**
 * The version of an obligation that governs a company for a period.
 *
 * Two things happen here in a fixed order, and the order is the point. Applicability is judged
 * first — the monthly and quarterly versions of GSTR-1 are both in force at the same time, and only
 * the company's filing frequency separates them — and only then does the highest version win. A
 * "latest version wins" rule applied first would hand every monthly filer the quarterly dates.
 */
export interface DefinitionChoice {
  readonly definition: ObligationDefinition | null;
  readonly outcome: ApplicabilityOutcome;
}

export const chooseDefinition = (
  candidates: readonly ObligationDefinition[],
  profile: CompanyComplianceProfile,
): DefinitionChoice => {
  let bestApplies: { definition: ObligationDefinition; outcome: ApplicabilityOutcome } | null = null;
  let cannotDecide: ApplicabilityOutcome | null = null;
  let doesNotApply: ApplicabilityOutcome | null = null;

  for (const definition of candidates) {
    const outcome = applicabilityOf(definition, profile);
    if (outcome.kind === 'APPLIES') {
      if (bestApplies === null || definition.version > bestApplies.definition.version) bestApplies = { definition, outcome };
    } else if (outcome.kind === 'CANNOT_DECIDE') {
      cannotDecide = outcome;
    } else if (doesNotApply === null) {
      doesNotApply = outcome;
    }
  }

  if (bestApplies !== null) return { definition: bestApplies.definition, outcome: bestApplies.outcome };
  // An unanswered question beats a confident "no". If any version could not be decided, the
  // obligation is unresolved, not absent — the whole point of the exception queue.
  if (cannotDecide !== null) return { definition: null, outcome: cannotDecide };
  return {
    definition: null,
    outcome: doesNotApply ?? {
      kind: 'DOES_NOT_APPLY',
      because: bilingual('No version of this rule was in force for that period.', 'Us period ke liye is niyam ka koi version laagu nahin tha.'),
    },
  };
};
