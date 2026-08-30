/**
 * Issue #37 [E37] — reading the file exactly as it was written.
 *
 * Every one of these exports is "CSV" and none of them agree: Tally writes a title and a blank line
 * above the headings, Vyapar quotes an address with a comma inside it, a Windows machine writes
 * CRLF and a BOM, and somebody's file is tab separated because Excel was set to a European locale.
 * All of that is a reading problem, and it is solved here so that nothing downstream ever has to
 * think about it.
 *
 * Nothing in this file interprets a value. A cell arrives as the text it was, spaces and all.
 */

export interface Sheet {
  /** The header row, in file order. */
  readonly headers: readonly string[];
  /** One entry per data row: the cells, padded to the header count. */
  readonly rows: readonly (readonly string[])[];
  /** 1-based line number of each data row in the original file, for problem messages. */
  readonly rowNumbers: readonly number[];
  readonly delimiter: string;
  /** Rows above the header that were titles or blanks, kept so nothing is silently dropped. */
  readonly preamble: readonly string[];
}

const CANDIDATE_DELIMITERS = [',', '\t', ';', '|'] as const;

/** Splits one line's worth of a delimited file, honouring quotes. Returns every raw record. */
const splitRecords = (text: string, delimiter: string): string[][] => {
  const records: string[][] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let index = 0;

  const endCell = (): void => {
    cells.push(cell);
    cell = '';
  };
  const endRecord = (): void => {
    endCell();
    records.push(cells);
    cells = [];
  };

  while (index < text.length) {
    const character = text[index] as string;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      cell += character;
      index += 1;
      continue;
    }
    if (character === '"' && cell.trim() === '') {
      // A quote only opens a quoted field at the start of one; a stray quote mid-cell is data.
      cell = '';
      quoted = true;
      index += 1;
      continue;
    }
    if (character === delimiter) {
      endCell();
      index += 1;
      continue;
    }
    if (character === '\r') {
      index += text[index + 1] === '\n' ? 2 : 1;
      endRecord();
      continue;
    }
    if (character === '\n') {
      index += 1;
      endRecord();
      continue;
    }
    cell += character;
    index += 1;
  }
  if (cell !== '' || cells.length > 0) endRecord();
  return records;
};

/**
 * Works out which character separates the columns.
 *
 * The winner is the one that gives the most consistent column count across the first few lines,
 * which is a stronger signal than counting occurrences: an address full of commas beats a comma
 * count, but it does not beat consistency.
 */
export const sniffDelimiter = (text: string): string => {
  let best = ',';
  let bestScore = -1;
  for (const delimiter of CANDIDATE_DELIMITERS) {
    const sample = splitRecords(text, delimiter).slice(0, 20).filter((record) => record.some((c) => c.trim() !== ''));
    if (sample.length === 0) continue;
    const widths = sample.map((record) => record.length);
    const widest = Math.max(...widths);
    if (widest < 2) continue;
    const agreeing = widths.filter((width) => width === widest).length;
    const score = widest * 10 + agreeing;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
};

const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/**
 * Finds the heading row.
 *
 * Tally and BUSY put the company name, the report title and a date range above the headings. The
 * headings are the first row that has at least two filled cells and as many as the widest row, so a
 * title line — one filled cell — never wins.
 */
const findHeaderRow = (records: readonly (readonly string[])[]): number => {
  const widest = Math.max(0, ...records.map((record) => record.filter((c) => c.trim() !== '').length));
  for (let index = 0; index < records.length; index += 1) {
    const filled = (records[index] as readonly string[]).filter((cell) => cell.trim() !== '').length;
    if (filled >= 2 && filled >= Math.min(widest, 2)) return index;
  }
  return 0;
};

export interface ReadOptions {
  readonly delimiter?: string;
  /** Force a header row (0-based, counting every line) when the guess is wrong. */
  readonly headerRow?: number;
}

/** Turns the text of a delimited file into a sheet. Never throws on shape; that is a row problem. */
export const readDelimited = (raw: string, options: ReadOptions = {}): Sheet => {
  const text = stripBom(raw);
  const delimiter = options.delimiter ?? sniffDelimiter(text);
  const records = splitRecords(text, delimiter);
  const headerIndex = options.headerRow ?? findHeaderRow(records);
  const headers = (records[headerIndex] ?? []).map((cell) => cell.trim());
  const width = headers.length;

  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  for (let index = headerIndex + 1; index < records.length; index += 1) {
    const record = records[index] as string[];
    if (record.every((cell) => cell.trim() === '')) continue;
    const padded = Array.from({ length: width }, (_unused, column) => record[column] ?? '');
    rows.push(padded);
    rowNumbers.push(index + 1);
  }

  return {
    headers,
    rows,
    rowNumbers,
    delimiter,
    preamble: records.slice(0, headerIndex).map((record) => record.join(delimiter)).filter((line) => line.trim() !== ''),
  };
};

/** Reads a sheet into named cells, which is how everything downstream wants it. */
export const asRecords = (sheet: Sheet): Readonly<Record<string, string>>[] =>
  sheet.rows.map((row) => {
    const record: Record<string, string> = {};
    sheet.headers.forEach((header, index) => {
      record[header] = row[index] ?? '';
    });
    return record;
  });

const quoteIfNeeded = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

/** Writes a CSV, used for the error file the person hands back to whoever made the export. */
export const toCsv = (headers: readonly string[], rows: readonly (readonly string[])[]): string =>
  [headers, ...rows].map((row) => row.map((cell) => quoteIfNeeded(cell ?? '')).join(',')).join('\r\n');

/**
 * A spreadsheet reader, so `.xlsx` never becomes a dependency of the rules.
 *
 * `adapters/xlsx.ts` implements this over `read-excel-file`; the tests read CSV, so the whole
 * module runs with no dependencies installed at all.
 */
export interface SpreadsheetReader {
  read(bytes: Uint8Array): Promise<Sheet>;
}
