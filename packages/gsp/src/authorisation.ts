/**
 * Issue #33 [E33] — the one question asked before every call to the government.
 *
 * "May we do this, for this GST number, right now?"
 *
 * The answer is computed here, from the authorisation record and the clock, and nowhere else.
 * Keeping it in one pure function is what makes the third non-goal — "give one customer access to
 * another GSTIN" — a property of the code rather than a promise: there is exactly one door, it
 * takes a GST number, and it compares that number with the one on the consent.
 *
 * Every refusal is a sentence somebody can act on. A shopkeeper standing next to a loaded lorry at
 * eight in the evening is not helped by "403", and a business that cannot tell "your authorisation
 * ran out, here is how to renew it" from "the portal is down" will make the wrong decision about
 * whether to send the goods.
 */
import { bilingual, OPERATION_SCOPES, SCOPE_NAMES, type GovernmentScope, type GstinAuthorisation, type ProviderProfile, type Refusal } from './types.ts';

export interface AuthorisationCheck {
  readonly authorisation: GstinAuthorisation | null;
  readonly operation: string;
  readonly gstin: string;
  readonly now: string;
  readonly provider?: ProviderProfile;
}

export type AuthorisationVerdict =
  | { readonly allowed: true; readonly scope: GovernmentScope; readonly authorisation: GstinAuthorisation }
  | { readonly allowed: false; readonly refusal: Refusal };

/**
 * Whether one call may be made.
 *
 * The order of the checks is deliberate. Identity first — a call whose GST number does not match
 * the authorisation is refused before anything else is even considered, so a mismatch can never be
 * excused by a generous scope list. Then the state of the authorisation, then what was consented
 * to, then what the provider can actually do.
 */
export const checkAuthorisation = (input: AuthorisationCheck): AuthorisationVerdict => {
  const scope = OPERATION_SCOPES[input.operation];
  if (scope === undefined) {
    return refuse('UNKNOWN_OPERATION', false, bilingual(
      'This app tried to do something with the government that it has no permission mapped for, so nothing was sent.',
      'App ne government ke saath aisa kuch karna chaha jiski koi ijazat tay nahin hai, isliye kuch bheja nahin gaya.',
    ), null);
  }

  const authorisation = input.authorisation;
  if (authorisation === null) {
    return refuse('NOT_AUTHORISED', false, bilingual(
      `GST number ${input.gstin} is not connected to the government services yet.`,
      `GST number ${input.gstin} abhi government services se juda nahin hai.`,
    ), bilingual('Connect this GST number in settings; it takes a one-time password on the signatory’s phone.', 'Settings mein yeh GST number jodein; signatory ke phone par ek OTP aayega.'));
  }

  if (authorisation.gstin !== input.gstin) {
    // Not reachable through the service, which looks the record up by the same number. Kept
    // because the day it becomes reachable is the day one business acts for another's GST number.
    return refuse('GSTIN_MISMATCH', false, bilingual(
      'That request was for a different GST number than the one authorised, so nothing was sent.',
      'Woh request kisi doosre GST number ke liye thi, isliye kuch nahin bheja gaya.',
    ), null);
  }

  switch (authorisation.status) {
    case 'REVOKED':
      return refuse('AUTHORISATION_REVOKED', false, bilingual(
        `The permission to act for GST number ${input.gstin} was taken back${authorisation.revokedAt === null ? '' : ` on ${authorisation.revokedAt.slice(0, 10)}`}, so nothing was sent.`,
        `GST number ${input.gstin} ke liye di gayi ijazat wapas le li gayi thi, isliye kuch nahin bheja gaya.`,
      ), bilingual('Authorise it again in settings if this business should still be connected.', 'Agar yeh business abhi bhi juda rehna chahiye to settings mein dobara ijazat dein.'));
    case 'SUSPENDED':
      return refuse('AUTHORISATION_SUSPENDED', true, bilingual(
        `Calls for GST number ${input.gstin} are paused: ${authorisation.suspendedReason ?? 'no reason was recorded'}.`,
        `GST number ${input.gstin} ke liye calls roki gayi hain: ${authorisation.suspendedReason ?? 'koi vajah darj nahin hai'}.`,
      ), bilingual('Resume it in settings once the reason is dealt with.', 'Vajah door hone par settings mein dobara chaalu karein.'));
    case 'EXPIRED':
      return refuse('AUTHORISATION_EXPIRED', false, expiredWording(input.gstin), renewAction());
    case 'ACTIVE':
      break;
    default:
      return refuse('NOT_AUTHORISED', false, bilingual(
        `Connecting GST number ${input.gstin} is not finished yet.`,
        `GST number ${input.gstin} jodna abhi poora nahin hua hai.`,
      ), bilingual('Finish it in settings — the one-time password step is still pending.', 'Settings mein poora karein — OTP wala step abhi baaki hai.'));
  }

  if (hasLapsed(authorisation, input.now)) {
    return refuse('AUTHORISATION_EXPIRED', false, expiredWording(input.gstin), renewAction());
  }

  if (authorisation.credential === null) {
    return refuse('CREDENTIAL_MISSING', false, bilingual(
      'The connection for this GST number has no working credentials, so nothing was sent.',
      'Is GST number ke connection ke paas chalu credentials nahin hain, isliye kuch nahin bheja gaya.',
    ), bilingual('Connect this GST number again in settings.', 'Settings mein yeh GST number dobara jodein.'));
  }

  if (!authorisation.scopes.includes(scope)) {
    return refuse('SCOPE_NOT_GRANTED', false, bilingual(
      `This business did not allow "${SCOPE_NAMES[scope]['en-IN'].toLowerCase()}" for GST number ${input.gstin}, so nothing was sent.`,
      `Is business ne GST number ${input.gstin} ke liye "${SCOPE_NAMES[scope]['hi-IN']}" ki ijazat nahin di, isliye kuch nahin bheja gaya.`,
    ), bilingual('Add it to the permissions in settings, with the owner’s agreement.', 'Malik ki sehmati se settings mein yeh ijazat jodein.'));
  }

  if (input.provider !== undefined && !input.provider.supports.includes(scope)) {
    return refuse('PROVIDER_DOES_NOT_SUPPORT', false, bilingual(
      `Our provider cannot do "${SCOPE_NAMES[scope]['en-IN'].toLowerCase()}" for this business, so nothing was sent.`,
      `Hamara provider is business ke liye "${SCOPE_NAMES[scope]['hi-IN']}" nahin kar sakta, isliye kuch nahin bheja gaya.`,
    ), null);
  }

  return { allowed: true, scope, authorisation };
};

/** An authorisation whose validity has run out, whatever its stored status still says. */
export const hasLapsed = (authorisation: GstinAuthorisation, now: string): boolean => {
  if (authorisation.validUntil !== null && authorisation.validUntil <= now) return true;
  const credential = authorisation.credential;
  return credential !== null && credential.expiresAt !== null && credential.expiresAt <= now;
};

/**
 * The status a screen should show, which is not always the status in the row.
 *
 * A record that says `ACTIVE` with a credential that expired last night is not active, and a stored
 * status recomputed on write would be wrong the moment the clock moved past it. So the stored value
 * is what somebody did, and this is what is true now.
 */
export const effectiveStatus = (authorisation: GstinAuthorisation, now: string): GstinAuthorisation['status'] =>
  authorisation.status === 'ACTIVE' && hasLapsed(authorisation, now) ? 'EXPIRED' : authorisation.status;

const expiredWording = (gstin: string) =>
  bilingual(
    `The connection for GST number ${gstin} has expired, so nothing was sent.`,
    `GST number ${gstin} ka connection khatam ho gaya hai, isliye kuch nahin bheja gaya.`,
  );

const renewAction = () =>
  bilingual(
    'Connect it again in settings — it takes a one-time password on the signatory’s phone.',
    'Settings mein dobara jodein — signatory ke phone par ek OTP aayega.',
  );

const refuse = (
  reason: Refusal['reason'],
  retryable: boolean,
  message: Refusal['message'],
  nextAction: Refusal['nextAction'],
): AuthorisationVerdict => ({ allowed: false, refusal: { reason, message, retryable, nextAction } });
