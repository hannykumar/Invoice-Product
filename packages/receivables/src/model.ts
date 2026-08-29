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
  /** Cheques taken but not yet cleared. Not bank balance, and shown separately for that reason. */
  readonly chequesNotCleared: Money;
}

export const RECEIVABLES_PERMISSIONS = {
  record: 'payments.record',
  allocate: 'payments.allocate',
  reverse: 'payments.reverse',
  writeOff: 'payments.write_off',
} as const;
