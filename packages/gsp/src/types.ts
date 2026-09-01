/**
 * Issue #33 [E33] — what an authorisation to act for a GST number is made of.
 *
 * The plain problem first. Everything this product does with the government — registering an
 * invoice for its IRN, raising an e-way bill, filing a return, downloading what suppliers reported
 * — happens through a licensed provider, and the provider will only act for a GST number that the
 * business itself has authorised. That authorisation is not a setting. It is a consent, given by a
 * named person on a date, for a named list of things, that expires, that can be taken back, and
 * that belongs to exactly one GST number.
 *
 * Four rules run through every type below.
 *
 *   1. **One GST number, one authorisation.** A business with a Karnataka registration and a
 *      Maharashtra one has two of these, with separate consent, separate credentials and separate
 *      expiry. Nothing in this module can be scoped to a company alone, because a company is not
 *      what the government authorises. This is what makes "give one customer access to another
 *      GSTIN" impossible rather than merely forbidden.
 *   2. **We never hold a portal password.** There is no field for one anywhere in this file, and
 *      that is the design, not an omission. What we hold is an opaque credential *reference* the
 *      vault (#8) resolves, and the transient state of an OTP challenge — its id, when it expires,
 *      how many attempts are left. The one-time password itself is typed by the person, passed
 *      through to the provider and never written down.
 *   3. **Taking authorisation back stops the next call and erases nothing.** A revoked
 *      authorisation keeps its consent record, its credential history and every call ever made
 *      under it. The business is entitled to know what was done in its name, and a record deleted
 *      to make a screen tidy is a record that was needed later.
 *   4. **What we believe must match what the government acknowledged.** Every call is recorded with
 *      the provider's own request id and the government's own acknowledgement. Where our record
 *      says one thing and the portal says another, that is an exception for a person — never a
 *      silent correction in either direction.
 */
import type { CompanyId, IsoDate, UserId } from '@invoice/kernel';
import type { Bilingual } from '../../gst-returns/src/types.ts';

export type { Bilingual };

export const bilingual = (en: string, hi: string): Bilingual => Object.freeze({ 'en-IN': en, 'hi-IN': hi });

// ---------------------------------------------------------------------------- scopes

/**
 * The things a business can authorise us to do in its name, one per government act.
 *
 * They are separate because they are separately consequential. Reading what suppliers reported is
 * harmless; cancelling an e-invoice is not; filing a return is the business making a legal
 * statement. A consent screen that offered "connect to GST" as one switch would be asking for
 * permission to do things nobody agreed to.
 */
export type GovernmentScope =
  | 'EINVOICE_GENERATE'
  | 'EINVOICE_CANCEL'
  | 'EINVOICE_FETCH'
  | 'EWAY_GENERATE'
  | 'EWAY_UPDATE'
  | 'EWAY_CANCEL'
  | 'EWAY_FETCH'
  | 'RETURN_SUBMIT'
  | 'RETURN_FETCH'
  | 'GSTR2B_FETCH';

export const SCOPE_NAMES: Readonly<Record<GovernmentScope, Bilingual>> = Object.freeze({
  EINVOICE_GENERATE: bilingual('Register your sales bills for an IRN', 'Aapke bikri bill ka IRN lena'),
  EINVOICE_CANCEL: bilingual('Cancel an e-invoice within the allowed time', 'Samay ke andar e-invoice cancel karna'),
  EINVOICE_FETCH: bilingual('Look up an e-invoice already registered', 'Pehle se registered e-invoice dekhna'),
  EWAY_GENERATE: bilingual('Raise e-way bills for goods you send', 'Aapke bheje maal ka e-way bill banana'),
  EWAY_UPDATE: bilingual('Change the vehicle or extend an e-way bill', 'Gaadi badalna ya e-way bill badhana'),
  EWAY_CANCEL: bilingual('Cancel an e-way bill within the allowed time', 'Samay ke andar e-way bill cancel karna'),
  EWAY_FETCH: bilingual('Look up an e-way bill', 'E-way bill dekhna'),
  RETURN_SUBMIT: bilingual('File your GST returns', 'Aapke GST return file karna'),
  RETURN_FETCH: bilingual('Check what has been filed', 'Kya file hua hai yeh dekhna'),
  GSTR2B_FETCH: bilingual('Download what your suppliers reported about you', 'Suppliers ne aapke baare mein kya bataya, woh lena'),
});

/**
 * Which scope each provider operation needs.
 *
 * The operation names are the ones #26, #27, #30 and #31 already send through #8's connector, so
 * this table is the single place where "what the code is doing" is translated into "what the
 * business agreed to". An operation missing from this table is refused: an act nobody has mapped to
 * a consent is an act nobody consented to.
 *
 * They must be spelled exactly as the adapters send them, which is not a detail: `eway.vehicle` and
 * `eway.transporter` are what #27 posts, and a table carrying tidier names would refuse a driver
 * changing lorries at nine at night with "this app tried to do something it has no permission
 * for". A test in `ops/gsp-selection` reads the adapters and fails if the two ever drift apart.
 */
export const OPERATION_SCOPES: Readonly<Record<string, GovernmentScope>> = Object.freeze({
  'einvoice.generate': 'EINVOICE_GENERATE',
  'einvoice.cancel': 'EINVOICE_CANCEL',
  'einvoice.fetch': 'EINVOICE_FETCH',
  'eway.generate': 'EWAY_GENERATE',
  'eway.vehicle': 'EWAY_UPDATE',
  'eway.transporter': 'EWAY_UPDATE',
  'eway.extend': 'EWAY_UPDATE',
  'eway.consolidate': 'EWAY_UPDATE',
  'eway.cancel': 'EWAY_CANCEL',
  'eway.reject': 'EWAY_CANCEL',
  'eway.fetch': 'EWAY_FETCH',
  'return.submit': 'RETURN_SUBMIT',
  'return.status': 'RETURN_FETCH',
  'gstr2b.fetch': 'GSTR2B_FETCH',
});

// ---------------------------------------------------------------------------- the states

/**
 * Where one GST number's authorisation has got to.
 *
 * The three states before `ACTIVE` exist because the real thing takes three steps and can stop at
 * any of them: the provider creates an API user for the GST number, the portal sends a one-time
 * password to the signatory's phone, and somebody types it back. A business stuck at
 * `OTP_REQUESTED` because nobody read the message is an ordinary Tuesday, and the screen should be
 * able to say exactly that instead of "not connected".
 */
export type AuthorisationStatus =
  | 'NOT_STARTED'
  | 'API_USER_PENDING'
  | 'OTP_REQUESTED'
  | 'ACTIVE'
  | 'EXPIRED'
  | 'SUSPENDED'
  | 'REVOKED';

/**
 * The consent itself: who agreed, to what, when, and the words they were shown.
 *
 * The wording is stored with the consent rather than referenced, because the text on the screen is
 * what the person actually agreed to. A version number pointing at wording that has since been
 * edited proves nothing.
 */
export interface ConsentRecord {
  readonly id: string;
  readonly grantedBy: UserId;
  readonly grantedAt: string;
  readonly scopes: readonly GovernmentScope[];
  /** The exact sentence shown to the person, in the language they were shown it in. */
  readonly wordingShown: Bilingual;
  /** How the person confirmed: an OTP on the signatory's phone, or an authorised signatory in person. */
  readonly method: 'PORTAL_OTP' | 'SIGNED_AUTHORISATION';
  /** Set when the consent has been withdrawn. The record itself is never deleted. */
  readonly withdrawnAt?: string;
  readonly withdrawnBy?: UserId;
  readonly withdrawalReason?: string;
}

/**
 * A one-time password challenge in flight.
 *
 * Note what is not here: the password. The provider sends it to the signatory's registered phone,
 * the person types it into this product, and it is passed straight through to the provider without
 * being stored, hashed or logged. What we keep is enough to show a sensible screen — which request
 * it belongs to, when it stops working, and how many tries are left before the portal locks it.
 */
export interface OtpChallenge {
  readonly requestId: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly attemptsRemaining: number;
  /** The last four digits of the phone the portal sent it to, so a person knows where to look. */
  readonly sentToHint: string;
}

/**
 * An opaque handle to credentials held by the vault (#8).
 *
 * `reference` is a vault address, never a secret, and this product's own logs and audit records
 * carry the reference and nothing else. Rotation replaces the live handle and pushes the previous
 * one into `history`, because "which credential was this call made with" is a question an incident
 * has to be able to answer.
 */
export interface CredentialHandle {
  readonly reference: string;
  readonly issuedAt: string;
  readonly expiresAt: string | null;
  readonly rotatedBy?: UserId;
  readonly rotationReason?: string;
}

/**
 * One GST number's authorisation, whole.
 *
 * The identity is `(companyId, gstin)`. Everything the channel checks before a call is on this
 * record, so the check is one lookup and cannot drift from what a screen shows.
 */
export interface GstinAuthorisation {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly gstin: string;
  readonly legalName: string;
  readonly status: AuthorisationStatus;
  readonly provider: string;
  /** Sandbox until a signed contract says otherwise. See `ProviderProfile`. */
  readonly environment: ProviderEnvironment;
  readonly scopes: readonly GovernmentScope[];
  readonly consent: ConsentRecord | null;
  readonly credential: CredentialHandle | null;
  readonly credentialHistory: readonly CredentialHandle[];
  readonly otp: OtpChallenge | null;
  /** The provider's own user id for this GST number. Not a secret; useful in a support call. */
  readonly apiUserId: string | null;
  /** When the authorisation itself lapses. The portal's session validity, not the credential's. */
  readonly validUntil: string | null;
  readonly suspendedReason: string | null;
  readonly revokedAt: string | null;
  readonly revokedBy: UserId | null;
  readonly revocationReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const authorisationKey = (companyId: CompanyId, gstin: string): string => `${companyId}:${gstin}`;

// ---------------------------------------------------------------------------- the provider

export type ProviderEnvironment = 'SANDBOX' | 'PRODUCTION';

/**
 * What we know about the provider we are calling.
 *
 * The comparison and the contract are #50 and #51 and are not finished. Until they are, this shape
 * is how a provider is described to the code: which environment, which acts it supports, and the
 * call limits it publishes. A profile that does not list an act cannot be used for it — an
 * unlisted operation is not a permission we quietly assume the contract covers.
 */
export interface ProviderProfile {
  readonly name: string;
  readonly environment: ProviderEnvironment;
  readonly supports: readonly GovernmentScope[];
  /** Published limits. Ours are enforced below them, so we are never the reason a limit is hit. */
  readonly limits: readonly RateLimitRule[];
  /** Where the contract and the onboarding record live, for a person who has to check. */
  readonly contractRef: string | null;
}

export interface RateLimitRule {
  /** An operation name, or `*` for every operation on this GST number. */
  readonly operation: string;
  readonly maxCalls: number;
  readonly windowSeconds: number;
}

// ---------------------------------------------------------------------------- refusals

/**
 * Why a call was not made.
 *
 * Every one of these is a sentence a shopkeeper can act on, because the alternative — "403" on a
 * screen at eight in the evening with a lorry waiting — is how a business decides the software is
 * broken. `retryable` says whether the same call will work later without anybody doing anything.
 */
export type RefusalReason =
  | 'NOT_AUTHORISED'
  | 'AUTHORISATION_REVOKED'
  | 'AUTHORISATION_EXPIRED'
  | 'AUTHORISATION_SUSPENDED'
  | 'SCOPE_NOT_GRANTED'
  | 'UNKNOWN_OPERATION'
  | 'PROVIDER_DOES_NOT_SUPPORT'
  | 'RATE_LIMITED'
  | 'GSTIN_MISMATCH'
  | 'CREDENTIAL_MISSING';

export interface Refusal {
  readonly reason: RefusalReason;
  readonly message: Bilingual;
  readonly retryable: boolean;
  /** What the business can do about it, when there is something. */
  readonly nextAction: Bilingual | null;
  /** Set for a rate limit: the moment the call may be tried again. */
  readonly retryAfter?: string;
}

// ---------------------------------------------------------------------------- the call record

export type CallOutcomeKind =
  /** The provider answered and the government accepted it. */
  | 'ACCEPTED'
  /** The provider answered and the government refused the document itself. */
  | 'REJECTED'
  /** We never found out. Never recorded as a failure — see the note on `ProviderCall`. */
  | 'UNKNOWN'
  /** We did not call at all. */
  | 'REFUSED';

/**
 * One call to the government, as we will need to remember it.
 *
 * `UNKNOWN` is the state this whole module is built around. A timeout on an e-invoice does not mean
 * the invoice was not registered; it means we do not know, and the difference is an IRN that exists
 * with nobody holding it. Unknown calls are kept, polled and reconciled by `reconcile.ts` until the
 * government's own answer settles them. Nothing here is ever quietly marked failed.
 *
 * The payload is not stored. What is stored is enough to reconcile — operation, GST number,
 * document reference, idempotency key, provider request id, government acknowledgement — and the
 * redaction in `redact.ts` is what keeps a secret out of it even when a caller passes one in.
 */
export interface ProviderCall {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly gstin: string;
  readonly operation: string;
  readonly scope: GovernmentScope | null;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  /** Our own reference for the thing being sent: an invoice id, an e-way movement, a period. */
  readonly documentRef: string | null;
  readonly outcome: CallOutcomeKind;
  readonly providerRequestId: string | null;
  /** The government's own acknowledgement number, IRN or e-way number, when it gave one. */
  readonly governmentReference: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly refusal: RefusalReason | null;
  readonly attempts: number;
  readonly credentialReference: string | null;
  readonly startedAt: string;
  readonly settledAt: string | null;
  readonly actorId: UserId;
  /** Set when reconciliation has since settled an unknown call. */
  readonly reconciledAt: string | null;
}

/** What polling the provider found out about a call we were unsure of. */
export type ReconciliationOutcome =
  /** The government's record agrees with ours. Nothing to do but say so. */
  | { readonly kind: 'CONFIRMED'; readonly governmentReference: string }
  /** It went through after all. Our record is corrected to match the government's. */
  | { readonly kind: 'CORRECTED'; readonly governmentReference: string; readonly was: CallOutcomeKind }
  /** It never went through. Recorded, so the document can be sent again deliberately. */
  | { readonly kind: 'NOT_FOUND' }
  /** We hold one thing and the government holds another. A person decides; nothing is overwritten. */
  | { readonly kind: 'CONFLICT'; readonly ours: string; readonly theirs: string }
  | { readonly kind: 'STILL_UNKNOWN'; readonly detail: string };

export interface ReconciliationReport {
  readonly at: string;
  readonly checked: number;
  readonly confirmed: number;
  readonly corrected: number;
  readonly notFound: number;
  readonly conflicts: readonly ReconciliationConflict[];
  readonly stillUnknown: number;
}

export interface ReconciliationConflict {
  readonly callId: string;
  readonly gstin: string;
  readonly operation: string;
  readonly documentRef: string | null;
  readonly ours: string;
  readonly theirs: string;
  readonly question: Bilingual;
}

// ---------------------------------------------------------------------------- permissions

/**
 * Connecting a GST number, taking that connection back and rotating credentials are three
 * different acts and three different permissions.
 *
 * Authorising is the business making a statement to the government; revoking is an emergency
 * control that must not require the person who can authorise; rotating touches credentials and
 * belongs with whoever handles security. Reading the connection status is harmless and separate
 * from all three.
 */
export const GSP_PERMISSIONS = Object.freeze({
  view: 'gsp.connection.view',
  authorise: 'gsp.connection.authorise',
  revoke: 'gsp.connection.revoke',
  rotate: 'gsp.credential.rotate',
  reconcile: 'gsp.calls.reconcile',
});

/** The sentence a person is shown before they authorise. Stored with the consent they give. */
export const consentWording = (gstin: string, scopes: readonly GovernmentScope[]): Bilingual =>
  bilingual(
    `You are allowing this app to act for GST number ${gstin} through our authorised provider, for these things only: ${scopes.map((scope) => SCOPE_NAMES[scope]['en-IN'].toLowerCase()).join('; ')}. You can take this back at any time, and we never see or keep your GST portal password.`,
    `Aap is app ko GST number ${gstin} ke liye, hamare adhikrit provider ke through, sirf in kaamon ki ijazat de rahe hain: ${scopes.map((scope) => SCOPE_NAMES[scope]['hi-IN'].toLowerCase()).join('; ')}. Aap yeh ijazat kabhi bhi wapas le sakte hain, aur aapka GST portal password hum na dekhte hain na rakhte hain.`,
  );

export type { CompanyId, IsoDate, UserId };
