/**
 * Issue #49 [X01] — where this actually stands, today.
 *
 * This file is the register for the real company, and it is deliberately almost empty: **the
 * company does not exist yet.** Incorporating one needs a person with identity documents, a
 * chartered accountant's advice and money, and none of those are things this repository can supply.
 *
 * Keeping the truthful, empty state here rather than a plausible-looking filled-in one is the whole
 * point. `npm run vendor:readiness` prints exactly what is missing and which issues it holds up, so
 * nobody discovers at contract time that #50 was waiting on a board resolution nobody had drafted.
 *
 * As each step completes, edit this file. Nothing in it may be a real identifier — the register
 * throws if you try, and `docs/compliance/x01-*` explains where those live instead.
 */
import { VendorOnboardingRegister } from './register.ts';
import type { CompanyRecord, DocumentKind } from './model.ts';
import { FULL_DOCUMENT_PACK } from './catalogue.ts';

export const CURRENT_STATE: CompanyRecord = (() => {
  const register = new VendorOnboardingRegister();
  register.company({
    legalName: null,
    entityType: null,
    incorporatedOn: null,
    registeredStateCode: null,
    domain: null,
  });
  // Every document a provider will ask for, listed so the size of the job is visible from day one.
  for (const kind of FULL_DOCUMENT_PACK as readonly DocumentKind[]) {
    register.document({ kind, status: 'NOT_STARTED', note: 'Waiting on the entity being formed.' });
  }
  return register.build();
})();
