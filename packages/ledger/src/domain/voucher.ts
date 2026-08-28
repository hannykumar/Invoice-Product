/** Issue #4 [E04] — vouchers and journal lines, and the invariants that make them a ledger. */
import type {
  AccountId,
  BranchId,
  CompanyId,
  IsoDate,
  JournalLineId,
  Money,
  PartyId,
  UserId,
  VoucherId,
} from '@invoice/kernel';

/** See docs/product/spec/states.json, machine `voucher`. */
export type VoucherState = 'DRAFT' | 'FINAL' | 'REVERSED';

/**
 * The primitives every business document eventually becomes. Sales and purchase documents are
 * owned by other issues; what reaches the ledger is one of these.
 */
export type VoucherType =
  | 'SALE'
  | 'PURCHASE'
  | 'RECEIPT'
  | 'PAYMENT'
  | 'JOURNAL'
  | 'CREDIT_NOTE'
  | 'DEBIT_NOTE'
  | 'OPENING_BALANCE'
  | 'REVERSAL';

export const VOUCHER_TYPES: readonly VoucherType[] = [
  'SALE',
  'PURCHASE',
  'RECEIPT',
  'PAYMENT',
  'JOURNAL',
  'CREDIT_NOTE',
  'DEBIT_NOTE',
  'OPENING_BALANCE',
  'REVERSAL',
];

/** The permission required to post each voucher type, enforced server-side by issue #3. */
export const POST_PERMISSION: Record<VoucherType, string> = {
  SALE: 'ledger.post.sale',
  PURCHASE: 'ledger.post.purchase',
  RECEIPT: 'ledger.post.receipt',
  PAYMENT: 'ledger.post.payment',
  JOURNAL: 'ledger.post.journal',
  CREDIT_NOTE: 'ledger.post.credit_note',
  DEBIT_NOTE: 'ledger.post.debit_note',
  OPENING_BALANCE: 'ledger.post.opening_balance',
  REVERSAL: 'ledger.reverse',
};

/** Where this voucher came from, so any figure can be traced back to a real document. */
export interface SourceDocument {
  /** e.g. "sales_invoice", "purchase_invoice", "payment", "import_batch". */
  readonly kind: string;
  readonly id: string;
  /** The number a person would recognise, e.g. "INV/KB/2026-27/00042". */
  readonly number: string | null;
}

export interface JournalLine {
  readonly id: JournalLineId;
  readonly voucherId: VoucherId;
  readonly lineNo: number;
  readonly accountId: AccountId;
  /** Set when the line belongs to a specific customer or supplier. */
  readonly partyId: PartyId | null;
  readonly debit: Money;
  readonly credit: Money;
  readonly narration: string | null;
}

export interface Voucher {
  readonly id: VoucherId;
  readonly companyId: CompanyId;
  readonly branchId: BranchId | null;
  readonly type: VoucherType;
  /** Internal sequence per company, type and financial year, e.g. "SALE/2026-27/000012". */
  readonly number: string;
  /** The date that decides the fiscal period, the tax period and which rules applied. */
  readonly date: IsoDate;
  readonly state: VoucherState;
  readonly narration: string | null;
  readonly source: SourceDocument | null;
  readonly lines: readonly JournalLine[];
  readonly idempotencyKey: string;
  readonly createdBy: UserId;
  readonly createdAt: string;
  /** Set on the original when it has been reversed. */
  readonly reversedByVoucherId: VoucherId | null;
  /** Set on a REVERSAL voucher, pointing at what it undid. */
  readonly reversesVoucherId: VoucherId | null;
  /** Set on the replacement voucher of an amendment. */
  readonly amendsVoucherId: VoucherId | null;
  /** Why a final record was reversed or amended. Never optional in practice. */
  readonly reason: string | null;
}

export const isFinal = (v: Voucher): boolean => v.state === 'FINAL';
export const isReversed = (v: Voucher): boolean => v.state === 'REVERSED';

/** A final voucher may never be edited or deleted; this is the check every writer calls. */
export const isImmutable = (v: Voucher): boolean => v.state !== 'DRAFT';
