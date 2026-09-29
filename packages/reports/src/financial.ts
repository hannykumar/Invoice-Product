/**
 * Issue #35 [E35] — the trial balance, the profit and loss, and the balance sheet.
 *
 * All three are folds over the same one read of the books, so they cannot disagree with each
 * other. The trial balance is the check that the books hold together; the other two are that same
 * set of rows, split by what kind of account they belong to.
 *
 * Nothing here plugs a difference. If the two sides do not meet, the report says by how much and
 * shows the entries, because a balance sheet that always balances is a balance sheet that has
 * stopped telling you anything.
 */
import { formatINR, money, subtract, sum, zero, type Money } from '@invoice/kernel';
import { appearsInProfitAndLoss, normalSide, type Account, type AccountType, type Side, type SystemAccountRole } from '@invoice/ledger';
import {
  addFigures,
  emptyFigure,
  figureOf,
  subtractFigures,
  type Bilingual,
  type Figure,
} from './model.ts';
import { contributionOf, contributionsForAccount, type LoadedBooks } from './source.ts';

export interface AccountRow {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  /** What the product relies on this account for, when it relies on it for anything. */
  readonly systemRole: SystemAccountRole | null;
  readonly side: Side;
  /** Where this account stood when the period began. */
  readonly opening: Figure;
  /** What was put on each side during the period, before they were netted off. */
  readonly periodDebits: Figure;
  readonly periodCredits: Figure;
  /** What the period did to it: debits less credits, signed towards its normal side. */
  readonly movement: Figure;
  /** Where it stands on the closing date. Opening plus movement, and it is checked. */
  readonly closing: Figure;
}

const rowFor = (books: LoadedBooks, account: Account): AccountRow => {
  const side = normalSide(account.type);
  const opening = figureOf(contributionsForAccount(books.opening, account, side));
  const movement = figureOf(contributionsForAccount(books.movement, account, side));
  const closing = figureOf(contributionsForAccount(books.closing, account, side));
  const inPeriod = contributionsForAccount(books.movement, account, 'DEBIT');
  return {
    accountId: account.id,
    code: account.code,
    name: account.name,
    type: account.type,
    systemRole: account.systemRole,
    side,
    opening,
    periodDebits: figureOf(inPeriod.filter((c) => c.amount.minor > 0n)),
    periodCredits: figureOf(inPeriod.filter((c) => c.amount.minor < 0n).map((c) => ({ ...c, amount: money(-c.amount.minor) }))),
    movement,
    closing,
  };
};

/** Every postable account this company has actually used, in code order. */
export const accountRows = (books: LoadedBooks): AccountRow[] =>
  books.accounts
    .filter((a) => a.isGroup === false)
    .map((a) => rowFor(books, a))
    .filter((r) => r.opening.contributors.length > 0 || r.closing.contributors.length > 0)
    .sort((a, b) => a.code.localeCompare(b.code));

export interface TrialBalanceBody {
  readonly rows: readonly AccountRow[];
  readonly totalDebits: Figure;
  readonly totalCredits: Figure;
  /** Zero, or the books do not hold together and every other figure is suspect. */
  readonly difference: Money;
  readonly balanced: boolean;
}

export const trialBalanceBody = (books: LoadedBooks): TrialBalanceBody => {
  const rows = accountRows(books);
  // The totals are the two sides of every posting up to the closing date, exactly as
  // `@invoice/ledger`'s own trial balance sums them. Netting them per account first would hide the
  // one thing this report exists to prove.
  const posted = books.closing.map((entry) => ({ entry, debit: entry.line.debit, credit: entry.line.credit }));
  const totalDebits = figureOf(
    posted.filter((p) => p.debit.minor !== 0n).map((p) => contributionOf(p.entry, 'DEBIT')),
  );
  const totalCredits = figureOf(
    posted.filter((p) => p.credit.minor !== 0n).map((p) => contributionOf(p.entry, 'CREDIT')),
  );
  const difference = subtract(totalDebits.amount, totalCredits.amount);
  return { rows, totalDebits, totalCredits, difference, balanced: difference.minor === 0n };
};

export interface StatementSection {
  readonly heading: Bilingual;
  readonly rows: readonly AccountRow[];
  readonly total: Figure;
}

/**
 * Issue #273 — one line of the profit and loss as a person reads it.
 *
 * `ACCOUNT` is an account's own figure. `LESS` is a return taken off the line above it, carried as
 * a negative figure because that is what it does to the total. `NET` is the line above less the
 * return: net sales, or net purchases. The lines of a section always add up to its total, with the
 * `NET` line left out of the sum because it only restates the two lines above it.
 */
export interface StatementLine {
  readonly kind: 'ACCOUNT' | 'LESS' | 'NET';
  readonly label: Bilingual;
  readonly amount: Figure;
}

export interface ProfitAndLossSection extends StatementSection {
  readonly lines: readonly StatementLine[];
}

export interface ProfitAndLossBody {
  /**
   * What the business earned: sales less goods returned by customers (net sales), then any other
   * income. A sales return is a reduction of revenue, not a cost, so it is shown here, taken off
   * sales, and never among what was spent.
   */
  readonly income: ProfitAndLossSection;
  /**
   * What the business spent: purchases less goods returned to suppliers (net purchases), then every
   * other cost. A purchase return reduces purchases; it is not income.
   */
  readonly expenses: ProfitAndLossSection;
  /** Sales of goods and services, before anything came back. */
  readonly grossSales: Figure;
  /** Goods returned by customers in the period, as a positive amount. */
  readonly salesReturns: Figure;
  /** Sales less goods returned by customers. */
  readonly netSales: Figure;
  /** Purchases of goods, before anything was sent back. */
  readonly grossPurchases: Figure;
  /** Goods returned to suppliers in the period, as a positive amount. */
  readonly purchaseReturns: Figure;
  /** Purchases less goods returned to suppliers. */
  readonly netPurchases: Figure;
  /** Income less expenses for the period. Positive means the business made money. */
  readonly result: Figure;
  readonly madeMoney: boolean;
  /**
   * False when goods were sold but nothing has been written into the books for what they cost. The
   * figure is then higher than the business really kept, and the page has to say so rather than
   * letting an owner plan around it.
   */
  readonly costOfGoodsInBooks: boolean;
  readonly sentence: Bilingual;
}

const sectionOf = (heading: Bilingual, rows: readonly AccountRow[], pick: (row: AccountRow) => Figure): StatementSection => ({
  heading,
  rows,
  total: addFigures(rows.map(pick)),
});

const negated = (figure: Figure): Figure => subtractFigures(emptyFigure(), figure);

const sameName = (name: string): Bilingual => ({ 'en-IN': name, 'hi-IN': name });

/**
 * A group that has a return taken off it: the group's own accounts, the return on its own line as
 * a deduction, and the net line under them. With no return in the period there is nothing to take
 * off, so the accounts stand alone and no net line is printed.
 */
const groupWithReturns = (
  accounts: readonly AccountRow[],
  returned: AccountRow | undefined,
  returnedAmount: Figure,
  net: Bilingual,
): StatementLine[] => {
  const lines: StatementLine[] = accounts.map((r) => ({ kind: 'ACCOUNT', label: sameName(r.name), amount: r.movement }));
  if (returned === undefined || returnedAmount.amount.minor === 0n) return lines;
  return [
    ...lines,
    { kind: 'LESS', label: { 'en-IN': `Less: ${returned.name.toLowerCase()}`, 'hi-IN': `Ghatayein: ${returned.name.toLowerCase()}` }, amount: negated(returnedAmount) },
    { kind: 'NET', label: net, amount: subtractFigures(addFigures(accounts.map((r) => r.movement)), returnedAmount) },
  ];
};

export const profitAndLossBody = (books: LoadedBooks): ProfitAndLossBody => {
  const rows = accountRows(books).filter((r) => appearsInProfitAndLoss(r.type));
  const byRole = (role: SystemAccountRole): AccountRow | undefined => rows.find((r) => r.systemRole === role);

  // Issue #273 — returns are taken off the side they undo. Goods returned by customers are kept
  // in their own account on the spending side of the ledger, and that posting is right; it is the
  // statement that moves them under sales, re-signed towards the earning side so the figure there
  // is negative. Goods returned to suppliers already sit under purchases as a credit, so they are
  // already negative there and only need to be placed next to purchases.
  const salesAccounts = rows.filter((r) => r.systemRole === 'SALES_GOODS' || r.systemRole === 'SALES_SERVICES');
  const salesReturnRow = byRole('SALES_RETURNS');
  const salesReturns = salesReturnRow?.movement ?? emptyFigure();
  const salesReturnOnIncomeSide: AccountRow | undefined =
    salesReturnRow === undefined ? undefined : { ...salesReturnRow, movement: negated(salesReturnRow.movement) };
  const otherIncome = rows.filter((r) => r.type === 'INCOME' && !salesAccounts.includes(r));

  const purchaseAccounts = rows.filter((r) => r.systemRole === 'PURCHASES_GOODS');
  const purchaseReturnRow = byRole('PURCHASE_RETURNS');
  const purchaseReturns = purchaseReturnRow === undefined ? emptyFigure() : negated(purchaseReturnRow.movement);
  const otherExpenses = rows.filter(
    (r) => r.type === 'EXPENSE' && !purchaseAccounts.includes(r) && r !== purchaseReturnRow && r !== salesReturnRow,
  );

  const incomeRows = [...salesAccounts, ...(salesReturnOnIncomeSide ? [salesReturnOnIncomeSide] : []), ...otherIncome];
  const expenseRows = [...purchaseAccounts, ...(purchaseReturnRow ? [purchaseReturnRow] : []), ...otherExpenses];
  const income: ProfitAndLossSection = {
    ...sectionOf({ 'en-IN': 'Money the business earned', 'hi-IN': 'Business ne jo kamaya' }, incomeRows, (r) => r.movement),
    lines: [
      ...groupWithReturns(salesAccounts, salesReturnRow, salesReturns, { 'en-IN': 'Net sales', 'hi-IN': 'Net bikri' }),
      ...otherIncome.map((r): StatementLine => ({ kind: 'ACCOUNT', label: sameName(r.name), amount: r.movement })),
    ],
  };
  const expenses: ProfitAndLossSection = {
    ...sectionOf({ 'en-IN': 'Money the business spent', 'hi-IN': 'Business ne jo kharch kiya' }, expenseRows, (r) => r.movement),
    lines: [
      ...groupWithReturns(purchaseAccounts, purchaseReturnRow, purchaseReturns, { 'en-IN': 'Net purchases', 'hi-IN': 'Net khareed' }),
      ...otherExpenses.map((r): StatementLine => ({ kind: 'ACCOUNT', label: sameName(r.name), amount: r.movement })),
    ],
  };
  const grossSales = addFigures(salesAccounts.map((r) => r.movement));
  const grossPurchases = addFigures(purchaseAccounts.map((r) => r.movement));

  const result = subtractFigures(income.total, expenses.total);
  const madeMoney = result.amount.minor >= 0n;
  const amount = formatINR(money(result.amount.minor < 0n ? -result.amount.minor : result.amount.minor));
  const costOfGoodsInBooks =
    income.total.amount.minor === 0n ||
    expenses.rows.some((r) => r.systemRole === 'PURCHASES_GOODS' && r.movement.amount.minor !== 0n);
  return {
    income,
    expenses,
    grossSales,
    salesReturns,
    netSales: subtractFigures(grossSales, salesReturns),
    grossPurchases,
    purchaseReturns,
    netPurchases: subtractFigures(grossPurchases, purchaseReturns),
    result,
    madeMoney,
    costOfGoodsInBooks,
    sentence: costOfGoodsInBooks
      ? {
          'en-IN': madeMoney
            ? `You earned ${formatINR(income.total.amount)} and spent ${formatINR(expenses.total.amount)}, so you kept ${amount}.`
            : `You earned ${formatINR(income.total.amount)} and spent ${formatINR(expenses.total.amount)}, so you are short by ${amount}.`,
          'hi-IN': madeMoney
            ? `Aapne ${formatINR(income.total.amount)} kamaye aur ${formatINR(expenses.total.amount)} kharch kiye, yaani ${amount} bache.`
            : `Aapne ${formatINR(income.total.amount)} kamaye aur ${formatINR(expenses.total.amount)} kharch kiye, yaani ${amount} kam pade.`,
        }
      : {
          'en-IN': `You earned ${formatINR(income.total.amount)} and spent ${formatINR(expenses.total.amount)}. What your goods cost is not in the books yet, so the ${amount} left over is higher than the real figure.`,
          'hi-IN': `Aapne ${formatINR(income.total.amount)} kamaye aur ${formatINR(expenses.total.amount)} kharch kiye. Maal ki lagat abhi books mein nahin hai, isliye ${amount} bachat asli se zyada dikh rahi hai.`,
        },
  };
};

export interface BalanceSheetBody {
  readonly assets: StatementSection;
  readonly liabilities: StatementSection;
  readonly ownersMoney: StatementSection;
  /**
   * Everything earned less everything spent since the books began, up to the closing date. No
   * entry has moved it into the owner's money, because year-end closing is not built; it is shown
   * on its own rather than folded in where nobody could see where it came from.
   */
  readonly resultSoFar: Figure;
  readonly totalAssets: Figure;
  readonly totalClaims: Figure;
  /** Assets less what is claimed against them. Shown, never plugged. */
  readonly difference: Money;
  readonly balanced: boolean;
  readonly sentence: Bilingual;
}

export const balanceSheetBody = (books: LoadedBooks): BalanceSheetBody => {
  const rows = accountRows(books).filter((r) => appearsInProfitAndLoss(r.type) === false);
  const assets = sectionOf(
    { 'en-IN': 'What the business owns', 'hi-IN': 'Business ke paas kya hai' },
    rows.filter((r) => r.type === 'ASSET'),
    (r) => r.closing,
  );
  const liabilities = sectionOf(
    { 'en-IN': 'What the business owes', 'hi-IN': 'Business ko kya dena hai' },
    rows.filter((r) => r.type === 'LIABILITY'),
    (r) => r.closing,
  );
  const ownersMoney = sectionOf(
    { 'en-IN': "The owner's money in the business", 'hi-IN': 'Malik ka paisa business mein' },
    rows.filter((r) => r.type === 'EQUITY'),
    (r) => r.closing,
  );

  // The result to show alongside the sheet is everything earned less everything spent up to the
  // closing date, not just this period's, because that is what the assets are standing on.
  const pnlRows = accountRows(books).filter((r) => appearsInProfitAndLoss(r.type));
  const resultSoFar = subtractFigures(
    addFigures(pnlRows.filter((r) => r.type === 'INCOME').map((r) => r.closing)),
    addFigures(pnlRows.filter((r) => r.type === 'EXPENSE').map((r) => r.closing)),
  );

  const totalAssets = assets.total;
  const totalClaims = addFigures([liabilities.total, ownersMoney.total, resultSoFar]);
  const difference = subtract(totalAssets.amount, totalClaims.amount);
  const balanced = difference.minor === 0n;
  return {
    assets,
    liabilities,
    ownersMoney,
    resultSoFar,
    totalAssets,
    totalClaims,
    difference,
    balanced,
    sentence: balanced
      ? {
          'en-IN': `The business owns ${formatINR(totalAssets.amount)}, and that is fully accounted for.`,
          'hi-IN': `Business ke paas ${formatINR(totalAssets.amount)} hai, aur poora hisaab mil raha hai.`,
        }
      : {
          'en-IN': `What the business owns and what is claimed against it differ by ${formatINR(difference)}. Someone should look at the entries below.`,
          'hi-IN': `Business ke paas jo hai aur uspar jo dawa hai, unmein ${formatINR(difference)} ka farq hai. Neeche ki entries dekhni chahiye.`,
        },
  };
};

export const zeroFigure = (): Figure => emptyFigure();
export const nil = (): Money => zero('INR');
