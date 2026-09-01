/**
 * Issue #33 [E33] — the surfaces this module sits on, and the two it owns.
 *
 * The provider is somebody else's software and the connector is GPT 2's (#8). What this module owns
 * is the authorisation state and the record of every call made under it. Everything else is a port,
 * which is what lets the whole onboarding — API user, one-time password, consent, credential,
 * rotation, revocation — run in a test with no network and no contract signed.
 *
 * `GspProviderPort` is deliberately about *onboarding*, not about GST. Registering an invoice goes
 * through #8's connector like every other government call; what a provider additionally offers, and
 * what nothing else in this product models, is the dance that gets a GST number authorised in the
 * first place.
 */
import type { CompanyId, IsoDate } from '@invoice/kernel';
import type {
  GovernmentScope,
  GstinAuthorisation,
  ProviderCall,
  ProviderProfile,
} from './types.ts';

export interface AuthorisationRepository {
  find(companyId: CompanyId, gstin: string): Promise<GstinAuthorisation | null>;
  list(companyId: CompanyId): Promise<readonly GstinAuthorisation[]>;
  put(authorisation: GstinAuthorisation): Promise<void>;
}

/**
 * Every call, kept.
 *
 * Append-only in spirit: a row is written when a call starts and settled when it ends, and nothing
 * is deleted — not on revocation, not on disconnection, not when a business leaves. What was done
 * in a business's name is the business's record.
 */
export interface CallLogRepository {
  insert(call: ProviderCall): Promise<void>;
  settle(call: ProviderCall): Promise<void>;
  find(companyId: CompanyId, id: string): Promise<ProviderCall | null>;
  findByIdempotencyKey(companyId: CompanyId, key: string): Promise<ProviderCall | null>;
  /** The calls whose fate we never learned. What reconciliation reads. */
  listUnsettled(companyId: CompanyId, before: string): Promise<readonly ProviderCall[]>;
  list(companyId: CompanyId, gstin?: string): Promise<readonly ProviderCall[]>;
}

/**
 * The provider's onboarding surface.
 *
 * Note what `verifyOtp` takes and what it returns: it takes the password the person typed and
 * returns a credential *reference*. The password goes in and never comes back, is never stored on
 * this side, and appears in no log — the provider verifies it against the portal, and what we keep
 * is a vault address.
 */
export interface GspProviderPort {
  readonly profile: ProviderProfile;
  /** Creates the provider's API user for a GST number. Nothing can be sent before this exists. */
  createApiUser(input: CreateApiUserInput): Promise<CreateApiUserOutcome>;
  /** Asks the portal to send a one-time password to the signatory's registered phone. */
  requestOtp(input: { readonly gstin: string; readonly apiUserId: string }): Promise<RequestOtpOutcome>;
  verifyOtp(input: { readonly gstin: string; readonly requestId: string; readonly otp: string }): Promise<VerifyOtpOutcome>;
  /** Issues fresh credentials for a GST number already authorised. */
  rotateCredential(input: { readonly gstin: string; readonly reason: string }): Promise<RotateOutcome>;
  /** Tells the provider to stop acting for this GST number. */
  revoke(input: { readonly gstin: string; readonly reason: string }): Promise<RevokeOutcome>;
  /** The authoritative answer about one call we were unsure of. */
  statusOf(input: { readonly gstin: string; readonly operation: string; readonly providerRequestId: string | null; readonly documentRef: string | null }): Promise<ProviderStatusOutcome>;
  health(): Promise<'healthy' | 'degraded' | 'unavailable'>;
}

export interface CreateApiUserInput {
  readonly companyId: CompanyId;
  readonly gstin: string;
  readonly legalName: string;
  /** The person the portal will send the one-time password to, as the portal already holds them. */
  readonly signatoryHint: string;
  readonly scopes: readonly GovernmentScope[];
}

export type CreateApiUserOutcome =
  | { readonly kind: 'CREATED'; readonly apiUserId: string }
  /** The provider already has a user for this GST number. An ordinary answer on a retry. */
  | { readonly kind: 'EXISTS'; readonly apiUserId: string }
  | { readonly kind: 'REFUSED'; readonly code: string; readonly message: string }
  | { readonly kind: 'UNAVAILABLE'; readonly retryable: boolean; readonly detail: string };

export type RequestOtpOutcome =
  | {
      readonly kind: 'SENT';
      readonly requestId: string;
      readonly expiresAt: string;
      readonly attemptsAllowed: number;
      /** Last four digits of the phone the portal holds. Never the whole number. */
      readonly sentToHint: string;
    }
  | { readonly kind: 'REFUSED'; readonly code: string; readonly message: string }
  | { readonly kind: 'UNAVAILABLE'; readonly retryable: boolean; readonly detail: string };

export type VerifyOtpOutcome =
  | {
      readonly kind: 'AUTHORISED';
      /** A vault address. Never a secret, and nothing here ever holds the portal password. */
      readonly credentialReference: string;
      readonly credentialExpiresAt: string | null;
      readonly validUntil: string | null;
    }
  | { readonly kind: 'WRONG_OTP'; readonly attemptsRemaining: number }
  | { readonly kind: 'EXPIRED' }
  | { readonly kind: 'UNAVAILABLE'; readonly retryable: boolean; readonly detail: string };

export type RotateOutcome =
  | { readonly kind: 'ROTATED'; readonly credentialReference: string; readonly credentialExpiresAt: string | null }
  /** The provider needs the business to authorise again — a rotation is not always silent. */
  | { readonly kind: 'REAUTHORISATION_REQUIRED'; readonly message: string }
  | { readonly kind: 'UNAVAILABLE'; readonly retryable: boolean; readonly detail: string };

export type RevokeOutcome =
  | { readonly kind: 'REVOKED'; readonly at: string }
  /** The provider has no record of it. Our side still stops calling, which is the point. */
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'UNAVAILABLE'; readonly retryable: boolean; readonly detail: string };

export type ProviderStatusOutcome =
  | { readonly kind: 'FOUND'; readonly governmentReference: string; readonly acknowledgedAt: string }
  /** The government has no record: the call never landed, and the document can be sent again. */
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'UNAVAILABLE'; readonly retryable: boolean; readonly detail: string };

/**
 * Our own call limits, kept below the provider's published ones.
 *
 * Being throttled by a provider is worse than throttling ourselves: their limit returns an error we
 * cannot distinguish from a real refusal, at a moment we did not choose. Ours returns a sentence
 * and a time to try again.
 */
export interface RateLimiterPort {
  /** Reserves one call, or refuses with the moment it may be tried again. */
  reserve(key: string, rules: readonly { readonly maxCalls: number; readonly windowSeconds: number }[], now: string): { readonly allowed: boolean; readonly retryAfter?: string };
}

/**
 * Where a disagreement with the government goes.
 *
 * Implemented by the exception queue (#7/#48). It is a port because this module must never be the
 * thing that decides what a conflict means; it states it, with both sides, and a person decides.
 */
export interface GovernmentExceptionSink {
  raise(input: {
    readonly companyId: CompanyId;
    readonly gstin: string;
    readonly kind: string;
    readonly reference: string;
    readonly ours: string;
    readonly theirs: string;
    readonly question: { readonly 'en-IN': string; readonly 'hi-IN': string };
    readonly at: string;
  }): Promise<void>;
}

export type { IsoDate };
