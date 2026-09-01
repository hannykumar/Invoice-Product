/**
 * Issue #50 [X02] — what the comparison weighs, and by how much.
 *
 * The weights are here so they can be argued with. The issue's own non-goal — "choose only by
 * lowest headline price" — is enforced by the arithmetic: cost is weighted below endpoint coverage
 * and below what happens to a customer's data, and no amount of cheapness can outweigh a missing
 * critical capability, because a provider missing one is not scored at all.
 */
import type { Criterion } from './model.ts';

export const CRITERIA: readonly Criterion[] = Object.freeze([
  {
    id: 'endpoint_coverage',
    label: { 'en-IN': 'Does it actually do everything we send it', 'hi-IN': 'Jo hum bhejte hain, kya woh sab kar sakta hai' },
    weight: 30,
    essential: true,
    why: 'Measured against the checklist in capabilities.ts, which comes from the operations this product already issues. A gap here is a feature that stops working, not a compromise.',
  },
  {
    id: 'sandbox_access',
    label: { 'en-IN': 'Can we try it before we commit', 'hi-IN': 'Kya bina commitment ke aazma sakte hain' },
    weight: 15,
    essential: true,
    why: 'The issue asks for a sandbox before commitment, and the conformance harness needs one to run against. A provider that will only demonstrate on a call is asking us to sign for claims we cannot check.',
  },
  {
    id: 'cost',
    label: { 'en-IN': 'What it costs at ten businesses, and at fifty', 'hi-IN': 'Dus business par kitna, aur pachaas par kitna' },
    weight: 15,
    essential: true,
    why: 'Judged as a curve, not a headline: a low per-call fee behind a monthly minimum is expensive at ten customers and cheap at five hundred, and we start at ten.',
  },
  {
    id: 'data_storage',
    label: { 'en-IN': 'What they keep of our customers’ data, and for how long', 'hi-IN': 'Hamare customers ka data woh kya rakhte hain, aur kab tak' },
    weight: 15,
    essential: true,
    why: 'Their retention becomes ours in every conversation with a customer about privacy. A provider that keeps invoice payloads indefinitely is a promise we then cannot make.',
  },
  {
    id: 'support_and_sla',
    label: { 'en-IN': 'What happens on the 20th when the portal is slow', 'hi-IN': 'Bees taareekh ko portal slow ho to kya hota hai' },
    weight: 10,
    essential: false,
    why: 'Filing deadlines are the same day for everybody, so provider load peaks exactly when our customers cannot wait. A support desk that answers in two working days is no support on the 20th.',
  },
  {
    id: 'portability_and_exit',
    label: { 'en-IN': 'What we can take with us if we leave', 'hi-IN': 'Agar hum chhodein to kya saath le ja sakte hain' },
    weight: 8,
    essential: true,
    why: 'Termination terms decide whether a bad provider is a nuisance or a hostage situation. It is essential because it is unanswerable after signing.',
  },
  {
    id: 'callbacks',
    label: { 'en-IN': 'Do they push acknowledgements back to us', 'hi-IN': 'Kya woh acknowledgement wapas bhejte hain' },
    weight: 4,
    essential: false,
    why: 'We poll perfectly well without it (#33) and the door for it exists (#123); pushing just settles a timed-out invoice in seconds rather than at the next sweep.',
  },
  {
    id: 'startup_terms',
    label: { 'en-IN': 'Can a small company actually sign this', 'hi-IN': 'Kya ek chhoti company yeh sign kar sakti hai' },
    weight: 3,
    essential: false,
    why: 'Minimum commitments, security deposits and enterprise-only tiers rule providers out for reasons that have nothing to do with their software.',
  },
]);
