/**
 * Issue #33 [E33] — making our record agree with the government's.
 *
 * This is the third acceptance criterion — "internal status matches authoritative government
 * acknowledgement" — and it exists because of one everyday event: the network drops between us and
 * the portal after the portal has already registered the invoice. At that moment the government
 * holds an IRN and we hold nothing. Nobody is at fault, and the business has a real problem: send
 * it again and there are two, leave it and there is an invoice that cannot legally move.
 *
 * So an unanswered call is never marked failed. It is marked `UNKNOWN`, and this file chases it:
 * it asks the provider what the government's record actually says and settles the call one of four
 * ways.
 *
 *   - **Confirmed** — the government has what we have. Nothing to do; the call is settled.
 *   - **Corrected** — it went through after all. Our record is brought up to the government's,
 *     because the government's record is the one that counts.
 *   - **Not found** — it never landed. Recorded as such, so the document can be sent again
 *     deliberately rather than hopefully.
 *   - **Conflict** — we hold one reference and the government holds another. Nothing is
 *     overwritten in either direction and a person is asked. Two different references for one
 *     document is not a data problem to be resolved by whoever wrote the last line of code.
 *
 * Reconciliation is idempotent and can run as often as anybody likes: a settled call is not
 * re-checked, and an unknown one that is still unknown stays exactly as it was.
 */
import type { Clock, CompanyId } from '@invoice/kernel';
import type { ActorContext, AuditPort } from '@invoice/ledger';
import { forbidden } from '@invoice/kernel';
import { redactDetails } from './redact.ts';
import type { CallLogRepository, GovernmentExceptionSink, GspProviderPort } from './ports.ts';
import {
  GSP_PERMISSIONS,
  bilingual,
  type ProviderCall,
  type ReconciliationConflict,
  type ReconciliationOutcome,
  type ReconciliationReport,
} from './types.ts';

export interface ReconcilerDeps {
  readonly calls: CallLogRepository;
  readonly provider: GspProviderPort;
  readonly audit: AuditPort;
  readonly clock: Clock;
  readonly exceptions?: GovernmentExceptionSink;
  /**
   * How long to leave a call alone before chasing it, in seconds.
   *
   * A call made four seconds ago that has not answered is not a mismatch; it is a call in flight.
   * Chasing it immediately would ask the provider about something it is still doing.
   */
  readonly settleAfterSeconds?: number;
}

export class GovernmentCallReconciler {
  readonly #deps: ReconcilerDeps;

  constructor(deps: ReconcilerDeps) {
    this.#deps = deps;
  }

  /** Chase every call this company never got an answer for. */
  async run(actor: ActorContext): Promise<ReconciliationReport> {
    if (!actor.permissions.includes(GSP_PERMISSIONS.reconcile)) {
      throw forbidden('GSP_FORBIDDEN', 'You do not have permission to reconcile government calls.', {
        details: { permission: GSP_PERMISSIONS.reconcile },
      });
    }
    const now = this.#deps.clock.now();
    const before = new Date(now.getTime() - (this.#deps.settleAfterSeconds ?? 60) * 1000).toISOString();
    const pending = await this.#deps.calls.listUnsettled(actor.companyId, before);

    let confirmed = 0;
    let corrected = 0;
    let notFound = 0;
    let stillUnknown = 0;
    const conflicts: ReconciliationConflict[] = [];

    for (const call of pending) {
      const outcome = await this.#check(call);
      switch (outcome.kind) {
        case 'CONFIRMED':
          confirmed += 1;
          await this.#settle(actor, call, 'ACCEPTED', outcome.governmentReference);
          break;
        case 'CORRECTED':
          corrected += 1;
          await this.#settle(actor, call, 'ACCEPTED', outcome.governmentReference);
          break;
        case 'NOT_FOUND':
          notFound += 1;
          await this.#settle(actor, call, 'REJECTED', null, 'NOT_RECEIVED');
          break;
        case 'CONFLICT': {
          const conflict = this.#conflictOf(call, outcome.ours, outcome.theirs);
          conflicts.push(conflict);
          await this.#raiseConflict(actor, call, conflict);
          break;
        }
        case 'STILL_UNKNOWN':
          stillUnknown += 1;
          break;
      }
    }

    return Object.freeze({
      at: now.toISOString(),
      checked: pending.length,
      confirmed,
      corrected,
      notFound,
      conflicts,
      stillUnknown,
    });
  }

  async #check(call: ProviderCall): Promise<ReconciliationOutcome> {
    const status = await this.#deps.provider.statusOf({
      gstin: call.gstin,
      operation: call.operation,
      providerRequestId: call.providerRequestId,
      documentRef: call.documentRef,
    });
    if (status.kind === 'UNAVAILABLE') return { kind: 'STILL_UNKNOWN', detail: status.detail };
    if (status.kind === 'NOT_FOUND') return { kind: 'NOT_FOUND' };
    if (call.governmentReference === null) {
      return { kind: 'CORRECTED', governmentReference: status.governmentReference, was: call.outcome };
    }
    if (call.governmentReference === status.governmentReference) {
      return { kind: 'CONFIRMED', governmentReference: status.governmentReference };
    }
    return { kind: 'CONFLICT', ours: call.governmentReference, theirs: status.governmentReference };
  }

  async #settle(
    actor: ActorContext,
    call: ProviderCall,
    outcome: ProviderCall['outcome'],
    governmentReference: string | null,
    errorCode?: string,
  ): Promise<void> {
    const at = this.#deps.clock.now().toISOString();
    const settled: ProviderCall = {
      ...call,
      outcome,
      governmentReference: governmentReference ?? call.governmentReference,
      ...(errorCode === undefined ? {} : { errorCode }),
      settledAt: call.settledAt ?? at,
      reconciledAt: at,
    };
    await this.#deps.calls.settle(settled);
    await this.#deps.audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: 'gsp.call.reconciled',
      subjectType: 'government_call',
      subjectId: call.id,
      summary:
        outcome === 'ACCEPTED'
          ? `${call.operation} for ${call.gstin} did reach the government; our record now matches it.`
          : `${call.operation} for ${call.gstin} never reached the government, so it can be sent again.`,
      details: redactDetails({
        gstin: call.gstin,
        operation: call.operation,
        outcome,
        governmentReference: settled.governmentReference ?? '',
        documentRef: call.documentRef ?? '',
        providerRequestId: call.providerRequestId ?? '',
      }),
    });
  }

  #conflictOf(call: ProviderCall, ours: string, theirs: string): ReconciliationConflict {
    return {
      callId: call.id,
      gstin: call.gstin,
      operation: call.operation,
      documentRef: call.documentRef,
      ours,
      theirs,
      question: bilingual(
        `Our record for this document says ${ours}, and the government's record says ${theirs}. Somebody needs to look at both before anything else is sent for it.`,
        `Hamare record mein is document par ${ours} hai aur government ke record mein ${theirs}. Iske liye kuch aur bhejne se pehle koi dono dekh le.`,
      ),
    };
  }

  async #raiseConflict(actor: ActorContext, call: ProviderCall, conflict: ReconciliationConflict): Promise<void> {
    const at = this.#deps.clock.now().toISOString();
    // Neither side is written over. The call keeps our reference, the exception carries both, and a
    // person decides — which is the exception-queue rule of the whole product applied to the one
    // place where the other party is the government.
    await this.#deps.calls.settle({ ...call, reconciledAt: at });
    await this.#deps.exceptions?.raise({
      companyId: actor.companyId,
      gstin: call.gstin,
      kind: 'GOVERNMENT_REFERENCE_CONFLICT',
      reference: call.documentRef ?? call.id,
      ours: conflict.ours,
      theirs: conflict.theirs,
      question: conflict.question,
      at,
    });
    await this.#deps.audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: 'gsp.call.conflict',
      subjectType: 'government_call',
      subjectId: call.id,
      summary: conflict.question['en-IN'],
      details: redactDetails({
        gstin: call.gstin,
        operation: call.operation,
        ours: conflict.ours,
        theirs: conflict.theirs,
        documentRef: call.documentRef ?? '',
      }),
    });
  }
}

export type { CompanyId };
