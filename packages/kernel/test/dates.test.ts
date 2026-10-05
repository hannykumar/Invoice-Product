/**
 * Issue #234 — "today" is the calendar date in India, never the UTC date.
 *
 * India is five and a half hours ahead of UTC all year. Between midnight and 05:30 in India the UTC
 * date is still yesterday, so a bill made then and dated by UTC would carry yesterday's date.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixedClock, indiaDateOf, indiaToday, readIndianTimestamp, writeIndianTimestamp } from '../src/index.ts';

test('00:30 in India on 28 Sep is 28 Sep, although it is still 27 Sep in UTC', () => {
  assert.equal(indiaDateOf('2026-09-27T19:00:00.000Z'), '2026-09-28');
  assert.equal(new Date('2026-09-27T19:00:00.000Z').toISOString().slice(0, 10), '2026-09-27');
});

test('05:29 and 05:30 in the morning in India are the same day, and 23:59 is still that day', () => {
  assert.equal(indiaDateOf('2026-09-27T23:59:00.000Z'), '2026-09-28');
  assert.equal(indiaDateOf('2026-09-28T00:00:00.000Z'), '2026-09-28');
  assert.equal(indiaDateOf('2026-09-28T18:29:59.000Z'), '2026-09-28');
  assert.equal(indiaDateOf('2026-09-28T18:30:00.000Z'), '2026-09-29');
});

test('the last evening of March in India already belongs to the new financial year at midnight', () => {
  assert.equal(indiaDateOf('2027-03-31T18:30:00.000Z'), '2027-04-01');
});

test('today by a clock is the India date of that clock', () => {
  assert.equal(indiaToday(fixedClock('2026-08-29T10:00:00.000Z')), '2026-08-29');
});

test('issue #283 — a portal timestamp is Indian wall-clock time, whatever the server zone', () => {
  assert.equal(readIndianTimestamp('2026-09-29 20:12:51').toISOString(), '2026-09-29T14:42:51.000Z');
  assert.equal(readIndianTimestamp('29/09/2026 20:12:51').toISOString(), '2026-09-29T14:42:51.000Z');
  assert.equal(readIndianTimestamp('29/09/2026 08:12:51 PM').toISOString(), '2026-09-29T14:42:51.000Z');
  assert.equal(readIndianTimestamp('29/09/2026 12:05:00 AM').toISOString(), '2026-09-28T18:35:00.000Z');
  assert.equal(readIndianTimestamp('2026-09-29T14:42:51Z').toISOString(), '2026-09-29T14:42:51.000Z');
  assert.ok(Number.isNaN(readIndianTimestamp('not a time').getTime()));
  const at = new Date('2026-09-29T14:42:51.000Z');
  assert.equal(writeIndianTimestamp(at, 'YYYY-MM-DD'), '2026-09-29 20:12:51');
  assert.equal(writeIndianTimestamp(at), '29/09/2026 20:12:51');
});
