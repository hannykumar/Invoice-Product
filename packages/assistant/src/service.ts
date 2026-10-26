/**
 * Issue #34 [E34] — the assistant itself.
 *
 * One method: ask a question, get an answer. What happens in between is deliberately dull, and the
 * dullness is the point:
 *
 *   understand (a lexicon) → resolve the period → fetch reports through the actor's own permissions
 *   → lift figures out of them with their snapshot and their records → put rule questions to the
 *   rules engine → write sentences that are checked before they are allowed out.
 *
 * There is no step in which anything decides what the answer should be. A model, if one is plugged
 * in at all, may only suggest which of these fixed questions was being asked.
 */
import { indiaDateOf } from '@invoice/kernel';
import {
  DomainError,
  invalid,
  isoDate,
  type Clock,
  type IsoDate,
} from '@invoice/kernel';
import type { ActorContext, AuditPort, PermissionPort } from '@invoice/ledger';
import type { ComplianceRegister } from '@invoice/compliance-register';
import { FactSet, type RulesEngine } from '@invoice/rules-engine';
import { REPORT_PERMISSIONS, type Report, type ReportFilter, type ReportId, type ReportService } from '@invoice/reports';
import { citeFrom, plainSentence, safeSentence, wording } from './citations.ts';
import { citeCompliance, describeCitation, supportOf } from './compliance.ts';
import { ASK_INSTEAD, looksLikeAnInstruction, understand, type Understanding } from './language.ts';
import {
  ANSWERABLE_INTENTS,
  ASSISTANT_PERMISSIONS,
  FIGURE_DISCLAIMER,
  RULE_DISCLAIMER,
  type Answer,
  type AnswerState,
  type Bilingual,
  type CitedAmount,
  type ComplianceCitation,
  type Intent,
  type NextStep,
} from './model.ts';
import { ASSUMED_PERIOD_NOTE, resolvePeriod, type ResolvedPeriod } from './periods.ts';
import { fetchReport, type Fetched } from './retrieval.ts';
import type {
  BlockedDocumentPort,
  ComplianceCalendarPort,
  ExceptionQueuePort,
  QuestionUnderstandingPort,
} from './ports.ts';

export interface AssistantServiceDeps {
  readonly reports: ReportService;
  readonly permissions: PermissionPort;
  readonly audit: AuditPort;
  readonly clock: Clock;
  /** Needed for rule questions. Without it, no compliance question is answered at all. */
  readonly rules?: RulesEngine;
  readonly register?: ComplianceRegister;
  /** Needed for "why is this blocked?". Without it the question is refused, not guessed at. */
  readonly blocked?: BlockedDocumentPort;
  /** GPT 3's #32. Absent for now, and every answer that would have used it says so. */
  readonly calendar?: ComplianceCalendarPort;
  readonly exceptions?: ExceptionQueuePort;
  readonly understanding?: QuestionUnderstandingPort;
  readonly idFactory?: () => string;
}

export interface AskCommand {
  readonly question: string;
  /** The day the question is about. Passed in so the same question always resolves the same way. */
  readonly today?: IsoDate;
  readonly branchId?: ReportFilter['branchId'];
}

interface Draft {
  state: AnswerState;
  sentences: Bilingual[];
  amounts: CitedAmount[];
  compliance: ComplianceCitation[];
  assumptions: Bilingual[];
  sources: { reportId: ReportId; snapshotId: string }[];
  withheld: Bilingual[];
  nextSteps: NextStep[];
  exceptionId: string | null;
}

const emptyDraft = (): Draft => ({
  state: 'ANSWERED',
  sentences: [],
  amounts: [],
  compliance: [],
  assumptions: [],
  sources: [],
  withheld: [],
  nextSteps: [],
  exceptionId: null,
});

/**
 * Issue #397 — what "why is this bill blocked?" needs the asker to hold: the bill and its customer
 * are sales data, the shortfall is stock data. The same permissions the sales and stock reports ask.
 */
const BLOCKED_BILL_PERMISSIONS = [REPORT_PERMISSIONS.sales, REPORT_PERMISSIONS.stock] as const;

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

export class AssistantService {
  readonly #deps: AssistantServiceDeps;
  readonly #newId: () => string;

  constructor(deps: AssistantServiceDeps) {
    this.#deps = deps;
    this.#newId = deps.idFactory ?? (() => crypto.randomUUID());
  }

  /** Every question this assistant can answer, for a screen that wants to offer examples. */
  static supportedIntents(): readonly Intent[] {
    return ANSWERABLE_INTENTS;
  }

  async ask(actor: ActorContext, command: AskCommand): Promise<Answer> {
    this.#deps.permissions.require(actor, ASSISTANT_PERMISSIONS.ask, 'ask about this business');
    const question = command.question.trim();
    if (question === '') {
      throw invalid('ASSISTANT_EMPTY_QUESTION', 'Ask me something about your business and I will look it up.');
    }

    const now = this.#deps.clock.now();
    const today = command.today ?? indiaDateOf(now);
    const reading = understand(question);
    const period = resolvePeriod(question, today);
    const instruction = looksLikeAnInstruction(question);

    const settled = await this.#settleIntent(reading);
    const intent = settled.intent;
    const draft = emptyDraft();

    if (instruction !== null) {
      // Recorded, and that is all it does. Nothing about what is fetched or whose it is comes from
      // the question: the intent comes from the table above, the company from the signed-in actor.
      draft.assumptions.push(
        plainSentence(
          'Part of your question read like an instruction to the app rather than a question about your business. I answered the question and ignored the rest.',
          'आपके सवाल का एक हिस्सा बिज़नेस के सवाल की जगह ऐप को दिया गया निर्देश लग रहा था. मैंने सवाल का जवाब दिया है, बाक़ी छोड़ दिया.',
        ),
      );
    }

    if (intent === 'UNSUPPORTED' || settled.confidence < ASK_INSTEAD) {
      this.#unsupported(draft, reading, intent);
    } else {
      await this.#answer(actor, intent, reading, period, command, draft);
    }

    if (period.assumed && draft.state !== 'NOT_MY_QUESTION' && intent !== 'WHY_BLOCKED' && intent !== 'COMPLIANCE_QUESTION') {
      draft.assumptions.push(ASSUMED_PERIOD_NOTE(period));
    }

    const usesRules = draft.compliance.length > 0;
    const answer: Answer = {
      id: this.#newId(),
      question,
      intent,
      state: draft.state,
      askedAt: now.toISOString(),
      sentences: draft.sentences,
      amounts: draft.amounts,
      compliance: draft.compliance,
      period:
        draft.state === 'NOT_MY_QUESTION' || intent === 'WHY_BLOCKED' || intent === 'COMPLIANCE_QUESTION'
          ? null
          : { from: period.from, to: period.to, described: period.described },
      assumptions: draft.assumptions,
      sourcesUsed: draft.sources,
      withheld: draft.withheld,
      nextSteps: draft.nextSteps,
      exceptionId: draft.exceptionId,
      disclaimer: usesRules ? RULE_DISCLAIMER : FIGURE_DISCLAIMER,
    };

    await this.#deps.audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at: now.toISOString(),
      action: 'assistant.answered',
      subjectType: 'assistant_answer',
      subjectId: answer.id,
      // What was asked and what was used, never the figures themselves — the same rule the reports
      // module follows, for the same reason: an audit trail is not a copy of the books.
      summary: `Asked about ${intent.toLowerCase().replace(/_/g, ' ')}; answered ${answer.state.toLowerCase().replace(/_/g, ' ')}.`,
      details: {
        intent,
        state: answer.state,
        confidence: String(reading.confidence),
        from: period.from,
        to: period.to,
        reports: draft.sources.map((source) => source.reportId).join(','),
        rules: draft.compliance.map((citation) => `${citation.ruleId ?? 'none'}@${citation.ruleVersion ?? '-'}`).join(','),
        withheld: String(draft.withheld.length),
        instructionLike: instruction === null ? 'no' : 'yes',
      },
    });

    return answer;
  }

  // ------------------------------------------------------------- understanding

  /**
   * The lexicon decides. A model may only speak when the lexicon found nothing, and only by naming
   * one of the questions this package already answers.
   */
  async #settleIntent(reading: Understanding): Promise<{ intent: Intent; confidence: number }> {
    const own = { intent: reading.intent, confidence: reading.confidence };
    if (reading.intent !== 'UNSUPPORTED' && reading.confidence >= ASK_INSTEAD) return own;

    const port = this.#deps.understanding;
    if (port === undefined) return own;

    // Only the words the lexicon matched are handed over, never the raw question: a model that
    // cannot read the sentence cannot be talked into anything by it.
    const suggestion = await port.suggest(reading.evidence, ANSWERABLE_INTENTS);
    if (suggestion === null) return own;
    const named = ANSWERABLE_INTENTS.find((intent) => intent === suggestion.intent);
    // An intent we do not have is not an intent. Nothing a model says can widen this list.
    if (named === undefined || suggestion.confidence < ASK_INSTEAD) return own;
    return { intent: named, confidence: suggestion.confidence };
  }

  #unsupported(draft: Draft, reading: Understanding, intent: Intent): void {
    draft.state = 'NOT_MY_QUESTION';
    if (intent !== 'UNSUPPORTED' && reading.alternatives.length > 0) {
      draft.state = 'CANNOT_ANSWER';
      draft.sentences.push(
        plainSentence(
          'I am not sure which of these you meant, so I would rather ask than answer the wrong one.',
          'मुझे पक्का नहीं कि आप इनमें से क्या पूछ रहे हैं, इसलिए ग़लत जवाब देने से बेहतर है पूछ लूँ.',
        ),
      );
      for (const candidate of [intent, ...reading.alternatives].slice(0, 3)) {
        draft.nextSteps.push({ label: describeIntent(candidate), action: null });
      }
      return;
    }
    draft.sentences.push(
      plainSentence(
        'I answer questions about your own books — what you sold, what you are owed, what is in the godown, your GST for a period, and what a rule we hold says. I could not match your question to any of those.',
        'मैं आपकी अपनी बहीखाते के सवालों का जवाब देता हूँ — कितना बेचा, कितना लेना है, गोदाम में क्या है, किसी समय का GST, और हमारे पास दर्ज नियम क्या कहता है. आपका सवाल इनमें से किसी से नहीं मिला.',
      ),
    );
    for (const example of ANSWERABLE_INTENTS.slice(0, 4)) {
      draft.nextSteps.push({ label: describeIntent(example), action: null });
    }
  }

  // ------------------------------------------------------------------ answering

  async #answer(
    actor: ActorContext,
    intent: Intent,
    reading: Understanding,
    period: ResolvedPeriod,
    command: AskCommand,
    draft: Draft,
  ): Promise<void> {
    const filter: ReportFilter =
      command.branchId === undefined ? { from: period.from, to: period.to } : { from: period.from, to: period.to, branchId: command.branchId };

    switch (intent) {
      case 'MONEY_OWED_TO_ME':
      case 'MONEY_I_OWE':
        return this.#dues(actor, filter, intent === 'MONEY_OWED_TO_ME', draft);
      case 'SALES_IN_PERIOD':
        return this.#sales(actor, filter, period, draft);
      case 'PURCHASES_IN_PERIOD':
        return this.#purchases(actor, filter, period, draft);
      case 'PROFIT_IN_PERIOD':
        return this.#profit(actor, filter, period, draft);
      case 'WHAT_I_OWN':
        return this.#balanceSheet(actor, filter, draft);
      case 'STOCK_POSITION':
        return this.#stock(actor, filter, reading, draft);
      case 'GST_IN_PERIOD':
        return this.#gst(actor, filter, period, draft);
      case 'NEEDS_ATTENTION':
        return this.#attention(actor, filter, draft);
      case 'WHY_BLOCKED':
        return this.#whyBlocked(actor, reading, period, draft);
      case 'COMPLIANCE_QUESTION':
        return this.#compliance(actor, reading, period, draft);
      default:
        return this.#unsupported(draft, reading, intent);
    }
  }

  /** Records a fetched report on the draft, or its refusal, and says whether anything came back. */
  #took<TBody>(draft: Draft, fetched: Fetched<TBody>): Report<TBody> | null {
    if (fetched.ok) {
      draft.sources.push({ reportId: fetched.report.header.reportId, snapshotId: fetched.report.header.snapshotId });
      return fetched.report;
    }
    draft.withheld.push(fetched.withheld);
    draft.state = fetched.kind === 'NOT_ALLOWED' ? 'NEEDS_PERMISSION' : 'CANNOT_ANSWER';
    return null;
  }

  async #dues(actor: ActorContext, filter: ReportFilter, incoming: boolean, draft: Draft): Promise<void> {
    const what: Bilingual = incoming
      ? { 'en-IN': 'who owes you money', 'hi-IN': 'किससे पैसा लेना है' }
      : { 'en-IN': 'who you owe money to', 'hi-IN': 'किसको पैसा देना है' };
    const report = this.#took(
      draft,
      await fetchReport(what, () =>
        incoming ? this.#deps.reports.receivablesAgeing(actor, filter) : this.#deps.reports.payablesAgeing(actor, filter),
      ),
    );
    if (report === null) return;

    const body = report.body;
    draft.amounts.push(citeFrom(report, what, body.total));
    const worst = [...body.rows].sort((left, right) => right.oldestDaysOverdue - left.oldestDaysOverdue)[0];

    draft.sentences.push(
      plainSentence(
        incoming
          ? wording`Your customers owe you ${draft.amounts[0]?.formatted ?? ''} across ${plural(body.rows.length, 'customer', 'customers')}.`
          : wording`You owe ${draft.amounts[0]?.formatted ?? ''} across ${plural(body.rows.length, 'supplier', 'suppliers')}.`,
        incoming
          ? wording`आपके ${plural(body.rows.length, 'ग्राहक', 'ग्राहक')} से ${draft.amounts[0]?.formatted ?? ''} लेना है.`
          : wording`आपको ${plural(body.rows.length, 'सप्लायर', 'सप्लायर')} को ${draft.amounts[0]?.formatted ?? ''} देना है.`,
      ),
    );
    if (worst !== undefined && worst.oldestDaysOverdue > 0) {
      draft.sentences.push(
        plainSentence(
          wording`The one waiting longest is ${worst.partyName}: ${worst.oldestDaysOverdue} days past due.`,
          wording`सबसे पुराना ${worst.partyName} का है: ${worst.oldestDaysOverdue} दिन से बाक़ी.`,
        ),
      );
    }
    draft.nextSteps.push({
      label: incoming
        ? { 'en-IN': 'Open who owes money, and for how long', 'hi-IN': 'खोलिए: किसका पैसा बाक़ी है, और कब से' }
        : { 'en-IN': 'Open what you owe', 'hi-IN': 'खोलिए: आपको क्या देना है' },
      action: 'reports:ageing',
    });
  }

  async #sales(actor: ActorContext, filter: ReportFilter, period: ResolvedPeriod, draft: Draft): Promise<void> {
    const what: Bilingual = { 'en-IN': 'your sales', 'hi-IN': 'आपकी बिक्री' };
    const report = this.#took(draft, await fetchReport(what, () => this.#deps.reports.salesRegister(actor, filter)));
    if (report === null) return;

    const body = report.body;
    const total = citeFrom(report, { 'en-IN': 'what you billed', 'hi-IN': 'आपने कितने का बिल बनाया' }, body.total);
    const taxable = citeFrom(report, { 'en-IN': 'value before GST', 'hi-IN': 'GST से पहले की कीमत' }, body.taxableValue);
    draft.amounts.push(total, taxable);
    draft.sentences.push(
      plainSentence(
        wording`You billed ${total.formatted} ${period.described['en-IN']}, across ${plural(body.rows.length, 'bill', 'bills')}. Before GST that is ${taxable.formatted}.`,
        wording`${period.described['hi-IN']} आपने ${total.formatted} का बिल बनाया, ${plural(body.rows.length, 'बिल', 'बिल')} में. GST से पहले यह ${taxable.formatted} है.`,
      ),
    );
    draft.nextSteps.push({ label: { 'en-IN': 'Open every bill you gave out', 'hi-IN': 'खोलिए: आपके दिए हुए सारे बिल' }, action: 'reports:sales_register' });
  }

  async #purchases(actor: ActorContext, filter: ReportFilter, period: ResolvedPeriod, draft: Draft): Promise<void> {
    const what: Bilingual = { 'en-IN': 'your purchases', 'hi-IN': 'आपकी ख़रीद' };
    const report = this.#took(draft, await fetchReport(what, () => this.#deps.reports.purchaseRegister(actor, filter)));
    if (report === null) return;

    const body = report.body;
    if (!body.available) {
      draft.state = 'CANNOT_ANSWER';
      draft.sentences.push(
        plainSentence(
          'Supplier bills are not recorded in this business yet, so there is nothing to add up. This is not the same as having bought nothing.',
          'इस बिज़नेस में सप्लायर के बिल अभी दर्ज नहीं होते, इसलिए जोड़ने को कुछ नहीं है. इसका मतलब यह नहीं कि ख़रीद हुई ही नहीं.',
        ),
      );
      return;
    }
    const total = citeFrom(report, { 'en-IN': 'what you were billed', 'hi-IN': 'आपको कितने का बिल मिला' }, body.total);
    draft.amounts.push(total);
    draft.sentences.push(
      plainSentence(
        wording`You were billed ${total.formatted} ${period.described['en-IN']}, across ${plural(body.rows.length, 'supplier bill', 'supplier bills')}.`,
        wording`${period.described['hi-IN']} आपको ${total.formatted} के बिल मिले, ${plural(body.rows.length, 'बिल', 'बिल')}.`,
      ),
    );
  }

  async #profit(actor: ActorContext, filter: ReportFilter, period: ResolvedPeriod, draft: Draft): Promise<void> {
    const what: Bilingual = { 'en-IN': 'what you earned and what you spent', 'hi-IN': 'कितना कमाया और कितना ख़र्च हुआ' };
    const report = this.#took(draft, await fetchReport(what, () => this.#deps.reports.profitAndLoss(actor, filter)));
    if (report === null) return;

    const body = report.body;
    const result = citeFrom(report, { 'en-IN': 'what you kept', 'hi-IN': 'कितना बचा' }, body.result);
    const income = citeFrom(report, { 'en-IN': 'everything you earned', 'hi-IN': 'जो कुछ कमाया' }, body.income.total);
    const expenses = citeFrom(report, { 'en-IN': 'everything you spent', 'hi-IN': 'जो कुछ ख़र्च हुआ' }, body.expenses.total);
    draft.amounts.push(result, income, expenses);

    draft.sentences.push(
      plainSentence(
        wording`${period.described['en-IN']} you earned ${income.formatted} and spent ${expenses.formatted}, so you ${body.madeMoney ? 'kept' : 'were short by'} ${result.formatted}.`,
        wording`${period.described['hi-IN']} आपने ${income.formatted} कमाए और ${expenses.formatted} ख़र्च किए, इसलिए ${result.formatted} ${body.madeMoney ? 'बचे' : 'का घाटा रहा'}.`,
      ),
    );
    if (!body.costOfGoodsInBooks) {
      draft.state = 'PARTLY_ANSWERED';
      draft.sentences.push(
        plainSentence(
          'Goods were sold but what they cost has not been written into the books yet, so this figure is higher than what you really kept.',
          'माल बिका है पर उसकी लागत अभी बहीखाते में नहीं लिखी गई, इसलिए यह आंकड़ा असली बचत से ज़्यादा है.',
        ),
      );
    }
    await this.#checkBooksHoldTogether(actor, filter, draft);
  }

  async #balanceSheet(actor: ActorContext, filter: ReportFilter, draft: Draft): Promise<void> {
    const what: Bilingual = { 'en-IN': 'what the business owns and owes', 'hi-IN': 'बिज़नेस के पास क्या है और क्या देना है' };
    const report = this.#took(draft, await fetchReport(what, () => this.#deps.reports.balanceSheet(actor, filter)));
    if (report === null) return;

    const body = report.body;
    const assets = citeFrom(report, { 'en-IN': 'what the business owns', 'hi-IN': 'बिज़नेस के पास जो है' }, body.totalAssets);
    const claims = citeFrom(report, { 'en-IN': 'what is claimed against it', 'hi-IN': 'उस पर जो दावे हैं' }, body.totalClaims);
    draft.amounts.push(assets, claims);
    draft.sentences.push(
      plainSentence(
        wording`The business owns ${assets.formatted}, and ${claims.formatted} of that is claimed by others or is your own money in it.`,
        wording`बिज़नेस के पास ${assets.formatted} है, और उसमें से ${claims.formatted} पर दूसरों का या आपका अपना दावा है.`,
      ),
    );
    if (!body.balanced) {
      draft.state = 'PARTLY_ANSWERED';
      draft.sentences.push(
        plainSentence(
          'The two sides do not come to the same figure, so something is missing from the books. That has to be sorted out before this page can be relied on.',
          'दोनों तरफ़ का जोड़ बराबर नहीं है, मतलब बहीखाते में कुछ छूट रहा है. इस पन्ने पर भरोसा करने से पहले उसे ठीक करना होगा.',
        ),
      );
      await this.#raise(actor, draft, 'The balance sheet does not balance for the period the owner asked about.', [
        `snapshot:${report.header.snapshotId}`,
        `difference:${body.difference.minor.toString()} paise`,
      ]);
    }
  }

  async #stock(actor: ActorContext, filter: ReportFilter, reading: Understanding, draft: Draft): Promise<void> {
    const what: Bilingual = { 'en-IN': 'what is left in the godown', 'hi-IN': 'गोदाम में क्या बचा है' };
    const report = this.#took(draft, await fetchReport(what, () => this.#deps.reports.stock(actor, filter)));
    if (report === null) return;

    const body = report.body;
    const wanted = (reading.slots.itemText ?? '').toLowerCase().trim();
    const matching = wanted === '' ? [] : body.rows.filter((row) => row.itemName.toLowerCase().includes(wanted));

    if (wanted !== '' && matching.length === 0) {
      draft.state = 'CANNOT_ANSWER';
      draft.sentences.push(
        plainSentence(
          wording`I could not find an item called "${reading.slots.itemText ?? ''}" in your godown. Check the name on the item list.`,
          wording`"${reading.slots.itemText ?? ''}" नाम का कोई सामान आपके गोदाम में नहीं मिला. सामान की सूची में नाम देख लीजिए.`,
        ),
      );
      return;
    }

    if (matching.length > 0) {
      for (const row of matching.slice(0, 5)) {
        draft.sentences.push(
          plainSentence(
            wording`${row.itemName} at ${row.warehouseName}: ${row.closing} ${row.unitCode} in the godown, ${row.available} ${row.unitCode} free to sell${row.reserved === '0' ? '' : wording` (${row.reserved} ${row.unitCode} held by unfinished bills)`}.`,
            wording`${row.itemName}, ${row.warehouseName}: गोदाम में ${row.closing} ${row.unitCode}, बेचने के लिए ${row.available} ${row.unitCode}${row.reserved === '0' ? '' : wording` (${row.reserved} ${row.unitCode} अधूरे बिल ने रोक रखा है)`}.`,
          ),
        );
      }
      draft.nextSteps.push({ label: { 'en-IN': 'Open what is left in the godown', 'hi-IN': 'खोलिए: गोदाम में क्या बचा है' }, action: 'reports:stock' });
      return;
    }

    const value = citeFrom(report, { 'en-IN': 'what the goods are worth', 'hi-IN': 'माल की कीमत' }, body.value);
    draft.amounts.push(value);
    draft.sentences.push(
      plainSentence(
        wording`You are holding ${plural(body.rows.length, 'item', 'items')} worth ${value.formatted} at what they cost.`,
        wording`आपके पास ${plural(body.rows.length, 'सामान', 'सामान')} है, लागत के हिसाब से ${value.formatted} का.`,
      ),
    );
  }

  async #gst(actor: ActorContext, filter: ReportFilter, period: ResolvedPeriod, draft: Draft): Promise<void> {
    const what: Bilingual = { 'en-IN': 'GST you collected and GST you paid', 'hi-IN': 'आपने जो GST लिया और जो दिया' };
    const report = this.#took(draft, await fetchReport(what, () => this.#deps.reports.gstSummary(actor, filter)));
    if (report === null) return;

    const body = report.body;
    const collected = citeFrom(report, { 'en-IN': 'GST you collected', 'hi-IN': 'आपने जो GST लिया' }, body.totalCollected);
    const paid = citeFrom(report, { 'en-IN': 'GST you already paid', 'hi-IN': 'आप पहले जो GST दे चुके' }, body.totalAlreadyPaid);
    draft.amounts.push(collected, paid);

    draft.sentences.push(
      plainSentence(
        wording`${period.described['en-IN']} you collected ${collected.formatted} of GST and had already paid ${paid.formatted} on your own purchases.`,
        wording`${period.described['hi-IN']} आपने ${collected.formatted} GST लिया और अपनी ख़रीद पर ${paid.formatted} पहले ही दे चुके थे.`,
      ),
    );
    // The difference is a bookkeeping figure, not a return. Saying what it turns into on a return is
    // a compliance statement, and this module does not make those without a rule behind them.
    draft.sentences.push(body.caution);
    draft.state = 'PARTLY_ANSWERED';
    draft.nextSteps.push({ label: { 'en-IN': 'Open the GST summary', 'hi-IN': 'GST का सार खोलिए' }, action: 'reports:gst_summary' });
  }

  async #attention(actor: ActorContext, filter: ReportFilter, draft: Draft): Promise<void> {
    const what: Bilingual = { 'en-IN': 'things worth a second look', 'hi-IN': 'दोबारा देखने लायक़ चीज़ें' };
    const report = this.#took(draft, await fetchReport(what, () => this.#deps.reports.exceptions(actor, filter)));
    if (report === null) return;

    const body = report.body;
    if (body.clean) {
      draft.sentences.push(
        plainSentence('Nothing is waiting for you. Your books hold together for this period.', 'आपके लिए कुछ बाक़ी नहीं है. इस समय का हिसाब ठीक है.'),
      );
      return;
    }
    draft.sentences.push(body.sentence);
    for (const exception of body.exceptions.slice(0, 5)) {
      draft.sentences.push({
        'en-IN': `${exception.what['en-IN']} ${exception.why['en-IN']}`,
        'hi-IN': `${exception.what['hi-IN']} ${exception.why['hi-IN']}`,
      });
    }
    draft.state = 'PARTLY_ANSWERED';
    draft.nextSteps.push({ label: { 'en-IN': 'Open things worth a second look', 'hi-IN': 'खोलिए: दोबारा देखने लायक़ चीज़ें' }, action: 'reports:exceptions' });
  }

  /**
   * "Why is this invoice blocked?" — the question this issue is written around.
   *
   * The module that blocked it says what is in the way; where the block is about a rule, the rules
   * engine is asked itself rather than a sentence being taken on trust. The answer ends with the
   * next safe action, which is what the person actually wanted.
   */
  async #whyBlocked(actor: ActorContext, reading: Understanding, period: ResolvedPeriod, draft: Draft): Promise<void> {
    const port = this.#deps.blocked;
    const reference = reading.slots.documentRef;
    if (port === undefined) {
      draft.state = 'CANNOT_ANSWER';
      draft.sentences.push(
        plainSentence(
          'I cannot see why a bill is held up on this setup. Open the bill and the screen will say what is in the way.',
          'इस सेटअप पर मैं नहीं देख सकता कि बिल क्यों रुका है. बिल खोलिए, स्क्रीन बताएगी कि क्या रोक रहा है.',
        ),
      );
      return;
    }
    // Issue #397 — the answer names the bill, its customer and which items are short and by how
    // much, so it is only given to someone who may see bills and stock. Checked before the lookup
    // so a refusal reads the same whether or not the bill exists.
    if (!BLOCKED_BILL_PERMISSIONS.every((permission) => this.#may(actor, permission))) {
      draft.state = 'NEEDS_PERMISSION';
      draft.sentences.push(
        plainSentence(
          'You do not have access to that bill. Ask the owner if you need to see bills and stock.',
          'आपको उस बिल को देखने की इजाज़त नहीं है. बिल और स्टॉक देखना हो तो मालिक से इजाज़त माँगिए.',
        ),
      );
      return;
    }
    if (reference === null) {
      draft.state = 'CANNOT_ANSWER';
      draft.sentences.push(
        plainSentence(
          'Tell me which bill you mean — its number, such as INV-1042 — and I will say exactly what is holding it up.',
          'बताइए कौनसा बिल — उसका नंबर, जैसे INV-1042 — मैं ठीक बताता हूँ कि उसे क्या रोक रहा है.',
        ),
      );
      return;
    }

    const document = await port.find(actor, reference);
    if (document === null) {
      draft.state = 'CANNOT_ANSWER';
      draft.sentences.push(
        plainSentence(
          wording`I could not find ${reference} in this business.`,
          wording`${reference} इस बिज़नेस में नहीं मिला.`,
        ),
      );
      return;
    }
    if (document.reasons.length === 0) {
      draft.sentences.push(
        plainSentence(
          wording`${document.number ?? reference} is not blocked by anything. If it still will not go out, open it and try again.`,
          wording`${document.number ?? reference} को कुछ रोक नहीं रहा. फिर भी न जाए तो उसे खोलकर दोबारा कोशिश कीजिए.`,
        ),
      );
      return;
    }

    draft.state = 'NEEDS_A_PERSON';
    draft.sentences.push(
      plainSentence(
        wording`${document.number ?? reference}${document.partyName === null ? '' : wording` for ${document.partyName}`} is held up by ${plural(document.reasons.length, 'thing', 'things')}.`,
        wording`${document.number ?? reference}${document.partyName === null ? '' : wording`, ${document.partyName} के लिए,`} ${plural(document.reasons.length, 'चीज़', 'चीज़ें')} की वजह से रुका है.`,
      ),
    );

    for (const reason of document.reasons) {
      draft.sentences.push(reason.what);
      if (reason.topic !== undefined) {
        const citation = this.#decide(reason.topic, reason.facts ?? {}, document.date);
        if (citation !== null) {
          draft.compliance.push(citation);
          draft.sentences.push(safeSentence(describeCitation(citation), supportOf(citation)));
        }
      }
      draft.nextSteps.push({ label: reason.nextStep, action: reason.action });
    }
  }

  /** A question about a rule, asked in the abstract: "do I need an e-way bill?" */
  async #compliance(actor: ActorContext, reading: Understanding, period: ResolvedPeriod, draft: Draft): Promise<void> {
    const topic = reading.slots.topic;
    if (topic === null || this.#deps.rules === undefined || this.#deps.register === undefined) {
      draft.state = 'CANNOT_ANSWER';
      draft.sentences.push(
        plainSentence(
          'I only answer rule questions where we hold an approved rule with the notification it comes from, and I do not have one for this. Your accountant can tell you, and we will not guess.',
          'मैं नियम के सवाल का जवाब तभी देता हूँ जब हमारे पास मंज़ूर किया नियम और उसका नोटिफ़िकेशन हो; इसके लिए नहीं है. आपके अकाउंटेंट बता सकते हैं, हम अंदाज़ा नहीं लगाएंगे.',
        ),
      );
      return;
    }

    const citation = this.#decide(topic, {}, period.to);
    if (citation === null) {
      draft.state = 'CANNOT_ANSWER';
      draft.sentences.push(
        plainSentence(
          'We do not hold a rule for that yet, so I will not put a position on it.',
          'उसके लिए अभी हमारे पास नियम नहीं है, इसलिए मैं कोई राय नहीं दूँगा.',
        ),
      );
      return;
    }

    draft.compliance.push(citation);
    draft.sentences.push(safeSentence(describeCitation(citation), supportOf(citation)));
    if (citation.certainty !== 'THE_RULE_SAYS') {
      // An answer that says "we are not sure" is not an answered question. Marking it answered is
      // how a hedge quietly becomes a position.
      draft.state = 'CANNOT_ANSWER';
    }

    if (citation.missing.length > 0) {
      draft.state = 'NEEDS_A_PERSON';
      draft.sentences.push(
        plainSentence(
          wording`To answer this for one of your bills I need: ${citation.missing.map((fact) => fact.label).join(', ')}. Open the bill and I can answer it exactly.`,
          wording`आपके किसी बिल के लिए यह बताने को चाहिए: ${citation.missing.map((fact) => fact.label).join(', ')}. बिल खोलिए, फिर मैं ठीक बता सकता हूँ.`,
        ),
      );
    }

    if (this.#deps.calendar === undefined) {
      // GPT 3's #32 is not here yet. An answer about dates would be an invention, so it is refused
      // by name rather than approximated.
      draft.assumptions.push(
        plainSentence(
          'I cannot see your filing dates or reminders here yet, so nothing in this answer is about when something is due.',
          'अभी मैं आपकी फ़ाइलिंग की तारीख़ें या याद-दिलाने वाले नहीं देख सकता, इसलिए इस जवाब में कब तक करना है, यह शामिल नहीं है.',
        ),
      );
    }
  }

  /** Puts one question to the rules engine. Returns null when there is no rule for the topic. */
  /** Whether the asker holds a permission, asked of the platform rather than read off the actor. */
  #may(actor: ActorContext, permission: string): boolean {
    try {
      this.#deps.permissions.require(actor, permission, 'see this');
      return true;
    } catch (error) {
      if (error instanceof DomainError && error.kind === 'FORBIDDEN') return false;
      throw error;
    }
  }

  #decide(topic: string, facts: Readonly<Record<string, string>>, on: IsoDate): ComplianceCitation | null {
    const engine = this.#deps.rules;
    const register = this.#deps.register;
    if (engine === undefined || register === undefined) return null;
    const { decision } = engine.evaluate({
      topic,
      facts: FactSet.of(facts, 'DOCUMENT'),
      documentDate: on,
    });
    return citeCompliance(decision, register, on);
  }

  /**
   * Checks the books hold together before a figure derived from them is relied on.
   *
   * An unbalanced trial balance makes every other total suspect, so the answer says so instead of
   * quoting a profit as though it were settled.
   */
  async #checkBooksHoldTogether(actor: ActorContext, filter: ReportFilter, draft: Draft): Promise<void> {
    const fetched = await fetchReport({ 'en-IN': 'whether the books hold together', 'hi-IN': 'क्या बहीखाते का हिसाब मिल रहा है' }, () =>
      this.#deps.reports.trialBalance(actor, filter),
    );
    if (!fetched.ok) return;
    if (fetched.report.body.balanced) return;
    draft.state = 'PARTLY_ANSWERED';
    draft.sources.push({ reportId: fetched.report.header.reportId, snapshotId: fetched.report.header.snapshotId });
    draft.sentences.push(
      plainSentence(
        'Be careful with this figure: the two sides of your books do not add up to the same total, so something is missing.',
        'इस आंकड़े से सावधान रहिए: आपकी बहीखाते के दोनों तरफ़ का जोड़ बराबर नहीं है, कुछ छूट रहा है.',
      ),
    );
  }

  async #raise(actor: ActorContext, draft: Draft, summary: string, evidence: readonly string[]): Promise<void> {
    const queue = this.#deps.exceptions;
    if (queue === undefined) return;
    const item = await queue.raise({ companyId: actor.companyId, summary, evidence });
    draft.exceptionId = item.id;
    draft.nextSteps.push({
      label: { 'en-IN': 'A person has been asked to look at this', 'hi-IN': 'एक व्यक्ति से इसे देखने को कहा गया है' },
      action: `exception:${item.id}`,
    });
  }
}

/** How each supported question reads when it is offered as an example. */
export const describeIntent = (intent: Intent): Bilingual => {
  const table: Record<Intent, Bilingual> = {
    MONEY_OWED_TO_ME: { 'en-IN': 'Who owes me money?', 'hi-IN': 'मुझे किससे पैसा लेना है?' },
    MONEY_I_OWE: { 'en-IN': 'Who do I owe money to?', 'hi-IN': 'मुझे किसको पैसा देना है?' },
    SALES_IN_PERIOD: { 'en-IN': 'How much did I sell last month?', 'hi-IN': 'पिछले महीने कितना बेचा?' },
    PURCHASES_IN_PERIOD: { 'en-IN': 'How much did I buy this month?', 'hi-IN': 'इस महीने कितनी ख़रीद हुई?' },
    PROFIT_IN_PERIOD: { 'en-IN': 'Did I make money this month?', 'hi-IN': 'इस महीने मुनाफ़ा हुआ?' },
    WHAT_I_OWN: { 'en-IN': 'What does the business own and owe?', 'hi-IN': 'बिज़नेस के पास क्या है और क्या देना है?' },
    STOCK_POSITION: { 'en-IN': 'How much rice is left?', 'hi-IN': 'चावल कितना बचा है?' },
    GST_IN_PERIOD: { 'en-IN': 'How much GST did I collect this month?', 'hi-IN': 'इस महीने कितना GST लिया?' },
    NEEDS_ATTENTION: { 'en-IN': 'What needs my attention?', 'hi-IN': 'मुझे किस पर ध्यान देना चाहिए?' },
    WHY_BLOCKED: { 'en-IN': 'Why is INV-1042 blocked?', 'hi-IN': 'INV-1042 क्यों रुका है?' },
    COMPLIANCE_QUESTION: { 'en-IN': 'Do I need an e-way bill for this?', 'hi-IN': 'इसके लिए ई-वे बिल ज़रूरी है क्या?' },
    UNSUPPORTED: { 'en-IN': 'Something about your books', 'hi-IN': 'आपकी बहीखाते के बारे में कुछ' },
  };
  return table[intent];
};
