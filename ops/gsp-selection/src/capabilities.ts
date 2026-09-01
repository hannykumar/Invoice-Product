/**
 * Issue #50 [X02] — the checklist, taken from what this product actually sends.
 *
 * The temptation with a provider comparison is a wish list: every GST API anybody has ever named,
 * scored out of five. That produces a shortlist nobody can act on, because it never says which
 * gaps break something we have already built.
 *
 * So the list below is derived from the product. Every capability with a `usedBy` names an
 * operation this repository already issues through #8's connector — the ones in
 * `OPERATION_SCOPES` (#33) — and a provider missing it breaks a feature that exists, has tests and
 * has a screen. A test in this package fails if the product starts sending an operation nobody has
 * put on the checklist, so the requirement cannot quietly drift away from the software.
 *
 * The three with `usedBy: null` are what the issue asks us to request but the product does not
 * call yet: the taxpayer lookup #19 wants for supplier checks, the IMS actions #31 will need when
 * accepting and rejecting move to the portal, and the callbacks #123 built a door for.
 */
import { OPERATION_SCOPES } from '@invoice/gsp';
import type { Capability } from './model.ts';

const capability = (
  id: string,
  en: string,
  hi: string,
  usedBy: string | null,
  neededBy: string,
  critical: boolean,
  why: string,
): Capability => ({ id, label: { 'en-IN': en, 'hi-IN': hi }, usedBy, neededBy, critical, why });

export const CAPABILITIES: readonly Capability[] = Object.freeze([
  capability(
    'api_user_otp', 'Authorise a GST number with a one-time password to the signatory',
    'Signatory ke OTP se GST number ki ijazat lena',
    null, '#33', true,
    'The only way to act for a customer without holding their portal password. A provider that cannot do this cannot be used at all, whatever else it offers.',
  ),
  capability(
    'irn_generate', 'Register an invoice and return the IRN', 'Invoice register kar ke IRN dena',
    'einvoice.generate', '#26', true,
    'The e-invoice lifecycle is built on it, and an invoice without an IRN is not a valid invoice.',
  ),
  capability(
    'irn_cancel', 'Cancel an e-invoice inside the government window', 'Samay ke andar e-invoice cancel karna',
    'einvoice.cancel', '#26', true,
    'A mistake found within twenty-four hours must be cancellable, or the correction becomes a credit note nobody asked for.',
  ),
  capability(
    'irn_fetch', 'Look up an IRN already registered', 'Pehle se registered IRN dekhna',
    'einvoice.fetch', '#26', true,
    'How an unknown outcome is settled after a timeout. Without it a lost acknowledgement stays lost.',
  ),
  capability(
    'eway_generate', 'Raise an e-way bill', 'E-way bill banana',
    'eway.generate', '#27', true,
    'Goods above the threshold cannot legally move without one.',
  ),
  capability(
    'eway_update', 'Change the vehicle, extend validity, assign a transporter, consolidate',
    'Gaadi badalna, validity badhana, transporter dena, ek trip mein jodna',
    'eway.vehicle', '#27', true,
    'A breakdown on the road is the ordinary case. A provider that can only create bills leaves the lorry illegal.',
  ),
  capability(
    'eway_cancel', 'Cancel or reject an e-way bill', 'E-way bill cancel ya reject karna',
    'eway.cancel', '#27', true,
    'Both the sender cancelling and the other party rejecting are separate acts the portal supports.',
  ),
  capability(
    'eway_fetch', 'Look up an e-way bill', 'E-way bill dekhna',
    'eway.fetch', '#27', false,
    'Used for reconciliation. Painful to lose, survivable without.',
  ),
  capability(
    'return_file', 'Save and file GSTR-1 and GSTR-3B', 'GSTR-1 aur GSTR-3B bharna aur file karna',
    'return.submit', '#30', true,
    'Filing is the last button of the return workspace. Everything before it works without a provider; this does not.',
  ),
  capability(
    'return_status', 'Check what has been filed, with the acknowledgement number',
    'Kya file hua hai aur uska number dekhna',
    'return.status', '#30', true,
    'Our record of a filing has to be checkable against the government’s, or the two drift apart silently.',
  ),
  capability(
    'gstr2b_fetch', 'Download GSTR-2B for a month', 'Mahine ka GSTR-2B lena',
    'gstr2b.fetch', '#31', true,
    'The purchase reconciliation works from an uploaded file too, but a download is what makes it happen every month rather than when somebody remembers.',
  ),
  capability(
    'ims_actions', 'Accept, reject or keep pending on the IMS screen',
    'IMS par accept, reject ya pending rakhna',
    null, '#31', false,
    'The decisions are recorded in our own workspace today. Pushing them to the portal is the natural next step.',
  ),
  capability(
    'taxpayer_lookup', 'Look up a GST number: name, status, filing history',
    'GST number dekhna: naam, sthiti, filing ka record',
    null, '#19', false,
    'Supplier risk warnings are built on a mock today. This is what makes them real.',
  ),
  capability(
    'callbacks', 'Post acknowledgements back to us, signed', 'Acknowledgement wapas bhejna, signature ke saath',
    null, '#123', false,
    'We built the door and it works without them; a provider that pushes settles a timed-out invoice in seconds instead of at the next sweep.',
  ),
]);

export const CRITICAL_CAPABILITIES: readonly Capability[] = Object.freeze(CAPABILITIES.filter((item) => item.critical));

/**
 * The operations this product sends that no capability covers.
 *
 * Always empty, and a test keeps it that way. If somebody adds an operation to the authorised
 * channel without adding it here, the requirement we send providers is quietly out of date — which
 * is discovered, in the worst case, when a provider we signed cannot do it.
 */
export const uncoveredOperations = (): readonly string[] => {
  const covered = new Set(CAPABILITIES.map((item) => item.usedBy).filter((item): item is string => item !== null));
  return Object.keys(OPERATION_SCOPES).filter((operation) => !covered.has(operation) && !alias(operation, covered));
};

/**
 * Several product operations are one provider capability.
 *
 * Changing a vehicle, extending validity, assigning a transporter and consolidating a trip are four
 * calls in our code and one line in a provider's price list, so they are compared as one.
 */
const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'eway.transporter': 'eway.vehicle',
  'eway.extend': 'eway.vehicle',
  'eway.consolidate': 'eway.vehicle',
  'eway.reject': 'eway.cancel',
});

const alias = (operation: string, covered: ReadonlySet<string>): boolean => {
  const target = ALIASES[operation];
  return target !== undefined && covered.has(target);
};
