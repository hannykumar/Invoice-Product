/**
 * Issue #11 [E11] — the sentences a till shows go through issue #46's linter.
 *
 * These are read at a counter, often by someone who has never studied accounting, and often while
 * a customer waits. Wording that is only reviewed by eye drifts.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { supportedLocales, type Locale } from '@invoice/ux-vocabulary';
import { lintUserFacingText } from '@invoice/ux-vocabulary/lint';
import type { Bilingual } from '../src/index.ts';
import { ABC, inr, makeDesk, on } from './fixtures.ts';

/** Words these pages teach on purpose: a bill and a credit limit are the subject matter. */
const TAUGHT = ['gst', 'credit', 'discount', 'bill', 'stock', 'balance', 'limit'];

const check = (sentence: Bilingual, where: string): void => {
  for (const locale of supportedLocales() as readonly Locale[]) {
    const issues = lintUserFacingText(sentence[locale], { locale, allow: TAUGHT });
    assert.equal(issues.length, 0, `${where} (${locale}): "${sentence[locale]}" — ${issues.map((i) => i.detail).join('; ')}`);
  }
};

test('every sentence a quote produces is one a shopkeeper can read', async () => {
  const desk = makeDesk({ blockWhenOverdueByDays: 30 });
  desk.parties.setLimit(inr(1000));
  desk.positions.set(inr(900), 45);
  desk.cost.set({ CRATE: inr(120) });
  desk.priceList.set([{ itemId: 'CRATE', amount: inr(200), name: 'Shop rates' }]);

  const quote = await desk.service.quote(desk.actor, {
    partyId: ABC,
    documentDate: on('2026-08-29'),
    lines: [{ lineId: 'l1', itemId: 'CRATE', itemName: 'Plastic crate', unit: 'PCS', quantity: '10', unitPrice: inr(100) }],
  });

  check(quote.credit.sentence, 'credit verdict');
  check(quote.credit.why, 'credit explanation');
  for (const line of quote.lines) {
    check(line.price.sentence, 'price suggestion');
    if (line.discount !== null) check(line.discount.sentence, 'discount');
    if (line.margin !== null) check(line.margin.sentence, 'margin warning');
  }
  for (const reason of quote.reasons) check(reason, 'reason shown to the person');
});

test('the sentences for a customer with no history and no limit read plainly too', async () => {
  const desk = makeDesk();
  const quote = await desk.service.quote(desk.actor, {
    partyId: ABC,
    documentDate: on('2026-08-29'),
    lines: [{ lineId: 'l1', itemId: 'CRATE', itemName: 'Plastic crate', unit: 'PCS', quantity: '10' }],
  });
  check(quote.credit.sentence, 'no limit set');
  check(quote.credit.why, 'no limit explanation');
  check(quote.lines[0]?.price.sentence as Bilingual, 'no price known');
});
