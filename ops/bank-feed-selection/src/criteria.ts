/**
 * Issue #52 [X04] — what the comparison is actually about, and how much each thing counts.
 *
 * The weights are here, in one place, so the recommendation can be argued with. Anybody who thinks
 * price should count for more than consent can change a number and re-run it — which is the point
 * of writing the comparison as code rather than as a paragraph.
 */
import type { Criterion } from './model.ts';

export const CRITERIA: readonly Criterion[] = [
  {
    id: 'consent_and_revocation',
    label: { 'en-IN': 'Consent and revocation', 'hi-IN': 'Anumati aur use wapas lena' },
    weight: 25,
    essential: true,
    why: 'The shopkeeper must be able to see what they agreed to and take it back without ringing anybody. A route where revocation means an email to support is not revocation.',
  },
  {
    id: 'accounting_use_permitted',
    label: { 'en-IN': 'Accounting and reconciliation use is contractually allowed', 'hi-IN': 'Hisab-kitab ke liye anubandh mein ijazat' },
    weight: 20,
    essential: true,
    why: 'Some data licences permit lending decisions and not bookkeeping. Building reconciliation on a licence that forbids it is a launch that has to be undone.',
  },
  {
    id: 'bank_coverage',
    label: { 'en-IN': 'How many of our customers’ banks are reachable', 'hi-IN': 'Kitne grahakon ke bank pahunch mein hain' },
    weight: 15,
    essential: true,
    why: 'An MSME product cannot ask a shopkeeper to change banks. Coverage of the banks they already use is the whole value.',
  },
  {
    id: 'cost',
    label: { 'en-IN': 'What it costs per business per month', 'hi-IN': 'Har business par har mahine kitna kharch' },
    weight: 15,
    essential: true,
    why: 'This sits under a ₹499 plan. A feed that costs more per business than the plan earns is not a feed, it is a subsidy.',
  },
  {
    id: 'history_depth',
    label: { 'en-IN': 'How far back the transaction history goes', 'hi-IN': 'Purana lena-dena kitne peeche tak milta hai' },
    weight: 8,
    essential: false,
    why: 'A business joining mid-year needs the year so far, or the first reconciliation is a manual one.',
  },
  {
    id: 'data_freshness',
    label: { 'en-IN': 'How soon a transaction appears', 'hi-IN': 'Lena-dena kitni jaldi dikhta hai' },
    weight: 7,
    essential: false,
    why: 'Same-day is enough for bookkeeping. Real time is a nice-to-have that is often priced as a necessity.',
  },
  {
    id: 'sandbox_availability',
    label: { 'en-IN': 'A sandbox we can build against', 'hi-IN': 'Jisme hum bana kar dekh sakein, aisa sandbox' },
    weight: 5,
    essential: true,
    why: "This issue's acceptance criterion. Without one there is nothing to prove the adapter against, and the conformance harness has nothing to run.",
  },
  {
    id: 'startup_eligibility',
    label: { 'en-IN': 'Whether a company our size is eligible at all', 'hi-IN': 'Hamare aakar ki company yogya hai ya nahin' },
    weight: 5,
    essential: true,
    why: 'Several routes require volumes, capital or a banking relationship a new company does not have. Finding that out after choosing wastes a quarter.',
  },
];

export const totalWeight = (criteria: readonly Criterion[] = CRITERIA): number =>
  criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
