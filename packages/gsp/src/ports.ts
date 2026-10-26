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
import type { ConnectorKind } from '../../platform/src/connectors.ts';
import type {
  GovernmentScope,
  GstinAuthorisation,
  ProviderCall,
  ProviderProfile,
} from './types.ts';

/** Issue #366 — keyset paging: up to `limit` rows after the row with id `after`. Without one, every row. */
export interface Page {
  readonly after?: string;
  readonly limit?: number;
}

export interface AuthorisationRepository {
  find(companyId: CompanyId, gstin: string): Promise<GstinAuthorisation | null>;
  // ponytail: not paged — one row per GST registration of one business, a handful. Page it if a
  // business ever holds hundreds.
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
  /** The calls whose fate we never learned, oldest first. What reconciliation reads. */
  listUnsettled(companyId: CompanyId, before: string, page?: Page): Promise<readonly ProviderCall[]>;
  /**
   * Which company a provider's callback is about — the id only, never the call itself.
   *
   * The one cross-company lookup here, and it is cross-company on purpose: a callback arrives
   * with no session and no company, and the company is then taken *from the row it matched*
   * rather than from anything the caller said. That is what stops a forged callback naming
   * somebody else's company — it never gets to name one. The reference is matched against this
   * connector's calls only: the provider's request id answers first, our own correlation id
   * only when no call carries that request id, and a reference that could name two companies'
   * calls answers null rather than guessing — through the fallback too. On PostgreSQL this goes through a SECURITY DEFINER function that
   * returns one uuid or none (#477); row-level security is never bypassed, the finder's own
   * policy is what shows it the match columns and nothing else.
   */
  companyForRequest(kind: ConnectorKind, reference: string): Promise<CompanyId | null>;
  /**
   * The call a provider's callback is about, inside the company the lookup found. Once the
   * company is known the row is read in its own tenant context like every other read here.
   */
  findByProviderRequestId(kind: ConnectorKind, companyId: CompanyId, providerRequestId: string): Promise<ProviderCall | null>;
  findByCorrelationId(companyId: CompanyId, correlationId: string): Promise<ProviderCall | null>;
  /** In the order they started; calls that started at the same instant, in the order they were written. */
  list(companyId: CompanyId, gstin?: string, page?: Page): Promise<readonly ProviderCall[]>;
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
 * Every provider callback we have taken delivery of, including the ones we threw out.
 *
 * Two jobs, and the second is the one people forget. It deduplicates — a provider that does not get
 * a 200 will send the same event again, and the same acknowledgement must not settle a call twice.
 * And it records callbacks whose signature did not verify, by a digest of the bytes rather than by
 * anything inside them: a body that failed authentication is not evidence, but the fact that
 * somebody sent it is.
 */
export interface WebhookEventRepository {
  /** Null when this event id has not been seen for this connector before. */
  find(kind: string, eventId: string): Promise<WebhookEventRecord | null>;
  insert(record: WebhookEventRecord): Promise<void>;
  /**
   * Re-writes a delivery's record, but only while it still says UNMATCHED: a callback that
   * arrived before the call it answered is matched again when it is re-delivered, and must not
   * stay lost as a "duplicate" (#477). A settled record is never rewritten.
   */
  update(record: WebhookEventRecord): Promise<void>;
  /** An unverified delivery, recorded by digest. Nothing inside it is read or stored. */
  recordRejected(input: { readonly kind: string; readonly digest: string; readonly at: string; readonly reason: string }): Promise<void>;
  listRejected(): Promise<readonly { readonly kind: string; readonly digest: string; readonly reason: string }[]>;
}

export interface WebhookEventRecord {
  readonly kind: string;
  readonly eventId: string;
  readonly providerRequestId: string;
  readonly receivedAt: string;
  /** The call it was about, when it matched one. */
  readonly callId: string | null;
  readonly companyId: CompanyId | null;
  readonly outcome: string;
  readonly governmentReference: string | null;
}

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
