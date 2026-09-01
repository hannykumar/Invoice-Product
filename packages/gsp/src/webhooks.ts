/**
 * Issue #123 — landing a provider's callback on the call it belongs to.
 *
 * The problem is the ordinary one this whole module is built around, seen from the other side. A
 * call to the portal times out; we record it as `UNKNOWN` (#33) and go on with our day; thirty
 * seconds later the provider rings back with the IRN. Before this file, that callback was
 * authenticated by #8's verifier, deduplicated, and then dropped on the floor — and the invoice
 * stayed unsettled until reconciliation next polled. Polling works. It is just late, and the answer
 * was already in the building.
 *
 * Five rules, and each of them is a way this goes wrong if you are careless.
 *
 *   1. **The body is not data until the signature verifies.** Nothing here reads a field, matches a
 *      call or writes a record before `WebhookVerifier` has authenticated the bytes. An unverified
 *      delivery is recorded by a digest of what arrived — the fact that somebody sent it is worth
 *      knowing — and never parsed.
 *   2. **The company comes from the matched call, never from the callback.** A callback names a
 *      provider request id, which we generated. We find our own row and take the company and the
 *      GST number from it. A forged callback therefore cannot name a company at all, which is a
 *      stronger property than checking whether the one it named was allowed.
 *   3. **The same event twice changes the record once.** Providers that do not get a 200 resend,
 *      and an acknowledgement applied twice would settle a call twice. Deduplication is durable —
 *      a unique index — rather than a set in a process that restarts.
 *   4. **Late is not wrong.** A callback that arrives after polling already settled the same call is
 *      the ordinary race, not an error: if it agrees, it is confirmed and nothing changes.
 *   5. **Disagreement is never resolved by whoever wrote last.** If we hold one reference and the
 *      callback carries another — or we recorded that the document never arrived and the callback
 *      says it did — neither side is written over. An exception goes to a person with both, exactly
 *      as reconciliation does, because two references for one invoice is a question about somebody's
 *      tax and not a merge conflict.
 */
import { createHash } from 'node:crypto';
import type { Clock, CompanyId } from '@invoice/kernel';
import type { AuditPort } from '@invoice/ledger';
import { ConnectorError, type ConnectorGateway, type ConnectorKind } from '../../platform/src/connectors.ts';
import { governmentReferenceOf } from './channel.ts';
import { redactDetails } from './redact.ts';
import type {
  AuthorisationRepository,
  CallLogRepository,
  GovernmentExceptionSink,
  WebhookEventRepository,
} from './ports.ts';
import { bilingual, type Bilingual, type ProviderCall } from './types.ts';

export type WebhookOutcome =
  /** An unsettled call now has the government's own answer. */
  | { readonly kind: 'SETTLED'; readonly callId: string; readonly governmentReference: string }
  /** The callback agrees with what we already hold. Nothing changed, which is the right amount. */
  | { readonly kind: 'CONFIRMED'; readonly callId: string }
  /** Two answers for one document. Both kept, a person asked. */
  | { readonly kind: 'CONFLICT'; readonly callId: string; readonly ours: string; readonly theirs: string; readonly question: Bilingual }
  /** Seen before. Providers resend when they do not get a 200; this is not an error. */
  | { readonly kind: 'DUPLICATE'; readonly eventId: string }
  /** Verified, but about a call this product has no record of making. Recorded, not acted on. */
  | { readonly kind: 'UNMATCHED'; readonly eventId: string }
  /** The matched call's GST number is not connected here at all. */
  | { readonly kind: 'REFUSED'; readonly reason: 'UNAUTHORISED_GSTIN'; readonly callId: string }
  /** The callback carries no acknowledgement to apply. */
  | { readonly kind: 'IGNORED'; readonly eventId: string; readonly detail: string };

export interface WebhookReceiverDeps {
  readonly gateway: ConnectorGateway;
  readonly calls: CallLogRepository;
  readonly authorisations: AuthorisationRepository;
  readonly events: WebhookEventRepository;
  readonly audit: AuditPort;
  readonly clock: Clock;
  readonly exceptions?: GovernmentExceptionSink;
}

/** Raised when the signature does not verify. The delivery is recorded; the body is not read. */
export class WebhookNotAuthenticated extends Error {
  readonly kind = 'UNAUTHENTICATED' as const;
  constructor() {
    super('That callback could not be authenticated, so nothing in it was read.');
  }
}

export class GovernmentWebhookReceiver {
  readonly #deps: WebhookReceiverDeps;

  constructor(deps: WebhookReceiverDeps) {
    this.#deps = deps;
  }

  /**
   * Take delivery of one callback.
   *
   * `rawBody` is the bytes as they arrived. It has to be: a signature is over what was sent, and a
   * body that has been parsed and re-serialised is a different string with the same meaning — which
   * verifies against nothing.
   */
  async receive(kind: ConnectorKind, rawBody: string, signature: string): Promise<WebhookOutcome> {
    const at = this.#deps.clock.now().toISOString();

    let verified: Awaited<ReturnType<ConnectorGateway['receiveWebhook']>>;
    try {
      verified = await this.#deps.gateway.receiveWebhook(kind, rawBody, signature);
    } catch (error) {
      // Recorded by digest. We know somebody sent something and that it did not authenticate; we
      // do not know, and will not pretend to know, what it said.
      await this.#deps.events.recordRejected({
        kind,
        digest: createHash('sha256').update(rawBody).digest('hex'),
        at,
        reason: error instanceof ConnectorError ? error.code : 'UNAUTHORIZED',
      });
      await this.#deps.audit.record({
        // No company: the body is not trusted, so it cannot name one. Recorded against the
        // platform's own tenant so an operator can still see the attempt.
        companyId: SYSTEM_COMPANY,
        actorId: SYSTEM_ACTOR,
        at,
        action: 'gsp.webhook.rejected',
        subjectType: 'government_webhook',
        subjectId: kind,
        summary: 'A provider callback arrived that could not be authenticated. Nothing in it was read.',
        details: { connector: kind },
      });
      throw new WebhookNotAuthenticated();
    }

    const webhook = verified.webhook;
    const seen = await this.#deps.events.find(kind, webhook.eventId);
    if (seen !== null || verified.duplicate) {
      // The provider resending is ordinary. Answering "yes, we have it" is what stops it resending.
      return { kind: 'DUPLICATE', eventId: webhook.eventId };
    }

    const call = await this.#match(webhook.providerRequestId);
    if (call === null) {
      await this.#remember(kind, webhook.eventId, webhook.providerRequestId, at, null, null, 'UNMATCHED', null);
      return { kind: 'UNMATCHED', eventId: webhook.eventId };
    }

    // Everything from here is about a row we wrote ourselves, so the company and the GST number are
    // ours and not the caller's.
    const authorisation = await this.#deps.authorisations.find(call.companyId, call.gstin);
    if (authorisation === null) {
      await this.#remember(kind, webhook.eventId, webhook.providerRequestId, at, call.id, call.companyId, 'REFUSED', null);
      await this.#audit(call, 'gsp.webhook.refused', `A callback arrived for GST number ${call.gstin}, which is not connected to this business.`, { eventId: webhook.eventId });
      return { kind: 'REFUSED', reason: 'UNAUTHORISED_GSTIN', callId: call.id };
    }

    const theirs = governmentReferenceOf(webhook.payload);
    if (theirs === null) {
      await this.#remember(kind, webhook.eventId, webhook.providerRequestId, at, call.id, call.companyId, 'IGNORED', null);
      return { kind: 'IGNORED', eventId: webhook.eventId, detail: 'The callback carried no acknowledgement number.' };
    }

    // Our record already has an answer for this document.
    if (call.governmentReference !== null) {
      if (call.governmentReference === theirs) {
        await this.#remember(kind, webhook.eventId, webhook.providerRequestId, at, call.id, call.companyId, 'CONFIRMED', theirs);
        return { kind: 'CONFIRMED', callId: call.id };
      }
      return this.#conflict(kind, webhook.eventId, webhook.providerRequestId, at, call, call.governmentReference, theirs);
    }

    // We recorded that it never arrived, and the government says otherwise. That is a disagreement
    // about a document, not a late answer, and it is not settled by the newer message winning.
    if (call.outcome === 'REJECTED') {
      return this.#conflict(kind, webhook.eventId, webhook.providerRequestId, at, call, call.errorCode ?? 'we recorded that it never reached the government', theirs);
    }

    const settled: ProviderCall = {
      ...call,
      outcome: 'ACCEPTED',
      governmentReference: theirs,
      settledAt: call.settledAt ?? at,
      reconciledAt: at,
    };
    await this.#deps.calls.settle(settled);
    await this.#remember(kind, webhook.eventId, webhook.providerRequestId, at, call.id, call.companyId, 'SETTLED', theirs);
    await this.#audit(call, 'gsp.webhook.settled', `${call.operation} for ${call.gstin} did reach the government; the provider's callback settled it.`, {
      eventId: webhook.eventId,
      governmentReference: theirs,
    });
    return { kind: 'SETTLED', callId: call.id, governmentReference: theirs };
  }

  async #match(providerRequestId: string): Promise<ProviderCall | null> {
    const byRequest = await this.#deps.calls.findByProviderRequestId(providerRequestId);
    if (byRequest !== null) return byRequest;
    // A call that timed out never learned its provider request id. The correlation id is ours and
    // travelled out with the request, which is what makes the unknown call findable at all.
    return this.#deps.calls.findByCorrelationId(providerRequestId);
  }

  async #conflict(
    kind: ConnectorKind,
    eventId: string,
    providerRequestId: string,
    at: string,
    call: ProviderCall,
    ours: string,
    theirs: string,
  ): Promise<WebhookOutcome> {
    const question = bilingual(
      `Our record for this document says ${ours}, and the provider's callback says ${theirs}. Somebody needs to look at both before anything else is sent for it.`,
      `Hamare record mein is document par ${ours} hai aur provider ke callback mein ${theirs}. Iske liye kuch aur bhejne se pehle koi dono dekh le.`,
    );
    // The call is left exactly as it was. Only the fact that it has been looked at is written.
    await this.#deps.calls.settle({ ...call, reconciledAt: at });
    await this.#remember(kind, eventId, providerRequestId, at, call.id, call.companyId, 'CONFLICT', theirs);
    await this.#deps.exceptions?.raise({
      companyId: call.companyId,
      gstin: call.gstin,
      kind: 'GOVERNMENT_REFERENCE_CONFLICT',
      reference: call.documentRef ?? call.id,
      ours,
      theirs,
      question,
      at,
    });
    await this.#audit(call, 'gsp.webhook.conflict', question['en-IN'], { eventId, ours, theirs });
    return { kind: 'CONFLICT', callId: call.id, ours, theirs, question };
  }

  async #remember(
    kind: string,
    eventId: string,
    providerRequestId: string,
    at: string,
    callId: string | null,
    companyId: CompanyId | null,
    outcome: string,
    governmentReference: string | null,
  ): Promise<void> {
    await this.#deps.events.insert({ kind, eventId, providerRequestId, receivedAt: at, callId, companyId, outcome, governmentReference });
  }

  async #audit(call: ProviderCall, action: string, summary: string, details: Readonly<Record<string, string>>): Promise<void> {
    await this.#deps.audit.record({
      companyId: call.companyId,
      // The provider acted, not a person. Recorded as the system actor rather than as whoever
      // happened to make the original call, which would put somebody's name on an event they
      // were not present for.
      actorId: SYSTEM_ACTOR,
      at: this.#deps.clock.now().toISOString(),
      action,
      subjectType: 'government_call',
      subjectId: call.id,
      summary,
      details: redactDetails({ gstin: call.gstin, operation: call.operation, documentRef: call.documentRef ?? '', ...details }),
    });
  }
}

/** Callbacks are the provider acting, not a person. */
const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000' as never;
const SYSTEM_COMPANY = '00000000-0000-4000-8000-000000000000' as never;

export { SYSTEM_ACTOR as WEBHOOK_SYSTEM_ACTOR };
