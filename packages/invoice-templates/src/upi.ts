/**
 * Issue #144 — the pay-by-scan UPI square on the bill.
 *
 * A customer points PhonePe, Google Pay, Paytm or their bank's app at the square and the app opens
 * with the business's name, the bill number and the exact amount already filled in. The square is
 * nothing but a UPI payment link (the NPCI `upi://pay` form) drawn as a QR code.
 *
 * Three rules live here, so no renderer decides them on its own:
 *
 *  - The amount is **what is still due on this bill**, never the bill total when part of it has been
 *    paid. A square asking for money already received is how a customer pays twice.
 *  - No square on a bill with nothing due, and none on a credit note, which is money going the other
 *    way. There is nothing for a customer to pay from either.
 *  - No square on 58 mm till roll. At that width the square would print too small for a phone to
 *    read reliably, and a counter slip is handed over after the customer has already paid.
 */
import { invalid, subtract, toDecimalString, type Money } from '@invoice/kernel';
import type { InvoiceDocument } from './document.ts';
import type { PageFormat } from './template.ts';
import { qrSvg } from './qr.ts';

/**
 * A UPI id is a name, an @, and the bank or app's handle: `sharmafruits@okicici`, `9876543210@ybl`.
 * The name part allows letters, digits, dots, hyphens and underscores; the handle is letters and
 * digits. This is the form every UPI app accepts.
 */
const UPI_ID = /^[a-z0-9][a-z0-9._-]{1,254}@[a-z][a-z0-9]{1,63}$/;

/** Trims and lower-cases a UPI id. UPI ids are not case-sensitive, and apps show them in lower case. */
export const normaliseUpiId = (raw: string): string => raw.trim().toLowerCase();

/**
 * Refuses a UPI id that no app could pay to.
 *
 * It throws rather than saving it anyway, because a wrong id on the bill sends the customer's
 * payment attempt nowhere — or, worse, to a stranger whose id happens to match the mistake.
 */
export const validateUpiId = (raw: string): string => {
  const id = normaliseUpiId(raw);
  if (!id.includes('@')) {
    throw invalid('UPI_ID_NO_AT', 'A UPI id has an @ in it, like sharmafruits@okicici. You can find yours in your UPI app, under your profile.');
  }
  if (!UPI_ID.test(id)) {
    throw invalid('UPI_ID_NOT_VALID', 'That does not look like a UPI id. It should look like sharmafruits@okicici — letters or digits, an @, then your bank or app’s name.');
  }
  return id;
};

/**
 * What is still owed on this bill.
 *
 * The outstanding figure is used when the bill carries one, because that is the figure the business
 * has already worked out. Otherwise it is the total less whatever was paid at the counter.
 */
export const amountDue = (doc: InvoiceDocument): Money => {
  const { totals } = doc;
  if (totals.outstanding != null) return totals.outstanding;
  if (totals.amountPaid != null) return subtract(totals.invoiceValue, totals.amountPaid);
  return totals.invoiceValue;
};

/** Whether this bill is one a customer could pay from at all, whatever the paper. */
export const billHasSomethingToPay = (doc: InvoiceDocument): boolean =>
  doc.title !== 'CREDIT_NOTE' && amountDue(doc).minor > 0n;

/** Whether the paper has room for a square a phone can read. */
export const paperFitsUpiSquare = (format: PageFormat): boolean => format !== 'THERMAL_58MM';

/** Keeps the characters a UPI app reads literally, and percent-encodes the rest. */
const encode = (value: string): string => encodeURIComponent(value).replace(/%40/g, '@');

/**
 * The UPI payment link the square carries.
 *
 *  - `pa` — the business's UPI id, where the money goes.
 *  - `pn` — the business's name, which the customer's app shows so they can see who they are paying.
 *  - `am` — the amount still due, in rupees with two decimals. The app fills it in.
 *  - `cu` — always INR.
 *  - `tn` — the bill number. It lands on both the customer's and the business's payment record, so
 *    a payment can be matched to its bill without anyone asking which one it was for.
 */
export const upiPaymentLink = (upiId: string, payeeName: string, amount: Money, billNumber: string): string =>
  `upi://pay?pa=${encode(validateUpiId(upiId))}&pn=${encode(payeeName.trim().slice(0, 99))}&am=${toDecimalString(amount)}&cu=INR&tn=${encode(billNumber)}`;

/** The square itself, as an SVG, for a bill whose business has saved a UPI id. */
export const upiSquareSvg = (doc: InvoiceDocument, upiId: string): string =>
  qrSvg(upiPaymentLink(upiId, doc.seller.name, amountDue(doc), doc.number), `UPI payment to ${upiId}`);
