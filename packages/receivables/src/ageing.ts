/**
 * Issue #20 [E20] — how long money has been owed, in buckets a person recognises.
 *
 * The buckets are counted from the **due date**, not the invoice date, because "sixty days old" and
 * "thirty days late" are different facts and only the second one is a problem.
 */
import { sum, zero, type IsoDate, type Money } from '@invoice/kernel';
import type { DocumentPosition, PartyPosition } from './model.ts';
import { daysBetween } from './allocation.ts';

export interface AgeingBucket {
  readonly label: { readonly 'en-IN': string; readonly 'hi-IN': string };
  readonly fromDays: number;
  readonly toDays: number | null;
  readonly amount: Money;
}

export const AGEING_BANDS: readonly { label: { 'en-IN': string; 'hi-IN': string }; from: number; to: number | null }[] = [
  { label: { 'en-IN': 'Not due yet', 'hi-IN': 'Abhi baaki nahin' }, from: Number.NEGATIVE_INFINITY, to: 0 },
  { label: { 'en-IN': 'Up to 30 days late', 'hi-IN': '30 din tak late' }, from: 1, to: 30 },
  { label: { 'en-IN': '31 to 60 days late', 'hi-IN': '31 se 60 din late' }, from: 31, to: 60 },
  { label: { 'en-IN': '61 to 90 days late', 'hi-IN': '61 se 90 din late' }, from: 61, to: 90 },
  { label: { 'en-IN': 'More than 90 days late', 'hi-IN': '90 din se zyada late' }, from: 91, to: null },
];

export const ageingOf = (positions: readonly DocumentPosition[], today: IsoDate): readonly AgeingBucket[] =>
  AGEING_BANDS.map((band) => ({
    label: band.label,
    fromDays: band.from === Number.NEGATIVE_INFINITY ? -99999 : band.from,
    toDays: band.to,
    amount: sum(
      positions
        .filter((p) => p.outstanding.minor > 0n)
        .filter((p) => {
          const days = p.document.dueDate === null ? 0 : daysBetween(today, p.document.dueDate);
          const aboveFrom = band.from === Number.NEGATIVE_INFINITY || days >= band.from;
          const belowTo = band.to === null || days <= band.to;
          return aboveFrom && belowTo;
        })
        .map((p) => p.outstanding),
    ),
  }));

export interface OverdueSummary {
  readonly partyId: string;
  readonly outstanding: Money;
  readonly oldestDaysOverdue: number;
  /** One sentence a shopkeeper reads on the home screen. */
  readonly sentence: { readonly 'en-IN': string; readonly 'hi-IN': string };
}

/** The home-screen answer to "who owes me money?", worst first. */
export const overdueSummaries = (
  positionsByParty: readonly PartyPosition[],
  nameOf: (partyId: string) => string,
  formatMoney: (m: Money) => string,
): readonly OverdueSummary[] =>
  positionsByParty
    .filter((p) => p.totalOutstanding.minor > 0n)
    .map((p) => {
      const oldest = p.documents
        .filter((d) => d.outstanding.minor > 0n)
        .reduce((worst, d) => Math.max(worst, d.daysOverdue), 0);
      const name = nameOf(p.partyId);
      const amount = formatMoney(p.totalOutstanding);
      return {
        partyId: p.partyId,
        outstanding: p.totalOutstanding,
        oldestDaysOverdue: oldest,
        sentence: {
          'en-IN':
            oldest > 0
              ? `${name} still owes you ${amount}, and the oldest bill is ${oldest} days late.`
              : `${name} still owes you ${amount}.`,
          'hi-IN':
            oldest > 0
              ? `${name} se ${amount} lena baaki hai, aur sabse purana bill ${oldest} din late hai.`
              : `${name} se ${amount} lena baaki hai.`,
        },
      };
    })
    .sort((a, b) => {
      if (a.oldestDaysOverdue !== b.oldestDaysOverdue) return b.oldestDaysOverdue - a.oldestDaysOverdue;
      return Number(b.outstanding.minor - a.outstanding.minor);
    });

export const zeroMoney = (): Money => zero('INR');
