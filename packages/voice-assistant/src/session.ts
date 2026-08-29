/**
 * Issue #10 [E10] — the conversation.
 *
 * A session holds one parsed instruction and the questions still standing between it and a draft.
 * Three rules govern it, and each is an acceptance criterion:
 *
 *  1. **A low-confidence material fact is never silently accepted.** Quantity, unit, rate, price
 *     basis, customer and item each have to clear the bar or be asked about.
 *  2. **One answer fixes one field.** Correcting the quantity does not make someone repeat the
 *     customer, the item and the rate.
 *  3. **The draft goes down the ordinary path.** This module produces the same input a person
 *     typing would produce, and issue #9 applies the same permissions and approvals to it.
 */
import { fromDecimalString, invalid, isoDate, quantityFromString, type CompanyId, type IsoDate, type PartyId } from '@invoice/kernel';
import type { DraftInvoiceInput } from '@invoice/sales';
import { mergeAlternatives, parseInstruction, type Field, type ParsedInstruction, type ParsedLine } from './parse.ts';
import type { EntityResolver, Resolution, ResolvedItem, ResolvedParty, Transcription } from './ports.ts';

/** Below this, a material field is asked about rather than used. */
export const MATERIAL_CONFIDENCE = 0.9;

export type QuestionKind =
  | 'QUANTITY'
  | 'UNIT'
  | 'RATE'
  | 'PRICE_BASIS'
  | 'PARTY'
  | 'ITEM'
  | 'NOT_A_SALE';

export interface QuestionOption {
  readonly value: string;
  readonly label: string;
}

export interface Question {
  readonly id: string;
  readonly kind: QuestionKind;
  readonly field: string;
  readonly ask: { readonly 'en-IN': string; readonly 'hi-IN': string };
  readonly why: { readonly 'en-IN': string; readonly 'hi-IN': string };
  /** When we have candidates, offering them beats asking someone to type it again. */
  readonly options: readonly QuestionOption[];
  /** What we thought we heard, so the person can see why we are asking. */
  readonly heard: string;
}

export interface Answers {
  readonly quantity?: string;
  readonly unit?: string;
  readonly rate?: string;
  readonly priceBasis?: 'INCLUSIVE' | 'EXCLUSIVE';
  readonly partyId?: string;
  readonly itemId?: string;
}

export interface TranscriptRecord {
  /** What was said or typed, kept as evidence beside the draft — never instead of it. */
  readonly text: string;
  readonly alternatives: readonly { text: string; confidence: number }[];
  readonly language: string;
  readonly audioRef: string | null;
  readonly capturedAt: string;
}

export interface SessionState {
  readonly companyId: CompanyId;
  readonly parsed: ParsedInstruction;
  readonly answers: Answers;
  readonly party: Resolution<ResolvedParty> | null;
  readonly item: Resolution<ResolvedItem> | null;
  readonly transcript: TranscriptRecord;
  readonly documentDate: IsoDate;
}

const q = (
  id: string,
  kind: QuestionKind,
  field: string,
  en: string,
  hi: string,
  whyEn: string,
  whyHi: string,
  heard: string,
  options: QuestionOption[] = [],
): Question => ({
  id,
  kind,
  field,
  ask: { 'en-IN': en, 'hi-IN': hi },
  why: { 'en-IN': whyEn, 'hi-IN': whyHi },
  options,
  heard,
});

export class AssistantSession {
  readonly state: SessionState;
  readonly #resolver: EntityResolver;

  private constructor(state: SessionState, resolver: EntityResolver) {
    this.state = state;
    this.#resolver = resolver;
  }

  /** Starts from typed text. */
  static fromText(
    companyId: CompanyId,
    text: string,
    resolver: EntityResolver,
    documentDate: IsoDate,
    capturedAt: string,
  ): AssistantSession {
    const parsed = parseInstruction(text);
    return AssistantSession.#build(
      companyId,
      parsed,
      { text, alternatives: [{ text, confidence: 1 }], language: parsed.language, audioRef: null, capturedAt },
      resolver,
      documentDate,
    );
  }

  /**
   * Starts from speech.
   *
   * Every alternative the provider offered is parsed, and where they disagree the disagreement
   * survives as a question. This is the seventeen-or-seventy case.
   */
  static fromSpeech(
    companyId: CompanyId,
    transcription: Transcription,
    resolver: EntityResolver,
    documentDate: IsoDate,
    capturedAt: string,
  ): AssistantSession {
    const readings = transcription.alternatives.map((a) => ({ parsed: parseInstruction(a.text), confidence: a.confidence }));
    if (readings.length === 0) throw invalid('VOICE_NO_TRANSCRIPT', 'We did not catch that. Please say it again.');
    const parsed = mergeAlternatives(readings);
    return AssistantSession.#build(
      companyId,
      parsed,
      {
        text: transcription.alternatives[0]?.text ?? '',
        alternatives: transcription.alternatives.map((a) => ({ text: a.text, confidence: a.confidence })),
        language: parsed.language,
        audioRef: transcription.audioRef ?? null,
        capturedAt,
      },
      resolver,
      documentDate,
    );
  }

  static #build(
    companyId: CompanyId,
    parsed: ParsedInstruction,
    transcript: TranscriptRecord,
    resolver: EntityResolver,
    documentDate: IsoDate,
  ): AssistantSession {
    const line = parsed.lines[0] as ParsedLine;
    const party = parsed.partyText.value === null ? null : resolver.party(companyId, parsed.partyText.value);
    const item = line.itemText.value === null ? null : resolver.item(companyId, line.itemText.value);
    return new AssistantSession({ companyId, parsed, answers: {}, party, item, transcript, documentDate }, resolver);
  }

  /** Answers one question. Everything else is left exactly as it was. */
  answer(field: keyof Answers, value: string): AssistantSession {
    const answers: Answers = { ...this.state.answers, [field]: value };
    let party = this.state.party;
    let item = this.state.item;
    if (field === 'partyId') party = { status: 'resolved', record: { partyId: value, name: value }, score: 1 };
    if (field === 'itemId') {
      const existing = this.state.item;
      const chosen =
        existing !== null && existing.status === 'ambiguous'
          ? existing.candidates.find((c) => c.record.itemId === value)?.record
          : undefined;
      item = { status: 'resolved', record: chosen ?? { itemId: value, name: value, baseUnit: '' }, score: 1 };
    }
    return new AssistantSession({ ...this.state, answers, party, item }, this.#resolver);
  }

  /** Re-reads a corrected phrase for one field, without disturbing the others. */
  correct(field: keyof Answers, value: string): AssistantSession {
    return this.answer(field, value);
  }

  #resolvedParty(): ResolvedParty | null {
    const answered = this.state.answers.partyId;
    if (answered !== undefined) {
      const chosen =
        this.state.party?.status === 'ambiguous'
          ? this.state.party.candidates.find((c) => c.record.partyId === answered)?.record
          : undefined;
      return chosen ?? { partyId: answered, name: answered };
    }
    return this.state.party?.status === 'resolved' ? this.state.party.record : null;
  }

  #resolvedItem(): ResolvedItem | null {
    const answered = this.state.answers.itemId;
    if (answered !== undefined) {
      const chosen =
        this.state.item?.status === 'ambiguous'
          ? this.state.item.candidates.find((c) => c.record.itemId === answered)?.record
          : undefined;
      return chosen ?? (this.state.item?.status === 'resolved' ? this.state.item.record : { itemId: answered, name: answered, baseUnit: '' });
    }
    return this.state.item?.status === 'resolved' ? this.state.item.record : null;
  }

  #value<T extends string>(f: Field<T>, answered: string | undefined): string | null {
    if (answered !== undefined) return answered;
    return f.value === null ? null : (f.value as string);
  }

  /** Everything still standing between this instruction and a draft. */
  questions(): readonly Question[] {
    const open: Question[] = [];
    const parsed = this.state.parsed;
    const line = parsed.lines[0] as ParsedLine;
    const answers = this.state.answers;

    if (!parsed.isSale) {
      open.push(
        q('not-a-sale', 'NOT_A_SALE', 'action',
          'We could not tell what you want to do. Did you mean to make a bill?',
          'Samajh nahin aaya aap kya karna chahte hain. Kya aapko bill banana hai?',
          'We only act on an instruction we understood, never on a guess.',
          'Hum sirf samjhi hui baat par kaam karte hain, andaaze par nahin.',
          parsed.transcript),
      );
      return open;
    }

    const party = this.#resolvedParty();
    if (party === null) {
      const resolution = this.state.party;
      if (resolution !== null && resolution.status === 'ambiguous') {
        open.push(
          q('party', 'PARTY', 'partyId',
            `More than one customer has a name like "${parsed.partyText.value}". Which one did you mean?`,
            `"${parsed.partyText.value}" jaise naam wale ek se zyada customer hain. Aapka matlab kaunsa tha?`,
            'Billing the wrong customer moves money to the wrong account and is slow to correct.',
            'Galat customer ka bill banne se paisa galat khaate mein jaata hai aur sudhaarna mushkil hai.',
            parsed.partyText.evidence,
            resolution.candidates.map((c) => ({ value: c.record.partyId, label: c.record.name }))),
        );
      } else {
        open.push(
          q('party', 'PARTY', 'partyId',
            parsed.partyText.value === null ? 'Who is this bill for?' : `We do not have a customer called "${parsed.partyText.value}". Who is this bill for?`,
            parsed.partyText.value === null ? 'Yeh bill kiske liye hai?' : `"${parsed.partyText.value}" naam ka customer nahin mila. Yeh bill kiske liye hai?`,
            'Every bill belongs to someone, and we will not choose for you.',
            'Har bill kisi na kisi ka hota hai, aur hum aapki taraf se nahin chunenge.',
            parsed.partyText.evidence),
        );
      }
    }

    const item = this.#resolvedItem();
    if (item === null) {
      const resolution = this.state.item;
      if (resolution !== null && resolution.status === 'ambiguous') {
        open.push(
          q('item', 'ITEM', 'itemId',
            `More than one item is called something like "${line.itemText.value}". Which one?`,
            `"${line.itemText.value}" jaisi ek se zyada cheezein hain. Kaunsi?`,
            'Two similar names are the easiest way to bill the wrong thing.',
            'Milte-julte naam se galat cheez ka bill ban jaana sabse aasaan galti hai.',
            line.itemText.evidence,
            resolution.candidates.map((c) => ({ value: c.record.itemId, label: c.record.name }))),
        );
      } else {
        open.push(
          q('item', 'ITEM', 'itemId',
            line.itemText.value === null ? 'What are you selling?' : `We do not have anything called "${line.itemText.value}". What are you selling?`,
            line.itemText.value === null ? 'Aap kya bech rahe hain?' : `"${line.itemText.value}" naam ki koi cheez nahin mili. Aap kya bech rahe hain?`,
            'We only bill for things that are set up, so the tax and the stock are right.',
            'Hum sirf un cheezon ka bill banate hain jo set up hain, taaki tax aur stock sahi rahein.',
            line.itemText.evidence),
        );
      }
    }

    open.push(...this.#numberQuestion(line.quantity, answers.quantity, 'quantity', 'QUANTITY',
      'How many?', 'Kitne?',
      'A misheard number is the difference between seventeen boxes and seventy.',
      'Galat suna hua number satrah aur sattar ka farq hai.'));

    const unitValue = this.#value(line.unit, answers.unit);
    if (unitValue === null || line.unit.confidence < MATERIAL_CONFIDENCE) {
      open.push(
        q('unit', 'UNIT', 'unit',
          'In what — boxes, kilos, pieces?', 'Kis mein — box, kilo, piece?',
          'The same number means different stock in different units.',
          'Ek hi ginti alag ikai mein alag maal hoti hai.',
          line.unit.evidence,
          line.unit.alternatives.map((a) => ({ value: a.value, label: a.value }))),
      );
    }

    open.push(...this.#numberQuestion(line.rate, answers.rate, 'rate', 'RATE',
      'What rate?', 'Kya rate?',
      'The rate decides the whole bill, so we will not assume it.',
      'Rate se poora bill banta hai, isliye hum andaaza nahin lagayenge.'));

    const basis = answers.priceBasis ?? parsed.priceBasis.value;
    if (basis === null || basis === undefined || parsed.priceBasis.confidence < MATERIAL_CONFIDENCE) {
      open.push(
        q('price-basis', 'PRICE_BASIS', 'priceBasis',
          'Does that rate already include GST?', 'Kya us rate mein GST shaamil hai?',
          'Getting this backwards changes what the customer pays.',
          'Ise ulta samajhne se customer ka dena badal jaata hai.',
          parsed.priceBasis.evidence,
          [
            { value: 'EXCLUSIVE', label: 'No, GST is extra' },
            { value: 'INCLUSIVE', label: 'Yes, GST is included' },
          ]),
      );
    }

    return open;
  }

  #numberQuestion(
    f: Field<string>,
    answered: string | undefined,
    field: string,
    kind: QuestionKind,
    en: string,
    hi: string,
    whyEn: string,
    whyHi: string,
  ): Question[] {
    if (answered !== undefined) return [];
    if (f.value !== null && f.confidence >= MATERIAL_CONFIDENCE) return [];
    const options = [
      ...(f.value === null ? [] : [{ value: f.value, label: f.value }]),
      ...f.alternatives.map((a) => ({ value: a.value, label: a.value })),
    ];
    const ask = f.value === null ? en : `${en} We heard "${f.evidence}".`;
    const askHi = f.value === null ? hi : `${hi} Humne "${f.evidence}" suna.`;
    return [q(field, kind, field, ask, askHi, whyEn, whyHi, f.evidence, options)];
  }

  get ready(): boolean {
    return this.questions().length === 0;
  }

  /**
   * The draft, in exactly the shape a person typing would have produced.
   *
   * It goes to `SalesService` like any other draft, so the same permissions, approvals, stock
   * checks and tax rules apply. Speaking a sale does not open a shorter path to the books.
   */
  toDraftInput(): DraftInvoiceInput {
    const open = this.questions();
    if (open.length > 0) {
      throw invalid(
        'VOICE_NOT_READY',
        `There is still something to confirm: ${open.map((x) => x.ask['en-IN']).join(' ')}`,
      );
    }
    const line = this.state.parsed.lines[0] as ParsedLine;
    const party = this.#resolvedParty() as ResolvedParty;
    const item = this.#resolvedItem() as ResolvedItem;
    const quantityText = this.#value(line.quantity, this.state.answers.quantity) as string;
    const unitCode = this.#value(line.unit, this.state.answers.unit) as string;
    const rateText = this.#value(line.rate, this.state.answers.rate) as string;
    const basis = (this.state.answers.priceBasis ?? this.state.parsed.priceBasis.value) as 'INCLUSIVE' | 'EXCLUSIVE';

    return {
      partyId: party.partyId as PartyId,
      customerType: 'B2B',
      supplyKind: 'GOODS',
      documentDate: this.state.documentDate,
      lines: [
        {
          lineId: 'l1',
          itemId: item.itemId,
          quantity: quantityFromString(quantityText, unitCode),
          unitPrice: fromDecimalString(`${rateText}.00`),
          priceBasis: basis,
        },
      ],
      narration: `Spoken: ${this.state.transcript.text}`,
    };
  }

  /** What to read back before anything is recorded. */
  confirmation(locale: 'en-IN' | 'hi-IN'): string {
    const line = this.state.parsed.lines[0] as ParsedLine;
    const party = this.#resolvedParty();
    const item = this.#resolvedItem();
    const quantityText = this.#value(line.quantity, this.state.answers.quantity) ?? '?';
    const unitCode = this.#value(line.unit, this.state.answers.unit) ?? '?';
    const rateText = this.#value(line.rate, this.state.answers.rate) ?? '?';
    const basis = this.state.answers.priceBasis ?? this.state.parsed.priceBasis.value;
    const basisText =
      basis === 'INCLUSIVE'
        ? locale === 'hi-IN' ? 'GST shaamil' : 'GST included'
        : locale === 'hi-IN' ? 'GST alag' : 'GST extra';
    return locale === 'hi-IN'
      ? `Zara jaanch lein: ${party?.name ?? '?'} ko ${item?.name ?? '?'} ke ${quantityText} ${unitCode}, ${rateText} prati ${unitCode}, ${basisText}.`
      : `Please check: sell ${quantityText} ${unitCode} of ${item?.name ?? '?'} to ${party?.name ?? '?'} at ${rateText} per ${unitCode}, ${basisText}.`;
  }
}

export const todayIso = (at: Date): IsoDate => isoDate(at.toISOString().slice(0, 10));
