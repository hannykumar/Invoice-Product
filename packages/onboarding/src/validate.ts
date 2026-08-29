/**
 * Issue #36 [E36] — checking each step, in words the person can act on.
 *
 * Every message here names the thing that is wrong and what to do about it. "GSTIN checksum
 * validation failed" tells a shopkeeper nothing; "this GST number does not match the rest of it,
 * so a digit was probably mistyped" tells them to look at it again.
 */
import { compareDates, isoDate, type IsoDate } from '@invoice/kernel';
import { GST_STATE_CODES, validateGstin } from '../../masters/src/validation.ts';
import { templateById } from '@invoice/invoice-templates';
import { profileFor } from './business-types.ts';
import { checkOpeningBalances } from './opening-balances.ts';
import type { OnboardingAnswers, StepId, StepProblem } from './model.ts';

const p = (code: string, en: string, hi: string, field?: string): StepProblem => ({
  code,
  message: { 'en-IN': en, 'hi-IN': hi },
  ...(field === undefined ? {} : { field }),
});

const validateBusiness = (a: OnboardingAnswers): StepProblem[] => {
  const problems: StepProblem[] = [];
  if ((a.business.legalName ?? '').trim().length < 2) {
    problems.push(p('BUSINESS_NAME_MISSING', 'What is your business called?', 'Aapke business ka naam kya hai?', 'legalName'));
  }
  if (a.business.businessType === undefined) {
    problems.push(p('BUSINESS_TYPE_MISSING', 'What kind of work do you do?', 'Aap kis tarah ka kaam karte hain?', 'businessType'));
  }
  const stateCode = a.business.stateCode;
  if (stateCode === undefined) {
    problems.push(p('BUSINESS_STATE_MISSING', 'Which state is your business in?', 'Aapka business kis rajya mein hai?', 'stateCode'));
  } else if (GST_STATE_CODES[stateCode] === undefined) {
    problems.push(p('BUSINESS_STATE_UNKNOWN', 'We do not recognise that state.', 'Yeh rajya pehchaan mein nahin aaya.', 'stateCode'));
  }
  return problems;
};

const validateTaxProfile = (a: OnboardingAnswers): StepProblem[] => {
  const problems: StepProblem[] = [];
  const registration = a.taxProfile.registration;
  if (registration === undefined) {
    problems.push(
      p('TAX_REGISTRATION_MISSING', 'Is your business registered for GST?', 'Kya aapka business GST mein registered hai?', 'registration'),
    );
    return problems;
  }

  if (registration === 'UNREGISTERED') {
    if ((a.taxProfile.gstin ?? null) !== null) {
      problems.push(
        p(
          'TAX_GSTIN_UNEXPECTED',
          'You said the business is not registered, but a GST number is filled in. One of the two needs changing.',
          'Aapne kaha business registered nahin hai, lekin GST number bhara hai. Dono mein se ek badalna hoga.',
          'gstin',
        ),
      );
    }
  } else {
    const gstin = a.taxProfile.gstin ?? '';
    if (gstin.trim() === '') {
      problems.push(p('TAX_GSTIN_MISSING', 'Please enter your GST number.', 'Apna GST number bharein.', 'gstin'));
    } else {
      const result = validateGstin(gstin, 'gstin');
      if (!result.ok) {
        // Issue #5 already words these for a shopkeeper — "the last character does not match the
        // rest of it, so a digit was probably mistyped" — so we pass their sentence through rather
        // than writing a second, blander one.
        for (const problem of result.problems) {
          problems.push(
            p(
              'TAX_GSTIN_INVALID',
              `${problem.message} Please check it against your registration certificate.`,
              'Yeh GST number theek nahin lag raha. Apne registration certificate se milaayein.',
              'gstin',
            ),
          );
        }
      } else if (a.business.stateCode !== undefined && gstin.slice(0, 2) !== a.business.stateCode) {
        problems.push(
          p(
            'TAX_GSTIN_STATE_MISMATCH',
            'Your GST number starts with a different state to the one you chose. We will not pick one for you.',
            'Aapka GST number jis rajya ka hai woh aapke chune hue rajya se alag hai. Hum khud koi nahin chunenge.',
            'gstin',
          ),
        );
      }
    }
    if (a.taxProfile.filingFrequency === undefined) {
      problems.push(
        p(
          'TAX_FILING_FREQUENCY_MISSING',
          'Do you file GST every month or every three months? Your accountant or the GST portal will tell you.',
          'Aap GST har mahine bharte hain ya teen mahine mein? Aapke accountant ya GST portal se pata chalega.',
          'filingFrequency',
        ),
      );
    }
  }

  const start = a.taxProfile.booksStartDate;
  if (start === undefined) {
    problems.push(
      p('TAX_BOOKS_START_MISSING', 'From which date should we keep your books?', 'Kis taarikh se aapka hisaab rakhein?', 'booksStartDate'),
    );
  } else if (compareDates(start, isoDate('2017-07-01')) < 0) {
    problems.push(
      p(
        'TAX_BOOKS_START_TOO_EARLY',
        'GST began on 1 July 2017, so books here cannot start before that.',
        'GST 1 July 2017 se shuru hua, isliye hisaab usse pehle se nahin ho sakta.',
        'booksStartDate',
      ),
    );
  }
  return problems;
};

const validateBranding = (a: OnboardingAnswers): StepProblem[] => {
  const problems: StepProblem[] = [];
  const templateId = a.branding.templateId;
  if (templateId === undefined) {
    problems.push(p('BRANDING_TEMPLATE_MISSING', 'Pick how your bill should look.', 'Chunein ki aapka bill kaisa dikhe.', 'templateId'));
  } else if (templateById(templateId) === undefined) {
    problems.push(p('BRANDING_TEMPLATE_UNKNOWN', 'That bill design is not one we have.', 'Woh bill design hamare paas nahin hai.', 'templateId'));
  }
  const prefix = a.branding.invoicePrefix ?? '';
  if (prefix !== '' && !/^[A-Z0-9]{1,6}$/.test(prefix)) {
    problems.push(
      p(
        'BRANDING_PREFIX_INVALID',
        'The short code before your bill number can only use capital letters and digits, up to six.',
        'Bill number se pehle wala code sirf capital letters aur ank ka ho sakta hai, chhah tak.',
        'invoicePrefix',
      ),
    );
  }
  return problems;
};

const validateItems = (a: OnboardingAnswers): StepProblem[] => {
  const problems: StepProblem[] = [];
  const type = a.business.businessType;
  const keepsStock = type === undefined ? true : profileFor(type).keepsStock;
  if (keepsStock && a.items.length === 0) {
    problems.push(
      p('ITEMS_NONE', 'Add at least one thing you sell.', 'Kam se kam ek cheez jodein jo aap bechte hain.', 'items'),
    );
  }
  a.items.forEach((item, index) => {
    const where = item.name.trim() === '' ? `item ${index + 1}` : item.name;
    if (item.name.trim() === '') {
      problems.push(p('ITEM_NAME_MISSING', `${where}: what is this called?`, `${where}: iska naam kya hai?`, item.itemId));
    }
    if (item.baseUnit.trim() === '') {
      problems.push(
        p('ITEM_UNIT_MISSING', `${where}: how do you count it — pieces, kilos, boxes?`, `${where}: ise kaise ginte hain — piece, kilo, box?`, item.itemId),
      );
    }
  });
  return problems;
};

const validateRates = (a: OnboardingAnswers): StepProblem[] => {
  const problems: StepProblem[] = [];
  for (const rate of a.rates) {
    if (rate.basis.trim() === '') {
      problems.push(
        p(
          'RATE_BASIS_MISSING',
          `Please say where the ${Number(rate.ratePercentTimes100) / 100}% rate comes from, so anyone reading the bill later knows.`,
          `Kripya batayein ki ${Number(rate.ratePercentTimes100) / 100}% rate kahan se aaya, taaki baad mein padhne wale ko pata rahe.`,
          rate.code,
        ),
      );
    }
    if (rate.ratePercentTimes100 < 0n || rate.ratePercentTimes100 > 10000n) {
      problems.push(
        p('RATE_OUT_OF_RANGE', 'A GST rate is between 0 and 100 per cent.', 'GST rate 0 se 100 pratishat ke beech hota hai.', rate.code),
      );
    }
    if (rate.code.trim() === '') {
      problems.push(
        p('RATE_CODE_MISSING', 'Which goods or service is this rate for?', 'Yeh rate kis saaman ya service ke liye hai?', rate.code),
      );
    }
  }
  return problems;
};

const validateOpening = (a: OnboardingAnswers): readonly StepProblem[] => {
  const check = checkOpeningBalances(a.openingBalances);
  if (check.balanced) return check.problems.filter((x) => x.code !== 'OPENING_UNBALANCED');
  if (a.openingDifferenceAccepted != null && a.openingDifferenceAccepted.reason.trim() !== '') {
    // A person has looked at the difference and written down why. That is allowed, and recorded.
    return check.problems.filter((x) => x.code !== 'OPENING_UNBALANCED');
  }
  return check.problems;
};

export const validateStep = (step: StepId, answers: OnboardingAnswers): readonly StepProblem[] => {
  switch (step) {
    case 'business':
      return validateBusiness(answers);
    case 'tax_profile':
      return validateTaxProfile(answers);
    case 'branding':
      return validateBranding(answers);
    case 'items':
      return validateItems(answers);
    case 'rates':
      return validateRates(answers);
    case 'opening_balances':
      return validateOpening(answers);
    case 'ready':
      return [];
  }
};

export type { IsoDate };
