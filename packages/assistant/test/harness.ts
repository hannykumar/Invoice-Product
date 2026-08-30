/**
 * Issue #34 [E34] — a real business to ask questions about.
 *
 * The business is issue #35's own golden fixture: stock bought in, bills issued through
 * `SalesService`, money taken through `ReceivablesService`, a part payment, a cheque that has not
 * cleared, money against no bill. The assistant is pointed at the same `ReportService` those tests
 * use, so "the assistant's number equals the report's number" is a claim about the real thing.
 *
 * The rules engine and the compliance register are the shipped ones, in production mode, so a
 * DRAFT rule cannot answer anything here — which is itself one of the behaviours under test.
 */
import { fixedClock, isoDate, type CompanyId } from '@invoice/kernel';
import { permissionPortFromActor, type ActorContext } from '@invoice/ledger';
import { ComplianceRegister } from '@invoice/compliance-register';
import { RulesEngine, shippedRegistry } from '@invoice/rules-engine';
import { aBusyMonth, actorWith, ALL_PERMISSIONS, type Business } from '../../reports/test/fixtures.ts';
import { AssistantService } from '../src/service.ts';
import type { BlockedDocument, BlockedDocumentPort, ExceptionQueuePort, QuestionUnderstandingPort } from '../src/ports.ts';

export const ASSISTANT_PERMISSIONS = [...ALL_PERMISSIONS, 'assistant.ask'];

/** The day every test asks its questions on, so a period never depends on when the suite runs. */
export const TODAY = isoDate('2026-04-30');

/** A blocked bill, described by whoever blocked it. Sales (#9) will implement this port for real. */
export class StubBlockedDocuments implements BlockedDocumentPort {
  readonly #documents: BlockedDocument[];

  constructor(documents: readonly BlockedDocument[]) {
    this.#documents = [...documents];
  }

  async find(_companyId: CompanyId, reference: string): Promise<BlockedDocument | null> {
    return (
      this.#documents.find(
        (document) => document.number?.toUpperCase() === reference.toUpperCase() || document.documentId === reference,
      ) ?? null
    );
  }
}

export class RecordingExceptionQueue implements ExceptionQueuePort {
  readonly raised: { summary: string; evidence: readonly string[] }[] = [];

  async raise(input: { companyId: CompanyId; summary: string; evidence: readonly string[] }): Promise<{ id: string }> {
    this.raised.push({ summary: input.summary, evidence: input.evidence });
    return { id: `exception-${this.raised.length}` };
  }
}

/** A model that answers whatever it is told to. Used to prove it cannot widen what we support. */
export class ScriptedUnderstanding implements QuestionUnderstandingPort {
  readonly seen: string[] = [];
  readonly #reply: { intent: string; confidence: number; because: string } | null;

  constructor(reply: { intent: string; confidence: number; because: string } | null) {
    this.#reply = reply;
  }

  async suggest(question: string): Promise<{ intent: string; confidence: number; because: string } | null> {
    this.seen.push(question);
    return this.#reply;
  }
}

export interface Harness {
  readonly business: Business;
  readonly assistant: AssistantService;
  readonly actor: ActorContext;
  readonly exceptions: RecordingExceptionQueue;
}

export const buildAssistant = async (
  options: {
    permissions?: readonly string[];
    blocked?: BlockedDocumentPort;
    understanding?: QuestionUnderstandingPort;
    business?: Business;
    withRules?: boolean;
  } = {},
): Promise<Harness> => {
  const business = options.business ?? (await aBusyMonth());
  const exceptions = new RecordingExceptionQueue();
  const withRules = options.withRules ?? true;

  const assistant = new AssistantService({
    reports: business.reports,
    permissions: permissionPortFromActor,
    audit: business.audit,
    clock: fixedClock('2026-04-30T11:00:00.000Z'),
    exceptions,
    ...(withRules
      ? {
          rules: new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.gst', mode: 'production' }),
          register: new ComplianceRegister(),
        }
      : {}),
    ...(options.blocked === undefined ? {} : { blocked: options.blocked }),
    ...(options.understanding === undefined ? {} : { understanding: options.understanding }),
    idFactory: (() => {
      let n = 0;
      return () => `answer-${(n += 1)}`;
    })(),
  });

  return {
    business,
    assistant,
    exceptions,
    actor: actorWith(options.permissions ?? ASSISTANT_PERMISSIONS, { companyId: business.actor.companyId }),
  };
};
