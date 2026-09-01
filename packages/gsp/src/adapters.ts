/**
 * Issue #33 [E33] — the stores, the limiter, a provider that behaves like the real one, and the
 * production ports the rest of the product plugs into.
 *
 * Two things here are worth reading before the code.
 *
 * **The sandbox provider is not a stub.** It does the things that actually go wrong: it sends a
 * one-time password that expires, it counts wrong attempts down and locks, it hands back an opaque
 * credential reference and never a password, it can be told to time out mid-call so an unknown
 * outcome is exercised for real, and it keeps a record of what the "government" holds so
 * reconciliation is tested against a second opinion rather than against a rubber stamp. Until #50
 * and #51 have chosen and contracted a provider, this is what the product runs on — and it is what
 * every conformance test will be pointed at afterwards.
 *
 * **The production ports are thin on purpose.** #26 and #27 already have adapters that speak to the
 * IRP and the e-way portal through #8's connector. Rewriting them here would be reimplementing
 * another issue's module and would leave two copies to keep in step. Instead `AuthorisedGateway`
 * wraps the gateway those adapters already take, so the authorisation check, the rate limit and the
 * call record sit in front of them without either module knowing. What is written from scratch here
 * is only what did not exist: the return-filing port (#30) and the GSTR-2B fetch (#31).
 */
import type { CompanyId, IsoDate } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import type { GovernmentReturnPort, GovernmentSubmitOutcome, GovernmentSubmitRequest } from '../../gst-returns/src/ports.ts';
import type { PortalFetchOutcome, PortalRecordSource } from '../../itc/src/ports.ts';
import type { TaxPeriod } from '../../gst-returns/src/types.ts';
import type { GovernmentChannel } from './channel.ts';
import type {
  AuthorisationRepository,
  CallLogRepository,
  CreateApiUserInput,
  CreateApiUserOutcome,
  GovernmentExceptionSink,
  GspProviderPort,
  ProviderStatusOutcome,
  RateLimiterPort,
  RequestOtpOutcome,
  RevokeOutcome,
  RotateOutcome,
  VerifyOtpOutcome,
} from './ports.ts';
import type { GstinAuthorisation, ProviderCall, ProviderProfile } from './types.ts';

// ---------------------------------------------------------------------------- stores

export class InMemoryAuthorisations implements AuthorisationRepository {
  readonly #rows = new Map<string, GstinAuthorisation>();

  async find(companyId: CompanyId, gstin: string): Promise<GstinAuthorisation | null> {
    return this.#rows.get(`${companyId}:${gstin}`) ?? null;
  }

  async list(companyId: CompanyId): Promise<readonly GstinAuthorisation[]> {
    return [...this.#rows.values()].filter((row) => row.companyId === companyId);
  }

  async put(authorisation: GstinAuthorisation): Promise<void> {
    this.#rows.set(`${authorisation.companyId}:${authorisation.gstin}`, authorisation);
  }
}

export class InMemoryCallLog implements CallLogRepository {
  readonly #rows = new Map<string, ProviderCall>();

  async insert(call: ProviderCall): Promise<void> {
    this.#rows.set(call.id, call);
  }

  async settle(call: ProviderCall): Promise<void> {
    this.#rows.set(call.id, call);
  }

  async find(companyId: CompanyId, id: string): Promise<ProviderCall | null> {
    const row = this.#rows.get(id);
    return row !== undefined && row.companyId === companyId ? row : null;
  }

  async findByIdempotencyKey(companyId: CompanyId, key: string): Promise<ProviderCall | null> {
    return [...this.#rows.values()].find((row) => row.companyId === companyId && row.idempotencyKey === key) ?? null;
  }

  async listUnsettled(companyId: CompanyId, before: string): Promise<readonly ProviderCall[]> {
    return [...this.#rows.values()].filter(
      (row) => row.companyId === companyId && row.outcome === 'UNKNOWN' && row.reconciledAt === null && row.startedAt <= before,
    );
  }

  async list(companyId: CompanyId, gstin?: string): Promise<readonly ProviderCall[]> {
    return [...this.#rows.values()]
      .filter((row) => row.companyId === companyId && (gstin === undefined || row.gstin === gstin))
      .sort((left, right) => (left.startedAt < right.startedAt ? -1 : 1));
  }
}

/**
 * Our own limiter, kept below whatever the provider publishes.
 *
 * A sliding window rather than a bucket that refills on the hour: the portals' limits are "so many
 * in so long", and a window that resets on a boundary lets a business make every call it has in the
 * last second before it and every call again in the first second after.
 */
export class SlidingWindowLimiter implements RateLimiterPort {
  readonly #calls = new Map<string, number[]>();

  reserve(
    key: string,
    rules: readonly { readonly maxCalls: number; readonly windowSeconds: number }[],
    now: string,
  ): { readonly allowed: boolean; readonly retryAfter?: string } {
    if (rules.length === 0) return { allowed: true };
    const at = Date.parse(now);
    const history = (this.#calls.get(key) ?? []).filter((time) => time > at - Math.max(...rules.map((rule) => rule.windowSeconds)) * 1000);
    for (const rule of rules) {
      const inWindow = history.filter((time) => time > at - rule.windowSeconds * 1000);
      if (inWindow.length >= rule.maxCalls) {
        const oldest = inWindow[0] ?? at;
        this.#calls.set(key, history);
        return { allowed: false, retryAfter: new Date(oldest + rule.windowSeconds * 1000).toISOString() };
      }
    }
    history.push(at);
    this.#calls.set(key, history);
    return { allowed: true };
  }
}

/** Where a disagreement with the government goes when nothing else is wired up yet. */
export class RecordingExceptionSink implements GovernmentExceptionSink {
  readonly raised: { readonly gstin: string; readonly reference: string; readonly ours: string; readonly theirs: string }[] = [];

  async raise(input: Parameters<GovernmentExceptionSink['raise']>[0]): Promise<void> {
    this.raised.push({ gstin: input.gstin, reference: input.reference, ours: input.ours, theirs: input.theirs });
  }
}

// ---------------------------------------------------------------------------- the provider

export const SANDBOX_PROFILE: ProviderProfile = Object.freeze<ProviderProfile>({
  name: 'sandbox-gsp',
  environment: 'SANDBOX',
  supports: Object.freeze([
    'EINVOICE_GENERATE', 'EINVOICE_CANCEL', 'EINVOICE_FETCH',
    'EWAY_GENERATE', 'EWAY_UPDATE', 'EWAY_CANCEL', 'EWAY_FETCH',
    'RETURN_SUBMIT', 'RETURN_FETCH', 'GSTR2B_FETCH',
  ]),
  // Deliberately small so the limit is reachable in a test without a thousand calls. A real
  // profile carries the provider's published figures, and ours stay under them.
  limits: Object.freeze([{ operation: '*', maxCalls: 60, windowSeconds: 60 }]),
  contractRef: null,
});

export interface SandboxOptions {
  readonly now: () => Date;
  /** The code the sandbox portal will accept. Not a secret; there is no real portal behind it. */
  readonly otp?: string;
  readonly otpValiditySeconds?: number;
  readonly attemptsAllowed?: number;
  readonly profile?: ProviderProfile;
}

/**
 * A provider that behaves like the real one, with no contract and no network.
 *
 * Everything a live GSP does that this product has to survive is here: an OTP that expires, wrong
 * attempts that count down, credentials that are references rather than secrets, an outage that can
 * be switched on mid-test, and a government record that can be made to disagree with ours so the
 * conflict path is exercised rather than assumed.
 */
export class SandboxGspProvider implements GspProviderPort {
  readonly profile: ProviderProfile;
  readonly #now: () => Date;
  readonly #otp: string;
  readonly #validity: number;
  readonly #attempts: number;
  readonly #users = new Map<string, string>();
  readonly #challenges = new Map<string, { gstin: string; expiresAt: string; attemptsRemaining: number }>();
  readonly #revoked = new Set<string>();
  /** What the "government" holds, by document reference. Reconciliation asks this, not the caller. */
  readonly #governmentRecord = new Map<string, string>();
  #mode: 'healthy' | 'unavailable' = 'healthy';
  #sequence = 0;

  constructor(options: SandboxOptions) {
    this.#now = options.now;
    this.#otp = options.otp ?? '123456';
    this.#validity = options.otpValiditySeconds ?? 600;
    this.#attempts = options.attemptsAllowed ?? 3;
    this.profile = options.profile ?? SANDBOX_PROFILE;
  }

  setMode(mode: 'healthy' | 'unavailable'): void {
    this.#mode = mode;
  }

  /** Records what the government holds for a document, for the reconciliation tests. */
  government(documentRef: string, reference: string): void {
    this.#governmentRecord.set(documentRef, reference);
  }

  async createApiUser(input: CreateApiUserInput): Promise<CreateApiUserOutcome> {
    if (this.#mode === 'unavailable') return { kind: 'UNAVAILABLE', retryable: true, detail: 'sandbox is switched off' };
    const existing = this.#users.get(input.gstin);
    if (existing !== undefined) return { kind: 'EXISTS', apiUserId: existing };
    const apiUserId = `api-user-${(this.#sequence += 1)}`;
    this.#users.set(input.gstin, apiUserId);
    return { kind: 'CREATED', apiUserId };
  }

  async requestOtp(input: { readonly gstin: string; readonly apiUserId: string }): Promise<RequestOtpOutcome> {
    if (this.#mode === 'unavailable') return { kind: 'UNAVAILABLE', retryable: true, detail: 'sandbox is switched off' };
    if (this.#revoked.has(input.gstin)) return { kind: 'REFUSED', code: 'REVOKED', message: 'This GST number is no longer authorised with the provider.' };
    const requestId = `otp-${(this.#sequence += 1)}`;
    const expiresAt = new Date(this.#now().getTime() + this.#validity * 1000).toISOString();
    this.#challenges.set(requestId, { gstin: input.gstin, expiresAt, attemptsRemaining: this.#attempts });
    return { kind: 'SENT', requestId, expiresAt, attemptsAllowed: this.#attempts, sentToHint: '••••1234' };
  }

  async verifyOtp(input: { readonly gstin: string; readonly requestId: string; readonly otp: string }): Promise<VerifyOtpOutcome> {
    if (this.#mode === 'unavailable') return { kind: 'UNAVAILABLE', retryable: true, detail: 'sandbox is switched off' };
    const challenge = this.#challenges.get(input.requestId);
    if (challenge === undefined || challenge.gstin !== input.gstin) return { kind: 'EXPIRED' };
    if (challenge.expiresAt <= this.#now().toISOString()) {
      this.#challenges.delete(input.requestId);
      return { kind: 'EXPIRED' };
    }
    if (input.otp !== this.#otp) {
      const attemptsRemaining = challenge.attemptsRemaining - 1;
      if (attemptsRemaining <= 0) {
        this.#challenges.delete(input.requestId);
        return { kind: 'WRONG_OTP', attemptsRemaining: 0 };
      }
      this.#challenges.set(input.requestId, { ...challenge, attemptsRemaining });
      return { kind: 'WRONG_OTP', attemptsRemaining };
    }
    this.#challenges.delete(input.requestId);
    this.#revoked.delete(input.gstin);
    return {
      kind: 'AUTHORISED',
      // A vault address. There is no password here, in the sandbox or in production.
      credentialReference: `vault://gsp/${input.gstin}/${(this.#sequence += 1)}`,
      credentialExpiresAt: new Date(this.#now().getTime() + 180 * 24 * 3600 * 1000).toISOString(),
      validUntil: new Date(this.#now().getTime() + 365 * 24 * 3600 * 1000).toISOString(),
    };
  }

  async rotateCredential(input: { readonly gstin: string; readonly reason: string }): Promise<RotateOutcome> {
    if (this.#mode === 'unavailable') return { kind: 'UNAVAILABLE', retryable: true, detail: 'sandbox is switched off' };
    if (this.#revoked.has(input.gstin)) return { kind: 'REAUTHORISATION_REQUIRED', message: 'The GST number must be authorised again.' };
    return {
      kind: 'ROTATED',
      credentialReference: `vault://gsp/${input.gstin}/${(this.#sequence += 1)}`,
      credentialExpiresAt: new Date(this.#now().getTime() + 180 * 24 * 3600 * 1000).toISOString(),
    };
  }

  async revoke(input: { readonly gstin: string; readonly reason: string }): Promise<RevokeOutcome> {
    if (this.#mode === 'unavailable') return { kind: 'UNAVAILABLE', retryable: true, detail: 'sandbox is switched off' };
    if (!this.#users.has(input.gstin)) return { kind: 'NOT_FOUND' };
    this.#revoked.add(input.gstin);
    return { kind: 'REVOKED', at: this.#now().toISOString() };
  }

  async statusOf(input: {
    readonly gstin: string;
    readonly operation: string;
    readonly providerRequestId: string | null;
    readonly documentRef: string | null;
  }): Promise<ProviderStatusOutcome> {
    if (this.#mode === 'unavailable') return { kind: 'UNAVAILABLE', retryable: true, detail: 'sandbox is switched off' };
    const held = input.documentRef === null ? undefined : this.#governmentRecord.get(input.documentRef);
    if (held === undefined) return { kind: 'NOT_FOUND' };
    return { kind: 'FOUND', governmentReference: held, acknowledgedAt: this.#now().toISOString() };
  }

  async health(): Promise<'healthy' | 'degraded' | 'unavailable'> {
    return this.#mode === 'healthy' ? 'healthy' : 'unavailable';
  }
}

// ---------------------------------------------------------------------------- production ports

/**
 * Filing a return through the authorised channel — the port #30 already knows how to consume.
 *
 * An `UNKNOWN` outcome is passed through as `UNKNOWN`, never as a rejection. A return workspace that
 * was told "rejected" when the truth was "we never found out" would let somebody file the same
 * month twice.
 */
export const authorisedReturnPort = (
  channel: GovernmentChannel,
  actorFor: (companyId: CompanyId) => ActorContext,
  provider: GspProviderPort,
): GovernmentReturnPort => ({
  provider: provider.profile.name,
  async submit(request: GovernmentSubmitRequest): Promise<GovernmentSubmitOutcome> {
    const actor = actorFor(request.companyId);
    const outcome = await channel.call(actor, {
      operation: 'return.submit',
      gstin: request.gstin,
      payload: { ...request.payload, Gstin: request.gstin, RetPeriod: request.period, RetType: request.returnType },
      idempotencyKey: request.idempotencyKey,
      documentRef: `${request.returnType}:${request.period}`,
    });
    const at = new Date().toISOString();
    if (outcome.kind === 'REFUSED') {
      return { kind: 'UNKNOWN', retryable: outcome.refusal.retryable, at, detail: outcome.refusal.message['en-IN'] };
    }
    if (outcome.kind === 'UNKNOWN') {
      return { kind: 'UNKNOWN', retryable: outcome.retryable, at, detail: 'The filing was sent but no acknowledgement came back, so it is being checked.' };
    }
    const body = outcome.response.payload;
    const errorCode = typeof body.ErrorCode === 'string' ? body.ErrorCode : null;
    if (errorCode !== null) {
      return {
        kind: 'REJECTED',
        errors: [{ code: errorCode, detail: String(body.ErrorMessage ?? 'The portal refused the return.') }],
        at,
      };
    }
    const reference = typeof body.AckNo === 'string' ? body.AckNo : typeof body.reference === 'string' ? body.reference : outcome.response.providerRequestId;
    return { kind: 'ACCEPTED', reference, acknowledgedAt: typeof body.AckDt === 'string' ? body.AckDt : at };
  },
  async health() {
    return provider.health();
  },
});

/**
 * Downloading GSTR-2B through the authorised channel — the port #31 already knows how to consume.
 *
 * It returns the portal's own text rather than parsed rows, exactly as #31's contract requires, so
 * the downloaded path and the imported-file path go through one reader and cannot drift apart.
 */
export const authorisedPortalRecordSource = (
  channel: GovernmentChannel,
  actorFor: (companyId: CompanyId) => ActorContext,
  provider: GspProviderPort,
): PortalRecordSource => ({
  provider: provider.profile.name,
  async fetchGstr2b(companyId: CompanyId, gstin: string, period: TaxPeriod): Promise<PortalFetchOutcome> {
    const actor = actorFor(companyId);
    const at = new Date().toISOString();
    const outcome = await channel.call(actor, {
      operation: 'gstr2b.fetch',
      gstin,
      payload: { Gstin: gstin, RetPeriod: period },
      idempotencyKey: `gstr2b:${companyId}:${gstin}:${period}`,
      documentRef: `GSTR2B:${period}`,
    });
    if (outcome.kind === 'REFUSED') {
      return { kind: 'UNAVAILABLE', retryable: outcome.refusal.retryable, at, detail: outcome.refusal.message['en-IN'] };
    }
    if (outcome.kind === 'UNKNOWN') {
      return { kind: 'UNAVAILABLE', retryable: outcome.retryable, at, detail: 'The portal did not answer.' };
    }
    const body = outcome.response.payload;
    // "Not published yet" is an ordinary answer in the first half of a month, and it is a different
    // fact from "no purchases were reported". #31 depends on the two never being confused.
    if (body.ErrorCode === 'RTN_NOT_AVAILABLE' || body.notReady === true) {
      return { kind: 'NOT_READY', at, detail: 'The statement for this month is not published yet.' };
    }
    const content = typeof body.content === 'string' ? body.content : typeof body.data === 'string' ? body.data : null;
    if (content === null) {
      return { kind: 'UNAVAILABLE', retryable: false, at, detail: 'The portal answered with something this app could not read.' };
    }
    return { kind: 'FETCHED', content, at };
  },
  async health() {
    return provider.health();
  },
});

export type { IsoDate };
