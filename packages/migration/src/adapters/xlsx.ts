/**
 * Issue #37 [E37] — reading an actual `.xlsx`, which is what people really send.
 *
 * The spreadsheet library sits behind `SpreadsheetReader` and is loaded only when a workbook
 * arrives, so the rules, the tests and `npm test` never depend on it. What comes back is text — the
 * same text a CSV would have given — because every value in this module is interpreted by
 * `coerce.ts` and nowhere else.
 *
 * One thing to know about workbooks: a cell formatted as a number arrives as a number, and a
 * number is where exactness goes to die. Whole rupees and paise survive it (they are exact in
 * binary-to-decimal round-tripping at these magnitudes), but a cell someone has formatted to show
 * two decimals while holding four will arrive with all four and be refused by `readMoney`, which is
 * the right answer: the file says something the person cannot see.
 */
import type { Sheet, SpreadsheetReader } from '../csv.ts';

type Cell = string | number | boolean | Date | null;

const asText = (value: Cell): string => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
  }
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value);
  return String(value);
};

/** Finds the heading row the same way the CSV reader does: the first properly filled row. */
const headerIndexOf = (rows: readonly (readonly Cell[])[]): number => {
  for (let index = 0; index < rows.length; index += 1) {
    const filled = (rows[index] ?? []).filter((cell) => asText(cell).trim() !== '').length;
    if (filled >= 2) return index;
  }
  return 0;
};

export interface XlsxReaderOptions {
  /** Which sheet to read, 1-based. The first sheet by default, as every export writes one. */
  readonly sheet?: number;
}

/**
 * A reader over `read-excel-file`, imported when it is used.
 *
 * If the dependency is not installed — some sandboxes cannot install anything — this says so in
 * words a person can act on rather than failing with a module-resolution stack trace.
 */
export const xlsxReader = (options: XlsxReaderOptions = {}): SpreadsheetReader => ({
  async read(bytes: Uint8Array): Promise<Sheet> {
    let readXlsxFile: (input: unknown, config?: unknown) => Promise<Cell[][]>;
    try {
      const module = (await import('read-excel-file/node')) as unknown as { default: typeof readXlsxFile };
      readXlsxFile = module.default;
    } catch {
      throw new Error(
        'Excel files cannot be read on this installation. Open the file in Excel, choose "Save as" and pick CSV, then bring that in instead.',
      );
    }

    const rows = await readXlsxFile(Buffer.from(bytes), { sheet: options.sheet ?? 1 });
    const headerIndex = headerIndexOf(rows);
    const headers = (rows[headerIndex] ?? []).map((cell) => asText(cell).trim());
    const data = rows.slice(headerIndex + 1).filter((row) => row.some((cell) => asText(cell).trim() !== ''));

    return {
      headers,
      rows: data.map((row) => headers.map((_header, column) => asText(row[column] ?? null))),
      rowNumbers: data.map((_row, index) => headerIndex + index + 2),
      delimiter: ',',
      preamble: rows.slice(0, headerIndex).map((row) => row.map(asText).filter((cell) => cell !== '').join(' ')).filter((line) => line !== ''),
    };
  },
});

/**
 * Turns a workbook into the CSV text `MigrationService.analyse` takes.
 *
 * The service works on text on purpose: the file a person uploads and the bytes whose digest stops
 * a second import must be one and the same thing, whatever format they arrived in.
 */
export const workbookToCsv = async (bytes: Uint8Array, options: XlsxReaderOptions = {}): Promise<string> => {
  const sheet = await xlsxReader(options).read(bytes);
  const { toCsv } = await import('../csv.ts');
  return toCsv(sheet.headers, sheet.rows);
};
