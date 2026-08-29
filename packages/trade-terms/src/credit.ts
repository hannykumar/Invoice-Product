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
            'hi-IN': `${name} ka sabse purana bina chukaya bill ${overdueDays} din late hai, isliye yeh bill roka gaya hai.`,
          }
        : {
            'en-IN': `No credit limit has been set for ${name}, so we cannot say whether this bill crosses one.`,
            'hi-IN': `${name} ke liye koi udhaar seema tay nahin hai, isliye yeh nahin keh sakte ki yeh bill use paar karta hai ya nahin.`,
          },
      why: {
        'en-IN': 'We do not guess a limit. Set one for this customer and we will check every bill against it.',
        'hi-IN': 'Hum seema ka andaaza nahin lagate. Is customer ke liye ek tay karein, phir hum har bill jaanchenge.',
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

  const sentence = tooLate
    ? {
        'en-IN': `${name}'s oldest unpaid bill is ${overdueDays} days late, so this bill is on hold until something is collected.`,
        'hi-IN': `${name} ka sabse purana bina chukaya bill ${overdueDays} din late hai, isliye kuch vasooli hone tak yeh bill roka gaya hai.`,
      }
    : overLimit
      ? {
          'en-IN': `${name} would owe you more than you allow. Their limit is ${formatINR(limit)}, and this bill takes them ${formatINR(excess)} over.`,
          'hi-IN': `${name} par aapki tay seema se zyada baaki ho jayega. Seema ${formatINR(limit)} hai, aur yeh bill unhe ${formatINR(excess)} zyada le jaata hai.`,
        }
      : {
          'en-IN': `${name} stays within their ${formatINR(limit)} limit; after this bill they would owe ${formatINR(exposure)}.`,
          'hi-IN': `${name} apni ${formatINR(limit)} ki seema mein hain; is bill ke baad unpar ${formatINR(exposure)} baaki hoga.`,
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
      'en-IN': 'We add up unpaid bills and bills that are not finished yet, so the figure does not surprise you later.',
      'hi-IN': 'Hum bina chukaye bill aur adhoore bill dono jodte hain, taaki baad mein hairaani na ho.',
    },
  };
};

export const exposureOf = (outstanding: Money, pending: Money, saleValue: Money): Money =>
  sum([outstanding, pending, saleValue]);

export const excessOver = (limit: Money, exposure: Money): Money => {
  const over = subtract(exposure, limit);
  return over.minor > 0n ? over : nil();
};
