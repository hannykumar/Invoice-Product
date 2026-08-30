/**
 * Issue #37 [E37] — the file the person hands back to whoever made the export.
 *
 * A rejected row is useless as a screen message: the person fixing it is usually not the person
 * importing it, and they are working in Excel. So every refused row comes back as a line in a CSV
 * with its original cells untouched, the row number it had, and — in the same file — what is wrong
 * and what to do about it, in both languages. They fix that file and bring it in again.
 */
import { toCsv } from './csv.ts';
import type { RowOutcome } from './model.ts';

export const ERROR_FILE_COLUMNS = ['Row in your file', 'What is wrong', 'Kya galat hai', 'Which column'] as const;

/** True when there is anything to hand back. */
export const hasErrors = (outcomes: readonly RowOutcome[]): boolean =>
  outcomes.some((outcome) => outcome.decision === 'REJECT');

/**
 * Builds the error file: the original headers first, so the person can correct the row in place,
 * then the explanation columns.
 */
export const buildErrorFile = (headers: readonly string[], outcomes: readonly RowOutcome[]): string => {
  const rejected = outcomes.filter((outcome) => outcome.decision === 'REJECT');
  const rows = rejected.map((outcome) => {
    const blocking = outcome.problems.filter((problem) => problem.severity === 'BLOCKING');
    const shown = blocking.length > 0 ? blocking : outcome.problems;
    return [
      ...headers.map((header) => outcome.raw[header] ?? ''),
      String(outcome.row),
      shown.map((problem) => problem.message['en-IN']).join(' '),
      shown.map((problem) => problem.message['hi-IN']).join(' '),
      shown.map((problem) => problem.column ?? '').filter((column) => column !== '').join(', '),
    ];
  });
  return toCsv([...headers, ...ERROR_FILE_COLUMNS], rows);
};
