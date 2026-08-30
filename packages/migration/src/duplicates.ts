/**
 * Issue #37 [E37] — bringing the same thing in twice.
 *
 * Three different things get called a duplicate, and they need three different answers:
 *
 *  - **The same file, again.** Handled in `service.ts` by the file's digest: the whole batch is
 *    refused, because a second import of the same trial balance doubles a business's books.
 *  - **The same row twice inside one file.** A repeated customer is skipped. A repeated *balance* is
 *    refused, because two rows for one account are either a mistake or a subtotal, and adding them
 *    together would be inventing a figure.
 *  - **A row matching something the business already has.** Skipped and reported, never overwritten:
 *    an import must not quietly change a customer's GST number to whatever the old file said.
 *
 * The matching itself is GPT 3's from `packages/masters` — the same rules that stop a duplicate
 * being typed in by hand, so the two paths cannot drift apart.
 */
import { checkForDuplicates, normaliseName } from '../../masters/src/matching.ts';
import type { ExistingRecord } from './ports.ts';
import type {
  Bilingual, CustomerRow, DuplicateSummary, EntityKind, ItemRow, OpeningBalanceRow, OpeningStockRow, RowOutcome,
} from './model.ts';

/** How a parsed row looks to the matcher. */
const matchableOf = (entity: EntityKind, parsed: NonNullable<RowOutcome['parsed']>): { name: string; keys: ExistingRecord } | null => {
  if (entity === 'customers' || entity === 'suppliers') {
    const row = parsed as CustomerRow;
    return {
      name: row.name,
      keys: {
        id: '',
        name: row.name,
        ...(row.tradeName === null ? {} : { aliases: [row.tradeName] }),
        ...(row.gstin === null ? {} : { gstins: [row.gstin] }),
        ...(row.pan === null ? {} : { pan: row.pan }),
        phones: row.phones,
        emails: row.emails,
        ...(row.externalId === null ? {} : { code: row.externalId }),
      },
    };
  }
  if (entity === 'items') {
    const row = parsed as ItemRow;
    return {
      name: row.name,
      keys: {
        id: '',
        name: row.name,
        aliases: [...row.barcodes],
        ...(row.externalId === null ? {} : { code: row.externalId }),
      },
    };
  }
  return null;
};

/** The key two rows of a stock or balance file must not share. */
const uniquenessKey = (entity: EntityKind, parsed: NonNullable<RowOutcome['parsed']>): string | null => {
  if (entity === 'opening_stock') {
    const row = parsed as OpeningStockRow;
    return `${normaliseName(row.itemRef)}|${row.warehouseRef ?? ''}|${row.batchNumber ?? ''}`;
  }
  if (entity === 'opening_balances') {
    const row = parsed as OpeningBalanceRow;
    return row.accountCode !== null ? `account:${row.accountCode.toUpperCase()}` : `party:${normaliseName(row.partyRef ?? '')}`;
  }
  return null;
};

const bilingual = (en: string, hi: string): Bilingual => ({ 'en-IN': en, 'hi-IN': hi });

export interface DuplicateOutcome {
  readonly outcomes: readonly RowOutcome[];
  readonly summary: DuplicateSummary;
}

/**
 * Marks duplicates on rows that were otherwise accepted.
 *
 * `existing` is what the business already has. It is passed in rather than fetched so this stays a
 * pure function: the same rows and the same existing records always give the same answer, which is
 * what makes the preview the person approves exactly what the commit does.
 */
export const markDuplicates = (
  entity: EntityKind,
  outcomes: readonly RowOutcome[],
  existing: readonly ExistingRecord[],
): DuplicateOutcome => {
  const seenNames = new Map<string, number>();
  const seenKeys = new Map<string, number>();
  const needsALook: DuplicateSummary['needsALook'][number][] = [];
  let withinFile = 0;
  let alreadyPresent = 0;

  const result = outcomes.map((outcome): RowOutcome => {
    if (outcome.decision !== 'ACCEPT' || outcome.parsed === null) return outcome;

    const key = uniquenessKey(entity, outcome.parsed);
    if (key !== null) {
      const first = seenKeys.get(key);
      if (first !== undefined) {
        withinFile += 1;
        return {
          ...outcome,
          parsed: null,
          decision: 'REJECT',
          duplicateOf: `row ${first}`,
          problems: [
            ...outcome.problems,
            {
              row: outcome.row,
              column: null,
              code: 'DUPLICATE_IN_FILE',
              severity: 'BLOCKING',
              value: key,
              message: bilingual(
                `The same entry already appears on row ${first} of this file. Two figures for one account are never added together, so please decide which one is right.`,
                `Yahi entry is file ki row ${first} mein bhi hai. Ek khaate ke do aankde jode nahin jaate; batayein kaunsa sahi hai.`,
              ),
            },
          ],
        };
      }
      seenKeys.set(key, outcome.row);
      return outcome;
    }

    const matchable = matchableOf(entity, outcome.parsed);
    if (matchable === null) return outcome;

    const normalised = normaliseName(matchable.name);
    const firstRow = seenNames.get(normalised);
    if (firstRow !== undefined) {
      withinFile += 1;
      return {
        ...outcome,
        decision: 'SKIP_DUPLICATE',
        duplicateOf: `row ${firstRow}`,
        problems: [
          ...outcome.problems,
          {
            row: outcome.row,
            column: null,
            code: 'DUPLICATE_IN_FILE',
            severity: 'WARNING',
            value: matchable.name,
            message: bilingual(
              `"${matchable.name}" is already on row ${firstRow} of this file, so this row was left out.`,
              `"${matchable.name}" is file ki row ${firstRow} mein pehle se hai, isliye yeh row chhod di gayi.`,
            ),
          },
        ],
      };
    }
    seenNames.set(normalised, outcome.row);

    const verdict = checkForDuplicates(existing, matchable.keys);
    if (verdict.decision === 'block') {
      alreadyPresent += 1;
      const candidate = verdict.candidates[0];
      const why = candidate?.reasons.map((reason) => reason.detail).join(' ') ?? '';
      return {
        ...outcome,
        decision: 'SKIP_DUPLICATE',
        duplicateOf: candidate?.record.name ?? 'an entry you already have',
        problems: [
          ...outcome.problems,
          {
            row: outcome.row,
            column: null,
            code: 'ALREADY_PRESENT',
            severity: 'WARNING',
            value: matchable.name,
            message: bilingual(
              `You already have "${candidate?.record.name ?? matchable.name}". ${why} This row was left out, and what you already have was not changed.`,
              `Aapke paas pehle se "${candidate?.record.name ?? matchable.name}" hai. ${why} Yeh row chhod di gayi aur purani entry badli nahin gayi.`,
            ),
          },
        ],
      };
    }
    if (verdict.decision === 'warn') {
      const candidate = verdict.candidates[0];
      const why = bilingual(
        `"${matchable.name}" looks close to "${candidate?.record.name ?? ''}". ${candidate?.reasons.map((reason) => reason.detail).join(' ') ?? ''}`,
        `"${matchable.name}" aur "${candidate?.record.name ?? ''}" milte-julte lagte hain.`,
      );
      needsALook.push({ row: outcome.row, name: matchable.name, existing: candidate?.record.name ?? '', why });
      return {
        ...outcome,
        problems: [
          ...outcome.problems,
          { row: outcome.row, column: null, code: 'SIMILAR_TO_EXISTING', severity: 'WARNING', value: matchable.name, message: why },
        ],
      };
    }
    return outcome;
  });

  return { outcomes: result, summary: { withinFile, alreadyPresent, needsALook } };
};
