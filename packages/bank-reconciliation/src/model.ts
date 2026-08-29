import type { Payment } from '@invoice/receivables';

/** Published subset of the bank-import record consumed here. */
export interface ImportedBankTransaction {
  readonly id: string;
  readonly companyId: string;
  readonly bookedOn: string;
  readonly description: string;
  readonly debitPaise: bigint;
  readonly creditPaise: bigint;
  readonly reference?: string;
  readonly fingerprint: string;
}

export type ReconciliationDirection = 'RECEIPT' | 'PAYMENT';
export type ReconciliationStatus = 'AUTO_MATCHED' | 'SUGGESTED' | 'CONFIRMED' | 'UNMATCHED';

export interface ReconciliationContext {
  readonly companyId: string;
  readonly actorId: string;
  readonly permissions: ReadonlySet<string>;
}

export interface BankLine {
  readonly id: string;
  readonly companyId: string;
  readonly bookedOn: string;
  readonly direction: ReconciliationDirection;
  readonly amountPaise: bigint;
  readonly description: string;
  readonly reference: string | null;
  readonly fingerprint: string;
}

export interface BookPayment {
  readonly id: string;
  readonly companyId: string;
  readonly direction: ReconciliationDirection;
  readonly amountPaise: bigint;
  readonly date: string;
  readonly reference: string | null;
}

export interface MatchCandidate {
  readonly id: string;
  readonly companyId: string;
  readonly bankTransactionIds: readonly string[];
  readonly paymentIds: readonly string[];
  readonly confidence: number;
  readonly amountDifferencePaise: bigint;
  readonly reasons: readonly string[];
}

export interface ReconciliationMatch extends MatchCandidate {
  readonly status: ReconciliationStatus;
  readonly remainingBankPaise: bigint;
  readonly remainingBookPaise: bigint;
  readonly confirmedBy: string | null;
  readonly confirmedAt: string | null;
}

export type ReconciliationExceptionKind =
  | 'AMBIGUOUS'
  | 'MISSING_BOOK'
  | 'MISSING_BANK'
  | 'WRONG_DATE'
  | 'DUPLICATE_BANK_TRANSACTION'
  | 'POSSIBLE_REVERSAL';

export interface ReconciliationException {
  readonly id: string;
  readonly companyId: string;
  readonly kind: ReconciliationExceptionKind;
  readonly bankTransactionIds: readonly string[];
  readonly paymentIds: readonly string[];
  readonly summary: string;
  readonly candidateIds: readonly string[];
}

export interface SuggestedPaymentCreation {
  readonly bankTransactionId: string;
  readonly direction: ReconciliationDirection;
  readonly amountPaise: bigint;
  readonly date: string;
  readonly reference: string | null;
  readonly narration: string;
}

export interface ReconciliationRun {
  readonly companyId: string;
  readonly candidates: readonly MatchCandidate[];
  readonly matches: readonly ReconciliationMatch[];
  readonly exceptions: readonly ReconciliationException[];
  readonly suggestedPayments: readonly SuggestedPaymentCreation[];
}

export interface ReconciliationAuditEvent {
  readonly id: string;
  readonly companyId: string;
  readonly actorId: string;
  readonly action: 'reconciliation.auto_matched' | 'reconciliation.confirmed' | 'reconciliation.unmatched';
  readonly matchId: string;
  readonly occurredAt: string;
  readonly reason: string | null;
}

export const fromBankTransaction = (transaction: ImportedBankTransaction): BankLine => ({
  id: transaction.id,
  companyId: transaction.companyId,
  bookedOn: transaction.bookedOn,
  direction: transaction.creditPaise > 0n ? 'RECEIPT' : 'PAYMENT',
  amountPaise: transaction.creditPaise > 0n ? transaction.creditPaise : transaction.debitPaise,
  description: transaction.description,
  reference: transaction.reference ?? null,
  fingerprint: transaction.fingerprint,
});

/** Cash and uncleared cheques are intentionally absent from bank reconciliation. */
export const fromPayment = (payment: Payment): BookPayment | null =>
  payment.state !== 'RECORDED' || payment.bankAccountCode === null
    ? null
    : {
        id: payment.id,
        companyId: payment.companyId,
        direction: payment.direction,
        amountPaise: payment.amount.minor,
        date: payment.date,
        reference: payment.reference,
      };
