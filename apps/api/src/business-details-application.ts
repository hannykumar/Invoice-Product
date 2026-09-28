/**
 * Issue #180 — the business's own particulars, kept in one place and printed on every document.
 *
 * Before this existed, every bill printed the seller as a company name and a godown nickname
 * ("Bengaluru · Peenya godown"). CGST Rule 46(a) asks for the supplier's *name, address and GSTIN*,
 * and a town with a godown name is not an address: there is no street and no PIN code. Rule 55
 * (delivery challan) and Rule 53 (credit note) ask for the same particulars, so all of them read
 * from here.
 *
 * Three rules shape this module.
 *
 * 1. **The address is mandatory; everything else is optional content.** A document cannot be issued
 *    without line 1, city and PIN code. Phone, e-mail, PAN, bank, declaration, terms and the
 *    signature image are printed when the business has entered them and are simply absent when it
 *    has not. Nothing is defaulted and no sentence is invented.
 * 2. **What can be checked, is checked.** The state must agree with the GSTIN's own state code, and
 *    the PAN must be the ten characters the GSTIN already carries. Both are ordinary data-entry
 *    mistakes that a buyer's accounts department finds after the bill has gone out.
 * 3. **The bank account lives in `packages/masters`, not here.** This module holds the id of the
 *    account that `MasterDataService` stores, and reads the account back for printing.
 */
import { financialYearOf, invalid, isoDate, type CompanyId } from '@invoice/kernel';
import { appToday } from './app-clock.ts';
import type { RenderableBank, RenderableParty } from '@invoice/invoice-templates';
import { validateLogo } from '@invoice/invoice-templates';
import {
  gstinPan,
  gstinStateCode,
  normaliseIdentifier,
  validateIfsc,
  validateBankAccountNumber,
  validatePan,
  validatePincode,
  validatePincodeForState,
  turnoverAnswerOn,
  turnoverBandOn,
  withTurnoverAnswer,
  above5CroreOf,
  TURNOVER_BANDS,
  type BankAccount,
  type TurnoverAbove5Crore,
  type TurnoverBand,
  type TurnoverAnswer,
  type ValidationResult,
} from '../../../packages/masters/src/index.ts';
import { STATE_NAMES } from '@invoice/transport';
import { GST_STATE_CODES } from '../../../packages/masters/src/validation.ts';
import { masterData, mastersContext } from './master-data.ts';

/**
 * Issue #237 — the one list of states a business, a customer or an address can be in: every
 * current GST state code, and the "Other Territory" code. The retired codes (25, merged into 26 in
 * 2020, and 28, the undivided Andhra Pradesh) stay valid for reading old documents but are never
 * offered for anything new. Setting up a business, Business details and the customer forms all
 * read this list, so none of them can offer a different set of states from the others.
 */
export const currentStates = (): readonly { readonly code: string; readonly name: string }[] =>
  Object.entries(GST_STATE_CODES)
    .filter(([, state]) => state.retired !== true)
    .map(([code, state]) => ({ code, name: state.name }))
    // Object keys like "10" are listed before "01"; the list reads in code order, 01 to 38, then 97.
    .sort((a, b) => a.code.localeCompare(b.code));

/** What one business has told us about itself. Everything but the address may be absent. */
export interface BusinessDetails {
  readonly legalName: string;
  readonly tradeName: string | null;
  readonly address1: string;
  readonly address2: string | null;
  readonly city: string;
  readonly pincode: string;
  readonly stateCode: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly pan: string | null;
  /** The id of the account held by `MasterDataService`. The account itself is never copied here. */
  readonly bankAccountId: string | null;
  readonly declaration: string | null;
  readonly terms: string | null;
  readonly signatureDataUri: string | null;
}

/** What the screen shows before anybody has saved anything, so the form opens part-filled. */
export interface BusinessPrefill {
  readonly legalName: string;
  readonly tradeName: string;
  readonly stateCode: string;
  readonly phone: string;
  readonly address1: string;
  readonly address2: string;
  readonly city: string;
  readonly pincode: string;
}

const details = new Map<string, BusinessDetails>();
const prefills = new Map<string, BusinessPrefill>();
/** Issue #187 — the turnover answer, one per financial year, kept apart from the address. */
const turnoverAnswers = new Map<string, readonly TurnoverAnswer[]>();

const str = (value: unknown): string => String(value ?? '').trim();

const require_ = (result: ValidationResult, code: string, fallback: string): void => {
  if (result.ok) return;
  throw invalid(code, result.problems[0]?.message ?? fallback);
};

// ------------------------------------------------------------------ the bank account, in masters

const bankAccountOf = (companyId: CompanyId | string, accountId: string | null): BankAccount | null => {
  if (accountId === null) return null;
  return masterData().bankAccounts(mastersContext(companyId)).find((account: BankAccount) => account.id === accountId) ?? null;
};

// ---------------------------------------------------------------------------------- reading them

export const businessDetailsOf = (companyId: CompanyId | string): BusinessDetails | null =>
  details.get(String(companyId)) ?? null;

/**
 * Remembers what somebody typed while setting a business up, so the Business details screen opens
 * with those answers already in it rather than asking for the same facts a second time.
 */
export const rememberBusinessPrefill = (companyId: CompanyId | string, prefill: BusinessPrefill): void => {
  prefills.set(String(companyId), prefill);
};

/** What the screen needs when it opens: what is saved, what to suggest, and the state list. */
export const readBusinessDetails = (
  companyId: CompanyId | string,
  company: { readonly name: string; readonly gstin: string },
) => {
  const saved = businessDetailsOf(companyId);
  const remembered = prefills.get(String(companyId)) ?? null;
  const stateCode = gstinStateCode(company.gstin);
  return {
    details: saved,
    bank: bankAccountOf(companyId, saved?.bankAccountId ?? null),
    gstin: company.gstin,
    // The state a GSTIN is registered in is a fact about the registration, not a choice, so the
    // screen shows it and refuses a different one (see `saveBusinessDetails`).
    gstinStateCode: stateCode,
    gstinStateName: STATE_NAMES[stateCode] ?? stateCode,
    gstinPan: gstinPan(company.gstin),
    prefill: {
      legalName: remembered?.legalName || company.name,
      tradeName: remembered?.tradeName ?? '',
      stateCode: remembered?.stateCode || stateCode,
      phone: remembered?.phone ?? '',
      address1: remembered?.address1 ?? '',
      address2: remembered?.address2 ?? '',
      city: remembered?.city ?? '',
      pincode: remembered?.pincode ?? '',
    },
    // Issue #237 — the same list setting up a business offers. A registration made under a code
    // that has since been retired is still shown, because the GST number decides this state.
    states: currentStates().some((state) => state.code === stateCode) ? currentStates() : [...currentStates(), { code: stateCode, name: STATE_NAMES[stateCode] ?? stateCode }],
    turnover: turnoverView(companyId),
  };
};

// ------------------------------------------------------------- the turnover question (#187)

const TURNOVER_ANSWERS: readonly TurnoverAbove5Crore[] = ['YES', 'NO', 'UNKNOWN'];
const todayIso = () => appToday();

/** Every answer this business has given, one per financial year. The calculator reads these. */
export const turnoverAnswersOf = (companyId: CompanyId | string): readonly TurnoverAnswer[] =>
  turnoverAnswers.get(String(companyId)) ?? [];

/** The answer for one financial year ("2026-27"), or "not sure" when that year was never answered. */
export const turnoverAnswerForYear = (companyId: CompanyId | string, financialYear: string): TurnoverAbove5Crore =>
  turnoverAnswersOf(companyId).find((answer) => answer.forFinancialYear === financialYear)?.answer ?? 'UNKNOWN';

/**
 * Records the turnover band for the financial year running today (#236). The answer is about the
 * year before, so it governs this year's bills, and on 1 April the question is open again.
 *
 * `band` is one of the five answers the screens offer. The older yes/no (`turnoverAbove5Crore`) is
 * still accepted from anything that sends it, and is kept as a yes/no: a "yes" says nothing about
 * ₹10 crore and a "no" nothing about the years before last, so Business details asks again.
 */
export const recordTurnoverAnswer = (
  companyId: CompanyId | string,
  input: { readonly band?: unknown; readonly above5Crore?: unknown },
  today = todayIso(),
): void => {
  const forFinancialYear = financialYearOf(today);
  const band = str(input.band).toUpperCase() as TurnoverBand;
  if (band !== ('' as TurnoverBand)) {
    if (!TURNOVER_BANDS.includes(band)) throw invalid('BUSINESS_TURNOVER_ANSWER', 'Choose one of the turnover answers, or Not sure.');
    turnoverAnswers.set(String(companyId), withTurnoverAnswer(turnoverAnswersOf(companyId), { answer: above5CroreOf(band), band, forFinancialYear }));
    return;
  }
  const answer = str(input.above5Crore).toUpperCase() as TurnoverAbove5Crore;
  if (answer === ('' as TurnoverAbove5Crore)) return;
  if (!TURNOVER_ANSWERS.includes(answer)) throw invalid('BUSINESS_TURNOVER_ANSWER', 'Choose Yes, No or Not sure.');
  // A bare yes/no never overwrites a band already given for this year with less than it said.
  const current = turnoverAnswersOf(companyId).find((given) => given.forFinancialYear === forFinancialYear);
  if (current?.band !== undefined && current.answer === answer) return;
  turnoverAnswers.set(String(companyId), withTurnoverAnswer(turnoverAnswersOf(companyId), { answer, forFinancialYear }));
};

/** The band that governs a bill dated `on`, or null when it has to be asked (#236). */
export const turnoverBandFor = (companyId: CompanyId | string, on: string): TurnoverBand | null =>
  turnoverBandOn(turnoverAnswersOf(companyId), isoDate(on));

const turnoverView = (companyId: CompanyId | string) => {
  const today = todayIso();
  const financialYear = financialYearOf(today);
  const given = turnoverAnswersOf(companyId).find((answer) => answer.forFinancialYear === financialYear);
  return {
    answer: given === undefined ? null : turnoverAnswerOn(turnoverAnswersOf(companyId), today),
    // Null when this year was never answered, or answered only with the old yes/no.
    band: turnoverBandOn(turnoverAnswersOf(companyId), today),
    // Issue #236 — an old "yes" or "no" is shown for what it was, with the question asked again.
    askAgain: given !== undefined && given.band === undefined && given.answer !== 'UNKNOWN' ? given.answer : null,
    financialYear,
  };
};

// ---------------------------------------------------------------------------------- saving them

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_SIGNATURE_CHARACTERS = 280_000; // ~200 KB once base64 encoded.

export const saveBusinessDetails = (
  companyId: CompanyId | string,
  company: { readonly name: string; readonly gstin: string },
  body: unknown,
) => {
  const input = (body ?? {}) as Record<string, unknown>;
  const clear = Array.isArray(input.clear) ? input.clear.map(String) : [];
  const current = businessDetailsOf(companyId);

  const legalName = str(input.legalName);
  if (legalName === '') throw invalid('BUSINESS_LEGAL_NAME', 'Type the name the business is registered under.');

  const address1 = str(input.address1);
  if (address1 === '') throw invalid('BUSINESS_ADDRESS1', 'Type the first line of the address — the law asks for the street, not only the town.');
  const city = str(input.city);
  if (city === '') throw invalid('BUSINESS_CITY', 'Type the town or city the business trades from.');
  const pincode = str(input.pincode);
  require_(validatePincode(pincode), 'BUSINESS_PINCODE', 'A PIN code has 6 digits.');

  const registeredState = gstinStateCode(company.gstin);
  const stateCode = str(input.stateCode) === '' ? registeredState : str(input.stateCode);
  if (stateCode !== registeredState) {
    throw invalid(
      'BUSINESS_STATE_MISMATCH',
      `Your GST number is registered in ${STATE_NAMES[registeredState] ?? registeredState}. The address on the bill must be in the same state.`,
    );
  }
  // Issue #224 — the seller's PIN is on every bill and is where every e-way bill starts from.
  require_(validatePincodeForState(pincode, stateCode), 'BUSINESS_PINCODE_STATE', 'That PIN code is not in your state.');

  const phone = str(input.phone);
  const email = str(input.email);
  if (email !== '' && !EMAIL.test(email)) throw invalid('BUSINESS_EMAIL', 'That is not an e-mail address. Leave it empty if the business has none.');

  const pan = normaliseIdentifier(str(input.pan));
  if (pan !== '') {
    require_(validatePan(pan), 'BUSINESS_PAN', 'A PAN has 5 letters, 4 digits and 1 letter, like ABCDE1234F.');
    const fromGstin = gstinPan(company.gstin);
    if (pan !== fromGstin) {
      throw invalid(
        'BUSINESS_PAN_MISMATCH',
        `Your GST number already carries a PAN: ${fromGstin}. A business has one PAN, so the two must be the same.`,
      );
    }
  }

  let signatureDataUri = clear.includes('signature') ? null : current?.signatureDataUri ?? null;
  const signature = str(input.signatureDataUri);
  if (signature !== '') {
    validateLogo(signature);
    if (signature.length > MAX_SIGNATURE_CHARACTERS) {
      throw invalid('BUSINESS_SIGNATURE_TOO_LARGE', 'That signature picture is too big. Use one under 200 KB.');
    }
    signatureDataUri = signature;
  }

  const bankAccountId = saveBankAccount(companyId, legalName, input, clear, current);
  recordTurnoverAnswer(companyId, { band: input.turnoverBand, above5Crore: input.turnoverAbove5Crore });

  const next: BusinessDetails = {
    legalName,
    tradeName: str(input.tradeName) === '' ? null : str(input.tradeName),
    address1,
    address2: str(input.address2) === '' ? null : str(input.address2),
    city,
    pincode,
    stateCode,
    phone: phone === '' ? null : phone,
    email: email === '' ? null : email,
    pan: pan === '' ? null : pan,
    bankAccountId,
    // Free text the business writes itself. Never pre-filled, never invented — see issue #158 and
    // the "no invented text on the bill" rule that removed the old "Goods once sold…" line.
    declaration: str(input.declaration) === '' ? null : str(input.declaration),
    terms: str(input.terms) === '' ? null : str(input.terms),
    signatureDataUri,
  };
  details.set(String(companyId), next);
  return { details: next, bank: bankAccountOf(companyId, bankAccountId), turnover: turnoverView(companyId) };
};

/** Writes the bank account into `packages/masters`, or leaves the saved one alone. */
const saveBankAccount = (
  companyId: CompanyId | string,
  legalName: string,
  input: Record<string, unknown>,
  clear: readonly string[],
  current: BusinessDetails | null,
): string | null => {
  if (clear.includes('bank')) return null;
  const bankName = str(input.bankName);
  const accountNumber = str(input.accountNumber);
  const ifsc = normaliseIdentifier(str(input.ifsc));
  const branch = str(input.branch);
  if (bankName === '' && accountNumber === '' && ifsc === '') return current?.bankAccountId ?? null;
  if (bankName === '' || accountNumber === '' || ifsc === '') {
    throw invalid('BUSINESS_BANK_INCOMPLETE', 'A bank account needs the bank name, the account number and the IFSC. Leave all three empty to print no bank details.');
  }
  require_(validateBankAccountNumber(accountNumber), 'BUSINESS_BANK_ACCOUNT', 'A bank account number has 9 to 18 digits.');
  require_(validateIfsc(ifsc), 'BUSINESS_BANK_IFSC', 'An IFSC has 4 bank letters, a 0, then 6 characters, like HDFC0001234.');

  const created = masterData().createBankAccount(
    mastersContext(companyId),
    {
      ownerType: 'company',
      accountName: legalName,
      accountNumber,
      ifsc,
      bankName,
      ...(branch === '' ? {} : { branchName: branch }),
      accountType: 'current',
    },
    { idempotencyKey: `business-details-bank:${String(companyId)}:${ifsc}:${accountNumber.replace(/\s/g, '')}` },
  );
  return created.record.id;
};

// ------------------------------------------------------------------- what the documents print

/** Everything a printed document takes from the business's own particulars. */
export interface SellerPrint {
  readonly seller: RenderableParty;
  readonly bank: RenderableBank | null;
  readonly declaration: string | null;
  readonly terms: string | null;
  readonly signatureDataUri: string | null;
}

/**
 * The seller block, frozen into a document the moment it is issued.
 *
 * Throws when there is no address, which is the same refusal `requireIssuable` gives, so no code
 * path can quietly print a bill without one.
 */
export const sellerPrint = (
  companyId: CompanyId | string,
  company: { readonly name: string; readonly gstin: string },
): SellerPrint => {
  const saved = requireIssuable(companyId);
  const account = bankAccountOf(companyId, saved.bankAccountId);
  return {
    seller: {
      // A trade name is the name the business trades under, and that is the one a customer knows.
      name: saved.tradeName ?? saved.legalName,
      addressLines: [saved.address1, ...(saved.address2 === null ? [] : [saved.address2]), `${saved.city} ${saved.pincode}`],
      gstin: company.gstin,
      pan: saved.pan,
      stateCode: saved.stateCode,
      stateName: STATE_NAMES[saved.stateCode] ?? saved.stateCode,
      phone: saved.phone,
      email: saved.email,
    },
    bank: account === null ? null : {
      bankName: account.bankName,
      accountNumber: account.accountNumber,
      branch: account.branchName ?? null,
      ifsc: account.ifsc,
    },
    declaration: saved.declaration,
    terms: saved.terms,
    signatureDataUri: saved.signatureDataUri,
  };
};

/** The "From / Dispatch From" block on an e-way bill, taken from the same address. */
export const dispatchFrom = (
  companyId: CompanyId | string,
  company: { readonly name: string; readonly gstin: string },
) => {
  const saved = requireIssuable(companyId);
  return {
    legalName: saved.tradeName ?? saved.legalName,
    gstin: company.gstin,
    address1: saved.address1,
    ...(saved.address2 === null ? {} : { address2: saved.address2 }),
    place: saved.city,
    pincode: saved.pincode,
    stateCode: saved.stateCode,
  };
};

/**
 * The one refusal. A document that travels with goods, or that a buyer claims credit on, must carry
 * where it came from, so nothing is issued until somebody has typed an address.
 */
export const requireIssuable = (companyId: CompanyId | string): BusinessDetails => {
  const saved = businessDetailsOf(companyId);
  if (saved === null || saved.address1 === '' || saved.city === '' || saved.pincode === '') {
    throw invalid(
      'BUSINESS_ADDRESS_MISSING',
      'Add your business address in Business details before issuing — the law requires it on every bill.',
    );
  }
  // Issue #224 — the seller's PIN prints on every bill and starts every e-way bill.
  if (!validatePincodeForState(saved.pincode, saved.stateCode).ok) {
    throw invalid(
      'BUSINESS_PINCODE_STATE',
      `Your business address is saved with PIN code ${saved.pincode}, which is not in ${STATE_NAMES[saved.stateCode] ?? saved.stateCode}. Correct it in Business details before issuing.`,
    );
  }
  return saved;
};

/** Test support: forgets everything, so one test's saved address cannot leak into another's. */
export const forgetBusinessDetails = (companyId: CompanyId | string): void => {
  details.delete(String(companyId));
  turnoverAnswers.delete(String(companyId));
};
