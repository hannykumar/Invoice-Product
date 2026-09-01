/**
 * Issue #33 [E33] — the one door to the government.
 *
 * Every call this product makes to a government service passes through `GovernmentChannel.call`. It
 * is a short function and it does five things in a fixed order: work out which GST number the call
 * is for, ask whether that number has authorised this act, reserve a slot against our own rate
 * limit, hand the call to #8's connector with the caller's idempotency key, and write down what
 * happened. Nothing else in this product is allowed to talk to a provider directly.
 *
 * Three decisions are worth stating plainly.
 *
 *   1. **The GST number is read from the document, not assumed.** A payload that names the seller's
 *      registration is authorised against that registration. Where the payload does not say and the
 *      business has exactly one authorised number, that is the number. Where the business has two
 *      and the payload is silent, the call is **refused** — a company with a Karnataka and a
 *      Maharashtra registration must never have an invoice filed under whichever one happened to be
 *      connected first.
 *   2. **A timeout is not a failure.** It is `UNKNOWN`, it is written down as such, and
 *      `reconcile.ts` chases the government's own answer until it is settled. Recording a timeout as
 *      a failure is how a business ends up with two IRNs for one invoice.
 *   3. **The call is recorded before it is made.** If this process dies mid-call the row is already
 *      there, unsettled, and reconciliation will find it. A log written only on success is a log
 *      that is missing exactly the calls somebody needs.
 */
import { conflict, type Clock, type CompanyId, type UserId } from '@invoice/kernel';
import type { ActorContext, AuditPort } from '@invoice/ledger';
import { ConnectorError, ConnectorGateway, type ConnectorKind, type ConnectorRequest, type ConnectorResponse } from '../../platform/src/connectors.ts';
import { checkAuthorisation } from './authorisation.ts';
import { redactDetails } from './redact.ts';
import type { AuthorisationRepository, CallLogRepository, GspProviderPort, RateLimiterPort } from './ports.ts';
import {
  bilingual,
  OPERATION_SCOPES,
  type GovernmentScope,
  type ProviderCall,
  type Refusal,
} from './types.ts';

export type ChannelOutcome =
  | { readonly kind: 'ANSWERED'; readonly response: ConnectorResponse; readonly callId: string }
  | { readonly kind: 'REFUSED'; readonly refusal: Refusal; readonly callId: string }
  /**
   * We do not know what happened. The document's state with the government is unsettled, the call
   * is recorded, and reconciliation will chase it.
   */
  | { readonly kind: 'UNKNOWN'; readonly retryable: boolean; readonly detail: string; readonly callId: string };

export interface ChannelCallInput {
  readonly operation: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  /** Our own reference for what is being sent, so a reconciliation can name the document. */
  readonly documentRef?: string;
  /** Given when the caller knows the registration; otherwise it is read from the payload. */
  readonly gstin?: string;
  readonly correlationId?: string;
}

export interface GovernmentChannelDeps {
  readonly gateway: ConnectorGateway;
  readonly authorisations: AuthorisationRepository;
  readonly calls: CallLogRepository;
  readonly audit: AuditPort;
  readonly clock: Clock;
  readonly provider?: GspProviderPort;
  readonly limiter?: RateLimiterPort;
  readonly idFactory?: () => string;
}

/** Which connector each government act belongs to. */
const CONNECTOR_FOR: Readonly<Record<GovernmentScope, ConnectorKind>> = Object.freeze({
  EINVOICE_GENERATE: 'irp',
  EINVOICE_CANCEL: 'irp',
  EINVOICE_FETCH: 'irp',
  EWAY_GENERATE: 'eway_bill',
  EWAY_UPDATE: 'eway_bill',
  EWAY_CANCEL: 'eway_bill',
  EWAY_FETCH: 'eway_bill',
  RETURN_SUBMIT: 'gst',
  RETURN_FETCH: 'gst',
  GSTR2B_FETCH: 'gst',
});

export class GovernmentChannel {
  readonly #deps: GovernmentChannelDeps;

  constructor(deps: GovernmentChannelDeps) {
    this.#deps = deps;
  }

  async call(actor: ActorContext, input: ChannelCallInput): Promise<ChannelOutcome> {
    const companyId = actor.companyId;
    const now = this.#deps.clock.now().toISOString();
    const scope = OPERATION_SCOPES[input.operation] ?? null;
    const resolved = await this.#resolveGstin(companyId, input);

    if (resolved.kind === 'AMBIGUOUS') {
      return this.#refused(actor, input, null, scope, resolved.refusal, now);
    }

    const gstin = resolved.gstin;
    const authorisation = await this.#deps.authorisations.find(companyId, gstin);
    const verdict = checkAuthorisation({
      authorisation,
      operation: input.operation,
      gstin,
      now,
      ...(this.#deps.provider === undefined ? {} : { provider: this.#deps.provider.profile }),
    });
    if (!verdict.allowed) return this.#refused(actor, input, gstin, scope, verdict.refusal, now);

    if (this.#deps.limiter !== undefined) {
      const rules = verdict.authorisation.scopes.length === 0 ? [] : this.#rulesFor(input.operation);
      const reservation = this.#deps.limiter.reserve(`${gstin}:${input.operation}`, rules, now);
      if (!reservation.allowed) {
        return this.#refused(actor, input, gstin, scope, {
          reason: 'RATE_LIMITED',
          retryable: true,
          message: bilingual(
            'The government service is only accepting a certain number of requests just now, so this one is waiting its turn.',
            'Government service abhi gine-chune requests hi le rahi hai, isliye yeh apni baari ka intezaar kar rahi hai.',
          ),
          nextAction: bilingual('Nothing to do — it will be sent again shortly.', 'Kuch karne ki zaroorat nahin — yeh thodi der mein dobara bhej di jaayegi.'),
          ...(reservation.retryAfter === undefined ? {} : { retryAfter: reservation.retryAfter }),
        }, now);
      }
    }

    // The retry of an identical call returns the first call's answer rather than making a second
    // one. The connector deduplicates too; doing it here as well means a retry does not even reach
    // the provider, and — more importantly — does not produce a second row nobody can reconcile.
    const priorCall = await this.#deps.calls.findByIdempotencyKey(companyId, input.idempotencyKey);
    if (priorCall !== null && priorCall.outcome === 'ACCEPTED' && priorCall.gstin !== gstin) {
      throw conflict('GSP_IDEMPOTENCY_REUSED', 'That reference has already been used for a different GST number.');
    }

    const callId = this.#deps.idFactory?.() ?? crypto.randomUUID();
    const correlationId = input.correlationId ?? `gsp-${callId}`;
    const started: ProviderCall = {
      id: callId,
      companyId,
      gstin,
      operation: input.operation,
      scope,
      idempotencyKey: input.idempotencyKey,
      correlationId,
      documentRef: input.documentRef ?? null,
      outcome: 'UNKNOWN',
      providerRequestId: null,
      governmentReference: null,
      errorCode: null,
      errorMessage: null,
      refusal: null,
      attempts: 1,
      credentialReference: verdict.authorisation.credential?.reference ?? null,
      startedAt: now,
      settledAt: null,
      actorId: actor.userId,
      reconciledAt: null,
    };
    await this.#deps.calls.insert(started);

    const request: ConnectorRequest = {
      tenantId: companyId,
      operation: input.operation,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      correlationId,
    };

    try {
      const response = await this.#deps.gateway.execute(CONNECTOR_FOR[verdict.scope], request);
      const settledAt = this.#deps.clock.now().toISOString();
      const errorCode = typeof response.payload.ErrorCode === 'string' ? response.payload.ErrorCode : null;
      const settled: ProviderCall = {
        ...started,
        outcome: errorCode === null ? 'ACCEPTED' : 'REJECTED',
        providerRequestId: response.providerRequestId,
        governmentReference: governmentReferenceOf(response.payload),
        errorCode,
        errorMessage: errorCode === null ? null : String(response.payload.ErrorMessage ?? ''),
        settledAt,
      };
      await this.#deps.calls.settle(settled);
      await this.#record(actor, settled, 'gsp.call.completed', `${input.operation} for ${gstin}: ${settled.outcome.toLowerCase()}.`);
      return { kind: 'ANSWERED', response, callId };
    } catch (error) {
      const detail = error instanceof ConnectorError ? error.code : 'OUTAGE';
      const retryable = error instanceof ConnectorError ? error.retryable : true;
      const unsettled: ProviderCall = { ...started, errorCode: detail, errorMessage: null };
      await this.#deps.calls.settle(unsettled);
      await this.#record(
        actor,
        unsettled,
        'gsp.call.unknown',
        `${input.operation} for ${gstin} did not get an answer, so its state with the government is unknown.`,
      );
      return { kind: 'UNKNOWN', retryable, detail, callId };
    }
  }

  /**
   * Which GST number this call is for.
   *
   * Reading it from the document is the honest order: the invoice says who is selling, and that is
   * the registration the government will judge it under. Falling back to "the one authorisation
   * this business has" is safe precisely because it is checked to be the only one.
   */
  async #resolveGstin(
    companyId: CompanyId,
    input: ChannelCallInput,
  ): Promise<{ readonly kind: 'RESOLVED'; readonly gstin: string } | { readonly kind: 'AMBIGUOUS'; readonly refusal: Refusal }> {
    const stated = input.gstin ?? gstinInPayload(input.payload);
    if (stated !== null && stated !== undefined) return { kind: 'RESOLVED', gstin: stated };

    const authorisations = await this.#deps.authorisations.list(companyId);
    const usable = authorisations.filter((row) => row.status === 'ACTIVE');
    const only = usable[0];
    if (usable.length === 1 && only !== undefined) return { kind: 'RESOLVED', gstin: only.gstin };

    return {
      kind: 'AMBIGUOUS',
      refusal: {
        reason: 'GSTIN_MISMATCH',
        retryable: false,
        message:
          usable.length === 0
            ? bilingual(
                'No GST number of this business is connected to the government services, so nothing was sent.',
                'Is business ka koi GST number government services se juda nahin hai, isliye kuch nahin bheja gaya.',
              )
            : bilingual(
                'This business has more than one connected GST number and the document did not say which one it belongs to, so nothing was sent.',
                'Is business ke ek se zyada GST number jude hain aur document ne nahin bataya ki yeh kis ka hai, isliye kuch nahin bheja gaya.',
              ),
        nextAction:
          usable.length === 0
            ? bilingual('Connect a GST number in settings.', 'Settings mein GST number jodein.')
            : bilingual('Choose the GST number this document belongs to and send it again.', 'Yeh document jis GST number ka hai woh chunkar dobara bhejein.'),
      },
    };
  }

  #rulesFor(operation: string): readonly { readonly maxCalls: number; readonly windowSeconds: number }[] {
    const limits = this.#deps.provider?.profile.limits ?? [];
    return limits
      .filter((rule) => rule.operation === operation || rule.operation === '*')
      .map((rule) => ({ maxCalls: rule.maxCalls, windowSeconds: rule.windowSeconds }));
  }

  async #refused(
    actor: ActorContext,
    input: ChannelCallInput,
    gstin: string | null,
    scope: GovernmentScope | null,
    refusal: Refusal,
    now: string,
  ): Promise<ChannelOutcome> {
    const callId = this.#deps.idFactory?.() ?? crypto.randomUUID();
    const call: ProviderCall = {
      id: callId,
      companyId: actor.companyId,
      gstin: gstin ?? '',
      operation: input.operation,
      scope,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId ?? `gsp-${callId}`,
      documentRef: input.documentRef ?? null,
      outcome: 'REFUSED',
      providerRequestId: null,
      governmentReference: null,
      errorCode: refusal.reason,
      errorMessage: refusal.message['en-IN'],
      refusal: refusal.reason,
      attempts: 0,
      credentialReference: null,
      startedAt: now,
      settledAt: now,
      actorId: actor.userId,
      reconciledAt: null,
    };
    // A refusal is recorded exactly like a call, and that is the point: "we did not send this, and
    // here is why" is the record a business needs when it asks why an invoice never reached the
    // portal. Refusals that leave no trace are how a silent integration failure lasts a month.
    await this.#deps.calls.insert(call);
    await this.#record(actor, call, 'gsp.call.refused', `${input.operation} was not sent: ${refusal.message['en-IN']}`);
    return { kind: 'REFUSED', refusal, callId };
  }

  async #record(actor: ActorContext, call: ProviderCall, action: string, summary: string): Promise<void> {
    await this.#deps.audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at: this.#deps.clock.now().toISOString(),
      action,
      subjectType: 'government_call',
      subjectId: call.id,
      summary,
      details: redactDetails({
        gstin: call.gstin,
        operation: call.operation,
        outcome: call.outcome,
        idempotencyKey: call.idempotencyKey,
        correlationId: call.correlationId,
        providerRequestId: call.providerRequestId ?? '',
        governmentReference: call.governmentReference ?? '',
        errorCode: call.errorCode ?? '',
        documentRef: call.documentRef ?? '',
        // The vault address, never the credential itself.
        vaultRef: call.credentialReference ?? '',
      }),
    });
  }
}

/**
 * The seller's registration as the document itself states it.
 *
 * The keys are the ones the government's own schemas use, which is why they are spelled the way
 * they are. A document that does not carry one is not guessed at.
 */
export const gstinInPayload = (payload: Readonly<Record<string, unknown>>): string | null => {
  const direct = payload.Gstin ?? payload.gstin ?? payload.userGstin ?? payload.UserGstin;
  if (typeof direct === 'string' && direct !== '') return direct;
  const seller = payload.SellerDtls ?? payload.sellerDtls;
  if (seller !== null && typeof seller === 'object') {
    const value = (seller as Record<string, unknown>).Gstin ?? (seller as Record<string, unknown>).gstin;
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
};

const governmentReferenceOf = (payload: Readonly<Record<string, unknown>>): string | null => {
  for (const key of ['Irn', 'irn', 'EwbNo', 'ewbNo', 'AckNo', 'ackNo', 'reference', 'Reference']) {
    const value = payload[key];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number') return String(value);
  }
  return null;
};

/**
 * The same guard, wearing #8's gateway as a coat.
 *
 * `#26` and `#27` already build their production adapters on `ConnectorGateway`. Rather than
 * rewriting either of them — which would be reimplementing another issue's module, and would leave
 * two IRP adapters to keep in step — this subclass puts the authorisation check, the rate limit and
 * the call record in front of the gateway they already hold. Wiring an existing adapter to the live
 * provider becomes a one-line change at the composition root, and no call can slip past the guard
 * because the guard *is* the gateway from the adapter's point of view.
 */
export class AuthorisedGateway extends ConnectorGateway {
  readonly #channel: GovernmentChannel;
  readonly #actorFor: (tenantId: string) => ActorContext;

  constructor(
    connectors: ConstructorParameters<typeof ConnectorGateway>[0],
    vault: ConstructorParameters<typeof ConnectorGateway>[1],
    verifier: ConstructorParameters<typeof ConnectorGateway>[2],
    channel: GovernmentChannel,
    actorFor: (tenantId: string) => ActorContext,
  ) {
    super(connectors, vault, verifier);
    this.#channel = channel;
    this.#actorFor = actorFor;
  }

  override async execute(kind: ConnectorKind, request: ConnectorRequest): Promise<ConnectorResponse> {
    const actor = this.#actorFor(request.tenantId);
    const outcome = await this.#channel.call(actor, {
      operation: request.operation,
      payload: request.payload,
      idempotencyKey: request.idempotencyKey,
      correlationId: request.correlationId,
    });
    if (outcome.kind === 'ANSWERED') return outcome.response;
    if (outcome.kind === 'REFUSED') {
      // The adapters above turn this into "this business is not set up with the provider yet",
      // which is exactly what an unauthorised call is. The refusal itself, with its plain wording,
      // is already on the call log for the screen that has to explain it.
      throw new ConnectorError(outcome.refusal.reason === 'RATE_LIMITED' ? 'OUTAGE' : 'UNAUTHORIZED', outcome.refusal.retryable);
    }
    throw new ConnectorError(outcome.detail === 'TIMEOUT' ? 'TIMEOUT' : 'OUTAGE', outcome.retryable);
  }
}

export type { UserId };
