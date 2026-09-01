/**
 * Issue #59 [E59] — the service a screen talks to.
 *
 * Three things happen here and nothing else: a line is looked up and answered or asked about; a
 * printed rate is held against the register; and an answer a person approved is remembered.
 *
 * The approval is the only write, and it is deliberately narrow. It writes an item-level default
 * effective from the approval date, records who approved it and what they were shown, and is
 * idempotent — pressing the button twice on a slow connection must not append two versions of the
 * same default with two different effective dates.
 */
import { resolve, percent } from './resolve.ts';
import { crossCheck } from './crosscheck.ts';
import type { Id, IsoDate } from '../../masters/src/types.ts';
import type { RateAuditPort, RateLearningPort, RateLine, TaxDefaultRegistryPort } from './ports.ts';
import type { ApproveSuggestionCommand, ApprovedRate, RateAdvice, RateCrossCheck } from './types.ts';

export interface RateAdvisorDeps {
  readonly registry: TaxDefaultRegistryPort;
  readonly learning: RateLearningPort;
  readonly audit: RateAuditPort;
  readonly clock: () => Date;
}

export class RateAdvisorService {
  readonly #registry: TaxDefaultRegistryPort;
  readonly #learning: RateLearningPort;
  readonly #audit: RateAuditPort;
  readonly #clock: () => Date;

  constructor(deps: RateAdvisorDeps) {
    this.#registry = deps.registry;
    this.#learning = deps.learning;
    this.#audit = deps.audit;
    this.#clock = deps.clock;
  }

  /**
   * Gathers what the register holds about a line, as of the document's own date.
   *
   * The HSN searched on is the line's own where it has one, and otherwise the item's — a bill whose
   * tax column is smudged usually still names the goods, and the item in the master list knows its
   * own code.
   */
  async #lookup(companyId: Id, line: RateLine, asOf: IsoDate) {
    const itemId = line.itemId ?? line.proposed?.itemId;
    const item = itemId === undefined ? null : await this.#registry.item(companyId, itemId, asOf);
    const hsnSac = line.hsnSac ?? line.proposed?.hsnSac ?? item?.hsnSac ?? undefined;
    const entries = await this.#registry.candidates(
      companyId,
      {
        ...(itemId === undefined ? {} : { itemId }),
        ...(hsnSac === undefined || hsnSac === '' ? {} : { hsnSac }),
      },
      asOf,
    );
    return { entries, item, hadSomethingToMatchOn: itemId !== undefined || (hsnSac !== undefined && hsnSac !== '') };
  }

  /**
   * What rate should this line use, as of the document's own date?
   *
   * `asOf` is the document date and never today's. A bill from March is answered with March's rate,
   * which is the fourth acceptance criterion and the one a wall-clock default would quietly break.
   */
  async suggest(companyId: Id, line: RateLine, asOf: IsoDate): Promise<RateAdvice> {
    const { entries, item, hadSomethingToMatchOn } = await this.#lookup(companyId, line, asOf);
    return resolve({
      asOf,
      entries,
      item,
      hadSomethingToMatchOn,
      ...(line.proposed === undefined ? {} : { proposed: line.proposed }),
    });
  }

  /**
   * Does the rate printed on the document agree with the register?
   *
   * Called for every line that has a printed rate, including the ones that look fine — a check only
   * run on suspicious lines is a check that finds nothing.
   */
  async check(companyId: Id, line: RateLine, asOf: IsoDate): Promise<RateCrossCheck | null> {
    if (line.printedRateBasisPoints === undefined) return null;
    const { entries, item } = await this.#lookup(companyId, line, asOf);
    return crossCheck({
      asOf,
      printedRateBasisPoints: line.printedRateBasisPoints,
      lineIndex: line.index,
      entries,
      item,
    });
  }

  /**
   * Remembers a rate a person approved.
   *
   * Three refusals, all of them the same rule from a different angle: a suggestion that rested on a
   * model's classification cannot be approved until that classification has been confirmed by a
   * named person; an approval must name an item to remember it against; and the effective date is
   * the approval date, so approving today never restates last year's bills.
   */
  async approve(
    context: { readonly companyId: Id; readonly actorId: Id },
    command: ApproveSuggestionCommand,
  ): Promise<ApprovedRate> {
    const resting = command.confirmedClassification;
    if (resting !== undefined && resting.confirmedBy === undefined) {
      throw new Error(
        'This rate was worked out from what the app thought the goods were. Somebody has to confirm that first, '
        + 'because the rate follows from it.',
      );
    }

    const rate = command.rate;
    const confirmedNote = resting === undefined
      ? ''
      : ` Classification proposed by ${resting.modelReference} and confirmed by ${resting.confirmedBy}.`;
    const source =
      `${rate.citation.source} (in force from ${rate.citation.effectiveFrom}); `
      + `approved by ${context.actorId} on ${command.approvedOn}.${confirmedNote}`;

    const learned = await this.#learning.remember(context.companyId, {
      itemId: command.itemId,
      gstRateBasisPoints: rate.gstRateBasisPoints,
      ...(rate.cessRateBasisPoints === undefined ? {} : { cessRateBasisPoints: rate.cessRateBasisPoints }),
      ...(rate.cessPerUnitPaise === undefined ? {} : { cessPerUnitPaise: rate.cessPerUnitPaise }),
      reverseCharge: rate.reverseCharge,
      source,
      effectiveFrom: command.approvedOn,
      idempotencyKey: command.idempotencyKey,
    });

    await this.#audit.record({
      companyId: context.companyId,
      actorId: context.actorId,
      at: this.#clock().toISOString(),
      action: 'rate.suggestion.approved',
      subjectId: command.itemId,
      summary:
        `${percent(rate.gstRateBasisPoints)} approved for this item from ${command.approvedOn}, `
        + `from ${rate.citation.source}.`,
      details: {
        rateBasisPoints: String(rate.gstRateBasisPoints),
        registerEntryId: rate.citation.registerEntryId,
        resolvedFrom: rate.basis,
        // Recorded because a rate that followed from a machine's reading of a line is a different
        // kind of fact from one somebody chose, and the audit trail should say which.
        classificationProposedBy: resting?.modelReference ?? 'none',
      },
    });

    return learned;
  }
}
