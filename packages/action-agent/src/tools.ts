/**
 * Issue #47 [E47] — the tools, over the modules that already do the work.
 *
 * Nothing here decides anything. `dues.find_unpaid` asks #23 what it would do; `reminders.send`
 * asks #23 to do it, which re-checks the bill against #20 at the moment of sending;
 * `books.total_owed` asks #34, which can only quote a figure that reconciles to one of #35's
 * reports and carries its snapshot id. The agent's contribution is deciding *which* of these to
 * call, showing a person first, and refusing the ones that are not its to finish.
 */
import { formatINR, invalid, isoDate, money, type IsoDate, type Money } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import type { CollectionsService } from '@invoice/collections';
import type { AssistantService } from '../../assistant/src/service.ts';
import type { Bilingual, ToolEvidence } from './model.ts';
import type { UnpaidBills } from './recipes.ts';
import type { ToolDefinition } from './registry.ts';

const asString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`"${field}" is missing, and it is not something to be guessed at.`);
  }
  return value;
};

const asDate = (value: unknown): IsoDate => isoDate(asString(value, 'today'));

const bilingual = (en: string, hi: string): Bilingual => ({ 'en-IN': en, 'hi-IN': hi });

// ------------------------------------------------------------------------------- reading tools

export interface FindUnpaidInput { readonly today: IsoDate }

/**
 * What is owed, and what #23 would do about each bill.
 *
 * It returns the bills that would be left alone as well as the ones that would be chased, with the
 * reason, because a plan built only from what *would* be sent hides the more interesting half.
 */
export const findUnpaidTool = (collections: CollectionsService): ToolDefinition<FindUnpaidInput, UnpaidBills> => ({
  name: 'dues.find_unpaid',
  kind: 'READ',
  risk: 'low',
  executability: 'ALWAYS',
  permissions: ['collections.reminders.view'],
  summary: bilingual('see which bills are unpaid', 'dekhein kaunse bill baaki hain'),
  parse: (input) => ({ today: asDate((input as { today?: unknown }).today) }),
  describe: () => bilingual('Look at every unpaid bill and what would be done about it.', 'Har baaki bill aur uske bare mein kya hoga, yeh dekhein.'),
  async run(actor, input) {
    const plan = await collections.plan(actor, input.today);
    return {
      bills: plan.candidates
        .filter((candidate) => candidate.reason !== 'SETTLED')
        .map((candidate) => ({
          documentId: candidate.documentId,
          bill: candidate.snapshot.documentNumber,
          partyId: String(candidate.partyId),
          partyName: candidate.partyName,
          outstanding: candidate.snapshot.outstanding,
          daysOverdue: candidate.snapshot.daysOverdue,
          wouldRemind: candidate.decision === 'SEND',
          leftAloneBecause: candidate.decision === 'SEND' ? null : candidate.explanation,
        })),
    };
  },
  evidence(_input, output) {
    const total = output.bills.reduce((sum, bill) => sum + bill.outstanding.minor, 0n);
    return {
      statement: bilingual(
        `${output.bills.length} unpaid bill${output.bills.length === 1 ? '' : 's'}, ${formatINR(money(total))} in all.`,
        `${output.bills.length} bill baaki, kul ${formatINR(money(total))}.`,
      ),
      details: Object.fromEntries(output.bills.map((bill) => [bill.bill, `${bill.partyName} · ${formatINR(bill.outstanding)} · ${bill.daysOverdue} days`])),
    };
  },
});

export interface TotalOwedInput { readonly today: IsoDate }
export interface TotalOwedOutput {
  readonly formatted: string;
  readonly reportId: string;
  readonly snapshotId: string;
  readonly sentence: Bilingual;
}

/**
 * The same total, from the canonical report.
 *
 * This is the grounding step. #34 will not let a figure into an answer unless it folds to its own
 * records, and it carries out the report id and the **snapshot id**, so the number the agent shows
 * can be checked against the report a person can open themselves.
 */
export const totalOwedTool = (assistant: AssistantService): ToolDefinition<TotalOwedInput, TotalOwedOutput> => ({
  name: 'books.total_owed',
  kind: 'READ',
  risk: 'low',
  executability: 'ALWAYS',
  permissions: ['assistant.ask'],
  summary: bilingual('check the total against your reports', 'kul rakam ko report se milaayein'),
  parse: (input) => ({ today: asDate((input as { today?: unknown }).today) }),
  describe: () => bilingual('Check the total owed against the report it comes from.', 'Kul kitna lena hai, use us report se milaayein jahan se woh aata hai.'),
  async run(actor, input) {
    const answer = await assistant.ask(actor, { question: 'How much do customers owe me?', today: input.today });
    const cited = answer.amounts[0];
    return {
      formatted: cited?.formatted ?? '—',
      reportId: cited?.reportId ?? '',
      snapshotId: cited?.snapshotId ?? '',
      sentence: answer.sentences[0] ?? bilingual('No figure could be quoted.', 'Koi rakam nahin batayi ja sakti.'),
    };
  },
  evidence: (_input, output) => ({
    statement: output.sentence,
    details: { total: output.formatted, report: output.reportId, snapshot: output.snapshotId },
  }),
});

// ------------------------------------------------------------------------------- writing tools

export interface SendReminderInput {
  readonly documentId: string;
  readonly bill: string;
  readonly partyName: string;
  readonly today: IsoDate;
}

/**
 * Sending one reminder.
 *
 * The agent does not decide what the message says or whether the bill still deserves one: #23 does
 * both, and re-reads the bill from receivables at the moment of sending. So a bill paid between
 * the approval and this call stops the message here as well as at the fingerprint check.
 */
export const sendReminderTool = (collections: CollectionsService): ToolDefinition<SendReminderInput, { state: string; message: Bilingual; outstanding: Money }> => ({
  name: 'reminders.send',
  kind: 'WRITE',
  risk: 'medium',
  executability: 'AFTER_APPROVAL',
  permissions: ['collections.reminders.send'],
  summary: bilingual('send a payment reminder', 'paise ka reminder bhejein'),
  parse: (input) => {
    const raw = input as Record<string, unknown>;
    return {
      documentId: asString(raw.documentId, 'documentId'),
      bill: asString(raw.bill, 'bill'),
      partyName: asString(raw.partyName, 'partyName'),
      today: asDate(raw.today),
    };
  },
  describe: (input) => bilingual(
    `Send ${input.partyName} a reminder about bill ${input.bill}.`,
    `${input.partyName} ko bill ${input.bill} ka reminder bhejein.`,
  ),
  partyOf: (input) => input.partyName,
  async run(actor, input) {
    const reminder = await collections.send(actor, { documentId: input.documentId, today: input.today });
    return { state: reminder.state, message: reminder.message, outstanding: reminder.snapshot.outstanding };
  },
  evidence: (input, output) => ({
    statement: output.state === 'SENT'
      ? bilingual(
          `Reminder about ${input.bill} for ${formatINR(output.outstanding)} went to ${input.partyName}.`,
          `${input.bill} ka ${formatINR(output.outstanding)} ka reminder ${input.partyName} ko chala gaya.`,
        )
      : bilingual(
          `The reminder about ${input.bill} was ${output.state.toLowerCase()}.`,
          `${input.bill} ka reminder ${output.state.toLowerCase()} raha.`,
        ),
    details: { bill: input.bill, party: input.partyName, amount: formatINR(output.outstanding), state: output.state },
  }),
});

export interface StopRemindingInput {
  readonly partyId: string;
  readonly partyName: string;
  readonly reason: string;
}

export const stopRemindingTool = (collections: CollectionsService): ToolDefinition<StopRemindingInput, { partyId: string }> => ({
  name: 'reminders.stop',
  kind: 'WRITE',
  risk: 'low',
  executability: 'AFTER_APPROVAL',
  permissions: ['collections.reminders.send'],
  summary: bilingual('stop reminding a customer', 'kisi grahak ko reminder bhejna band karein'),
  parse: (input) => {
    const raw = input as Record<string, unknown>;
    return {
      partyId: asString(raw.partyId, 'partyId'),
      partyName: asString(raw.partyName, 'partyName'),
      reason: asString(raw.reason, 'reason'),
    };
  },
  describe: (input) => bilingual(
    `Stop sending ${input.partyName} automatic reminders.`,
    `${input.partyName} ko automatic reminder bhejna band karein.`,
  ),
  partyOf: (input) => input.partyName,
  async run(actor, input) {
    await collections.optOut(actor, input.partyId as never, input.reason);
    return { partyId: input.partyId };
  },
  evidence: (input) => ({
    statement: bilingual(
      `${input.partyName} will not receive automatic reminders.`,
      `${input.partyName} ko automatic reminder nahin jayenge.`,
    ),
    details: { party: input.partyName },
  }),
});

// ------------------------------------------------------------------- the prepare-only high risk

export interface CancelInvoiceInput {
  readonly documentRef: string;
  readonly reason: string;
}

/**
 * Cancelling a bill: prepared, never finished.
 *
 * `run` throws. That is not defensive coding for an unlikely case — it is the assertion that no
 * path in this package calls a `PREPARE_ONLY` tool, and a test drives it. The service creates a
 * platform command in `submitted` instead, and a person finalises it on the sales screen.
 */
export const cancelInvoiceTool = (): ToolDefinition<CancelInvoiceInput, never> => ({
  name: 'sales.cancel',
  kind: 'WRITE',
  risk: 'high',
  highRiskClass: 'CANCELLATION',
  executability: 'PREPARE_ONLY',
  permissions: ['sales.cancel'],
  summary: bilingual('cancel a bill', 'ek bill radd karein'),
  parse: (input) => {
    const raw = input as Record<string, unknown>;
    return { documentRef: asString(raw.documentRef, 'documentRef'), reason: asString(raw.reason, 'reason') };
  },
  describe: (input) => bilingual(
    `Prepare the cancellation of bill ${input.documentRef} for you to confirm.`,
    `Bill ${input.documentRef} radd karne ki taiyari karein, confirm aap karenge.`,
  ),
  async run() {
    throw invalid(
      'AGENT_MUST_NOT_RUN',
      'Cancelling a bill is prepared for a person to finish, so the assistant never runs it.',
    );
  },
  evidence: (input): ToolEvidence => ({
    statement: bilingual(
      `Cancellation of ${input.documentRef} is prepared and waiting for you.`,
      `${input.documentRef} radd karne ki taiyari ho gayi hai, aapka intezar hai.`,
    ),
    details: { bill: input.documentRef },
  }),
});
