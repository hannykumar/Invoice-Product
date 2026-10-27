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
  | 'CHEQUE_NOT_CLEARED';

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
        'hi-IN': 'आपकी बुक्स के दोनों तरफ़ का जोड़ बराबर नहीं है।',
      },
      why: {
        'en-IN': 'Every entry puts the same amount on both sides. If they differ, something was saved without going through the usual path, and no figure on these pages can be trusted until it is found.',
        'hi-IN': 'हर एंट्री दोनों तरफ़ एक ही रक़म डालती है। फ़र्क़ है तो कुछ सीधे रस्ते के बाहर से सेव हुआ है, और जब तक वो मिलता नहीं, इन पन्नों का कोई आँकड़ा भरोसेमंद नहीं।',
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
        'hi-IN': `मूवमेंट के हिसाब से आपका माल ${formatINR(counted.amount)} का है, पर बुक्स में उसके ${formatINR(booked.amount)} लिखे हैं।`,
      },
      why: {
        'en-IN': 'The value of goods is not yet written into the books when they move. Until purchase recording is finished, the balance sheet shows what the books hold and this page shows what the godown holds.',
        'hi-IN': 'माल की कीमत बुक्स में नहीं लिखी जाती। ख़रीद पूरी होने तक बैलेंस शीट बुक्स का आँकड़ा दिखाती है और यह पन्ना गोदाम का।',
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
        'hi-IN': `${count(unpriced.length, 'बिल', 'बिल')} ऐसे गए जिनका GST रेट प्रोडक्ट ख़ुद से पक्का नहीं कर सका।`,
      },
      why: {
        'en-IN': 'A rate is either taken from the notification it comes from or declared by you, with your reason recorded. It is never picked because it looked likely.',
        'hi-IN': 'रेट या तो उस नोटिफ़िकेशन से आता है जहाँ से वो निकला है, या आप ख़ुद बताते हैं और कारण लिखा जाता है। अंदाज़े से कभी नहीं चुना जाता।',
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
        'hi-IN': `${count(stuck.length, 'बिल', 'बिल')} रुके हुए हैं और अभी किसी को दिए नहीं गए।`,
      },
      why: {
        'en-IN': 'A bill that has not been issued is not a sale, so none of these are counted in what you earned. They are listed so nobody forgets them.',
        'hi-IN': 'जो बिल दिया ही नहीं गया वो बिक्री नहीं है, इसलिए कमाई में इन्हें नहीं गिना गया। याद रहे, इसलिए यहाँ लिखे हैं।',
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
        'hi-IN': `${count(onAccount.length, 'आदमी', 'लोगों')} का पैसा आपके पास है जो किसी बिल के सामने नहीं लगा।`,
      },
      why: {
        'en-IN': 'Money is never attached to whichever bill looks closest. It waits here, visible, until someone says which bill it settles.',
        'hi-IN': 'पैसा अपने आप किसी भी बिल पर नहीं लगता। जब तक कोई बताता नहीं कि किस बिल का है, वो यहाँ सामने पड़ा रहता है।',
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
        'hi-IN': `${formatINR({ currency: 'INR', minor: cheques.reduce((t, r) => t + r.chequesNotCleared.minor, 0n) })} के चेक लिए तो हैं, पर अभी पैसे नहीं बने।`,
      },
      why: {
        'en-IN': 'A cheque is counted as money only when the bank has paid it. Until then it is shown on its own, so a bounced one is not a surprise three weeks later.',
        'hi-IN': 'चेक तभी पैसा माना जाता है जब बैंक दे देता है। तब तक वो अलग दिखता है, ताकि बाउंस होने पर तीन हफ़्ते बाद चौंकना न पड़े।',
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

  const exceptions = found.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return {
    exceptions,
    clean: exceptions.length === 0,
    sentence:
      exceptions.length === 0
        ? {
            'en-IN': 'Nothing on these pages needs a second look.',
            'hi-IN': 'इन पन्नों में कुछ भी दोबारा देखने लायक़ नहीं है।',
          }
        : {
            'en-IN': `${count(exceptions.length, 'thing needs', 'things need')} a look before you rely on these pages.`,
            'hi-IN': `इन पन्नों पर भरोसा करने से पहले ${count(exceptions.length, 'चीज़', 'चीज़ें')} देखनी चाहिए।`,
          },
  };
};
