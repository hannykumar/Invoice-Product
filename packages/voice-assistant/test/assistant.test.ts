/**
 * Issue #10 [E10] acceptance criteria, enforced automatically.
 *
 *  - "Low-confidence quantity, unit, price or party is never silently accepted"
 *  - "User can correct one field without repeating everything"
 *  - "Final action uses the same approval rules as manual entry"
 *
 * plus the required 17/70, kg-or-box and tax-inclusive ambiguity tests, similar-name tests, and
 * noisy code-switched speech.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, asId, isoDate, toDecimalString, type CompanyId } from '@invoice/kernel';
import { lintUserFacingText } from '../../ux-vocabulary/src/lint.ts';
import { detectLanguage } from '../src/lexicon.ts';
import { parseInstruction, readNumber } from '../src/parse.ts';
import { AssistantSession, MATERIAL_CONFIDENCE } from '../src/session.ts';
import type { EntityResolver, Resolution, ResolvedItem, ResolvedParty } from '../src/ports.ts';

const COMPANY: CompanyId = asId<'Company'>('va-co');
const TODAY = isoDate('2026-08-29');
const AT = '2026-08-29T10:00:00.000Z';

const PARTIES: ResolvedParty[] = [
  { partyId: 'abc', name: 'ABC Traders' },
  { partyId: 'abc-enterprises', name: 'ABC Enterprises' },
  { partyId: 'mehta', name: 'Mehta Stores' },
];
const ITEMS: ResolvedItem[] = [
  { itemId: 'APL-BOX-10', name: 'Apple box, 10 kg', baseUnit: 'BOX' },
  { itemId: 'APL-JUICE', name: 'Apple juice, 1 litre', baseUnit: 'PCS' },
];

/** Stands in for GPT 3's #5 resolver, with the same three outcomes and no fourth. */
const resolver = (options: { ambiguousParty?: boolean; ambiguousItem?: boolean } = {}): EntityResolver => ({
  party(_c: CompanyId, spoken: string): Resolution<ResolvedParty> {
    const text = spoken.toLowerCase();
    if (options.ambiguousParty && text.includes('abc')) {
      return { status: 'ambiguous', candidates: PARTIES.filter((p) => p.name.toLowerCase().startsWith('abc')).map((record) => ({ record, score: 0.8 })) };
    }
    const exact = PARTIES.find((p) => p.name.toLowerCase() === text);
    if (exact !== undefined) return { status: 'resolved', record: exact, score: 1 };
    const loose = PARTIES.filter((p) => p.name.toLowerCase().includes(text) || text.includes(p.name.toLowerCase().split(' ')[0] ?? ''));
    if (loose.length === 1) return { status: 'resolved', record: loose[0] as ResolvedParty, score: 0.9 };
    if (loose.length > 1) return { status: 'ambiguous', candidates: loose.map((record) => ({ record, score: 0.8 })) };
    return { status: 'not_found' };
  },
  item(_c: CompanyId, spoken: string): Resolution<ResolvedItem> {
    const text = spoken.toLowerCase();
    if (options.ambiguousItem && text.includes('apple')) {
      return { status: 'ambiguous', candidates: ITEMS.map((record) => ({ record, score: 0.8 })) };
    }
    // Without the ambiguity flag this stands in for a business whose "apple" means the box it
    // sells hundreds of, which is what #5's scoring would return.
    const hit = ITEMS.filter((i) => i.name.toLowerCase().includes(text));
    if (hit.length >= 1) return { status: 'resolved', record: hit[0] as ResolvedItem, score: 0.9 };
    return { status: 'not_found' };
  },
});

const fromText = (text: string, r: EntityResolver = resolver()) =>
  AssistantSession.fromText(COMPANY, text, r, TODAY, AT);

test('Hindi and English number words are read from a lexicon, not guessed', () => {
  const read = (text: string): number | null => readNumber(text.split(' '), 0)?.value ?? null;
  assert.equal(read('sattar'), 70);
  assert.equal(read('satrah'), 17);
  assert.equal(read('aath sau'), 800);
  assert.equal(read('do hazaar paanch sau'), 2500);
  assert.equal(read('seventy'), 70);
  assert.equal(read('seventeen'), 17);
  assert.equal(read('one thousand two hundred'), 1200);
  assert.equal(read('pachhattar'), 75);
  assert.equal(read('70'), 70);
  assert.equal(read('७०'), null, 'Devanagari digits are normalised before tokenising, not here');
  assert.equal(read('bakwaas'), null, 'a word we do not know becomes a question, never a number');
});

test('the Hinglish instruction from the issue parses into the right fields', () => {
  const parsed = parseInstruction('ABC Traders ko sattar box apple aath sau per box becho');
  assert.equal(parsed.isSale, true);
  assert.equal(parsed.partyText.value, 'ABC Traders');
  const line = parsed.lines[0];
  assert.equal(line?.quantity.value, '70');
  assert.equal(line?.unit.value, 'BOX');
  assert.equal(line?.rate.value, '800');
  assert.match(line?.itemText.value ?? '', /apple/);
  assert.equal(detectLanguage('ABC Traders ko sattar box apple aath sau per box becho'), 'hinglish');
});

test('an English instruction parses the same way', () => {
  const parsed = parseInstruction('sell 70 boxes of apple to Mehta Stores at 800 per box');
  assert.equal(parsed.isSale, true);
  assert.equal(parsed.partyText.value, 'Mehta Stores');
  assert.equal(parsed.lines[0]?.quantity.value, '70');
  assert.equal(parsed.lines[0]?.unit.value, 'BOX');
  assert.equal(parsed.lines[0]?.rate.value, '800');
});

test('seventeen or seventy is asked about, never chosen', () => {
  const session = AssistantSession.fromSpeech(
    COMPANY,
    {
      alternatives: [
        { text: 'Mehta Stores ko sattar box apple aath sau per box becho', confidence: 0.62 },
        { text: 'Mehta Stores ko satrah box apple aath sau per box becho', confidence: 0.55 },
      ],
      audioRef: 'rec-1',
    },
    resolver(),
    TODAY,
    AT,
  );

  const quantityQuestion = session.questions().find((q) => q.kind === 'QUANTITY');
  assert.ok(quantityQuestion !== undefined, 'a disagreement about the quantity must become a question');
  assert.deepEqual(
    quantityQuestion.options.map((o) => o.value).sort(),
    ['17', '70'],
    'both readings are offered rather than one being picked',
  );
  assert.match(quantityQuestion.why['en-IN'], /seventeen boxes and seventy/);
  assert.throws(() => session.toDraftInput(), (e: unknown) => e instanceof DomainError && e.code === 'VOICE_NOT_READY');
});

test('a confident transcription is not second-guessed', () => {
  const session = AssistantSession.fromSpeech(
    COMPANY,
    { alternatives: [{ text: 'Mehta Stores ko sattar box apple aath sau per box exclusive becho', confidence: 0.98 }] },
    resolver(),
    TODAY,
    AT,
  );
  assert.equal(session.questions().find((q) => q.kind === 'QUANTITY'), undefined);
  assert.ok(session.ready, `still asking: ${session.questions().map((q) => q.kind).join(', ')}`);
});

test('kilos or boxes is asked about when nobody said', () => {
  const session = fromText('sell 70 apple to Mehta Stores at 800');
  const unit = session.questions().find((q) => q.kind === 'UNIT');
  assert.ok(unit !== undefined);
  assert.match(unit.ask['en-IN'], /boxes, kilos, pieces/);
  assert.match(unit.why['en-IN'], /different stock in different units/);
});

test('whether the rate includes tax is always asked unless it was said', () => {
  const unsaid = fromText('sell 70 boxes apple to Mehta Stores at 800 per box');
  const basis = unsaid.questions().find((q) => q.kind === 'PRICE_BASIS');
  assert.ok(basis !== undefined, 'nobody said, so we ask');
  assert.deepEqual(basis.options.map((o) => o.value), ['EXCLUSIVE', 'INCLUSIVE']);

  const said = fromText('sell 70 boxes apple to Mehta Stores at 800 per box exclusive');
  assert.equal(said.questions().find((q) => q.kind === 'PRICE_BASIS'), undefined);

  // Saying both is a contradiction, not a preference.
  const both = fromText('sell 70 boxes apple to Mehta Stores at 800 per box inclusive plus');
  assert.ok(both.questions().some((q) => q.kind === 'PRICE_BASIS'));
});

test('two customers with similar names are never resolved silently', () => {
  const session = fromText('sell 70 boxes apple to ABC at 800 per box exclusive', resolver({ ambiguousParty: true }));
  const party = session.questions().find((q) => q.kind === 'PARTY');
  assert.ok(party !== undefined);
  assert.deepEqual(party.options.map((o) => o.label).sort(), ['ABC Enterprises', 'ABC Traders']);
  assert.match(party.why['en-IN'], /wrong customer/);
});

test('two items with similar names are never resolved silently', () => {
  const session = fromText('sell 70 boxes apple to Mehta Stores at 800 per box exclusive', resolver({ ambiguousItem: true }));
  const item = session.questions().find((q) => q.kind === 'ITEM');
  assert.ok(item !== undefined);
  assert.equal(item.options.length, 2);
});

test('an unknown customer is asked about rather than created', () => {
  const session = fromText('sell 70 boxes apple to Nobody Traders at 800 per box exclusive');
  const party = session.questions().find((q) => q.kind === 'PARTY');
  assert.ok(party !== undefined);
  assert.match(party.ask['en-IN'], /We do not have a customer called/);
});

test('one answer fixes one field, and nothing else has to be repeated', () => {
  const start = AssistantSession.fromSpeech(
    COMPANY,
    {
      alternatives: [
        { text: 'Mehta Stores ko sattar box apple aath sau per box exclusive becho', confidence: 0.6 },
        { text: 'Mehta Stores ko satrah box apple aath sau per box exclusive becho', confidence: 0.5 },
      ],
    },
    resolver(),
    TODAY,
    AT,
  );
  const before = start.questions();
  assert.ok(before.some((q) => q.kind === 'QUANTITY'));

  const corrected = start.answer('quantity', '70');
  assert.equal(corrected.questions().find((q) => q.kind === 'QUANTITY'), undefined, 'the answered field is settled');
  assert.ok(corrected.ready, `nothing else should have been disturbed: ${corrected.questions().map((q) => q.kind).join(', ')}`);

  const draft = corrected.toDraftInput();
  assert.equal(draft.partyId, 'mehta', 'the customer survived the correction');
  assert.equal(toDecimalString(draft.lines[0]?.unitPrice ?? { currency: 'INR', minor: 0n }), '800.00', 'so did the rate');
  assert.equal(draft.lines[0]?.quantity.scaled, 70_000000n);

  // And the original session is untouched, so a correction can be undone by going back.
  assert.ok(start.questions().some((q) => q.kind === 'QUANTITY'));
});

test('picking a customer from the list settles only that question', () => {
  const session = fromText('sell 70 boxes apple to ABC at 800 per box exclusive', resolver({ ambiguousParty: true }));
  const chosen = session.answer('partyId', 'abc-enterprises');
  assert.equal(chosen.questions().find((q) => q.kind === 'PARTY'), undefined);
  assert.equal(chosen.toDraftInput().partyId, 'abc-enterprises');
});

test('a draft is refused until everything material is settled', () => {
  const session = fromText('sell some apples to Mehta Stores');
  assert.equal(session.ready, false);
  assert.throws(() => session.toDraftInput(), (e: unknown) => e instanceof DomainError && e.code === 'VOICE_NOT_READY');
});

test('a sentence that is not an instruction is not acted on', () => {
  const session = fromText('what did Mehta Stores buy last month');
  const question = session.questions()[0];
  assert.equal(question?.kind, 'NOT_A_SALE');
  assert.match(question.ask['en-IN'], /Did you mean to make a bill/);
});

test('the draft is the same shape a person typing would produce', () => {
  const session = fromText('ABC Traders ko sattar box apple aath sau per box exclusive becho');
  assert.ok(session.ready, session.questions().map((q) => q.ask['en-IN']).join(' | '));
  const draft = session.toDraftInput();
  assert.equal(draft.partyId, 'abc');
  assert.equal(draft.supplyKind, 'GOODS');
  assert.equal(draft.documentDate, '2026-08-29');
  assert.equal(draft.lines.length, 1);
  assert.equal(draft.lines[0]?.priceBasis, 'EXCLUSIVE');
  assert.equal(draft.lines[0]?.quantity.unit, 'BOX');
  // The words spoken travel with the draft as evidence, never instead of the figures.
  assert.match(draft.narration ?? '', /^Spoken: ABC Traders ko sattar box/);
});

test('the recording is kept beside the draft, not in place of it', () => {
  const session = AssistantSession.fromSpeech(
    COMPANY,
    {
      alternatives: [
        { text: 'ABC Traders ko sattar box apple aath sau per box exclusive becho', confidence: 0.97 },
        { text: 'ABC Traders ko sattar box apple aath sau per box exclusive bech do', confidence: 0.4 },
      ],
      audioRef: 'recordings/2026-08-29/abc-1.wav',
    },
    resolver(),
    TODAY,
    AT,
  );
  assert.equal(session.state.transcript.audioRef, 'recordings/2026-08-29/abc-1.wav');
  assert.equal(session.state.transcript.alternatives.length, 2, 'every reading is kept, not just the winner');
  assert.equal(session.state.transcript.capturedAt, AT);
});

test('the read-back repeats every material fact before anything is recorded', () => {
  const session = fromText('ABC Traders ko sattar box apple aath sau per box exclusive becho');
  const english = session.confirmation('en-IN');
  assert.match(english, /70 BOX/);
  assert.match(english, /Apple box, 10 kg/);
  assert.match(english, /ABC Traders/);
  assert.match(english, /800 per BOX/);
  assert.match(english, /GST extra/);
  const hindi = session.confirmation('hi-IN');
  assert.match(hindi, /Zara jaanch lein/);
  assert.match(hindi, /GST alag/);
});

test('noisy, code-switched speech still parses or asks — it never invents', () => {
  const noisy = [
    'Mehta Stores ko 70 box apple 800 per box becho',
    'sell seventy boxes apple Mehta Stores at eight hundred per box',
    'Mehta Stores ko sattar peti apple aath sau rupaye per peti becho',
  ];
  for (const text of noisy) {
    const session = fromText(text);
    const open = session.questions();
    // Whatever it could not read becomes a question; nothing is filled in from nowhere.
    for (const question of open) {
      assert.ok(['UNIT', 'PRICE_BASIS', 'QUANTITY', 'RATE', 'PARTY', 'ITEM'].includes(question.kind));
    }
    const line = parseInstruction(text).lines[0];
    if (line?.quantity.value !== null) assert.equal(line?.quantity.value, '70');
    if (line?.rate.value !== null) assert.equal(line?.rate.value, '800');
  }
});

test('every question is understandable without training, in both languages', () => {
  const sessions = [
    fromText('sell some apples to Mehta Stores'),
    fromText('sell 70 boxes apple to ABC at 800 per box', resolver({ ambiguousParty: true })),
    fromText('what did Mehta Stores buy'),
  ];
  const problems: string[] = [];
  for (const session of sessions) {
    for (const question of session.questions()) {
      for (const locale of ['en-IN', 'hi-IN'] as const) {
        for (const text of [question.ask[locale], question.why[locale]]) {
          for (const issue of lintUserFacingText(text, { locale, allow: ['gst'] })) {
            problems.push(`${question.kind} (${locale}): ${issue.rule} — ${issue.detail}`);
          }
        }
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the confidence bar is a stated number, not a feeling', () => {
  assert.equal(MATERIAL_CONFIDENCE, 0.9);
  const parsed = parseInstruction('sell 70 boxes apple to Mehta Stores at 800 per box');
  assert.equal(parsed.lines[0]?.quantity.confidence, 1, 'a typed digit is certain');
  const spoken = parseInstruction('sattar box apple becho');
  assert.ok((spoken.lines[0]?.quantity.confidence ?? 0) >= MATERIAL_CONFIDENCE, 'a word from the lexicon is certain enough');
  assert.equal(spoken.lines[0]?.quantity.source, 'WORDS');
});
