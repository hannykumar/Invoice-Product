/**
 * The government's test GSTINs, and why letting them past our validation is safe.
 *
 * NIC's sandbox issues taxpayers like `33AAGCB1286Q003`. A real GSTIN carries `Z` in the fourteenth
 * position; these carry a digit. Our payload validation refuses them, correctly — and that refusal
 * blocks any end-to-end test of the product against the government's own sandbox.
 *
 * The way out is narrow on purpose. **The exception admits only numbers that could never be real.**
 * Everything listed here fails the published format in the fourteenth position, so GSTN cannot ever
 * have issued one to a business, and no shopkeeper can mistype their way into this list. The hole
 * is exactly the size of the government's own fake data and cannot be widened by accident.
 *
 * It is still off unless asked for, because a check that quietly relaxes itself is not a check.
 */

/** WhiteBooks' sandbox taxpayers: one per state, all sharing a PAN, none structurally valid. */
const SANDBOX_PATTERN = /^[0-9]{2}AAGCB1286Q[0-9]{3}$/;

/**
 * True for a GSTIN that belongs to the government's sandbox and to nothing else.
 *
 * Deliberately a pattern rather than a list of the thirty-six: the states are numbered by the
 * government, the PAN is fixed, and writing them out would invite someone to append a real one.
 */
export const isSandboxGstin = (gstin: string): boolean => SANDBOX_PATTERN.test(gstin.toUpperCase());

export interface PayloadOptions {
  /**
   * Accept the government's malformed sandbox GSTINs. Never set this against the live portal: an
   * invoice built with one is not a real invoice, and the IRN it earns is not a real IRN.
   */
  readonly allowSandboxGstins?: boolean;
}
