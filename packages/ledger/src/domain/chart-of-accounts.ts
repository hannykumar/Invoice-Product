/**
 * Issue #4 [E04] — the India-ready default chart of accounts.
 *
 * A new business gets a chart it can already use, in words it already knows. Every account a rule
 * or a posting template needs to find carries a `systemRole`, so renaming "Cash in hand" to
 * "Gulla" never breaks a posting.
 */
import { asId, type AccountId, type CompanyId } from '@invoice/kernel';
import type { Account, AccountType, SystemAccountRole } from './account.ts';

export interface SeedAccount {
  code: string;
  name: string;
  type: AccountType;
  parentCode: string | null;
  isGroup: boolean;
  systemRole: SystemAccountRole | null;
}

/** Groups are headings; only leaves can be posted to. Codes are stable and are used in reports. */
export const DEFAULT_CHART: readonly SeedAccount[] = [
  { code: '1000', name: 'What the business owns', type: 'ASSET', parentCode: null, isGroup: true, systemRole: null },
  { code: '1100', name: 'Cash and bank', type: 'ASSET', parentCode: '1000', isGroup: true, systemRole: null },
  { code: '1110', name: 'Cash in hand', type: 'ASSET', parentCode: '1100', isGroup: false, systemRole: 'CASH_IN_HAND' },
  { code: '1120', name: 'Bank accounts', type: 'ASSET', parentCode: '1100', isGroup: true, systemRole: null },
  { code: '1130', name: 'Cheques received, not yet cleared', type: 'ASSET', parentCode: '1100', isGroup: false, systemRole: 'CHEQUES_IN_HAND' },
  { code: '1200', name: 'Money customers owe you', type: 'ASSET', parentCode: '1000', isGroup: true, systemRole: 'TRADE_RECEIVABLES' },
  { code: '1300', name: 'Stock in hand', type: 'ASSET', parentCode: '1000', isGroup: false, systemRole: 'STOCK_IN_HAND' },
  { code: '1400', name: 'GST you already paid on purchases', type: 'ASSET', parentCode: '1000', isGroup: true, systemRole: null },
  { code: '1410', name: 'Input CGST', type: 'ASSET', parentCode: '1400', isGroup: false, systemRole: 'INPUT_CGST' },
  { code: '1420', name: 'Input SGST or UTGST', type: 'ASSET', parentCode: '1400', isGroup: false, systemRole: 'INPUT_SGST' },
  { code: '1430', name: 'Input IGST', type: 'ASSET', parentCode: '1400', isGroup: false, systemRole: 'INPUT_IGST' },
  { code: '1440', name: 'Input cess', type: 'ASSET', parentCode: '1400', isGroup: false, systemRole: 'INPUT_CESS' },

  { code: '2000', name: 'What the business owes', type: 'LIABILITY', parentCode: null, isGroup: true, systemRole: null },
  { code: '2100', name: 'Money you owe suppliers', type: 'LIABILITY', parentCode: '2000', isGroup: true, systemRole: 'TRADE_PAYABLES' },
  { code: '2200', name: 'GST you collected', type: 'LIABILITY', parentCode: '2000', isGroup: true, systemRole: null },
  { code: '2210', name: 'Output CGST', type: 'LIABILITY', parentCode: '2200', isGroup: false, systemRole: 'OUTPUT_CGST' },
  { code: '2220', name: 'Output SGST or UTGST', type: 'LIABILITY', parentCode: '2200', isGroup: false, systemRole: 'OUTPUT_SGST' },
  { code: '2230', name: 'Output IGST', type: 'LIABILITY', parentCode: '2200', isGroup: false, systemRole: 'OUTPUT_IGST' },
  { code: '2240', name: 'Output cess', type: 'LIABILITY', parentCode: '2200', isGroup: false, systemRole: 'OUTPUT_CESS' },

  { code: '3000', name: "The owner's money in the business", type: 'EQUITY', parentCode: null, isGroup: true, systemRole: null },
  { code: '3100', name: 'Capital', type: 'EQUITY', parentCode: '3000', isGroup: false, systemRole: null },
  { code: '3200', name: 'Profit kept in the business', type: 'EQUITY', parentCode: '3000', isGroup: false, systemRole: 'RETAINED_EARNINGS' },
  { code: '3900', name: 'Opening balance difference', type: 'EQUITY', parentCode: '3000', isGroup: false, systemRole: 'OPENING_BALANCE_DIFFERENCE' },

  { code: '4000', name: 'Money coming in', type: 'INCOME', parentCode: null, isGroup: true, systemRole: null },
  { code: '4100', name: 'Sales of goods', type: 'INCOME', parentCode: '4000', isGroup: false, systemRole: 'SALES_GOODS' },
  { code: '4200', name: 'Sales of services', type: 'INCOME', parentCode: '4000', isGroup: false, systemRole: 'SALES_SERVICES' },
  { code: '4900', name: 'Rounding difference', type: 'INCOME', parentCode: '4000', isGroup: false, systemRole: 'ROUND_OFF' },

  { code: '5000', name: 'Money going out', type: 'EXPENSE', parentCode: null, isGroup: true, systemRole: null },
  { code: '5100', name: 'Purchases of goods', type: 'EXPENSE', parentCode: '5000', isGroup: false, systemRole: 'PURCHASES_GOODS' },
  { code: '5150', name: 'Goods returned to suppliers', type: 'EXPENSE', parentCode: '5000', isGroup: false, systemRole: 'PURCHASE_RETURNS' },
  { code: '5200', name: 'Goods returned by customers', type: 'EXPENSE', parentCode: '5000', isGroup: false, systemRole: 'SALES_RETURNS' },
  { code: '5300', name: 'Freight paid on sales', type: 'EXPENSE', parentCode: '5000', isGroup: false, systemRole: 'FREIGHT_OUTWARD' },
  { code: '5400', name: 'Discount given', type: 'EXPENSE', parentCode: '5000', isGroup: false, systemRole: 'DISCOUNT_ALLOWED' },
  { code: '5500', name: 'Money we could not collect', type: 'EXPENSE', parentCode: '5000', isGroup: false, systemRole: 'BAD_DEBTS' },
  { code: '5900', name: 'Other business costs', type: 'EXPENSE', parentCode: '5000', isGroup: false, systemRole: null },
];

/** Builds the seed as real accounts for one company. Ids are deterministic per company. */
export const buildDefaultChart = (companyId: CompanyId, idFor: (code: string) => AccountId): Account[] => {
  const byCode = new Map<string, AccountId>(DEFAULT_CHART.map((a) => [a.code, idFor(a.code)]));
  return DEFAULT_CHART.map((a) => ({
    id: byCode.get(a.code) as AccountId,
    companyId,
    code: a.code,
    name: a.name,
    type: a.type,
    parentId: a.parentCode === null ? null : (byCode.get(a.parentCode) as AccountId),
    isGroup: a.isGroup,
    active: true,
    partyId: null,
    systemRole: a.systemRole,
  }));
};

export const defaultChartIdFactory = (companyId: CompanyId) => (code: string): AccountId =>
  asId<'Account'>(`${companyId}:acc:${code}`);
