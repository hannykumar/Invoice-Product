/**
 * Issue #47 [E47] — turning an understood request into concrete steps, against live data.
 *
 * Expansion is where "find ABC's unpaid invoices and send reminders" stops being a sentence and
 * becomes three named bills with three real amounts. It runs **read** tools only — the runner it is
 * given refuses anything else — so a preview can never change anything, however a recipe is
 * written. Everything a recipe cannot establish becomes a refusal with a question, never a guess.
 */
import { formatINR, type IsoDate, type Money } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import type { AgentIntent, Bilingual, PlannedStep, Refusal } from './model.ts';
import { WHAT_I_CAN_DO, type UnderstoodRequest } from './planning.ts';
import type { PartyDirectoryPort } from './ports.ts';
import type { ToolRegistry } from './registry.ts';

export interface ReadResult {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly output: unknown;
  readonly describe: Bilingual;
}

export interface RecipeContext {
  readonly actor: ActorContext;
  readonly registry: ToolRegistry;
  readonly parties: PartyDirectoryPort;
  readonly today: IsoDate;
  /** Runs a READ tool. Throws if asked for anything else — a preview cannot write. */
  readTool(name: string, input: unknown): Promise<ReadResult>;
  nextStepId(): string;
}

export interface Expansion {
  readonly steps: readonly PlannedStep[];
  readonly refusals: readonly Refusal[];
  readonly summary: Bilingual;
  /** The read results, kept so the report can show what the plan was built from. */
  readonly reads: readonly ReadResult[];
}

export interface UnpaidBill {
  readonly documentId: string;
  readonly bill: string;
  readonly partyId: string;
  readonly partyName: string;
  readonly outstanding: Money;
  readonly daysOverdue: number;
  readonly wouldRemind: boolean;
  readonly leftAloneBecause: Bilingual | null;
}

export interface UnpaidBills {
  readonly bills: readonly UnpaidBill[];
}

const refusal = (code: Refusal['code'], reason: Bilingual, tool: string | null = null): Refusal => ({ code, reason, tool });

const nothing = (summary: Bilingual, refusals: readonly Refusal[], reads: readonly ReadResult[] = []): Expansion => ({
  steps: [], refusals, summary, reads,
});

/**
 * Which customer was meant.
 *
 * One match is a fact. Several is a question. None is a refusal. The agent never picks the closest
 * name, because choosing whose money is being chased is not a guess it is entitled to make.
 */
const resolveParty = async (
  context: RecipeContext,
  text: string,
): Promise<{ party: { partyId: string; name: string } } | { refusal: Refusal }> => {
  const matches = await context.parties.resolve(context.actor, text);
  if (matches.length === 1) return { party: matches[0] as { partyId: string; name: string } };
  if (matches.length === 0) {
    return {
      refusal: refusal('MISSING_FACT', {
        'en-IN': `I could not find a customer called "${text}" in your business, so I have not assumed who you meant.`,
        'hi-IN': `आपके बिज़नेस में "${text}" नाम का कोई ग्राहक नहीं मिला, इसलिए मैंने अंदाज़ा नहीं लगाया कि आप किसकी बात कर रहे हैं.`,
      }),
    };
  }
  const names = matches.map((match) => match.name).join(', ');
  return {
    refusal: refusal('MISSING_FACT', {
      'en-IN': `"${text}" matches more than one customer — ${names}. Tell me which one and I will go ahead.`,
      'hi-IN': `"${text}" से एक से ज़्यादा ग्राहक मिलते हैं — ${names}. बता दीजिए कौनसा, फिर मैं आगे बढ़ता हूँ.`,
    }),
  };
};

/**
 * One step, built only if this person could take it themselves.
 *
 * A tool they may not use becomes a refusal they can read rather than a thrown error, because the
 * honest answer to "send them a reminder" from somebody who may not send reminders is a sentence,
 * not a stack trace. `execute` checks again and refuses outright — this is the courteous half of
 * the same rule, not the enforcing one.
 */
const step = (
  context: RecipeContext,
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  extra: { dependsOn?: string | null; amount?: Money | null; party?: string | null } = {},
): PlannedStep => {
  const tool = context.registry.require(toolName);
  const parsed = tool.parse(input as never);
  return {
    stepId: context.nextStepId(),
    tool: toolName,
    input,
    describe: tool.describe(parsed),
    kind: tool.kind,
    risk: tool.risk,
    executability: tool.executability,
    highRiskClass: tool.highRiskClass ?? null,
    dependsOn: extra.dependsOn ?? null,
    amount: extra.amount ?? (tool.amountOf?.(parsed) ?? null),
    party: extra.party ?? (tool.partyOf?.(parsed) ?? null),
  };
};

/**
 * The optional grounding step: what the canonical report says customers owe.
 *
 * It is **run**, not merely listed. #34 will not let a figure into an answer unless it folds to its
 * own records, and it carries out the report id and the snapshot id — so running it here is what
 * makes the agent's total checkable against a report a person can open, rather than a number this
 * package worked out for itself. Skipped, without complaint, for somebody who may not ask.
 */
const grounding = async (context: RecipeContext): Promise<{ step: PlannedStep; read: ReadResult } | null> => {
  if (!context.registry.permits(context.actor, 'books.total_owed')) return null;
  const read = await context.readTool('books.total_owed', { today: context.today });
  return { step: step(context, 'books.total_owed', { today: context.today }), read };
};

const notPermitted = (context: RecipeContext, toolName: string): Refusal | null => {
  if (context.registry.permits(context.actor, toolName)) return null;
  const tool = context.registry.require(toolName);
  return refusal('TOOL_NOT_PERMITTED', {
    'en-IN': `You do not have permission to ${tool.summary['en-IN']}, so I cannot do it for you either.`,
    'hi-IN': `आपको ${tool.summary['hi-IN']} की इजाज़त नहीं है, इसलिए मैं भी आपके लिए यह नहीं कर सकता.`,
  }, toolName);
};

export const expand = async (context: RecipeContext, understood: UnderstoodRequest): Promise<Expansion> => {
  switch (understood.intent) {
    case 'NOT_MY_REQUEST':
      return nothing(WHAT_I_CAN_DO, [refusal('NOT_MY_REQUEST', WHAT_I_CAN_DO)]);

    case 'MOVE_MONEY':
    case 'FILE_RETURN':
      return nothing(
        {
          'en-IN': 'This is not something I will finish on my own.',
          'hi-IN': 'यह काम मैं अपने आप पूरा नहीं करूँगा.',
        },
        [
          refusal('HIGH_RISK_PREPARE_ONLY', understood.intent === 'MOVE_MONEY'
            ? {
                'en-IN': 'Moving money is not something the assistant does. Record the payment yourself on the Payment screen, where you can see the account and the amount before it goes.',
                'hi-IN': 'पैसा भेजना असिस्टेंट का काम नहीं है. पेमेंट स्क्रीन पर ख़ुद रिकॉर्ड कीजिए, जहां अकाउंट और रकम भेजने से पहले दिख जाएंगे.',
              }
            : {
                'en-IN': 'Filing a return with the government is not something the assistant does. Prepare it on the GST screen and file it yourself, so the person filing is the person responsible.',
                'hi-IN': 'सरकार को रिटर्न फ़ाइल करना असिस्टेंट का काम नहीं है. GST स्क्रीन पर तैयार कीजिए और ख़ुद फ़ाइल कीजिए, ताकि जो फ़ाइल करे वही ज़िम्मेदार हो.',
              }),
        ],
      );

    case 'SHOW_WHO_OWES': {
      const read = await context.readTool('dues.find_unpaid', { today: context.today });
      const bills = (read.output as UnpaidBills).bills;
      const steps = [step(context, 'dues.find_unpaid', { today: context.today })];
      const checked = await grounding(context);
      if (checked !== null) steps.push(checked.step);
      const total = bills.reduce((sum, bill) => sum + bill.outstanding.minor, 0n);
      return {
        steps,
        refusals: [],
        reads: checked === null ? [read] : [read, checked.read],
        summary: {
          'en-IN': `${bills.length} unpaid bill${bills.length === 1 ? '' : 's'}, ${formatINR({ currency: 'INR', minor: total })} in all. Nothing here changes anything.`,
          'hi-IN': `${bills.length} बिल बाक़ी हैं, कुल ${formatINR({ currency: 'INR', minor: total })}. इससे कुछ बदलता नहीं.`,
        },
      };
    }

    case 'STOP_REMINDING': {
      if (understood.partyText === null) {
        return nothing(
          { 'en-IN': 'Which customer should I stop reminding?', 'hi-IN': 'किस ग्राहक को रिमाइंडर भेजना बंद करना है?' },
          [refusal('MISSING_FACT', {
            'en-IN': 'Tell me which customer to stop reminding, and I will do it. I have not guessed.',
            'hi-IN': 'बता दीजिए किस ग्राहक को रिमाइंडर बंद करना है, मैं कर दूँगा. मैंने अंदाज़ा नहीं लगाया.',
          })],
        );
      }
      const resolved = await resolveParty(context, understood.partyText);
      if ('refusal' in resolved) return nothing(resolved.refusal.reason, [resolved.refusal]);
      const blocked = notPermitted(context, 'reminders.stop');
      if (blocked !== null) return nothing(blocked.reason, [blocked]);
      return {
        steps: [step(context, 'reminders.stop', { partyId: resolved.party.partyId, partyName: resolved.party.name, reason: 'You asked me to stop reminding this customer.' }, { party: resolved.party.name })],
        refusals: [],
        reads: [],
        summary: {
          'en-IN': `${resolved.party.name} will stop receiving automatic reminders. Their bills stay exactly as they are.`,
          'hi-IN': `${resolved.party.name} को ऑटोमैटिक रिमाइंडर जाना बंद हो जाएगा. उनके बिल जैसे हैं वैसे ही रहेंगे.`,
        },
      };
    }

    case 'CANCEL_INVOICE': {
      if (understood.documentRef === null) {
        return nothing(
          { 'en-IN': 'Which bill should be cancelled?', 'hi-IN': 'कौनसा बिल रद्द करना है?' },
          [refusal('MISSING_FACT', {
            'en-IN': 'Tell me the bill number. Cancelling the wrong bill is not something I can undo for you.',
            'hi-IN': 'बिल नंबर बता दीजिए. ग़लत बिल रद्द हो गया तो मैं उसे वापस नहीं ला सकता.',
          })],
        );
      }
      const cannotCancel = notPermitted(context, 'sales.cancel');
      if (cannotCancel !== null) return nothing(cannotCancel.reason, [cannotCancel]);
      return {
        steps: [step(context, 'sales.cancel', { documentRef: understood.documentRef, reason: 'Prepared by the assistant at your request.' })],
        refusals: [refusal('HIGH_RISK_PREPARE_ONLY', {
          'en-IN': 'Cancelling a bill is yours to finish. I will prepare it and leave it waiting for you to confirm on the sales screen.',
          'hi-IN': 'बिल रद्द करना आपके हाथ में है. मैं उसे तैयार कर के छोड़ दूँगा; सेल्स स्क्रीन पर आप पक्का कर दीजिए.',
        }, 'sales.cancel')],
        reads: [],
        summary: {
          'en-IN': `I will prepare the cancellation of ${understood.documentRef} and stop there.`,
          'hi-IN': `मैं ${understood.documentRef} रद्द करने की तैयारी कर के रुक जाऊँगा.`,
        },
      };
    }

    case 'CHASE_UNPAID': {
      const read = await context.readTool('dues.find_unpaid', { today: context.today });
      let bills = (read.output as UnpaidBills).bills;
      let who: string | null = null;

      if (understood.partyText !== null) {
        const resolved = await resolveParty(context, understood.partyText);
        if ('refusal' in resolved) return nothing(resolved.refusal.reason, [resolved.refusal], [read]);
        who = resolved.party.name;
        bills = bills.filter((bill) => bill.partyId === resolved.party.partyId);
      }

      const steps: PlannedStep[] = [step(context, 'dues.find_unpaid', { today: context.today })];
      const checked = await grounding(context);
      if (checked !== null) steps.push(checked.step);
      const findStepId = (steps[0] as PlannedStep).stepId;

      const sending = bills.filter((bill) => bill.wouldRemind);
      const cannotSend = notPermitted(context, 'reminders.send');
      if (cannotSend !== null && sending.length > 0) {
        return nothing(cannotSend.reason, [cannotSend], [read]);
      }
      for (const bill of sending) {
        steps.push(step(context, 'reminders.send', { documentId: bill.documentId, bill: bill.bill, partyName: bill.partyName, today: context.today }, {
          dependsOn: findStepId,
          amount: bill.outstanding,
          party: bill.partyName,
        }));
      }

      const leftAlone = bills.filter((bill) => !bill.wouldRemind);
      const refusals: Refusal[] = [];
      if (sending.length === 0) {
        refusals.push(refusal('NOTHING_TO_DO', bills.length === 0
          ? {
              'en-IN': who === null ? 'Nobody owes you anything that is due, so there is nothing to send.' : `${who} has no unpaid bill that is due, so there is nothing to send.`,
              'hi-IN': who === null ? 'अभी किसी का कोई बिल बाक़ी नहीं है, इसलिए कुछ भेजने को नहीं है.' : `${who} का कोई बाक़ी बिल नहीं है, इसलिए कुछ भेजने को नहीं है.`,
            }
          : {
              'en-IN': `Every one of these ${bills.length} bills is deliberately being left alone today. The reasons are on the reminders screen.`,
              'hi-IN': `इन ${bills.length} बिलों को आज जान-बूझकर छोड़ा जा रहा है. वजह रिमाइंडर स्क्रीन पर लिखी है.`,
            }));
      }

      const total = sending.reduce((sum, bill) => sum + bill.outstanding.minor, 0n);
      return {
        steps,
        refusals,
        reads: checked === null ? [read] : [read, checked.read],
        summary: sending.length === 0
          ? { 'en-IN': 'Nothing would be sent.', 'hi-IN': 'कुछ नहीं भेजा जाएगा.' }
          : {
              'en-IN': `${sending.length} reminder${sending.length === 1 ? '' : 's'} about ${formatINR({ currency: 'INR', minor: total })}${leftAlone.length === 0 ? '' : `, and ${leftAlone.length} bill${leftAlone.length === 1 ? '' : 's'} left alone`}. Nothing goes until you say so.`,
              'hi-IN': `${formatINR({ currency: 'INR', minor: total })} के लिए ${sending.length} रिमाइंडर${leftAlone.length === 0 ? '' : `, और ${leftAlone.length} बिल छोड़ दिए गए`}. आपके कहे बिना कुछ नहीं जाएगा.`,
            },
      };
    }
  }
};

export type { AgentIntent };
