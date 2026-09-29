/**
 * Issue #20 [E20] — money in and money out.
 *
 * The rule that shapes everything here: **a bill is paid when the money has been received and
 * applied to it, not before.** A cheque that has not cleared is not bank balance. A payment that
 * has not been matched to a bill is not a settled bill. Money that arrived without an invoice sits
 * visibly on account rather than being attached to whichever bill looks closest.
 */
import type { BranchId, CompanyId, IsoDate, Money, PartyId, UserId, VoucherId } from '@invoice/kernel';

export type Direction = 'RECEIPT' | 'PAYMENT';

export type PaymentMode = 'CASH' | 'CHEQUE' | 'BANK_TRANSFER' | 'UPI' | 'CARD' | 'OTHER';

/** See docs/product/spec/states.json, machine `cheque`. */
export type ChequeState = 'PENDING' | 'DEPOSITED' | 'CLEARED' | 'BOUNCED' | 'CANCELLED';

/** See docs/product/spec/states.json, machine `payment`. */
export type PaymentState = 'RECORDED' | 'REVERSED';

/**
 * One step in a cheque's life, kept for ever.
 *
 * "Cheque status changes do not lose history" is an acceptance criterion, so the state is not a
 * column that gets overwritten — it is the last entry in a list nobody removes from.
 */
export interface ChequeEvent {
  readonly state: ChequeState;
  readonly on: IsoDate;
  readonly by: UserId;
  readonly at: string;
  readonly note: string | null;
}

export interface ChequeDetails {
  readonly number: string;
  readonly chequeDate: IsoDate;
  readonly bankName: string | null;
  readonly history: readonly ChequeEvent[];
}

export const currentChequeState = (cheque: ChequeDetails): ChequeState =>
  (cheque.history.at(-1) as ChequeEvent).state;

/** What a payment settles, and by how much. */
export interface Allocation {
  readonly documentId: string;
  readonly documentNumber: string;
  readonly amount: Money;
  /**
   * Issue #274 — set when an advance paid to a supplier was later adjusted against this bill, rather
   * than the bill being paid by this payment when it was made. The payment voucher prints these as
   * "Adjusted against bill", and the ones without it as bills settled at the time.
   */
  readonly adjustedFromAdvance?: boolean;
}

/** Issue #274 — a document number and its date, as a voucher prints a reference to it. */
export interface DocumentReference {
  readonly number: string;
  readonly date: IsoDate;
}

/**
 * Issue #274 — what an advance to a supplier is paid against, as a payment voucher records it.
 * `purchaseOrder` null means there is no purchase order: the advance is against goods to be supplied.
 * `supplierReceiptVoucher` is the receipt voucher the supplier issues on receiving an advance
 * (CGST Act section 31(3)(d), CGST Rule 50); null when it has not been received or not entered.
 */
export interface AdvanceParticulars {
  readonly purchaseOrder: DocumentReference | null;
  readonly supplierReceiptVoucher: DocumentReference | null;
}

export interface Payment {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly branchId: BranchId | null;
  readonly direction: Direction;
  readonly partyId: PartyId;
  readonly mode: PaymentMode;
  readonly amount: Money;
  readonly date: IsoDate;
  /** UTR, UPI reference, receipt book number — whatever the business will look for later. */
  readonly reference: string | null;
  /** Set for a bank transfer, a card or a cleared cheque. */
  readonly bankAccountCode: string | null;
  readonly cheque: ChequeDetails | null;
  readonly allocations: readonly Allocation[];
  /**
   * Issue #165 — set on money paid back to a customer out of an earlier receipt that no bill used,
   * such as a refunded advance. It returns money held on account, so it lowers that figure rather
   * than counting as a second amount on account.
   */
  readonly refundOf: string | null;
  /**
   * Issue #261 — money paid to a supplier before their bill, chosen as an advance by a person. The
   * part no bill has claimed sits in "Advances paid to suppliers" (something the business owns), not
   * in the supplier's account as a negative amount owed. It is set against their next bill with
   * `ReceivablesService.useSupplierAdvance`, which moves it across in the books. Absent means false.
   */
  readonly advanceToSupplier?: boolean;
  /** Issue #274 — what the advance was paid against. Only on an advance to a supplier. */
  readonly advanceParticulars?: AdvanceParticulars;
  readonly state: PaymentState;
  readonly voucherId: VoucherId | null;
  /** Set when a cheque bounced or the payment was undone: the entry that reversed it. */
  readonly reversalVoucherId: VoucherId | null;
  readonly reversalReason: string | null;
  readonly narration: string | null;
  readonly recordedBy: UserId;
  readonly recordedAt: string;
  readonly idempotencyKey: string;
  readonly version: number;
}

/** A bill or note that can be settled. Supplied by #9 for sales and #17 for purchases. */
export type DocumentKind = 'SALES_INVOICE' | 'PURCHASE_INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE';

export interface OpenDocument {
  readonly documentId: string;
  readonly kind: DocumentKind;
  readonly number: string;
  readonly partyId: PartyId;
  readonly date: IsoDate;
  readonly dueDate: IsoDate | null;
  readonly value: Money;
  /** `RECEIVABLE` means the customer owes us; `PAYABLE` means we owe them. */
  readonly side: 'RECEIVABLE' | 'PAYABLE';
}

export interface DocumentPosition {
  readonly document: OpenDocument;
  readonly allocated: Money;
  readonly outstanding: Money;
  /** Days past the due date on the day the position was worked out. Negative means not yet due. */
  readonly daysOverdue: number;
  readonly status: 'OPEN' | 'PARTLY_PAID' | 'SETTLED' | 'WRITTEN_OFF';
}

export interface PartyPosition {
  readonly partyId: PartyId;
  readonly documents: readonly DocumentPosition[];
  readonly totalOutstanding: Money;
  /** Money received that no bill has claimed yet. Visible, never guessed at. */
  readonly onAccount: Money;
  /**
   * Issue #261 — money paid to this supplier in advance that no bill of theirs has used yet. Kept
   * apart from what is owed: it is never subtracted from a bill until a person sets it against one.
   */
  readonly advancesPaid: Money;
  /** Cheques taken but not yet cleared. Not bank balance, and shown separately for that reason. */
  readonly chequesNotCleared: Money;
}

export const RECEIVABLES_PERMISSIONS = {
  record: 'payments.record',
  allocate: 'payments.allocate',
  reverse: 'payments.reverse',
  writeOff: 'payments.write_off',
} as const;
