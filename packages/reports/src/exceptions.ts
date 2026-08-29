/**
 * Issue #35 [E35] — what a person has to look at before believing the rest of the pack.
 *
 * Every other report in this package answers a question. This one lists the questions the books
 * cannot answer: a figure that two parts of the product disagree about, a bill priced without a
 * rate anyone can stand behind, money that arrived against no bill, a cheque counted as taken but
 * not yet cleared.
 *
 * None of it is resolved here. This package changes nothing; it says what is wrong, names the
 * records, and leaves the deciding to the person whose business it is.
 */
import { formatINR, subtract, type IsoDate, type Money } from '@invoice/kernel';
import type { SalesInvoice } from '@invoice/sales';
import type { StockMovement } from '@invoice/inventory';
import { figureOf, type Bilingual, type Contribution, type Figure } from './model.ts';
import { contributionsForAccount, type LoadedBooks } from './source.ts';
import type { AgeingBody } from './dues.ts';
import type { StockBody } from './stock.ts';
import type { RegisterBody } from './registers.ts';

export type ExceptionCode =
  | 'BOOKS_DO_NOT_BALANCE'
  | 'STOCK_VALUE_NOT_IN_BOOKS'
  | 'BILL_WITHOUT_TAX_DECISION'
  | 'BILL_STUCK_BEFORE_ISSUE'
  | 'MONEY_WITHOUT_A_BILL'
  | 'CHEQUE_NOT_CLEARED'
  | 'STOCK_WENT_NEGATIVE';

/** How much attention it needs, in the order a person should work down the page. */
export type ExceptionSeverity = 'BLOCKING' | 'NEEDS_A_DECISION' | 'WORTH_KNOWING';

export interface ReportException {
  readonly code: ExceptionCode;
  readonly severity: ExceptionSeverity;
  readonly what: Bilingual;
  readonly why: Bilingual;
  readonly amount: Money | null;
  readonly records: readonly Contribution[];
}

export interface ExceptionsBody {
  readonly exceptions: readonly ReportException[];
  readonly sentence: Bilingual;
  /** True when nothing on the page needs a person before the figures can be trusted. */
  readonly clean: boolean;
}

export interface ExceptionsInput {
  readonly books: LoadedBooks;
  readonly stock: StockBody;
  readonly movements: readonly StockMovement[];
  readonly salesInvoices: readonly SalesInvoice[];
  readonly sales: RegisterBody;
  readonly receivables: AgeingBody;
  readonly payables: AgeingBody;
  readonly to: IsoDate;
}

const nil = (): Money => ({ currency: 'INR', minor: 0n });

/** "1 bill" and "3 bills". A page that says "1 people" is a page nobody trusts. */
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const SEVERITY_ORDER: Record<ExceptionSeverity, number> = { BLOCKING: 0, NEEDS_A_DECISION: 1, WORTH_KNOWING: 2 };

/** The stock account as the ledger has it, which is not the same thing as the stock on the floor. */
const stockInBooks = (books: LoadedBooks): Figure => {
  const account = books.accounts.find((a) => a.systemRole === 'STOCK_IN_HAND' && a.isGroup === false);
  if (account === undefined) return figureOf([]);
  return figureOf(contributionsForAccount(books.closing, account, 'DEBIT'));
};

export const exceptionsBody = (input: ExceptionsInput): ExceptionsBody => {
  const found: ReportException[] = [];

  const debits = input.books.closing.map((e) => e.line.debit.minor).reduce((a, b) => a + b, 0n);
  const credits = input.books.closing.map((e) => e.line.credit.minor).reduce((a, b) => a + b, 0n);
  if (debits !== credits) {
    found.push({
      code: 'BOOKS_DO_NOT_BALANCE',
      severity: 'BLOCKING',
      what: {
        'en-IN': 'The two sides of your books do not add up to the same figure.',
        'hi-IN': 'Aapki books ke dono taraf ka jod barabar nahin hai.',
      },
      why: {
        'en-IN': 'Every entry puts the same amount on both sides. If they differ, something was saved without going through the usual path, and no figure on these pages can be trusted until it is found.',
        'hi-IN': 'Har entry dono taraf ek hi rakam daalti hai. Farq hai to kuch seedhe raste ke bahar se save hua hai, aur jab tak wo milta nahin, in panno ka koi aankda bharosemand nahin.',
      },
      amount: { currency: 'INR', minor: debits - credits },
      records: [],
    });
  }

  const counted = input.stock.value;
  const booked = stockInBooks(input.books);
  const gap = subtract(counted.amount, booked.amount);
  if (gap.minor !== 0n) {
    found.push({
      code: 'STOCK_VALUE_NOT_IN_BOOKS',
      severity: 'NEEDS_A_DECISION',
      what: {
        'en-IN': `Your goods are worth ${formatINR(counted.amount)} by the movements, but the books carry ${formatINR(booked.amount)} for them.`,
        'hi-IN': `Movements ke hisaab se aapka maal ${formatINR(counted.amount)} ka hai, par books mein uske ${formatINR(booked.amount)} likhe hain.`,
      },
      why: {
        'en-IN': 'The value of goods is not yet written into the books when they move. Until purchase recording is finished, the balance sheet shows what the books hold and this page shows what the godown holds.',
        'hi-IN': 'Maal ki keemat abhi movement ke saath books mein nahin likhi jaati. Kharid ka hissa poora hone tak, balance sheet books ka aankda dikhaati hai aur yeh panna godown ka.',
      },
      amount: gap,
      records: [...counted.contributors, ...booked.contributors],
    });
  }

  const unpriced = input.sales.rows.filter((row) => row.taxNotDecided);
  if (unpriced.length > 0) {
    found.push({
      code: 'BILL_WITHOUT_TAX_DECISION',
      severity: 'NEEDS_A_DECISION',
      what: {
        'en-IN': `${count(unpriced.length, 'bill', 'bills')} went out without a GST rate the product could stand behind.`,
        'hi-IN': `${count(unpriced.length, 'bill', 'bill')} aise gaye jinka GST rate product khud se pakka nahin kar saka.`,
      },
      why: {
        'en-IN': 'A rate is either taken from the notification it comes from or declared by you, with your reason recorded. It is never picked because it looked likely.',
        'hi-IN': 'Rate ya to us notification se aata hai jahan se wo nikla hai, ya aap khud batate hain aur kaaran likha jaata hai. Andaaze se kabhi nahin chunaa jaata.',
      },
      amount: nil(),
      records: unpriced.map((row) => ({
        sourceKind: 'sales_invoice',
        sourceId: row.documentId,
        sourceNumber: row.number,
        date: row.date,
        branchId: row.branchId,
        partyId: row.partyId,
        description: `${row.number} for ${row.partyName}`,
        amount: row.total,
      })),
    });
  }

  const stuck = input.salesInvoices.filter(
    (i) => (i.state === 'PENDING_APPROVAL' || i.state === 'NEEDS_INFO') && i.documentDate <= input.to,
  );
  if (stuck.length > 0) {
    found.push({
      code: 'BILL_STUCK_BEFORE_ISSUE',
      severity: 'WORTH_KNOWING',
      what: {
        'en-IN': `${count(stuck.length, 'bill is', 'bills are')} waiting and ${stuck.length === 1 ? 'has' : 'have'} not been given to anyone yet.`,
        'hi-IN': `${count(stuck.length, 'bill', 'bill')} ruke hue hain aur abhi kisi ko diye nahin gaye.`,
      },
      why: {
        'en-IN': 'A bill that has not been issued is not a sale, so none of these are counted in what you earned. They are listed so nobody forgets them.',
        'hi-IN': 'Jo bill diya hi nahin gaya wo bikri nahin hai, isliye kamai mein inhein nahin gina gaya. Yaad rahe, isliye yahan likhe hain.',
      },
      amount: nil(),
      records: stuck.map((invoice) => ({
        sourceKind: 'sales_invoice',
        sourceId: invoice.id,
        sourceNumber: invoice.number,
        date: invoice.documentDate,
        branchId: invoice.branchId,
        partyId: invoice.partyId,
        description: `A bill started on ${invoice.documentDate} that has not gone out`,
        amount: invoice.pricing?.totals.invoiceValue ?? nil(),
      })),
    });
  }

  const onAccount = [...input.receivables.rows, ...input.payables.rows].filter((r) => r.onAccount.minor !== 0n);
  if (onAccount.length > 0) {
    found.push({
      code: 'MONEY_WITHOUT_A_BILL',
      severity: 'NEEDS_A_DECISION',
      what: {
        'en-IN': `${count(onAccount.length, 'person has', 'people have')} money with you that is not against any bill.`,
        'hi-IN': `${count(onAccount.length, 'aadmi', 'logon')} ka paisa aapke paas hai jo kisi bill ke saamne nahin laga.`,
      },
      why: {
        'en-IN': 'Money is never attached to whichever bill looks closest. It waits here, visible, until someone says which bill it settles.',
        'hi-IN': 'Paisa apne aap kisi bhi bill par nahin lagta. Jab tak koi batata nahin ki kis bill ka hai, wo yahan saamne pada rehta hai.',
      },
      amount: { currency: 'INR', minor: onAccount.reduce((total, r) => total + r.onAccount.minor, 0n) },
      records: onAccount.map((row) => ({
        sourceKind: 'party',
        sourceId: row.partyId,
        sourceNumber: null,
        date: input.to,
        branchId: null,
        partyId: row.partyId,
        description: `${row.partyName} has money with you that no bill has claimed`,
        amount: row.onAccount,
      })),
    });
  }

  const cheques = [...input.receivables.rows, ...input.payables.rows].filter((r) => r.chequesNotCleared.minor !== 0n);
  if (cheques.length > 0) {
    found.push({
      code: 'CHEQUE_NOT_CLEARED',
      severity: 'WORTH_KNOWING',
      what: {
        'en-IN': `Cheques worth ${formatINR({ currency: 'INR', minor: cheques.reduce((t, r) => t + r.chequesNotCleared.minor, 0n) })} have been taken but have not turned into money yet.`,
        'hi-IN': `${formatINR({ currency: 'INR', minor: cheques.reduce((t, r) => t + r.chequesNotCleared.minor, 0n) })} ke cheque liye to hain, par abhi paise nahin bane.`,
      },
      why: {
        'en-IN': 'A cheque is counted as money only when the bank has paid it. Until then it is shown on its own, so a bounced one is not a surprise three weeks later.',
        'hi-IN': 'Cheque tabhi paisa maana jaata hai jab bank de deta hai. Tab tak wo alag dikhta hai, taaki bounce hone par teen hafte baad chaunkna na pade.',
      },
      amount: { currency: 'INR', minor: cheques.reduce((total, r) => total + r.chequesNotCleared.minor, 0n) },
      records: cheques.map((row) => ({
        sourceKind: 'party',
        sourceId: row.partyId,
        sourceNumber: null,
        date: input.to,
        branchId: null,
        partyId: row.partyId,
        description: `${row.partyName} gave cheques that have not cleared`,
        amount: row.chequesNotCleared,
      })),
    });
  }

  const overrides = input.movements.filter((m) => m.negativeOverride !== null && m.documentDate <= input.to);
  if (overrides.length > 0) {
    found.push({
      code: 'STOCK_WENT_NEGATIVE',
      severity: 'NEEDS_A_DECISION',
      what: {
        'en-IN': `${count(overrides.length, 'time', 'times')}, goods were sent out that the records did not show as being there.`,
        'hi-IN': `${count(overrides.length, 'baar', 'baar')} aisa maal bahar gaya jo record mein tha hi nahin.`,
      },
      why: {
        'en-IN': 'Someone with permission allowed it and gave a reason. Usually it means a purchase has not been recorded yet, and until it is, what the goods cost is a guess.',
        'hi-IN': 'Permission wale ne ijaazat di aur kaaran likha. Aksar iska matlab hai ki koi kharid abhi darj nahin hui, aur tab tak maal ki lagat ka pata nahin.',
      },
      amount: nil(),
      records: overrides.map((movement) => ({
        sourceKind: 'stock_movement',
        sourceId: movement.id,
        sourceNumber: movement.source.number,
        date: movement.documentDate,
        branchId: null,
        partyId: null,
        description: movement.negativeOverride?.reason ?? 'Allowed to go below zero',
        amount: nil(),
      })),
    });
  }

  const exceptions = found.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return {
    exceptions,
    clean: exceptions.length === 0,
    sentence:
      exceptions.length === 0
        ? {
            'en-IN': 'Nothing on these pages needs a second look.',
            'hi-IN': 'In panno mein kuch bhi dobara dekhne layak nahin hai.',
          }
        : {
            'en-IN': `${count(exceptions.length, 'thing needs', 'things need')} a look before you rely on these pages.`,
            'hi-IN': `In panno par bharosa karne se pehle ${count(exceptions.length, 'cheez', 'cheezein')} dekhni chahiye.`,
          },
  };
};
