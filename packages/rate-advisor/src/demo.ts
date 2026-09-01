/**
 * A runnable walkthrough of issue #59: `npm run demo:rates`.
 *
 * It plays out the two situations in the issue's own user example, on synthetic data, and prints
 * what a reviewer needs to check the acceptance criteria by eye.
 */
import { COMPANY, OWNER, SYNTHETIC_BASIS, makeShop } from './fixtures.ts';
import type { RateAdvice } from './types.ts';

const line = (text = '') => console.log(text);
const heading = (text: string) => { line(); line(text); line('-'.repeat(text.length)); };

const show = (advice: RateAdvice): void => {
  if (advice.kind === 'SUGGESTED') {
    line(`  ${advice.suggestion.reason['en-IN']}`);
    line(`  ${advice.suggestion.question['en-IN']}`);
    return;
  }
  line(`  [${advice.reason}] ${advice.question['en-IN']}`);
  line(`  What would help: ${advice.whatWouldHelp['en-IN']}`);
  for (const candidate of advice.candidates) {
    line(`    · ${candidate.gstRateBasisPoints / 100}% from ${candidate.citation.source}`);
  }
};

export const runDemo = async (): Promise<void> => {
  const shop = makeShop();

  heading('1. The tax column on a photographed bill is unreadable');
  line('  The bill names TMT bars. The app offers the rate its own register holds, and says why.');
  show(await shop.advisor.suggest(COMPANY, { index: 0, description: 'TMT BAR 12MM', itemId: shop.items.steel }, '2026-08-29'));

  heading('2. The shopkeeper taps yes, and it is remembered');
  const advice = await shop.advisor.suggest(COMPANY, { index: 0, description: 'Cement', hsnSac: '25232930' }, '2026-08-29');
  if (advice.kind === 'SUGGESTED') {
    const learned = await shop.advisor.approve({ companyId: COMPANY, actorId: OWNER }, {
      idempotencyKey: 'demo-approve-cement',
      itemId: shop.items.cement,
      rate: advice.suggestion.rate,
      approvedOn: '2026-08-29',
    });
    line(`  ${learned.message['en-IN']}`);
    line(`  Recorded as: ${learned.source}`);
  }

  heading('3. A second bill charges 18% on cement, and the register now says otherwise');
  // A rate change is a new version of the entry that already exists, not a second entry beside it.
  // Two entries would be a register disagreeing with itself, which is a different problem.
  const cementEntry = shop.masters.taxDefaultCandidates(shop.context, { itemId: shop.items.cement }, '2026-08-29')[0];
  shop.masters.setTaxDefault(shop.context, {
    id: cementEntry?.data.id,
    itemId: shop.items.cement, gstRateBasisPoints: 2800, reverseCharge: false,
    source: `Cement revised to 28% from 30 August 2026 ${SYNTHETIC_BASIS}`,
  } as never, { idempotencyKey: shop.key('demo-cement-28'), effectiveFrom: '2026-08-30' });
  const check = await shop.advisor.check(
    COMPANY,
    { index: 1, description: 'Cement', itemId: shop.items.cement, printedRateBasisPoints: 1800 },
    '2026-09-01',
  );
  line(`  ${check?.finding?.message['en-IN'] ?? 'nothing to report'}`);
  line(`  Severity: ${check?.finding?.severity}. Neither figure is applied; a person decides.`);

  heading('4. A bill from before the change keeps the rate it was raised under');
  show(await shop.advisor.suggest(COMPANY, { index: 0, description: 'Cement', itemId: shop.items.cement }, '2026-08-29'));

  heading('5. The app read the line itself, so it asks before any rate follows');
  show(await shop.advisor.suggest(COMPANY, {
    index: 0,
    description: 'OPC CEMENT 50KG PPC GRADE 43',
    proposed: {
      hsnSac: '25232930', proposedBy: 'MODEL', modelReference: 'ocr-classifier-2026.8',
      confidence: 0.91, fromText: 'OPC CEMENT 50KG PPC GRADE 43',
    },
  }, '2026-08-29'));

  heading('6. Goods nobody has set a rate for');
  show(await shop.advisor.suggest(COMPANY, { index: 0, description: 'Assorted hardware', itemId: shop.items.mystery }, '2026-08-29'));

  line();
  line('Every rate above came from the register. None was produced by a model, and none was applied without a yes.');
  line();
};

await runDemo();
