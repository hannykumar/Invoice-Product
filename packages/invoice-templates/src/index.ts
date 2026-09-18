/** Issue #13 [E13] — public surface. See docs/contracts/invoice-templates.v1.md. */
export * from './mandatory.ts';
export * from './template.ts';
export * from './document.ts';
export * from './words.ts';
export * from './snapshot.ts';
export * from './reserved.ts';
export * from './parts.ts';
export * from './hsn-summary.ts';
export * from './boxed.ts';
export * from './copies.ts';
export * from './render.ts';
export * from './pdf.ts';
export * from './from-sales.ts';
// Issue #141 — the delivery challan, printed on the same engine.
export * from './challan.ts';
// Issue #142 — the quotation and the proforma invoice, printed on the same engine.
export * from './presale.ts';
// Issue #186 — the credit note and the debit note, printed on the same engine.
export * from './credit-note.ts';
// Issue #147 — the mark of the trade a business may print behind its bill.
export * from './marks.ts';
// Issues #146 and #147 — what a business has said about how its own bill should look.
export * from './branding.ts';
// Issue #144 — the pay-by-scan UPI square, and the QR drawing it is made from.
export * from './qr.ts';
export * from './upi.ts';
