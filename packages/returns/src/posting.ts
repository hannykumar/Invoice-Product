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
