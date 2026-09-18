/**
 * Issue #9 [E09] — turning a priced invoice into ledger lines.
 *
 * This is the "posting template" the ledger contract deliberately does not own: deciding that a
 * sale debits the customer and credits income and output tax belongs to the module that owns the
 * document. The ledger then checks that what it is given balances.
 */
import { add, isZero, invalid, subtract, sum, zero, type AccountId, type Money } from '@invoice/kernel';
import type { AccountRepository } from '@invoice/ledger';
import type { CompanyId, PartyId } from '@invoice/kernel';
import type { InvoicePricing } from './model.ts';

export interface PostingLineOut {
  readonly accountId: AccountId;
  readonly partyId: string | null;
  readonly debit: Money;
  readonly credit: Money;
  readonly narration: string | null;
}

const nil = (): Money => zero('INR');

/**
 * Builds the entry for a final sale:
 *
 * ```
 *   Customer                        debit   invoice value
 *     Sales of goods or services   credit   taxable value
 *     Output CGST / SGST / UTGST / IGST / cess
 *     Rounding difference          credit   the few paise
 * ```
 *
 * Reverse-charge lines are the exception: the customer pays that GST to the government directly,
 * so it is neither charged to them nor recorded as our liability. `TaxTotals` already excludes it.
 */
export const buildSalePosting = async (
  accounts: AccountRepository,
  companyId: CompanyId,
  partyId: PartyId,
  supplyKind: 'GOODS' | 'SERVICES',
  pricing: InvoicePricing,
): Promise<PostingLineOut[]> => {
  const need = async (role: string): Promise<AccountId> => {
    const account = await accounts.findBySystemRole(companyId, role);
    if (account === null) {
      throw invalid(
        'SALES_ACCOUNT_MISSING',
        `This business has no account set up for ${role.toLowerCase().replace(/_/g, ' ')}, so the bill cannot be recorded.`,
        { details: { role } },
      );
    }
    return account.id;
  };

  const customerAccount = await accounts.findByPartyId(companyId, partyId);
  if (customerAccount === null) {
    throw invalid(
      'SALES_CUSTOMER_ACCOUNT_MISSING',
      'This customer does not have an account in your books yet, so the bill cannot be recorded.',
    );
  }

  const totals = pricing.totals;
  const lines: PostingLineOut[] = [];

  lines.push({
    accountId: customerAccount.id,
    partyId,
    debit: totals.invoiceValue,
    credit: nil(),
    narration: 'Amount the customer owes for this bill',
  });

  const incomeRole = supplyKind === 'GOODS' ? 'SALES_GOODS' : 'SALES_SERVICES';
  lines.push({
    accountId: await need(incomeRole),
    partyId: null,
    debit: nil(),
    credit: totals.taxableValue,
    narration: 'Sales',
  });

  const taxes: [Money, string][] = [
    [totals.cgst, 'OUTPUT_CGST'],
    [totals.sgst, 'OUTPUT_SGST'],
    [totals.utgst, 'OUTPUT_SGST'],
    [totals.igst, 'OUTPUT_IGST'],
    [totals.cess, 'OUTPUT_CESS'],
  ];
  // UTGST shares the SGST account role in the seeded chart, whose name covers both.
  const merged = new Map<string, Money>();
  for (const [amount, role] of taxes) {
    if (isZero(amount)) continue;
    merged.set(role, add(merged.get(role) ?? nil(), amount));
  }
  for (const [role, amount] of [...merged.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push({
      accountId: await need(role),
      partyId: null,
      debit: nil(),
      credit: amount,
      narration: 'GST collected',
    });
  }

  if (!isZero(totals.roundOff)) {
    const roundOffAccount = await need('ROUND_OFF');
    const positive = totals.roundOff.minor > 0n;
    lines.push({
      accountId: roundOffAccount,
      partyId: null,
      debit: positive ? nil() : { currency: 'INR', minor: -totals.roundOff.minor },
      credit: positive ? totals.roundOff : nil(),
      narration: 'Rounded to a neat total',
    });
  }

  // A last check before the ledger's: if this does not balance, the fault is in this template and
  // the message should say so rather than blaming the user's input.
  const debits = sum(lines.map((l) => l.debit));
  const credits = sum(lines.map((l) => l.credit));
  if (!isZero(subtract(debits, credits))) {
    throw invalid(
      'SALES_POSTING_UNBALANCED',
      'The bill could not be recorded because its parts do not add up. Nothing has been saved.',
    );
  }
  return lines;
};
