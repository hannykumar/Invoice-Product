/**
 * Issue #51 [X03] — where production access actually stands, today.
 *
 * Almost every line below says "not started", and that is the truthful state rather than a
 * pessimistic one: there is no company yet (#49), no provider has been chosen from written
 * proposals (#50), and the owner's standing instruction is that this product integrates against
 * free sandbox APIs only. A register filled in to look further along would be the one thing this
 * issue cannot afford, because the next person reads it before deciding whether to send a real
 * taxpayer's invoice to the live portal.
 *
 * Two lines are `DONE`, and they are the two this repository can honestly satisfy: the customer's
 * own authorisation dance, and the fallback that keeps a business invoicing with the provider
 * disconnected. `drills.ts` re-proves both every time the tests run, so neither can quietly rot.
 *
 * Edit this file as each step completes. Nothing in it may be a credential, a GST number or any
 * other real identifier — only pointers to where those live.
 */
import { GO_LIVE_STEPS } from './checklist.ts';
import type { ProductionRegister, StepRecord } from './model.ts';

const DONE: Readonly<Record<string, { readonly evidence: string; readonly note: string }>> = {
  CUSTOMER_AUTHORISATION_PROCEDURE: {
    evidence: 'packages/gsp (#33), docs/contracts/government-access-v1.md, drill: pilot-onboarding',
    note: 'Implemented and exercised end to end against the sandbox provider on every test run.',
  },
  FALLBACK_WORKFLOW: {
    evidence: 'packages/gst offlineJson (#26), drill: revocation-and-fallback',
    note: 'The government’s own JSON is produced with no provider involved, and the drill runs it after a revocation.',
  },
};

const ON_HOLD: Readonly<Record<string, { readonly evidence: string; readonly note: string }>> = {
  AGREEMENT_AND_SLA: {
    evidence: 'Standing decision, recorded below',
    note: 'No paid production GSP plan is being pursued. Raise it with the owner rather than treating it as the next step.',
  },
  CONTROLLED_PRODUCTION_SMOKE_TEST: {
    evidence: 'Standing decision, recorded below',
    note: 'The equivalent has been run against the free sandbox: a bill registered end to end on 9 September 2026 (docs/contracts/whitebooks-sandbox.md).',
  },
};

export const CURRENT_STATE: ProductionRegister = Object.freeze({
  environment: 'SANDBOX',
  sandboxProvider: 'WhiteBooks (formerly MasterGST) — free sandbox',
  contractedProvider: null,
  standingDecision:
    'This product integrates against free GST sandbox APIs only, not a paid production GSP plan. ' +
    'A sandbox proves the integration works; it issues no legally valid IRN or e-way bill, so it ' +
    'cannot serve a real shopkeeper. Moving to production is the owner’s decision to make, not a ' +
    'step to slide into once the sandbox works.',
  steps: Object.freeze(GO_LIVE_STEPS.map((step): StepRecord => {
    const done = DONE[step.id];
    if (done !== undefined) return { id: step.id, state: 'DONE', evidence: done.evidence, note: done.note };
    const held = ON_HOLD[step.id];
    if (held !== undefined) return { id: step.id, state: 'ON_HOLD_BY_DECISION', evidence: held.evidence, note: held.note };
    return { id: step.id, state: 'NOT_STARTED', evidence: null, note: null };
  })),
});
