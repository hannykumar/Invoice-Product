/** Issue #4 [E04] — accounts and what their type means. */
import type { AccountId, CompanyId, PartyId } from '@invoice/kernel';

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';

export type Side = 'DEBIT' | 'CREDIT';

/**
 * The side on which an account normally carries a balance. This is what lets a balance be
 * presented as a positive number in a report instead of a signed figure the owner must interpret.
 */
export const normalSide = (type: AccountType): Side =>
  type === 'ASSET' || type === 'EXPENSE' ? 'DEBIT' : 'CREDIT';

export const appearsInProfitAndLoss = (type: AccountType): boolean => type === 'INCOME' || type === 'EXPENSE';
export const appearsInBalanceSheet = (type: AccountType): boolean => !appearsInProfitAndLoss(type);

/**
 * Accounts the engine must be able to find by role rather than by name, because the name is the
 * business's to change and the role is the product's to rely on.
 */
export type SystemAccountRole =
  | 'ROUND_OFF'
  | 'OPENING_BALANCE_DIFFERENCE'
  | 'RETAINED_EARNINGS'
  | 'CASH_IN_HAND'
  | 'CHEQUES_IN_HAND'
  | 'TRADE_RECEIVABLES'
  | 'TRADE_PAYABLES'
  | 'SALES_GOODS'
  | 'SALES_SERVICES'
  | 'SALES_RETURNS'
  | 'BAD_DEBTS'
  | 'PURCHASES_GOODS'
  | 'PURCHASE_RETURNS'
  | 'OUTPUT_CGST'
  | 'OUTPUT_SGST'
  | 'OUTPUT_IGST'
  | 'OUTPUT_CESS'
  | 'INPUT_CGST'
  | 'INPUT_SGST'
  | 'INPUT_IGST'
  | 'INPUT_CESS'
  | 'STOCK_IN_HAND'
  | 'FREIGHT_OUTWARD'
  | 'DISCOUNT_ALLOWED';

export interface Account {
  readonly id: AccountId;
  readonly companyId: CompanyId;
  /** Stable within a company, shown in reports, chosen by the business. */
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly parentId: AccountId | null;
  /** A group holds other accounts and can never be posted to directly. */
  readonly isGroup: boolean;
  readonly active: boolean;
  /** Set when this account is one party's own account, so party balances derive from lines. */
  readonly partyId: PartyId | null;
  readonly systemRole: SystemAccountRole | null;
}
