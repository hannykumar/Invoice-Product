/**
 * Issue #20 [E20] — turning money into ledger lines.
 *
 * The distinction that matters: **a cheque in hand is not bank balance.** It is an asset the
 * business holds, and it becomes bank balance only when it clears. Collapsing the two is how a
 * shopkeeper discovers a bounced cheque by looking at a bank statement three weeks later.
 */
import { invalid, isZero, subtract, sum, zero, type AccountId, type Money, type PartyId } from '@invoice/kernel';
import type { AccountRepository } from '@invoice/ledger';
import type { CompanyId } from '@invoice/kernel';
import type { Direction, PaymentMode } from './model.ts';

export interface PostingLineOut {
  readonly accountId: AccountId;
  readonly partyId: string | null;
  readonly debit: Money;
  readonly credit: Money;
  readonly narration: string | null;
}

const nil = (): Money => zero('INR');

/**
 * Where the money physically sits, by how it arrived or left.
 *
 * Issue #230 — a cheque we are given waits in "cheques in hand" until it clears. A cheque we give a
 * supplier is drawn on our own bank account, so it comes out of that account: posting it against
 * cheques in hand would take money out of a drawer that never held it.
 */
export const settlementAccountRole = (mode: PaymentMode, direction: Direction = 'RECEIPT'): string | null => {
  switch (mode) {
    case 'CASH':
      return 'CASH_IN_HAND';
    case 'CHEQUE':
      // Deliberately not the bank. It is not there yet.
      return direction === 'RECEIPT' ? 'CHEQUES_IN_HAND' : null;
    case 'BANK_TRANSFER':
    case 'UPI':
    case 'CARD':
    case 'OTHER':
      return null;
  }
};

export const resolveAccounts = async (
  accounts: AccountRepository,
  companyId: CompanyId,
  partyId: PartyId,
  mode: PaymentMode,
  bankAccountCode: string | null,
  direction: Direction = 'RECEIPT',
): Promise<{ settlement: AccountId; party: AccountId }> => {
  const role = settlementAccountRole(mode, direction);
  let settlement: AccountId;
  if (role === null) {
    if (bankAccountCode === null) {
      throw invalid(
        'PAYMENT_BANK_ACCOUNT_REQUIRED',
        'Please say which bank account the money went into or came out of.',
      );
    }
    const account = await accounts.findByCode(companyId, bankAccountCode);
    if (account === null) {
      throw invalid('PAYMENT_BANK_ACCOUNT_UNKNOWN', `There is no account "${bankAccountCode}" in your books.`);
    }
    if (account.isGroup) {
      throw invalid('PAYMENT_BANK_ACCOUNT_IS_HEADING', `"${account.name}" is a heading, so money cannot go into it directly.`);
    }
    settlement = account.id;
  } else {
    const account = await accounts.findBySystemRole(companyId, role);
    if (account === null) {
      throw invalid(
        'PAYMENT_ACCOUNT_MISSING',
        'Your books do not have somewhere to record this kind of money yet.',
        { details: { role } },
      );
    }
    settlement = account.id;
  }

  const partyAccount = await accounts.findByPartyId(companyId, partyId);
  if (partyAccount === null) {
    throw invalid(
      'PAYMENT_PARTY_ACCOUNT_MISSING',
      'This customer or supplier does not have an account in your books yet.',
    );
  }
  return { settlement, party: partyAccount.id };
};

/**
 * Money in from a customer, or money out to a supplier.
 *
 * A receipt debits where the money went and credits the customer, which is what reduces what they
 * owe. **Which bill it settles is a separate question** — the allocation — because the customer's
 * balance falls the moment the money arrives, whether or not anyone has decided yet which invoice
 * it belongs to.
 */
export const buildPaymentPosting = (
  direction: Direction,
  settlement: AccountId,
  partyAccount: AccountId,
  partyId: PartyId,
  amount: Money,
  narration: string,
): PostingLineOut[] => {
  if (isZero(amount) || amount.minor < 0n) {
    throw invalid('PAYMENT_AMOUNT_NOT_POSITIVE', 'A payment needs an amount greater than zero.');
  }
  return direction === 'RECEIPT'
    ? [
        { accountId: settlement, partyId: null, debit: amount, credit: nil(), narration },
        { accountId: partyAccount, partyId, debit: nil(), credit: amount, narration: 'Reduces what the customer owes' },
      ]
    : [
        { accountId: partyAccount, partyId, debit: amount, credit: nil(), narration: 'Reduces what we owe' },
        { accountId: settlement, partyId: null, debit: nil(), credit: amount, narration },
      ];
};

/**
 * Issue #261 — money paid to a supplier, part of it (or all of it) before their bill.
 *
 * The part put against their bills reduces what we owe them, as any payment does. The rest is an
 * advance: something the business owns, a claim on goods still to come, so it goes to "Advances
 * paid to suppliers" and not into the supplier's account, where it would show up as a negative
 * amount owed hidden inside a total. It carries no GST and gives no input tax credit: for goods, no
 * tax is due on an advance, and the credit comes only with the supplier's tax invoice.
 */
export const buildSupplierAdvancePosting = (
  settlement: AccountId,
  partyAccount: AccountId,
  advancesAccount: AccountId,
  partyId: PartyId,
  againstBills: Money,
  advance: Money,
  narration: string,
): PostingLineOut[] => {
  if (advance.minor <= 0n || againstBills.minor < 0n) {
    throw invalid('PAYMENT_AMOUNT_NOT_POSITIVE', 'An advance needs an amount greater than zero.');
  }
  return [
    ...(againstBills.minor > 0n
      ? [{ accountId: partyAccount, partyId, debit: againstBills, credit: nil(), narration: 'Reduces what we owe' }]
      : []),
    { accountId: advancesAccount, partyId, debit: advance, credit: nil(), narration: 'Advance paid, to be taken off their next bill' },
    { accountId: settlement, partyId: null, debit: nil(), credit: sum([againstBills, advance]), narration },
  ];
};

/**
 * Issue #261 — an advance set against the supplier's bill. What we owe them falls by the amount
 * used, and the advance held falls by the same amount. No money moves and no tax changes.
 */
export const buildAdvanceUsePosting = (
  partyAccount: AccountId,
  advancesAccount: AccountId,
  partyId: PartyId,
  amount: Money,
  billNumber: string,
): PostingLineOut[] => [
  { accountId: partyAccount, partyId, debit: amount, credit: nil(), narration: `Advance taken off bill ${billNumber}` },
  { accountId: advancesAccount, partyId, debit: nil(), credit: amount, narration: `Advance taken off bill ${billNumber}` },
];

/** A cheque clearing moves it from "cheques in hand" into the bank. Nothing else changes. */
export const buildChequeClearingPosting = (
  bankAccount: AccountId,
  chequesInHand: AccountId,
  amount: Money,
  chequeNumber: string,
): PostingLineOut[] => [
  { accountId: bankAccount, partyId: null, debit: amount, credit: nil(), narration: `Cheque ${chequeNumber} cleared` },
  { accountId: chequesInHand, partyId: null, debit: nil(), credit: amount, narration: `Cheque ${chequeNumber} cleared` },
];

/**
 * Giving up on money a customer will not pay.
 *
 * It is an expense, not a disappearance: the customer's balance falls because the business bore
 * the loss, and the loss is visible in its own account.
 */
export const buildWriteOffPosting = (
  badDebts: AccountId,
  partyAccount: AccountId,
  partyId: PartyId,
  amount: Money,
  reason: string,
): PostingLineOut[] => [
  { accountId: badDebts, partyId: null, debit: amount, credit: nil(), narration: `Written off: ${reason}` },
  { accountId: partyAccount, partyId, debit: nil(), credit: amount, narration: `Written off: ${reason}` },
];

export const totalOf = (lines: readonly PostingLineOut[]): Money =>
  subtract(sum(lines.map((l) => l.debit)), sum(lines.map((l) => l.credit)));
