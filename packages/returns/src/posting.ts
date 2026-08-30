import { add, invalid, isZero, subtract, sum, zero, type AccountId, type CompanyId, type Money, type PartyId } from '@invoice/kernel';
import type { AccountRepository } from '@invoice/ledger';
import type { ReturnTaxAmounts } from './model.ts';

export interface ReturnPostingLine {
  readonly accountId: AccountId;
  readonly partyId: PartyId | null;
  readonly debit: Money;
  readonly credit: Money;
  readonly narration: string;
}

const nil = (): Money => zero('INR');

export const buildSalesReturnPosting = async (
  accounts: AccountRepository,
  companyId: CompanyId,
  partyId: PartyId,
  totals: ReturnTaxAmounts,
): Promise<ReturnPostingLine[]> => {
  const need = async (role: string): Promise<AccountId> => {
    const account = await accounts.findBySystemRole(companyId, role);
    if (account === null) throw invalid('RETURN_ACCOUNT_MISSING', `There is no account set up for ${role.toLowerCase().replace(/_/g, ' ')}.`);
    return account.id;
  };
  const customer = await accounts.findByPartyId(companyId, partyId);
  if (customer === null) throw invalid('RETURN_PARTY_ACCOUNT_MISSING', 'This customer does not have an account in the books.');

  const lines: ReturnPostingLine[] = [{
    accountId: await need('SALES_RETURNS'), partyId: null,
    debit: totals.taxableValue, credit: nil(), narration: 'Goods or services returned by the customer',
  }];
  const taxes: readonly [Money, string][] = [
    [totals.cgst, 'OUTPUT_CGST'], [add(totals.sgst, totals.utgst), 'OUTPUT_SGST'],
    [totals.igst, 'OUTPUT_IGST'], [totals.cess, 'OUTPUT_CESS'],
  ];
  for (const [amount, role] of taxes) {
    if (!isZero(amount)) lines.push({ accountId: await need(role), partyId: null, debit: amount, credit: nil(), narration: 'GST reduced for the returned supply' });
  }
  lines.push({ accountId: customer.id, partyId, debit: nil(), credit: totals.total, narration: 'Credit given to the customer' });

  const difference = subtract(sum(lines.map((line) => line.debit)), sum(lines.map((line) => line.credit)));
  if (!isZero(difference)) {
    throw invalid('RETURN_POSTING_UNBALANCED', 'The return amounts do not add up, so nothing has been recorded.');
  }
  return lines;
};

export const buildPurchaseReturnPosting = async (
  accounts: AccountRepository,
  companyId: CompanyId,
  partyId: PartyId,
  totals: ReturnTaxAmounts,
): Promise<ReturnPostingLine[]> => {
  const need = async (role: string): Promise<AccountId> => {
    const account = await accounts.findBySystemRole(companyId, role);
    if (account === null) throw invalid('RETURN_ACCOUNT_MISSING', `There is no account set up for ${role.toLowerCase().replace(/_/g, ' ')}.`);
    return account.id;
  };
  const supplier = await accounts.findByPartyId(companyId, partyId);
  if (supplier === null) throw invalid('RETURN_PARTY_ACCOUNT_MISSING', 'This supplier does not have an account in the books.');
  const lines: ReturnPostingLine[] = [{
    accountId: supplier.id, partyId, debit: totals.total, credit: nil(), narration: 'Amount no longer owed to the supplier',
  }];
  if (!isZero(totals.reverseChargeTax)) {
    lines.push({ accountId: await need('REVERSE_CHARGE_PAYABLE'), partyId: null, debit: totals.reverseChargeTax, credit: nil(), narration: 'Reverse-charge GST liability reduced' });
  }
  const returnedCost = add(totals.taxableValue, totals.ineligibleTax);
  if (!isZero(returnedCost)) {
    lines.push({ accountId: await need('PURCHASE_RETURNS'), partyId: null, debit: nil(), credit: returnedCost, narration: 'Goods or services returned to the supplier' });
  }
  const taxes: readonly [Money, string][] = [
    [totals.cgst, 'INPUT_CGST'], [add(totals.sgst, totals.utgst), 'INPUT_SGST'],
    [totals.igst, 'INPUT_IGST'], [totals.cess, 'INPUT_CESS'],
  ];
  for (const [amount, role] of taxes) {
    if (!isZero(amount)) lines.push({ accountId: await need(role), partyId: null, debit: nil(), credit: amount, narration: 'Input GST reduced for the returned purchase' });
  }
  const difference = subtract(sum(lines.map((line) => line.debit)), sum(lines.map((line) => line.credit)));
  if (!isZero(difference)) {
    const roundOff = await need('ROUND_OFF');
    lines.push({
      accountId: roundOff, partyId: null,
      debit: difference.minor < 0n ? { ...difference, minor: -difference.minor } : nil(),
      credit: difference.minor > 0n ? difference : nil(), narration: 'Rounding from the original supplier bill',
    });
  }
  const finalDifference = subtract(sum(lines.map((line) => line.debit)), sum(lines.map((line) => line.credit)));
  if (!isZero(finalDifference)) throw invalid('RETURN_POSTING_UNBALANCED', 'The purchase return amounts do not add up, so nothing has been recorded.');
  return lines;
};
