/**
 * Issue #35 [E35] — who owes the business money, who the business owes, and how late each is.
 *
 * Every figure here comes from `@invoice/receivables`, which derives a position from the document
 * less the payments applied to it, every time it is asked. Nothing is stored, so nothing can be
 * stale, and a partial payment never turns into a paid bill on the way to a report.
 *
 * Ageing counts from the **due date**, not the bill date. "Sixty days old" and "thirty days late"
 * are different facts and only the second one is a problem worth putting on a page.
 */
import { formatINR, sum, zero, type CompanyId, type IsoDate, type Money, type PartyId } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import { AGEING_BANDS, ageingOf, overdueSummaries, type DocumentPosition, type PartyPosition } from '@invoice/receivables';
import { figureOf, type Bilingual, type Contribution, type Figure, type ReportFilter } from './model.ts';
import type { DuesReadPort } from './ports.ts';

export type DuesSide = 'RECEIVABLE' | 'PAYABLE';

export interface AgeingRow {
  readonly partyId: PartyId;
  readonly partyName: string;
  readonly outstanding: Money;
  readonly oldestDaysOverdue: number;
  /** One bucket amount per band, in the order of `AGEING_BANDS`. */
  readonly buckets: readonly Money[];
  /** Money received that no bill has claimed. Shown, never applied to whatever looks closest. */
  readonly onAccount: Money;
  readonly chequesNotCleared: Money;
  readonly documents: readonly Contribution[];
  /** One sentence the owner can read without reading the table. */
  readonly sentence: Bilingual;
}

export interface AgeingBody {
  readonly side: DuesSide;
  readonly bandLabels: readonly Bilingual[];
  readonly rows: readonly AgeingRow[];
  readonly total: Figure;
  readonly bucketTotals: readonly Money[];
  readonly sentence: Bilingual;
}

const documentContribution = (position: DocumentPosition, partyName: string): Contribution => ({
  sourceKind: position.document.kind.toLowerCase(),
  sourceId: position.document.documentId,
  sourceNumber: position.document.number,
  date: position.document.date,
  branchId: null,
  partyId: position.document.partyId,
  description:
    position.daysOverdue > 0
      ? `${position.document.number} for ${partyName}, ${position.daysOverdue} days late`
      : `${position.document.number} for ${partyName}, not due yet`,
  amount: position.outstanding,
});

/**
 * `asOn` is the day lateness is counted from, and it is the closing date of the report rather than
 * today. A statement printed for March must not become more overdue every time it is reopened.
 */
export const ageingBody = async (
  dues: DuesReadPort,
  actor: ActorContext,
  companyId: CompanyId,
  filter: ReportFilter,
  side: DuesSide,
): Promise<AgeingBody> => {
  const asOn: IsoDate = filter.to;
  const parties = await dues.parties(companyId);

  const positions: { position: PartyPosition; name: string; documents: readonly DocumentPosition[] }[] = [];
  for (const partyId of parties) {
    const position = await dues.position(actor, partyId, asOn);
    const documents = position.documents.filter(
      (d) => d.document.side === side && d.outstanding.minor !== 0n && d.document.date <= filter.to,
    );
    // Money on account belongs to the party, not to one side of the books. It is shown once, with
    // what customers owe, rather than on both pages where it would be counted twice.
    const worthShowing = documents.length > 0 || (side === 'RECEIVABLE' && position.onAccount.minor !== 0n);
    if (!worthShowing) continue;
    positions.push({ position, name: await dues.nameOf(companyId, partyId), documents });
  }

  const summaries = new Map(
    overdueSummaries(
      positions.map((p) => ({ ...p.position, documents: p.documents, totalOutstanding: sum(p.documents.map((d) => d.outstanding)) })),
      (partyId) => positions.find((p) => p.position.partyId === partyId)?.name ?? partyId,
      formatINR,
    ).map((s) => [s.partyId, s]),
  );

  const rows: AgeingRow[] = positions
    .map((entry) => {
      const buckets = ageingOf(entry.documents, asOn).map((b) => b.amount);
      const summary = summaries.get(entry.position.partyId);
      const outstanding = sum(entry.documents.map((d) => d.outstanding));
      return {
        partyId: entry.position.partyId,
        partyName: entry.name,
        outstanding,
        oldestDaysOverdue: summary?.oldestDaysOverdue ?? 0,
        buckets,
        onAccount: side === 'RECEIVABLE' ? entry.position.onAccount : zero('INR'),
        chequesNotCleared: side === 'RECEIVABLE' ? entry.position.chequesNotCleared : zero('INR'),
        documents: entry.documents.map((d) => documentContribution(d, entry.name)),
        sentence: summary?.sentence ?? {
          'en-IN': `${entry.name} has nothing outstanding.`,
          'hi-IN': `${entry.name} ka kuch baaki nahin hai.`,
        },
      };
    })
    .filter((row) => row.outstanding.minor !== 0n || row.onAccount.minor !== 0n)
    .sort((a, b) =>
      a.oldestDaysOverdue === b.oldestDaysOverdue
        ? Number(b.outstanding.minor - a.outstanding.minor)
        : b.oldestDaysOverdue - a.oldestDaysOverdue,
    );

  const total = figureOf(rows.flatMap((r) => r.documents));
  const bucketTotals = AGEING_BANDS.map((_band, index) => sum(rows.map((r) => r.buckets[index] ?? zero('INR'))));
  const late = rows.filter((r) => r.oldestDaysOverdue > 0).length;

  return {
    side,
    bandLabels: AGEING_BANDS.map((b) => b.label),
    rows,
    total,
    bucketTotals,
    sentence:
      side === 'RECEIVABLE'
        ? {
            'en-IN': `Customers still owe you ${formatINR(total.amount)}, and ${late} of them ${late === 1 ? 'is' : 'are'} late.`,
            'hi-IN': `Customers se ${formatINR(total.amount)} lena baaki hai, aur unmein ${late} late hain.`,
          }
        : {
            'en-IN': `You still owe suppliers ${formatINR(total.amount)}, and ${late} of them ${late === 1 ? 'is' : 'are'} already past the date.`,
            'hi-IN': `Suppliers ko ${formatINR(total.amount)} dena baaki hai, aur unmein ${late} ki tareekh nikal chuki hai.`,
          },
  };
};
