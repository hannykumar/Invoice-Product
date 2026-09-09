/**
 * Issue #137 — the marked copies of an invoice.
 *
 * GST asks for three copies of an invoice for **goods**, each marked so anyone holding one knows
 * which it is: the Original goes to the buyer, the Duplicate travels with the transporter, and the
 * Triplicate stays with the seller. An invoice for **services** needs two, because nothing is
 * carried anywhere and there is no transporter to hand a copy to.
 *
 * We produced one unmarked render, which is not a bill a business can hand to a lorry driver.
 */
import type { InvoiceDocument, Locale } from './document.ts';
import { t, type WordingKey } from './parts.ts';

export type InvoiceCopy = 'ORIGINAL' | 'DUPLICATE' | 'TRIPLICATE';

const LABEL: Record<'GOODS' | 'SERVICES', Partial<Record<InvoiceCopy, WordingKey>>> = {
  GOODS: {
    ORIGINAL: 'copyOriginal',
    DUPLICATE: 'copyDuplicateTransporter',
    TRIPLICATE: 'copyTriplicate',
  },
  // No transporter copy, so the second and last copy is the one the business keeps.
  SERVICES: {
    ORIGINAL: 'copyOriginal',
    DUPLICATE: 'copyDuplicateSupplier',
  },
};

/** Which copies this bill has: three for goods, two for services. */
export const copiesFor = (doc: InvoiceDocument): readonly InvoiceCopy[] =>
  doc.supplyKind === 'GOODS' ? ['ORIGINAL', 'DUPLICATE', 'TRIPLICATE'] : ['ORIGINAL', 'DUPLICATE'];

/**
 * The marking printed at the top of a copy, or `null` where that copy does not exist for this bill.
 *
 * Asking for a transporter copy of a services invoice returns `null` rather than inventing a
 * marking, because a bill marked for a transporter who was never involved is a wrong bill.
 */
export const copyMarking = (doc: InvoiceDocument, copy: InvoiceCopy, locale: Locale): string | null => {
  const key = LABEL[doc.supplyKind][copy];
  return key === undefined ? null : t(key, locale);
};
