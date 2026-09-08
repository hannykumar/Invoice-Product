/**
 * Issue #59 [E59] acceptance criteria, enforced automatically.
 *
 *   - "Every suggested rate names its source notification, its effective date and the HSN or item"
 *   - "No rate is ever applied without explicit user approval, and none is ever produced by a model"
 *   - "A printed rate that disagrees with the register raises a finding rather than being accepted"
 *   - "A document dated before a rate change keeps the rate in force on its own date"
 *   - "Where no default exists, the user is asked; nothing is guessed"
 *
 * plus the listed failure cases: item match, HSN match, no match, ambiguity, multiple candidates,
 * nil-rated and cess-bearing goods, and a model-proposed HSN always shown before a rate follows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPANY, OWNER, SYNTHETIC_BASIS, makeShop } from '../src/fixtures.ts';
import { agree, percent, resolve } from '../src/resolve.ts';
import type { ProposedClassification, RateAdvice, RegisterRate } from '../src/types.ts';

const suggested = (advice: RateAdvice) => {
  assert.equal(advice.kind, 'SUGGESTED', advice.kind === 'ASK' ? advice.question['en-IN'] : '');
  return (advice as Extract<RateAdvice, { kind: 'SUGGESTED' }>).suggestion;
};

const asked = (advice: RateAdvice) => {
  assert.equal(advice.kind, 'ASK', 'this line should not have been answered');
  return advice as Extract<RateAdvice, { kind: 'ASK' }>;
};

// ------------------------------------------------------------------ suggesting a rate

test('an item with its own default is suggested, with the notification and the date behind it', async () => {
  const shop = makeShop();
  const advice = await shop.advisor.suggest(
    COMPANY,
    { index: 0, description: 'TMT bars 12mm', itemId: shop.items.steel },
    '2026-08-29',
  );

  const suggestion = suggested(advice);
  assert.equal(suggestion.rate.gstRateBasisPoints, 1800);
  assert.equal(suggestion.rate.basis, 'ITEM_DEFAULT');
  // The first acceptance criterion, field by field.
  assert.match(suggestion.rate.citation.source, /Notification 1\/2017-CTR Schedule III entry 224/);
  assert.equal(suggestion.rate.citation.effectiveFrom, '2026-04-01');
  assert.equal(suggestion.rate.subject.kind, 'ITEM');
  assert.equal(suggestion.asOf, '2026-08-29');
  // And the sentence a shopkeeper actually reads has all of it in it.
  assert.match(suggestion.reason['en-IN'], /^18% — because this is TMT Steel Bar 12mm \(HSN 72142090\)/);
  assert.match(suggestion.reason['en-IN'], /Notification 1\/2017-CTR Schedule III entry 224/);
  assert.match(suggestion.question['en-IN'], /Use 18%\?/);
  assert.ok(suggestion.reason['hi-IN'].length > 0, 'the reason has to exist in both languages');
});

test('a line with only an HSN is answered from the HSN default', async () => {
  const shop = makeShop();
  const advice = await shop.advisor.suggest(
    COMPANY,
    { index: 0, description: 'Cement bags', hsnSac: '25232930' },
    '2026-08-29',
  );

  const suggestion = suggested(advice);
  assert.equal(suggestion.rate.basis, 'HSN_DEFAULT');
  assert.equal(suggestion.rate.gstRateBasisPoints, 1800);
  assert.equal(suggestion.rate.subject.kind, 'HSN');
  assert.match(suggestion.reason['en-IN'], /HSN 25232930/);
});

test('an item default beats an HSN default for the same line', async () => {
  // Both exist for cement once an item-level entry is added. The more specific one has to win, or
  // a business that has deliberately set a rate for one brand is overruled by a general entry.
  const shop = makeShop();
  shop.masters.setTaxDefault(shop.context, {
    itemId: shop.items.cement, gstRateBasisPoints: 2800, reverseCharge: false,
    source: `The rate this business actually charges. ${SYNTHETIC_BASIS}`,
  } as never, { idempotencyKey: shop.key('tax-cement-item'), effectiveFrom: '2026-04-01' });

  const advice = await shop.advisor.suggest(
    COMPANY,
    { index: 0, description: 'Cement', itemId: shop.items.cement, hsnSac: '25232930' },
    '2026-08-29',
  );
  const suggestion = suggested(advice);
  assert.equal(suggestion.rate.basis, 'ITEM_DEFAULT');
  assert.equal(suggestion.rate.gstRateBasisPoints, 2800);
});

test('cess and reverse charge travel with the rate, so a suggestion never under-bills', async () => {
  const shop = makeShop();
  const advice = await shop.advisor.suggest(
    COMPANY,
    { index: 0, description: 'Cola 300ml', hsnSac: '22021010' },
    '2026-08-29',
  );

  const suggestion = suggested(advice);
  assert.equal(suggestion.rate.gstRateBasisPoints, 2800);
  assert.equal(suggestion.rate.cessRateBasisPoints, 1200);
  assert.match(suggestion.reason['en-IN'], /plus cess at 12%/);
});

test('a nil-rated entry is suggested as 0%, not treated as a missing rate', async () => {
  // Zero is an answer. A product that treats "0%" as "no rate found" sends a shopkeeper hunting for
  // a rate that does not exist, on goods that genuinely carry none.
  const shop = makeShop();
  const item = shop.masters.createItem(shop.context, {
    code: 'MILK', name: 'Fresh milk 500ml', kind: 'goods', hsnSac: '04011000', baseUnit: 'PCS',
  } as never, { idempotencyKey: shop.key('item-milk'), effectiveFrom: '2026-04-01' }).record.id;
  shop.masters.setTaxDefault(shop.context, {
    itemId: item, gstRateBasisPoints: 0, reverseCharge: false,
    source: `Nil-rated under Notification 2/2017-CTR. ${SYNTHETIC_BASIS}`,
  } as never, { idempotencyKey: shop.key('tax-milk'), effectiveFrom: '2026-04-01' });

  const suggestion = suggested(await shop.advisor.suggest(COMPANY, { index: 0, description: 'Milk', itemId: item }, '2026-08-29'));
  assert.equal(suggestion.rate.gstRateBasisPoints, 0);
  assert.match(suggestion.reason['en-IN'], /^0% — because/);
});

test('reverse charge is said out loud in the suggestion', async () => {
  const shop = makeShop();
  const item = shop.masters.createItem(shop.context, {
    code: 'FRT', name: 'Goods transport by road', kind: 'service', hsnSac: '996511', baseUnit: 'NOS',
  } as never, { idempotencyKey: shop.key('item-frt'), effectiveFrom: '2026-04-01' }).record.id;
  shop.masters.setTaxDefault(shop.context, {
    itemId: item, gstRateBasisPoints: 500, reverseCharge: true,
    source: `Reverse charge on goods transport. ${SYNTHETIC_BASIS}`,
  } as never, { idempotencyKey: shop.key('tax-frt'), effectiveFrom: '2026-04-01' });

  const suggestion = suggested(await shop.advisor.suggest(COMPANY, { index: 0, description: 'Freight', itemId: item }, '2026-08-29'));
  assert.equal(suggestion.rate.reverseCharge, true);
  assert.match(suggestion.reason['en-IN'], /paid by the buyer/);
});

// ------------------------------------------------------------------ the document's own date

test('a bill from before a rate change keeps the rate that was in force on its own date', async () => {
  // Cement moves from 18% to 28% on 1 July. A bill dated 20 June must still be answered with 18%,
  // whatever today is. This is the criterion a wall-clock default would silently break.
  const shop = makeShop();
  shop.masters.setTaxDefault(shop.context, {
    id: [...shop.masters.taxDefaultCandidates(shop.context, { hsnSac: '25232930' }, '2026-08-29')][0]?.data.id,
    hsnSac: '25232930', gstRateBasisPoints: 2800, reverseCharge: false,
    source: `Rate revised from 1 July 2026. ${SYNTHETIC_BASIS}`,
  } as never, { idempotencyKey: shop.key('tax-cement-new'), effectiveFrom: '2026-07-01' });

  const june = suggested(await shop.advisor.suggest(COMPANY, { index: 0, description: 'Cement', hsnSac: '25232930' }, '2026-06-20'));
  assert.equal(june.rate.gstRateBasisPoints, 1800);
  assert.equal(june.rate.citation.effectiveFrom, '2026-04-01');

  const august = suggested(await shop.advisor.suggest(COMPANY, { index: 0, description: 'Cement', hsnSac: '25232930' }, '2026-08-29'));
  assert.equal(august.rate.gstRateBasisPoints, 2800);
  assert.equal(august.rate.citation.effectiveFrom, '2026-07-01');
});

test('a bill dated before the register entry existed is asked about, not answered from it', async () => {
  // The register starts on 1 April. A bill from 15 March has an item to match on and nothing to
  // match it against, so the honest answer is a question rather than April's rate applied backwards.
  const shop = makeShop();
  const question = asked(await shop.advisor.suggest(
    COMPANY,
    { index: 0, description: 'TMT bars', itemId: shop.items.steel },
    '2026-03-15',
  ));
  assert.equal(question.reason, 'NO_ENTRY');
  assert.deepEqual([...question.candidates], []);
});

// ------------------------------------------------------------------ asking rather than guessing

test('an item with no default anywhere produces a question, not a rate', async () => {
  const shop = makeShop();
  const advice = await shop.advisor.suggest(
    COMPANY,
    { index: 0, description: 'Assorted hardware', itemId: shop.items.mystery },
    '2026-08-29',
  );

  const question = asked(advice);
  assert.equal(question.reason, 'NO_ENTRY');
  assert.deepEqual([...question.candidates], []);
  assert.match(question.question['en-IN'], /do not have a GST rate for this yet/);
  assert.ok(question.whatWouldHelp['en-IN'].length > 20, 'a question has to say what would answer it');
});

test('a line with nothing to match on says so, rather than saying no entry exists', async () => {
  // The two are different problems with different answers: one needs a rate set up, the other needs
  // somebody to say what the goods are.
  const shop = makeShop();
  const question = asked(await shop.advisor.suggest(COMPANY, { index: 0, description: 'Item as printed' }, '2026-08-29'));
  assert.equal(question.reason, 'NOTHING_TO_MATCH_ON');
  assert.match(question.whatWouldHelp['en-IN'], /HSN code/);
});

test('two entries that disagree are both shown and neither is picked', async () => {
  const shop = makeShop();
  shop.masters.setTaxDefault(shop.context, {
    hsnSac: '25232930', gstRateBasisPoints: 2800, reverseCharge: false,
    source: `A second entry somebody added by mistake. ${SYNTHETIC_BASIS}`,
  } as never, { idempotencyKey: shop.key('tax-cement-dupe'), effectiveFrom: '2026-04-01' });

  const question = asked(await shop.advisor.suggest(COMPANY, { index: 0, description: 'Cement', hsnSac: '25232930' }, '2026-08-29'));
  assert.equal(question.reason, 'CONFLICTING_ENTRIES');
  assert.equal(question.candidates.length, 2);
  assert.match(question.question['en-IN'], /18% and 28%|28% and 18%/);
  assert.match(question.whatWouldHelp['en-IN'], /Remove the entries that are wrong/);
});

test('two entries that agree are not treated as a conflict', async () => {
  const shop = makeShop();
  shop.masters.setTaxDefault(shop.context, {
    hsnSac: '25232930', gstRateBasisPoints: 1800, reverseCharge: false,
    source: `The same rate, recorded twice. ${SYNTHETIC_BASIS}`,
  } as never, { idempotencyKey: shop.key('tax-cement-same'), effectiveFrom: '2026-04-01' });

  const suggestion = suggested(await shop.advisor.suggest(COMPANY, { index: 0, description: 'Cement', hsnSac: '25232930' }, '2026-08-29'));
  assert.equal(suggestion.rate.gstRateBasisPoints, 1800);
});

test('entries agreeing on the rate but not on the cess are still a conflict', async () => {
  // The trap: comparing only the headline percentage would call these the same and quietly drop
  // 12% of cess off the bill.
  const shop = makeShop();
  shop.masters.setTaxDefault(shop.context, {
    hsnSac: '22021010', gstRateBasisPoints: 2800, reverseCharge: false,
    source: `Same rate, no cess recorded. ${SYNTHETIC_BASIS}`,
  } as never, { idempotencyKey: shop.key('tax-cola-nocess'), effectiveFrom: '2026-04-01' });

  const question = asked(await shop.advisor.suggest(COMPANY, { index: 0, description: 'Cola', hsnSac: '22021010' }, '2026-08-29'));
  assert.equal(question.reason, 'CONFLICTING_ENTRIES');
});

// ------------------------------------------------------------------ what a model may propose

test('a model-proposed classification is shown for confirmation before any rate follows from it', async () => {
  const shop = makeShop();
  const proposed: ProposedClassification = {
    hsnSac: '25232930',
    proposedBy: 'MODEL',
    modelReference: 'ocr-classifier-2026.8',
    confidence: 0.91,
    fromText: 'OPC CEMENT 50KG PPC GRADE 43',
  };

  const question = asked(await shop.advisor.suggest(
    COMPANY,
    { index: 0, description: 'OPC CEMENT 50KG PPC GRADE 43', proposed },
    '2026-08-29',
  ));
  assert.equal(question.reason, 'CLASSIFICATION_UNCONFIRMED');
  assert.equal(question.awaitingConfirmationOf?.modelReference, 'ocr-classifier-2026.8');
  // The wording has to admit where it came from. "We read X as Y" is a claim a person can reject.
  assert.match(question.question['en-IN'], /worked out by the app, not read off the bill/);
});

test('once the classification is confirmed, the rate follows from the register', async () => {
  const shop = makeShop();
  const confirmed: ProposedClassification = {
    hsnSac: '25232930',
    proposedBy: 'MODEL',
    modelReference: 'ocr-classifier-2026.8',
    confidence: 0.91,
    fromText: 'OPC CEMENT 50KG PPC GRADE 43',
    confirmedBy: OWNER,
    confirmedAt: '2026-08-29T10:05:00.000Z',
  };

  const suggestion = suggested(await shop.advisor.suggest(
    COMPANY,
    { index: 0, description: 'OPC CEMENT 50KG PPC GRADE 43', proposed: confirmed },
    '2026-08-29',
  ));
  assert.equal(suggestion.rate.gstRateBasisPoints, 1800);
  // And the suggestion still carries the fact that it rests on a machine's reading.
  assert.equal(suggestion.restingOn?.proposedBy, 'MODEL');
  assert.equal(suggestion.restingOn?.confirmedBy, OWNER);
});

test('a model has nowhere to put a rate, by construction', () => {
  // The second acceptance criterion, made structural rather than remembered. If somebody ever adds
  // a rate field to what a model may propose, this fails.
  const keys = new Set(Object.keys({
    hsnSac: '', itemId: '', proposedBy: 'MODEL', modelReference: '', confidence: 0,
    fromText: '', confirmedBy: '', confirmedAt: '',
  } satisfies Record<keyof ProposedClassification, unknown>));
  for (const forbidden of ['rate', 'gstRateBasisPoints', 'ratePercentTimes100', 'cessRateBasisPoints', 'percent']) {
    assert.ok(!keys.has(forbidden), `a model must not be able to propose ${forbidden}`);
  }
});

// ------------------------------------------------------------------ checking a printed rate

test('a printed rate that disagrees with the register raises a material finding', async () => {
  // The issue's own example: a bill charges 18% on cement, the register says 28%.
  const shop = makeShop();
  shop.masters.setTaxDefault(shop.context, {
    itemId: shop.items.cement, gstRateBasisPoints: 2800, reverseCharge: false,
    source: `Cement at 28%. ${SYNTHETIC_BASIS}`,
  } as never, { idempotencyKey: shop.key('tax-cement-28'), effectiveFrom: '2026-04-01' });

  const check = await shop.advisor.check(
    COMPANY,
    { index: 2, description: 'Cement', itemId: shop.items.cement, printedRateBasisPoints: 1800 },
    '2026-08-29',
  );

  assert.ok(check !== null);
  assert.equal(check.verdict, 'DISAGREES');
  assert.equal(check.finding?.code, 'GST_RATE_DISAGREES_WITH_REGISTER');
  assert.equal(check.finding?.severity, 'MATERIAL');
  assert.equal(check.finding?.field, 'lines[2].gstRateBasisPoints');
  assert.match(check.finding?.message['en-IN'] ?? '', /This bill charges 18%, but your records say 28%/);
  assert.match(check.finding?.message['en-IN'] ?? '', /One of them is wrong/);
  // Neither side is declared the winner: both figures are on the finding.
  assert.equal(check.documentSaysBasisPoints, 1800);
  assert.equal(check.registerSays?.gstRateBasisPoints, 2800);
});

test('a printed rate that matches raises nothing', async () => {
  const shop = makeShop();
  const check = await shop.advisor.check(
    COMPANY,
    { index: 0, description: 'TMT bars', itemId: shop.items.steel, printedRateBasisPoints: 1800 },
    '2026-08-29',
  );
  assert.equal(check?.verdict, 'AGREES');
  assert.equal(check?.finding, null);
});

test('a rate the register has nothing to say about is reported as unchecked, not as fine', async () => {
  const shop = makeShop();
  const check = await shop.advisor.check(
    COMPANY,
    { index: 1, description: 'Assorted hardware', itemId: shop.items.mystery, printedRateBasisPoints: 1800 },
    '2026-08-29',
  );
  assert.equal(check?.verdict, 'NOT_IN_REGISTER');
  assert.equal(check?.finding?.code, 'GST_RATE_NOT_IN_REGISTER');
  assert.match(check?.finding?.message['en-IN'] ?? '', /nothing was checked against it/);
});

test('a register that disagrees with itself cannot be used to check a bill', async () => {
  const shop = makeShop();
  shop.masters.setTaxDefault(shop.context, {
    hsnSac: '25232930', gstRateBasisPoints: 2800, reverseCharge: false,
    source: `A second, conflicting entry. ${SYNTHETIC_BASIS}`,
  } as never, { idempotencyKey: shop.key('tax-cement-conflict'), effectiveFrom: '2026-04-01' });

  const check = await shop.advisor.check(
    COMPANY,
    { index: 0, description: 'Cement', hsnSac: '25232930', printedRateBasisPoints: 1800 },
    '2026-08-29',
  );
  assert.equal(check?.verdict, 'REGISTER_CONFLICTED');
  assert.equal(check?.finding?.code, 'GST_RATE_REGISTER_CONFLICTED');
  assert.match(check?.finding?.message['en-IN'] ?? '', /records need fixing first/);
});

test('a line with no printed rate is not cross-checked at all', async () => {
  const shop = makeShop();
  const check = await shop.advisor.check(COMPANY, { index: 0, description: 'Cement', hsnSac: '25232930' }, '2026-08-29');
  assert.equal(check, null, 'there is nothing to check when the bill did not state a rate');
});

test('a printed rate is checked against the rate in force on the bill’s own date', async () => {
  const shop = makeShop();
  shop.masters.setTaxDefault(shop.context, {
    hsnSac: '25232930', gstRateBasisPoints: 2800, reverseCharge: false,
    source: `Revised from 1 July 2026. ${SYNTHETIC_BASIS}`,
  } as never, { idempotencyKey: shop.key('tax-cement-july'), effectiveFrom: '2026-07-01' });

  // A June bill charging 18% was right in June, and must not be flagged against July's rate.
  const june = await shop.advisor.check(
    COMPANY,
    { index: 0, description: 'Cement', hsnSac: '25232930', printedRateBasisPoints: 1800 },
    '2026-06-20',
  );
  assert.equal(june?.verdict, 'AGREES', june?.message['en-IN']);
});

// ------------------------------------------------------------------ approving and remembering

test('nothing is applied until somebody approves, and approving remembers it for next time', async () => {
  const shop = makeShop();
  const suggestion = suggested(await shop.advisor.suggest(
    COMPANY,
    { index: 0, description: 'Cement', itemId: shop.items.cement, hsnSac: '25232930' },
    '2026-08-29',
  ));
  // Before approval, the item still has no item-level default of its own.
  assert.equal(shop.masters.taxDefaultCandidates(shop.context, { itemId: shop.items.cement }, '2026-08-29').length, 0);

  const learned = await shop.advisor.approve({ companyId: COMPANY, actorId: OWNER }, {
    idempotencyKey: 'approve-cement-1',
    itemId: shop.items.cement,
    rate: suggestion.rate,
    approvedOn: '2026-08-29',
  });

  assert.equal(learned.learned, true);
  assert.equal(learned.gstRateBasisPoints, 1800);
  assert.equal(learned.effectiveFrom, '2026-08-29');
  // Learned at item level, so the next bill for this item answers without asking.
  const next = suggested(await shop.advisor.suggest(COMPANY, { index: 0, description: 'Cement', itemId: shop.items.cement }, '2026-09-01'));
  assert.equal(next.rate.basis, 'ITEM_DEFAULT');
  assert.equal(next.rate.gstRateBasisPoints, 1800);
});

test('an approved rate records who approved it and where it came from', async () => {
  const shop = makeShop();
  const suggestion = suggested(await shop.advisor.suggest(COMPANY, { index: 0, description: 'Cement', hsnSac: '25232930' }, '2026-08-29'));
  const learned = await shop.advisor.approve({ companyId: COMPANY, actorId: OWNER }, {
    idempotencyKey: 'approve-cement-2',
    itemId: shop.items.cement,
    rate: suggestion.rate,
    approvedOn: '2026-08-29',
  });

  assert.match(learned.source, /Notification 1\/2017-CTR Schedule III/);
  assert.match(learned.source, /in force from 2026-04-01/);
  assert.match(learned.source, new RegExp(`approved by ${OWNER} on 2026-08-29`));

  const entry = shop.rateAudit.events.find((event) => event.action === 'rate.suggestion.approved');
  assert.ok(entry !== undefined, 'approving a rate is a material action and belongs in the audit trail');
  assert.equal(entry.actorId, OWNER);
  assert.equal(entry.details?.registerEntryId, suggestion.rate.citation.registerEntryId);
  assert.equal(entry.details?.classificationProposedBy, 'none');
});

test('the learned rate takes effect from the approval date, not the bill’s date', async () => {
  // Approving today says what is true from today. Back-dating it to the bill would silently
  // restate every earlier bill for that item.
  const shop = makeShop();
  const suggestion = suggested(await shop.advisor.suggest(COMPANY, { index: 0, description: 'Cement', hsnSac: '25232930' }, '2026-05-10'));
  const learned = await shop.advisor.approve({ companyId: COMPANY, actorId: OWNER }, {
    idempotencyKey: 'approve-cement-3',
    itemId: shop.items.cement,
    rate: suggestion.rate,
    approvedOn: '2026-08-29',
  });

  assert.equal(learned.effectiveFrom, '2026-08-29');
  assert.equal(shop.masters.taxDefaultCandidates(shop.context, { itemId: shop.items.cement }, '2026-05-10').length, 0);
  assert.equal(shop.masters.taxDefaultCandidates(shop.context, { itemId: shop.items.cement }, '2026-08-29').length, 1);
});

test('approving twice on a slow connection saves one default, not two', async () => {
  const shop = makeShop();
  const suggestion = suggested(await shop.advisor.suggest(COMPANY, { index: 0, description: 'Cement', hsnSac: '25232930' }, '2026-08-29'));
  const command = {
    idempotencyKey: 'approve-cement-retry',
    itemId: shop.items.cement,
    rate: suggestion.rate,
    approvedOn: '2026-08-29',
  };

  const first = await shop.advisor.approve({ companyId: COMPANY, actorId: OWNER }, command);
  const retried = await shop.advisor.approve({ companyId: COMPANY, actorId: OWNER }, command);

  assert.equal(retried.gstRateBasisPoints, first.gstRateBasisPoints);
  assert.equal(shop.masters.taxDefaultCandidates(shop.context, { itemId: shop.items.cement }, '2026-08-29').length, 1);
});

test('a rate resting on an unconfirmed model reading cannot be approved', async () => {
  const shop = makeShop();
  const suggestion = suggested(await shop.advisor.suggest(COMPANY, { index: 0, description: 'TMT', itemId: shop.items.steel }, '2026-08-29'));

  await assert.rejects(
    () => shop.advisor.approve({ companyId: COMPANY, actorId: OWNER }, {
      idempotencyKey: 'approve-unconfirmed',
      itemId: shop.items.steel,
      rate: suggestion.rate,
      approvedOn: '2026-08-29',
      confirmedClassification: {
        hsnSac: '72142090', proposedBy: 'MODEL', modelReference: 'ocr-classifier-2026.8',
        confidence: 0.91, fromText: 'TMT BAR 12MM',
      },
    }),
    /Somebody has to confirm that first/,
  );
});

test('an approval that rested on a confirmed model reading records that it did', async () => {
  const shop = makeShop();
  const suggestion = suggested(await shop.advisor.suggest(COMPANY, { index: 0, description: 'TMT', itemId: shop.items.steel }, '2026-08-29'));
  await shop.advisor.approve({ companyId: COMPANY, actorId: OWNER }, {
    idempotencyKey: 'approve-confirmed',
    itemId: shop.items.steel,
    rate: suggestion.rate,
    approvedOn: '2026-08-29',
    confirmedClassification: {
      hsnSac: '72142090', proposedBy: 'MODEL', modelReference: 'ocr-classifier-2026.8',
      confidence: 0.91, fromText: 'TMT BAR 12MM', confirmedBy: OWNER, confirmedAt: '2026-08-29T10:05:00.000Z',
    },
  });

  const entry = shop.rateAudit.events.find((event) => event.action === 'rate.suggestion.approved');
  assert.equal(entry?.details?.classificationProposedBy, 'ocr-classifier-2026.8');
  const saved = shop.masters.taxDefaultCandidates(shop.context, { itemId: shop.items.steel }, '2026-08-29');
  assert.ok(saved.some((version) => /confirmed by/.test(version.data.source)));
});

// ------------------------------------------------------------------ small things worth pinning

test('percentages read the way a person writes them', () => {
  assert.equal(percent(1800), '18%');
  assert.equal(percent(0), '0%');
  assert.equal(percent(250), '2.5%');
  assert.equal(percent(2800), '28%');
});

test('two rates agree only when every figure a bill depends on agrees', () => {
  const base: RegisterRate = {
    gstRateBasisPoints: 2800, cessRateBasisPoints: 1200, reverseCharge: false, basis: 'HSN_DEFAULT',
    subject: { kind: 'HSN', hsnSac: '22021010', describedAs: null },
    citation: { source: 'x', effectiveFrom: '2026-04-01', registerEntryId: 'e1' },
  };
  assert.equal(agree(base, { ...base, citation: { ...base.citation, registerEntryId: 'e2' } }), true);
  assert.equal(agree(base, { ...base, cessRateBasisPoints: 0 }), false);
  assert.equal(agree(base, { ...base, reverseCharge: true }), false);
});

test('the resolver never answers from an empty register', () => {
  const advice = resolve({ asOf: '2026-08-29', entries: [], item: null, hadSomethingToMatchOn: true });
  assert.equal(advice.kind, 'ASK');
});
