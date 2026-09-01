/**
 * Issue #33 [E33] — connecting a GST number, and taking that connection back.
 *
 * The whole of the onboarding dance lives here: the provider creates an API user for the GST
 * number, the portal sends a one-time password to the signatory's phone, somebody types it back,
 * and the business's consent is recorded with the words it was given in. After that the credential
 * can be rotated, the connection can be paused, and it can be revoked — which stops the next call
 * and erases nothing.
 *
 * Three promises are kept here rather than anywhere else.
 *
 *   1. **We never take a portal password.** `verifyOtp` takes the one-time password the person just
 *      read off their phone, hands it to the provider and forgets it. Nothing on the record has a
 *      field for a password, and `containsSecretField` refuses a caller that tries to smuggle one
 *      into an onboarding payload.
 *   2. **Each GST number stands alone.** Every method takes a GST number and touches exactly one
 *      record. Revoking Karnataka does not touch Maharashtra, and a business with one connected
 *      registration and one half-connected one is an ordinary state this module can describe.
 *   3. **Revocation is a stop, not an erasure.** The status changes, the credential is cleared, the
 *      consent is marked withdrawn — and the consent record, the credential history and every call
 *      ever made under the authorisation stay exactly where they were.
 */
import { conflict, forbidden, invalid, notFound, type Clock, type CompanyId, type UserId } from '@invoice/kernel';
import type { ActorContext, AuditPort } from '@invoice/ledger';
import { effectiveStatus } from './authorisation.ts';
import { containsSecretField, redactDetails } from './redact.ts';
import type { AuthorisationRepository, CallLogRepository, GspProviderPort } from './ports.ts';
import {
  GSP_PERMISSIONS,
  authorisationKey,
  bilingual,
  consentWording,
  type Bilingual,
  type ConsentRecord,
  type GovernmentScope,
  type GstinAuthorisation,
  type ProviderCall,
} from './types.ts';

export interface GovernmentAccessDeps {
  readonly authorisations: AuthorisationRepository;
  readonly calls: CallLogRepository;
  readonly provider: GspProviderPort;
  readonly audit: AuditPort;
  readonly clock: Clock;
  readonly idFactory?: () => string;
}

export interface BeginOnboardingInput {
  readonly gstin: string;
  readonly legalName: string;
  /** How the portal will reach the authorised signatory. Held by the portal, not by us. */
  readonly signatoryHint: string;
  readonly scopes: readonly GovernmentScope[];
}

export type OnboardingStep =
  | { readonly kind: 'API_USER_READY'; readonly authorisation: GstinAuthorisation }
  | { readonly kind: 'OTP_SENT'; readonly authorisation: GstinAuthorisation }
  | { readonly kind: 'AUTHORISED'; readonly authorisation: GstinAuthorisation }
  | { readonly kind: 'WRONG_OTP'; readonly attemptsRemaining: number; readonly message: Bilingual }
  | { readonly kind: 'OTP_EXPIRED'; readonly message: Bilingual }
  | { readonly kind: 'REFUSED'; readonly code: string; readonly message: Bilingual }
  | { readonly kind: 'UNAVAILABLE'; readonly retryable: boolean; readonly message: Bilingual };

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/;

export class GovernmentAccessService {
  readonly #deps: GovernmentAccessDeps;

  constructor(deps: GovernmentAccessDeps) {
    this.#deps = deps;
  }

  // ------------------------------------------------------------------ reading

  /** Every GST number of this business and where its connection has got to. */
  async connections(actor: ActorContext): Promise<readonly GstinAuthorisation[]> {
    this.#require(actor, GSP_PERMISSIONS.view);
    const now = this.#now();
    return (await this.#deps.authorisations.list(actor.companyId)).map((row) => ({
      ...row,
      status: effectiveStatus(row, now),
    }));
  }

  async connection(actor: ActorContext, gstin: string): Promise<GstinAuthorisation> {
    this.#require(actor, GSP_PERMISSIONS.view);
    const row = await this.#load(actor.companyId, gstin);
    return { ...row, status: effectiveStatus(row, this.#now()) };
  }

  /** The authorisation and everything ever done under it, including after it was revoked. */
  async history(
    actor: ActorContext,
    gstin: string,
  ): Promise<{ readonly authorisation: GstinAuthorisation; readonly calls: readonly ProviderCall[] }> {
    this.#require(actor, GSP_PERMISSIONS.view);
    const authorisation = await this.#load(actor.companyId, gstin);
    const calls = await this.#deps.calls.list(actor.companyId, gstin);
    return { authorisation: { ...authorisation, status: effectiveStatus(authorisation, this.#now()) }, calls };
  }

  // ------------------------------------------------------------------ onboarding

  /**
   * Step one: ask the provider for an API user for this GST number.
   *
   * Safe to repeat. A provider that already has a user says so, and this ends in the same place —
   * which matters, because somebody who lost the page halfway through will press the button again.
   */
  async beginOnboarding(actor: ActorContext, input: BeginOnboardingInput): Promise<OnboardingStep> {
    this.#require(actor, GSP_PERMISSIONS.authorise);
    if (!GSTIN.test(input.gstin)) {
      throw invalid('GSP_GSTIN_INVALID', 'That does not look like a GST number. Check it against the registration certificate — a digit is probably mistyped.');
    }
    if (containsSecretField(input)) {
      // Somebody is trying to hand us a password "to make it easier". This product does not have
      // anywhere to put one, and the honest answer is to say so rather than to accept and drop it.
      throw invalid(
        'GSP_PASSWORD_NOT_ACCEPTED',
        'This app never asks for or keeps your GST portal password. Connecting works with a one-time password sent to the signatory’s phone.',
      );
    }
    if (input.scopes.length === 0) {
      throw invalid('GSP_SCOPES_REQUIRED', 'Choose what this business is allowing the app to do with the government.');
    }
    const unsupported = input.scopes.filter((scope) => !this.#deps.provider.profile.supports.includes(scope));
    if (unsupported.length > 0) {
      throw invalid('GSP_SCOPE_UNSUPPORTED', 'Our provider cannot do one of the things you selected for this GST number yet.', {
        details: { scopes: unsupported.join(',') },
      });
    }

    const existing = await this.#deps.authorisations.find(actor.companyId, input.gstin);
    if (existing !== null && existing.status === 'ACTIVE') {
      throw conflict('GSP_ALREADY_CONNECTED', 'This GST number is already connected. To change what it is allowed to do, connect it again after taking the current permission back.');
    }

    const outcome = await this.#deps.provider.createApiUser({
      companyId: actor.companyId,
      gstin: input.gstin,
      legalName: input.legalName,
      signatoryHint: input.signatoryHint,
      scopes: input.scopes,
    });
    if (outcome.kind === 'REFUSED') {
      return { kind: 'REFUSED', code: outcome.code, message: bilingual(outcome.message, outcome.message) };
    }
    if (outcome.kind === 'UNAVAILABLE') {
      return {
        kind: 'UNAVAILABLE',
        retryable: outcome.retryable,
        message: bilingual(
          'The provider did not answer just now, so this GST number is not connected yet. Nothing was lost — try again in a few minutes.',
          'Provider ne abhi jawab nahin diya, isliye yeh GST number abhi juda nahin hai. Kuch gaya nahin — thodi der baad phir se koshish karein.',
        ),
      };
    }

    const at = this.#now();
    const authorisation: GstinAuthorisation = {
      id: existing?.id ?? this.#id(),
      companyId: actor.companyId,
      gstin: input.gstin,
      legalName: input.legalName,
      status: 'API_USER_PENDING',
      provider: this.#deps.provider.profile.name,
      environment: this.#deps.provider.profile.environment,
      scopes: [...input.scopes],
      consent: existing?.consent ?? null,
      credential: null,
      credentialHistory: existing?.credentialHistory ?? [],
      otp: null,
      apiUserId: outcome.apiUserId,
      validUntil: null,
      suspendedReason: null,
      revokedAt: null,
      revokedBy: null,
      revocationReason: null,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    await this.#deps.authorisations.put(authorisation);
    await this.#audit(actor, authorisation, 'gsp.authorisation.started', `An API user was set up for GST number ${input.gstin}.`, {
      apiUser: outcome.apiUserId,
      scopes: input.scopes.join(','),
      environment: authorisation.environment,
    });
    return { kind: 'API_USER_READY', authorisation };
  }

  /** Step two: the portal sends a one-time password to the signatory's registered phone. */
  async requestOtp(actor: ActorContext, gstin: string): Promise<OnboardingStep> {
    this.#require(actor, GSP_PERMISSIONS.authorise);
    const authorisation = await this.#load(actor.companyId, gstin);
    if (authorisation.apiUserId === null) {
      throw invalid('GSP_NOT_STARTED', 'Start connecting this GST number before asking for the one-time password.');
    }
    if (authorisation.status === 'REVOKED') {
      throw invalid('GSP_REVOKED', 'The permission for this GST number was taken back. Start connecting it again.');
    }

    const outcome = await this.#deps.provider.requestOtp({ gstin, apiUserId: authorisation.apiUserId });
    if (outcome.kind === 'REFUSED') return { kind: 'REFUSED', code: outcome.code, message: bilingual(outcome.message, outcome.message) };
    if (outcome.kind === 'UNAVAILABLE') {
      return {
        kind: 'UNAVAILABLE',
        retryable: outcome.retryable,
        message: bilingual('The portal did not send the code just now. Try again in a few minutes.', 'Portal ne abhi code nahin bheja. Thodi der baad phir se koshish karein.'),
      };
    }

    const at = this.#now();
    const updated: GstinAuthorisation = {
      ...authorisation,
      status: 'OTP_REQUESTED',
      otp: {
        requestId: outcome.requestId,
        requestedAt: at,
        expiresAt: outcome.expiresAt,
        attemptsRemaining: outcome.attemptsAllowed,
        sentToHint: outcome.sentToHint,
      },
      updatedAt: at,
    };
    await this.#deps.authorisations.put(updated);
    // The request id and the phone hint are recorded; the password itself is not, because it is not
    // here — the portal sent it to a phone, and it will pass through this product without stopping.
    await this.#audit(actor, updated, 'gsp.authorisation.otp_requested', `A one-time password was sent to the signatory for GST number ${gstin}.`, {
      requestId: outcome.requestId,
      sentTo: outcome.sentToHint,
      expiresAt: outcome.expiresAt,
    });
    return { kind: 'OTP_SENT', authorisation: updated };
  }

  /**
   * Step three: the person types the code, the provider verifies it, and the consent is recorded.
   *
   * The `otp` argument is used once and never stored. What is written down is the consent — who
   * agreed, when, to which scopes, and the exact sentence they were shown — and a vault reference
   * for the credentials the provider issued.
   */
  async verifyOtp(actor: ActorContext, gstin: string, otp: string): Promise<OnboardingStep> {
    this.#require(actor, GSP_PERMISSIONS.authorise);
    const authorisation = await this.#load(actor.companyId, gstin);
    const challenge = authorisation.otp;
    if (challenge === null) {
      throw invalid('GSP_NO_OTP', 'Ask for the one-time password first — it is sent to the signatory’s phone.');
    }
    const at = this.#now();
    if (challenge.expiresAt <= at) {
      await this.#deps.authorisations.put({ ...authorisation, otp: null, updatedAt: at });
      return {
        kind: 'OTP_EXPIRED',
        message: bilingual('That code has expired. Ask for a new one.', 'Woh code khatam ho gaya. Naya code mangwaayein.'),
      };
    }

    const outcome = await this.#deps.provider.verifyOtp({ gstin, requestId: challenge.requestId, otp });
    if (outcome.kind === 'UNAVAILABLE') {
      return {
        kind: 'UNAVAILABLE',
        retryable: outcome.retryable,
        message: bilingual('The provider did not answer. Your code is still valid — try again in a moment.', 'Provider ne jawab nahin diya. Aapka code abhi bhi chalu hai — thodi der mein phir koshish karein.'),
      };
    }
    if (outcome.kind === 'EXPIRED') {
      await this.#deps.authorisations.put({ ...authorisation, otp: null, updatedAt: at });
      return { kind: 'OTP_EXPIRED', message: bilingual('That code has expired. Ask for a new one.', 'Woh code khatam ho gaya. Naya code mangwaayein.') };
    }
    if (outcome.kind === 'WRONG_OTP') {
      await this.#deps.authorisations.put({
        ...authorisation,
        otp: { ...challenge, attemptsRemaining: outcome.attemptsRemaining },
        updatedAt: at,
      });
      await this.#audit(actor, authorisation, 'gsp.authorisation.otp_rejected', `The one-time password for GST number ${gstin} did not match.`, {
        attemptsRemaining: String(outcome.attemptsRemaining),
      });
      return {
        kind: 'WRONG_OTP',
        attemptsRemaining: outcome.attemptsRemaining,
        message: bilingual(
          `That code did not match. ${outcome.attemptsRemaining} ${outcome.attemptsRemaining === 1 ? 'try' : 'tries'} left before the portal locks it.`,
          `Yeh code nahin mila. Portal band karne se pehle ${outcome.attemptsRemaining} baar aur koshish kar sakte hain.`,
        ),
      };
    }

    const consent: ConsentRecord = {
      id: this.#id(),
      grantedBy: actor.userId,
      grantedAt: at,
      scopes: authorisation.scopes,
      wordingShown: consentWording(gstin, authorisation.scopes),
      method: 'PORTAL_OTP',
    };
    const authorised: GstinAuthorisation = {
      ...authorisation,
      status: 'ACTIVE',
      consent,
      credential: {
        reference: outcome.credentialReference,
        issuedAt: at,
        expiresAt: outcome.credentialExpiresAt,
      },
      otp: null,
      validUntil: outcome.validUntil,
      suspendedReason: null,
      updatedAt: at,
    };
    await this.#deps.authorisations.put(authorised);
    await this.#audit(actor, authorised, 'gsp.authorisation.granted', `GST number ${gstin} was connected to the government services.`, {
      scopes: authorised.scopes.join(','),
      consentId: consent.id,
      // Named for what it is — a vault address — so the redactor does not mistake a non-secret
      // reference for a secret and blank out the one field an incident needs.
      vaultRef: outcome.credentialReference,
      validUntil: outcome.validUntil ?? '',
      environment: authorised.environment,
    });
    return { kind: 'AUTHORISED', authorisation: authorised };
  }

  // ------------------------------------------------------------------ living with it

  /**
   * Fresh credentials for a GST number already authorised.
   *
   * The old handle is kept in `credentialHistory` rather than thrown away, because "which
   * credential made this call" is the first question of any incident, and the calls that used it
   * are still in the log pointing at its reference.
   */
  async rotateCredential(actor: ActorContext, gstin: string, reason: string): Promise<GstinAuthorisation> {
    this.#require(actor, GSP_PERMISSIONS.rotate);
    if (reason.trim().length < 3) throw invalid('GSP_ROTATION_REASON_REQUIRED', 'Say briefly why the credentials are being replaced.');
    const authorisation = await this.#load(actor.companyId, gstin);
    if (authorisation.status !== 'ACTIVE') {
      throw invalid('GSP_NOT_ACTIVE', 'Only a connected GST number can have its credentials replaced.');
    }

    const outcome = await this.#deps.provider.rotateCredential({ gstin, reason });
    const at = this.#now();
    if (outcome.kind === 'UNAVAILABLE') {
      throw invalid('GSP_PROVIDER_UNAVAILABLE', 'The provider did not answer, so the credentials were not replaced. The old ones still work.');
    }
    if (outcome.kind === 'REAUTHORISATION_REQUIRED') {
      // The provider wants the business to consent again. Suspending rather than revoking is the
      // honest state: nobody withdrew anything, but nothing may be sent until they do.
      const suspended: GstinAuthorisation = {
        ...authorisation,
        status: 'SUSPENDED',
        suspendedReason: 'The provider needs this GST number to be authorised again before more can be sent.',
        credential: null,
        credentialHistory: authorisation.credential === null ? authorisation.credentialHistory : [...authorisation.credentialHistory, authorisation.credential],
        updatedAt: at,
      };
      await this.#deps.authorisations.put(suspended);
      await this.#audit(actor, suspended, 'gsp.credential.reauthorisation_required', `The provider asked for GST number ${gstin} to be authorised again.`, { reason });
      return suspended;
    }

    const rotated: GstinAuthorisation = {
      ...authorisation,
      credential: {
        reference: outcome.credentialReference,
        issuedAt: at,
        expiresAt: outcome.credentialExpiresAt,
        rotatedBy: actor.userId,
        rotationReason: reason,
      },
      credentialHistory: authorisation.credential === null ? authorisation.credentialHistory : [...authorisation.credentialHistory, authorisation.credential],
      updatedAt: at,
    };
    await this.#deps.authorisations.put(rotated);
    await this.#audit(actor, rotated, 'gsp.credential.rotated', `The credentials for GST number ${gstin} were replaced.`, {
      vaultRef: outcome.credentialReference,
      previousVaultRef: authorisation.credential?.reference ?? '',
      expiresAt: outcome.credentialExpiresAt ?? '',
    }, reason);
    return rotated;
  }

  /**
   * Take the permission back.
   *
   * The next call stops immediately — the channel reads this record before every call — and nothing
   * is deleted. The provider is told as well, and a provider that does not answer does not stop us:
   * our side has already stopped calling, which is what the business asked for.
   */
  async revoke(actor: ActorContext, gstin: string, reason: string): Promise<GstinAuthorisation> {
    this.#require(actor, GSP_PERMISSIONS.revoke);
    if (reason.trim().length < 3) throw invalid('GSP_REVOCATION_REASON_REQUIRED', 'Say briefly why this permission is being taken back.');
    const authorisation = await this.#load(actor.companyId, gstin);
    if (authorisation.status === 'REVOKED') return authorisation;

    let providerTold = 'yes';
    try {
      const outcome = await this.#deps.provider.revoke({ gstin, reason });
      if (outcome.kind === 'UNAVAILABLE') providerTold = 'not yet — the provider did not answer';
    } catch {
      providerTold = 'not yet — the provider did not answer';
    }

    const at = this.#now();
    const revoked: GstinAuthorisation = {
      ...authorisation,
      status: 'REVOKED',
      // Cleared so nothing can be sent; the history keeps what was used, and the call log keeps
      // every call that was made with it.
      credential: null,
      credentialHistory: authorisation.credential === null ? authorisation.credentialHistory : [...authorisation.credentialHistory, authorisation.credential],
      otp: null,
      consent: authorisation.consent === null ? null : { ...authorisation.consent, withdrawnAt: at, withdrawnBy: actor.userId, withdrawalReason: reason },
      revokedAt: at,
      revokedBy: actor.userId,
      revocationReason: reason,
      updatedAt: at,
    };
    await this.#deps.authorisations.put(revoked);
    await this.#audit(actor, revoked, 'gsp.authorisation.revoked', `The permission to act for GST number ${gstin} was taken back.`, {
      providerTold,
      consentId: authorisation.consent?.id ?? '',
    }, reason);
    return revoked;
  }

  /** Pause without withdrawing consent — a suspected problem, an unpaid provider bill, an audit. */
  async suspend(actor: ActorContext, gstin: string, reason: string): Promise<GstinAuthorisation> {
    this.#require(actor, GSP_PERMISSIONS.revoke);
    if (reason.trim().length < 3) throw invalid('GSP_SUSPEND_REASON_REQUIRED', 'Say briefly why calls are being paused.');
    const authorisation = await this.#load(actor.companyId, gstin);
    if (authorisation.status !== 'ACTIVE') throw invalid('GSP_NOT_ACTIVE', 'Only a connected GST number can be paused.');
    const at = this.#now();
    const suspended: GstinAuthorisation = { ...authorisation, status: 'SUSPENDED', suspendedReason: reason, updatedAt: at };
    await this.#deps.authorisations.put(suspended);
    await this.#audit(actor, suspended, 'gsp.authorisation.suspended', `Calls for GST number ${gstin} were paused.`, {}, reason);
    return suspended;
  }

  async resume(actor: ActorContext, gstin: string): Promise<GstinAuthorisation> {
    this.#require(actor, GSP_PERMISSIONS.revoke);
    const authorisation = await this.#load(actor.companyId, gstin);
    if (authorisation.status !== 'SUSPENDED') throw invalid('GSP_NOT_SUSPENDED', 'This GST number is not paused.');
    if (authorisation.credential === null) {
      throw invalid('GSP_REAUTHORISATION_REQUIRED', 'This GST number needs to be authorised again before it can be used, because its credentials were withdrawn.');
    }
    const at = this.#now();
    const resumed: GstinAuthorisation = { ...authorisation, status: 'ACTIVE', suspendedReason: null, updatedAt: at };
    await this.#deps.authorisations.put(resumed);
    await this.#audit(actor, resumed, 'gsp.authorisation.resumed', `Calls for GST number ${gstin} were started again.`, {});
    return resumed;
  }

  // ------------------------------------------------------------------ plumbing

  async #load(companyId: CompanyId, gstin: string): Promise<GstinAuthorisation> {
    const row = await this.#deps.authorisations.find(companyId, gstin);
    if (row === null) {
      throw notFound('GSP_CONNECTION_NOT_FOUND', 'That GST number is not set up for this business.', { details: { key: authorisationKey(companyId, gstin) } });
    }
    return row;
  }

  #now(): string {
    return this.#deps.clock.now().toISOString();
  }

  #id(): string {
    return this.#deps.idFactory?.() ?? crypto.randomUUID();
  }

  async #audit(
    actor: ActorContext,
    authorisation: GstinAuthorisation,
    action: string,
    summary: string,
    details: Readonly<Record<string, string>>,
    overrideReason?: string,
  ): Promise<void> {
    await this.#deps.audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at: this.#now(),
      action,
      subjectType: 'gstin_authorisation',
      subjectId: authorisation.gstin,
      summary,
      details: redactDetails({ gstin: authorisation.gstin, provider: authorisation.provider, status: authorisation.status, ...details }),
      ...(overrideReason === undefined ? {} : { overrideReason }),
    });
  }

  #require(actor: ActorContext, permission: string): void {
    if (!actor.permissions.includes(permission)) {
      throw forbidden('GSP_FORBIDDEN', 'You do not have permission to change how this business connects to the government.', {
        details: { permission },
      });
    }
  }
}

export type { UserId };
