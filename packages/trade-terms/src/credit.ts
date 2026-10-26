/**
 * Issue #11 [E11] — whether this customer should be given any more credit.
 *
 * The arithmetic of "are they over their limit" belongs to the approved `sales.credit_limit` rule
 * in #7, not here: it is versioned, effective-dated and explains itself, and a second copy of it
 * in this file is a second answer waiting to disagree. This module gathers the facts, hands them
 * over, and turns the rule's verdict into what the business asked to happen.
 *
 * The fact that matters most is the one that is easiest to leave out: **bills started and not yet
 * issued**. Two people at two tills, each writing a bill for the same customer, will each be told
 * the limit is fine unless the other's unfinished bill is counted.
 */
import { formatINR, money, subtract, sum, type IsoDate, type Money, type PartyId } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import { FactSet, type RulesEngine } from '@invoice/rules-engine';
import type { CreditDecision, CreditOutcome } from './model.ts';
import type { CreditPositionPort, PartyTermsPort, SalesHistoryPort } from './ports.ts';
import type { TradeTermsPolicy } from './policy.ts';

export interface CreditRequest {
  readonly partyId: PartyId;
  readonly saleValue: Money;
  readonly documentDate: IsoDate;
  /** The bill being written, so its own draft is not counted against itself. */
  readonly documentId: string | null;
}

export interface CreditDeps {
  readonly parties: PartyTermsPort;
  readonly positions: CreditPositionPort;
  readonly history: SalesHistoryPort;
  readonly engine: RulesEngine;
  readonly policy: TradeTermsPolicy;
}

const nil = (): Money => money(0n);

export const decideCredit = async (
  deps: CreditDeps,
  actor: ActorContext,
  request: CreditRequest,
): Promise<CreditDecision> => {
  const companyId = actor.companyId;
  const [limit, position, pending, name] = await Promise.all([
    deps.parties.creditLimit(companyId, request.partyId),
    deps.positions.outstanding(actor, request.partyId, request.documentDate),
    deps.history.pendingValue(companyId, request.partyId, request.documentId),
    deps.parties.nameOf(companyId, request.partyId),
  ]);

  const exposure = sum([position.total, pending, request.saleValue]);
  const overdueDays = position.oldestDaysOverdue;
  const tooLate =
    deps.policy.blockWhenOverdueByDays !== null && overdueDays > deps.policy.blockWhenOverdueByDays;

  // No limit on file is not a limit of zero, and not unlimited either: it is unknown. Nobody is
  // stopped by a fact nobody entered, and the page says the fact is missing.
  if (limit === null) {
    const outcome: CreditOutcome = tooLate ? 'BLOCK' : 'ALLOW';
    return {
      partyId: request.partyId,
      outcome,
      limit: null,
      outstanding: position.total,
      pending,
      saleValue: request.saleValue,
      exposure,
      excess: nil(),
      oldestDaysOverdue: overdueDays,
      ruleId: null,
      ruleVersion: null,
      sentence: tooLate
        ? {
            'en-IN': `${name}'s oldest unpaid bill is ${overdueDays} days late, so this bill is on hold.`,
            'hi-IN': `${name} का सबसे पुराना बिना चुकाया बिल ${overdueDays} दिन देर से है, इसलिए यह बिल रोका गया है।`,
          }
        : {
            'en-IN': `No credit limit has been set for ${name}, so we cannot say whether this bill crosses one.`,
            'hi-IN': `${name} के लिए कोई उधार सीमा तय नहीं है, इसलिए यह नहीं कह सकते कि यह बिल उसे पार करता है या नहीं।`,
          },
      why: {
        'en-IN': 'We do not guess a limit. Set one for this customer and we will check every bill against it.',
        'hi-IN': 'हम सीमा का अंदाज़ा नहीं लगाते। इस ग्राहक के लिए एक तय कीजिए, फिर हम हर बिल जाँचेंगे।',
      },
    };
  }

  // The approved rule decides over-limit. We give it every fact it asks for and keep its verdict.
  const decision = deps.engine.evaluate({
    topic: 'sales.credit_limit',
    facts: FactSet.of(
      {
        'party.creditLimit': limit,
        'party.outstanding': position.total,
        'party.pendingValue': pending,
        'sale.value': request.saleValue,
      },
      'DERIVED',
    ),
    documentDate: request.documentDate,
  }).decision;

  const excessMinor = exposure.minor - limit.minor;
  const excess = excessMinor > 0n ? money(excessMinor) : nil();
  const overLimit = decision.outcome === 'WARN';

  const outcome: CreditOutcome = tooLate
    ? 'BLOCK'
    : overLimit
      ? deps.policy.overLimit === 'BLOCK'
        ? 'BLOCK'
        : 'WARN'
      : 'ALLOW';

  // Issue #235 — the sum is written out, so the shopkeeper can check it on paper: what they owe
  // now, any bill held back for them, this bill, and what that comes to.
  const held = pending.minor > 0n;
  const owedNow = {
    'en-IN': `${name} owes ${formatINR(position.total)}.${held ? ` Bills held for them and not yet issued come to ${formatINR(pending)}.` : ''} This bill is ${formatINR(request.saleValue)}.`,
    'hi-IN': `${name} पर ${formatINR(position.total)} बाक़ी है।${held ? ` उनके रोके गए, अभी जारी न हुए बिल ${formatINR(pending)} के हैं।` : ''} यह बिल ${formatINR(request.saleValue)} का है।`,
  };
  const parts = [position.total, ...(held ? [pending] : []), request.saleValue].map(formatINR).join(' + ');
  const together = {
    'en-IN': `Together ${parts} = ${formatINR(exposure)}`,
    'hi-IN': `कुल ${parts} = ${formatINR(exposure)}`,
  };

  const sentence = tooLate
    ? {
        'en-IN': `${name}'s oldest unpaid bill is ${overdueDays} days late, so this bill is on hold until something is collected.`,
        'hi-IN': `${name} का सबसे पुराना बिना चुकाया बिल ${overdueDays} दिन देर से है, इसलिए कुछ वसूली होने तक यह बिल रोका गया है।`,
      }
    : overLimit
      ? {
          'en-IN': `${owedNow['en-IN']} ${together['en-IN']}. That is ${formatINR(exposure)} − ${formatINR(limit)} = ${formatINR(excess)} over their ${formatINR(limit)} limit.`,
          'hi-IN': `${owedNow['hi-IN']} ${together['hi-IN']}। यह उनकी ${formatINR(limit)} की सीमा से ${formatINR(exposure)} − ${formatINR(limit)} = ${formatINR(excess)} ज़्यादा है।`,
        }
      : {
          'en-IN': `${owedNow['en-IN']} ${together['en-IN']}. That is within their ${formatINR(limit)} limit.`,
          'hi-IN': `${owedNow['hi-IN']} ${together['hi-IN']}। यह उनकी ${formatINR(limit)} की सीमा के अंदर है।`,
        };

  return {
    partyId: request.partyId,
    outcome,
    limit,
    outstanding: position.total,
    pending,
    saleValue: request.saleValue,
    exposure,
    excess,
    oldestDaysOverdue: overdueDays,
    ruleId: decision.ruleId,
    ruleVersion: decision.ruleVersion,
    sentence,
    why: {
      'en-IN': 'We add what they owe after payments and credit notes, bills held back for them, and this whole bill with GST and charges.',
      'hi-IN': 'हम जोड़ते हैं: पेमेंट और क्रेडिट नोट के बाद का बाक़ी, उनके रोके गए बिल, और GST और ख़र्चों समेत यह पूरा बिल।',
    },
  };
};

export const exposureOf = (outstanding: Money, pending: Money, saleValue: Money): Money =>
  sum([outstanding, pending, saleValue]);

export const excessOver = (limit: Money, exposure: Money): Money => {
  const over = subtract(exposure, limit);
  return over.minor > 0n ? over : nil();
};
