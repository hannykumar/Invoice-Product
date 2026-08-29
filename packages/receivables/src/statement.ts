/**
 * Issue #20 [E20] — a party statement, in the form a business actually sends.
 *
 * Not a ledger extract. A list of what was billed, what was paid, and what is left, in date order,
 * ending in one sentence anyone can check.
 */
import { formatDate, formatINR, subtract, sum, zero, type IsoDate, type Money } from '@invoice/kernel';
import { currentChequeState, type OpenDocument, type Payment } from './model.ts';

export type StatementLineKind = 'BILL' | 'PAYMENT' | 'RETURN' | 'WRITE_OFF';

export interface StatementLine {
  readonly date: IsoDate;
  readonly kind: StatementLineKind;
  readonly reference: string;
  readonly description: { readonly 'en-IN': string; readonly 'hi-IN': string };
  /** Increases what they owe. */
  readonly charged: Money;
  /** Reduces what they owe. */
  readonly paid: Money;
  readonly runningBalance: Money;
  /** Set on a cheque that has not cleared, because it is not money yet. */
  readonly note: { readonly 'en-IN': string; readonly 'hi-IN': string } | null;
}

export interface Statement {
  readonly partyId: string;
  readonly partyName: string;
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly openingBalance: Money;
  readonly lines: readonly StatementLine[];
  readonly closingBalance: Money;
  readonly summary: { readonly 'en-IN': string; readonly 'hi-IN': string };
}

const nil = (): Money => zero('INR');

export const buildStatement = (
  partyId: string,
  partyName: string,
  documents: readonly OpenDocument[],
  payments: readonly Payment[],
  range: { from: IsoDate; to: IsoDate },
): Statement => {
  const inRange = (date: IsoDate): boolean => date >= range.from && date <= range.to;
  const before = (date: IsoDate): boolean => date < range.from;

  const openingBalance = subtract(
    sum(documents.filter((d) => before(d.date)).map((d) => d.value)),
    sum(payments.filter((p) => p.state === 'RECORDED' && before(p.date)).map((p) => p.amount)),
  );

  const events: { date: IsoDate; order: number; line: Omit<StatementLine, 'runningBalance'> }[] = [];

  for (const document of documents.filter((d) => inRange(d.date))) {
    const isNote = document.kind === 'CREDIT_NOTE' || document.kind === 'DEBIT_NOTE';
    events.push({
      date: document.date,
      order: 0,
      line: {
        date: document.date,
        kind: isNote ? 'RETURN' : 'BILL',
        reference: document.number,
        description: {
          'en-IN': isNote ? `Return note ${document.number}` : `Bill ${document.number}`,
          'hi-IN': isNote ? `Wapsi note ${document.number}` : `Bill ${document.number}`,
        },
        charged: document.value.minor >= 0n ? document.value : nil(),
        paid: document.value.minor < 0n ? { currency: 'INR', minor: -document.value.minor } : nil(),
        note: null,
      },
    });
  }

  for (const payment of payments.filter((p) => inRange(p.date))) {
    const chequeState = payment.cheque === null ? null : currentChequeState(payment.cheque);
    const pending = chequeState === 'PENDING' || chequeState === 'DEPOSITED';
    const bounced = chequeState === 'BOUNCED';
    events.push({
      date: payment.date,
      order: 1,
      line: {
        date: payment.date,
        kind: 'PAYMENT',
        reference: payment.reference ?? payment.cheque?.number ?? '',
        description: {
          'en-IN': `Received by ${payment.mode.toLowerCase().replace(/_/g, ' ')}`,
          'hi-IN': `${payment.mode.toLowerCase().replace(/_/g, ' ')} se mila`,
        },
        charged: payment.state === 'REVERSED' ? payment.amount : nil(),
        paid: payment.state === 'REVERSED' ? nil() : payment.amount,
        note: pending
          ? { 'en-IN': 'Cheque not cleared yet', 'hi-IN': 'Cheque abhi clear nahin hua' }
          : bounced
            ? { 'en-IN': 'Cheque did not clear, so this is owed again', 'hi-IN': 'Cheque clear nahin hua, isliye phir se dena hai' }
            : null,
      },
    });
  }

  events.sort((a, b) => (a.date === b.date ? a.order - b.order : a.date.localeCompare(b.date)));

  let running = openingBalance;
  const lines: StatementLine[] = events.map((e) => {
    running = subtract({ currency: 'INR', minor: running.minor + e.line.charged.minor }, e.line.paid);
    return { ...e.line, runningBalance: running };
  });

  const closingBalance = running;
  const owed = closingBalance.minor > 0n;
  return {
    partyId,
    partyName,
    from: range.from,
    to: range.to,
    openingBalance,
    lines,
    closingBalance,
    summary: {
      'en-IN': owed
        ? `${partyName} still owes you ${formatINR(closingBalance)} as on ${formatDate(range.to)}.`
        : closingBalance.minor === 0n
          ? `${partyName} owes you nothing as on ${formatDate(range.to)}.`
          : `You are holding ${formatINR({ currency: 'INR', minor: -closingBalance.minor })} of ${partyName}'s money as on ${formatDate(range.to)}.`,
      'hi-IN': owed
        ? `${formatDate(range.to)} tak ${partyName} se ${formatINR(closingBalance)} lena baaki hai.`
        : closingBalance.minor === 0n
          ? `${formatDate(range.to)} tak ${partyName} se kuch lena baaki nahin.`
          : `${formatDate(range.to)} tak ${partyName} ka ${formatINR({ currency: 'INR', minor: -closingBalance.minor })} aapke paas hai.`,
    },
  };
};
