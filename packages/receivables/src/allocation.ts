/**
 * Issue #20 [E20] — matching money to bills.
 *
 * Two rules, and both are refusals:
 *
 *  1. **A payment is never applied to a bill nobody chose.** The product suggests the oldest bill
 *     first, because that is what most businesses do, but a suggestion is not a decision and the
 *     caller must confirm it.
 *  2. **Nothing is over-applied.** ₹30,000 cannot settle ₹30,000 of one bill and ₹10,000 of
 *     another, and a bill already settled cannot absorb more.
 */
import { compareDates, invalid, isZero, subtract, sum, formatINR, toDecimalString, zero, type IsoDate, type Money } from '@invoice/kernel';
import type { Allocation, BillSettlement, DocumentPosition, OpenDocument, Payment } from './model.ts';

const nil = (): Money => zero('INR');

/** Days between two dates. Positive means the first is later. */
export const daysBetween = (later: IsoDate, earlier: IsoDate): number =>
  Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);

/**
 * What one document still owes, from the document's value less every accepted allocation.
 *
 * "Outstanding balances equal invoice less accepted allocations" is the acceptance criterion, so
 * outstanding is derived here and stored nowhere.
 */
export const positionOf = (
  document: OpenDocument,
  payments: readonly Payment[],
  today: IsoDate,
): DocumentPosition => {
  const live = payments.filter((p) => p.state === 'RECORDED');
  const allocated = sum(
    live.flatMap((p) => p.allocations.filter((a) => a.documentId === document.documentId).map((a) => a.amount)),
  );
  // Issue #295 — what TDS, a discount or a write-off settled on the bill is not owed either.
  const adjusted = sum(
    live.flatMap((p) => (p.settlements ?? []).filter((s) => s.documentId === document.documentId).map((s) => s.amount)),
  );
  const outstanding = subtract(document.value, sum([allocated, adjusted]));
  const daysOverdue = document.dueDate === null ? 0 : daysBetween(today, document.dueDate);
  const status: DocumentPosition['status'] = isZero(outstanding)
    ? 'SETTLED'
    : isZero(allocated)
      ? 'OPEN'
      : 'PARTLY_PAID';
  return { document, allocated, outstanding, daysOverdue, status };
};

/**
 * Suggests how a payment could be split, oldest bill first.
 *
 * A suggestion, not a decision: the caller confirms it. Anything left over is deliberately not
 * forced onto a bill — it stays on account where a person can see it.
 */
export const suggestAllocation = (
  amount: Money,
  positions: readonly DocumentPosition[],
): { allocations: Allocation[]; leftOver: Money } => {
  const open = [...positions]
    .filter((p) => !isZero(p.outstanding) && p.outstanding.minor > 0n)
    .sort((a, b) => {
      const byDue = compareDates(a.document.dueDate ?? a.document.date, b.document.dueDate ?? b.document.date);
      return byDue !== 0 ? byDue : compareDates(a.document.date, b.document.date);
    });

  let remaining = amount;
  const allocations: Allocation[] = [];
  for (const position of open) {
    if (remaining.minor <= 0n) break;
    const applied = remaining.minor >= position.outstanding.minor ? position.outstanding : remaining;
    allocations.push({
      documentId: position.document.documentId,
      documentNumber: position.document.number,
      amount: applied,
    });
    remaining = subtract(remaining, applied);
  }
  return { allocations, leftOver: remaining };
};

/**
 * Checks a proposed split before anything is written.
 *
 * Every refusal here names the bill and the amount, because "allocation exceeds outstanding" is
 * not something a shopkeeper can act on.
 */
export const validateAllocation = (
  amount: Money,
  allocations: readonly Allocation[],
  positions: readonly DocumentPosition[],
): void => {
  const byDocument = new Map(positions.map((p) => [p.document.documentId, p]));
  const seen = new Set<string>();

  for (const allocation of allocations) {
    if (allocation.amount.minor <= 0n) {
      throw invalid(
        'ALLOCATION_NOT_POSITIVE',
        `The amount put against ${allocation.documentNumber} must be more than zero.`,
      );
    }
    if (seen.has(allocation.documentId)) {
      throw invalid(
        'ALLOCATION_DUPLICATE_DOCUMENT',
        `${allocation.documentNumber} appears twice. Put the whole amount on it once.`,
      );
    }
    seen.add(allocation.documentId);

    const position = byDocument.get(allocation.documentId);
    if (position === undefined) {
      throw invalid(
        'ALLOCATION_UNKNOWN_DOCUMENT',
        `${allocation.documentNumber} is not one of their open bills, so this money cannot be put against it.`,
      );
    }
    if (allocation.amount.minor > position.outstanding.minor) {
      throw invalid(
        'ALLOCATION_EXCEEDS_OUTSTANDING',
        `${allocation.documentNumber} only has ${formatINR(position.outstanding)} left to pay, but ${formatINR(allocation.amount)} was put against it.`,
        { details: { documentNumber: allocation.documentNumber, outstanding: toDecimalString(position.outstanding) } },
      );
    }
  }

  const total = sum(allocations.map((a) => a.amount));
  if (total.minor > amount.minor) {
    throw invalid(
      'ALLOCATION_EXCEEDS_PAYMENT',
      `${formatINR(total)} has been put against bills, but only ${formatINR(amount)} was received.`,
      { details: { allocated: toDecimalString(total), amount: toDecimalString(amount) } },
    );
  }
};

/**
 * Money received that no bill has claimed. Visible, and never quietly attached to something.
 *
 * Only money that came **in** counts. An advance paid out to a supplier (#261) is the business's
 * money held by them, the opposite fact; it is `advancesPaidOf`, never "money with you".
 */
export const onAccountOf = (payments: readonly Payment[]): Money => {
  const recorded = payments.filter((p) => p.state === 'RECORDED');
  return subtract(
    sum(recorded.filter((p) => p.refundOf === null && p.direction === 'RECEIPT').map((p) => subtract(p.amount, sum(p.allocations.map((a) => a.amount))))),
    sum(recorded.filter((p) => p.refundOf !== null).map((p) => p.amount)),
  );
};

/** Issue #261 — what of the advances paid to a supplier no bill of theirs has used yet. */
export const advancesPaidOf = (payments: readonly Payment[]): Money =>
  sum(
    payments
      .filter((p) => p.state === 'RECORDED' && p.direction === 'PAYMENT' && p.advanceToSupplier === true)
      .map((p) => subtract(p.amount, sum(p.allocations.map((a) => a.amount)))),
  );

export const totalOutstanding = (positions: readonly DocumentPosition[]): Money =>
  sum(positions.map((p) => p.outstanding));

export const allocatedTotal = (allocations: readonly Allocation[]): Money => sum(allocations.map((a) => a.amount));

/**
 * Issue #295 — checks the non-cash ways chosen bills are settled alongside the money.
 *
 * A settlement is only on one of the party's open bills, always positive, and money plus
 * settlements on one bill never come to more than it still owes. TDS needs its Income-tax Act
 * section; a write-off stays within the limit the owner set in Business details.
 */
export const validateSettlements = (
  allocations: readonly Allocation[],
  settlements: readonly BillSettlement[],
  positions: readonly DocumentPosition[],
  writeOffLimit: Money,
): void => {
  const byDocument = new Map(positions.map((p) => [p.document.documentId, p]));
  const seen = new Set<string>();
  for (const settlement of settlements) {
    const key = `${settlement.documentId}:${settlement.kind}`;
    if (settlement.amount.minor <= 0n) {
      throw invalid('SETTLEMENT_NOT_POSITIVE', `The ${settlementWords(settlement.kind)} on ${settlement.documentNumber} must be more than zero.`);
    }
    if (seen.has(key)) {
      throw invalid('SETTLEMENT_DUPLICATE', `${settlement.documentNumber} has ${settlementWords(settlement.kind)} twice. Put the whole amount once.`);
    }
    seen.add(key);
    const position = byDocument.get(settlement.documentId);
    if (position === undefined) {
      throw invalid('SETTLEMENT_UNKNOWN_DOCUMENT', `${settlement.documentNumber} is not one of their open bills, so nothing can be settled on it.`);
    }
    if (settlement.kind === 'TDS_DEDUCTED' && (settlement.tdsSection ?? '').trim() === '') {
      throw invalid('TDS_SECTION_REQUIRED', `Say which section the customer deducted the ${formatINR(settlement.amount)} of tax under, for example 194C or 194Q.`);
    }
    if (settlement.kind !== 'TDS_DEDUCTED') continue;
    seen.add(`${settlement.documentId}:tds-checked`);
  }
  for (const settlement of settlements) {
    if (settlement.kind === 'BALANCE_WRITTEN_OFF' && settlement.amount.minor > writeOffLimit.minor) {
      throw invalid(
        'WRITE_OFF_OVER_LIMIT',
        `${formatINR(settlement.amount)} is more than the ${formatINR(writeOffLimit)} the owner allows writing off on one bill. Raise the limit in Business details, or collect it.`,
        { details: { limit: toDecimalString(writeOffLimit) } },
      );
    }
  }
  // Money plus adjustments on one bill never comes to more than it still owes.
  const onBill = new Map<string, bigint>();
  for (const allocation of allocations) onBill.set(allocation.documentId, (onBill.get(allocation.documentId) ?? 0n) + allocation.amount.minor);
  for (const settlement of settlements) onBill.set(settlement.documentId, (onBill.get(settlement.documentId) ?? 0n) + settlement.amount.minor);
  for (const [documentId, settled] of onBill) {
    const position = byDocument.get(documentId);
    if (position !== undefined && settled > position.outstanding.minor) {
      throw invalid(
        'SETTLEMENT_EXCEEDS_OUTSTANDING',
        `${position.document.number} only has ${formatINR(position.outstanding)} left to pay, but ${formatINR(money(settled))} of money and adjustments were put on it.`,
        { details: { documentNumber: position.document.number, outstanding: toDecimalString(position.outstanding) } },
      );
    }
  }
};

/** The shopkeeper's name for each kind, used in refusals and previews. */
export const settlementWords = (kind: BillSettlement['kind']): string =>
  kind === 'TDS_DEDUCTED' ? 'TDS deducted' : kind === 'DISCOUNT_ALLOWED' ? 'discount allowed' : 'amount written off';

