/**
 * Issue #37 [E37] — the import itself.
 *
 * The shape of the thing is four steps, and the order matters:
 *
 *   analyse → approve the mapping → preview → commit   (and, if it was wrong, roll back)
 *
 * Nothing is written before `commit`, `commit` refuses unless a person approved the very mapping it
 * is about to use, and everything `commit` wrote is remembered on the batch so `rollback` can take
 * it all back out. The reconciliation at the end is read back out of the ledger and the stock
 * ledger — never copied from the file — because a reconciliation that repeats its own input proves
 * nothing.
 */
import { createHash } from 'node:crypto';
import {
  conflict,
  formatINR,
  forbidden,
  invalid,
  isoDate,
  notAllowed,
  notFound,
  subtract,
  sum,
  zero,
  type Clock,
  type CompanyId,
  type IsoDate,
  type Money,
  type UserId,
} from '@invoice/kernel';
import type { ActorContext, AuditPort, LedgerService, LedgerStore, PermissionPort } from '@invoice/ledger';
import { checkOpeningBalances, withAcceptedDifference, type OpeningBalanceEntry } from '@invoice/onboarding';
import { detectEntity, detectSourceSystem, fingerprintOf, FIELDS, looksLikeTransactions, proposeMapping } from './columns.ts';
import { asRecords, readDelimited, type Sheet } from './csv.ts';
import { markDuplicates } from './duplicates.ts';
import { buildErrorFile, hasErrors } from './error-file.ts';
import { readRows } from './rows.ts';
import {
  emptyWritten,
  MIGRATION_PERMISSIONS,
  type Bilingual,
  type ColumnMapping,
  type CustomerRow,
  type DuplicateSummary,
  type EntityKind,
  type ImportBatch,
  type ItemRow,
  type OpeningBalanceRow,
  type OpeningStockRow,
  type Reconciliation,
  type RowOutcome,
} from './model.ts';
import type { ExistingMasters, MasterWriter, MigrationBatchStore, MigrationSourceStore, OpeningStockWriter } from './ports.ts';

export interface MigrationServiceDeps {
  readonly store: LedgerStore;
  readonly ledger: LedgerService;
  readonly batches: MigrationBatchStore & MigrationSourceStore;
  readonly existing: ExistingMasters;
  readonly masters: MasterWriter;
  /** Only needed to bring stock in. Without it an opening-stock file is refused, not half-done. */
  readonly stock?: OpeningStockWriter;
  readonly permissions: PermissionPort;
  readonly audit: AuditPort;
  readonly clock: Clock;
  readonly idFactory?: () => string;
}

export interface AnalyseCommand {
  readonly fileName: string;
  /** The file's text. Excel arrives through a `SpreadsheetReader` and becomes text before here. */
  readonly content: string;
  /** Override the guess when the person knows better. */
  readonly entity?: EntityKind;
  readonly delimiter?: string;
  readonly headerRow?: number;
  readonly asOn?: IsoDate;
  readonly defaultUnit?: string;
  readonly defaultWarehouseRef?: string;
  readonly partyKind?: 'CUSTOMER' | 'SUPPLIER';
}

export interface AnalysisResult {
  readonly batch: ImportBatch;
  readonly headers: readonly string[];
  /** The first few rows exactly as they are in the file, so the person can see what we saw. */
  readonly sample: readonly Readonly<Record<string, string>>[];
  readonly rowsInFile: number;
  readonly entityConfidence: number;
  readonly otherPossibleEntities: readonly EntityKind[];
  /** Text above the heading row — a Tally report title, usually. Kept, never imported. */
  readonly preamble: readonly string[];
}

export interface PreviewResult {
  readonly batch: ImportBatch;
  readonly outcomes: readonly RowOutcome[];
  readonly duplicates: DuplicateSummary;
  readonly accepted: number;
  readonly rejected: number;
  readonly skipped: number;
  /** For a trial balance: what the file's two sides come to, before anything is posted. */
  readonly openingTotals: {
    readonly debit: Money;
    readonly credit: Money;
    readonly difference: Money;
    readonly balanced: boolean;
    readonly message: Bilingual | null;
  } | null;
  readonly stockTotal: Money | null;
  /** Non-empty when at least one row was refused. A CSV, ready to be handed back. */
  readonly errorFile: string | null;
  readonly summary: Bilingual;
}

export interface CommitCommand {
  readonly idempotencyKey: string;
  /**
   * Only for a trial balance whose two sides do not agree. A person has to look at the difference
   * and say, in words, why it is being recorded — the product never absorbs it quietly.
   */
  readonly acceptDifference?: { readonly reason: string };
}

export interface CommitResult {
  readonly batch: ImportBatch;
  readonly reconciliation: Reconciliation;
  readonly created: { readonly parties: number; readonly items: number; readonly stockLines: number };
  readonly openingVoucherId: string | null;
}

const bilingual = (en: string, hi: string): Bilingual => ({ 'en-IN': en, 'hi-IN': hi });

const digestOf = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex');

export class MigrationService {
  readonly #store: LedgerStore;
  readonly #ledger: LedgerService;
  readonly #batches: MigrationBatchStore & MigrationSourceStore;
  readonly #existing: ExistingMasters;
  readonly #masters: MasterWriter;
  readonly #stock: OpeningStockWriter | undefined;
  readonly #permissions: PermissionPort;
  readonly #audit: AuditPort;
  readonly #clock: Clock;
  readonly #newId: () => string;

  constructor(deps: MigrationServiceDeps) {
    this.#store = deps.store;
    this.#ledger = deps.ledger;
    this.#batches = deps.batches;
    this.#existing = deps.existing;
    this.#masters = deps.masters;
    this.#stock = deps.stock;
    this.#permissions = deps.permissions;
    this.#audit = deps.audit;
    this.#clock = deps.clock;
    this.#newId = deps.idFactory ?? (() => crypto.randomUUID());
  }

  // ------------------------------------------------------------------ analyse

  /**
   * Reads the file, works out what it is, and proposes a mapping. Writes nothing.
   *
   * The same bytes twice is the one thing that must not slip through: a trial balance imported
   * twice doubles a business's opening balances, and nothing downstream would contradict it. So the
   * file's digest is checked first, and a repeat comes back as a refused batch that names the
   * import that already brought it in.
   */
  async analyse(actor: ActorContext, command: AnalyseCommand): Promise<AnalysisResult> {
    this.#permissions.require(actor, MIGRATION_PERMISSIONS.run, 'bring in data from another system');

    const sheet = readDelimited(command.content, {
      ...(command.delimiter === undefined ? {} : { delimiter: command.delimiter }),
      ...(command.headerRow === undefined ? {} : { headerRow: command.headerRow }),
    });
    if (sheet.headers.filter((header) => header !== '').length < 2) {
      throw invalid(
        'MIGRATION_NO_HEADINGS',
        'We could not find the heading row in this file. Open it, make sure the first row names the columns, and save it again.',
      );
    }
    if (command.entity === undefined && looksLikeTransactions(sheet.headers)) {
      throw notAllowed(
        'MIGRATION_TRANSACTIONS_NOT_SUPPORTED',
        'This file looks like a list of past bills rather than a list of customers, items or balances. Past bills come in through a separate format that checks each one against the books, because reading them in as a list would put figures into your accounts that nothing has checked. Bring in your customers, items, stock and opening balances here, and start billing from today.',
      );
    }

    const digest = digestOf(command.content);
    const earlier = await this.#batches.findByDigest(actor.companyId, digest);
    const detected = detectEntity(sheet.headers);
    const entity = command.entity ?? detected.entity;
    const sourceSystem = detectSourceSystem(sheet.headers);
    const proposal = proposeMapping(sheet.headers, entity, sourceSystem);
    const at = this.#clock.now().toISOString();

    const batch: ImportBatch = {
      id: this.#newId(),
      companyId: actor.companyId,
      fileName: command.fileName,
      digest,
      entity,
      sourceSystem,
      state: earlier !== null && earlier.state === 'COMMITTED' ? 'REJECTED_DUPLICATE' : 'ANALYSED',
      proposal,
      readOptions: {
        asOn: command.asOn ?? isoDate(this.#clock.now().toISOString().slice(0, 10)),
        defaultUnit: (command.defaultUnit ?? 'PCS').toUpperCase(),
        defaultWarehouseRef: command.defaultWarehouseRef ?? null,
        partyKind: command.partyKind ?? (entity === 'suppliers' ? 'SUPPLIER' : entity === 'customers' ? 'CUSTOMER' : null),
        delimiter: command.delimiter ?? sheet.delimiter,
        headerRow: command.headerRow ?? null,
      },
      approvedMapping: null,
      approvedFingerprint: null,
      approvedBy: null,
      createdBy: actor.userId,
      createdAt: at,
      committedAt: null,
      rolledBackAt: null,
      rollbackReason: null,
      written: emptyWritten(),
      reconciliation: null,
      duplicateOfBatchId: earlier !== null && earlier.state === 'COMMITTED' ? earlier.id : null,
      version: 1,
    };

    await this.#batches.insert(batch);
    await this.#batches.putSource(actor.companyId, batch.id, command.content);
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: 'migration.file_analysed',
      subjectType: 'migration_batch',
      subjectId: batch.id,
      summary: `Read ${sheet.rows.length} rows from ${command.fileName}, which looks like ${entity.replace('_', ' ')}.`,
      details: { fileName: command.fileName, entity, sourceSystem, rows: String(sheet.rows.length), state: batch.state },
    });

    return {
      batch,
      headers: sheet.headers,
      sample: asRecords(sheet).slice(0, 5),
      rowsInFile: sheet.rows.length,
      entityConfidence: command.entity === undefined ? detected.confidence : 1,
      otherPossibleEntities: detected.alternatives,
      preamble: sheet.preamble,
    };
  }

  // ---------------------------------------------------------------- approvals

  /**
   * Records that a person looked at the mapping and agreed with it.
   *
   * The fingerprint they send back must be the fingerprint of the mapping they are sending. That is
   * not ceremony: it is what makes "the user approved this" a fact about a specific set of columns
   * rather than about a screen they once saw.
   */
  async approveMapping(
    actor: ActorContext,
    batchId: string,
    input: { readonly columns: readonly ColumnMapping[]; readonly fingerprint: string },
  ): Promise<ImportBatch> {
    this.#permissions.require(actor, MIGRATION_PERMISSIONS.run, 'approve how these columns are read');
    const batch = await this.#require(actor, batchId);
    this.#refuseIfSettled(batch);

    const actual = fingerprintOf(input.columns);
    if (actual !== input.fingerprint) {
      throw conflict(
        'MIGRATION_MAPPING_CHANGED',
        'The columns changed after they were shown to you. Look at them once more and confirm again.',
      );
    }
    const mapped = new Set(input.columns.map((column) => column.field).filter((field): field is string => field !== null));
    const missing = FIELDS[batch.entity].filter((field) => field.required === true && !mapped.has(field.id));
    if (missing.length > 0) {
      throw invalid(
        'MIGRATION_MAPPING_INCOMPLETE',
        `Before this can be brought in, tell us which column holds: ${missing.map((field) => field.label.toLowerCase()).join(', ')}.`,
      );
    }
    const unknown = input.columns
      .filter((column) => column.field !== null && FIELDS[batch.entity].every((field) => field.id !== column.field))
      .map((column) => column.field);
    if (unknown.length > 0) {
      throw invalid('MIGRATION_MAPPING_UNKNOWN_FIELD', `We do not know what "${unknown[0]}" means for this kind of file.`);
    }

    const next: ImportBatch = {
      ...batch,
      state: 'MAPPING_APPROVED',
      approvedMapping: input.columns,
      approvedFingerprint: actual,
      approvedBy: actor.userId,
      version: batch.version + 1,
    };
    await this.#batches.update(next, batch.version);
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at: this.#clock.now().toISOString(),
      action: 'migration.mapping_approved',
      subjectType: 'migration_batch',
      subjectId: batch.id,
      summary: `Column mapping approved for ${batch.fileName}.`,
      details: { fingerprint: actual, entity: batch.entity },
    });
    return next;
  }

  // ------------------------------------------------------------------ preview

  /** Everything that would happen, and nothing that does. Safe to call as often as you like. */
  async preview(actor: ActorContext, batchId: string): Promise<PreviewResult> {
    this.#permissions.require(actor, MIGRATION_PERMISSIONS.run, 'see what this file would bring in');
    const batch = await this.#require(actor, batchId);
    const { sheet, outcomes, duplicates } = await this.#read(actor, batch);

    const accepted = outcomes.filter((outcome) => outcome.decision === 'ACCEPT');
    const rejected = outcomes.filter((outcome) => outcome.decision === 'REJECT');
    const skipped = outcomes.filter((outcome) => outcome.decision === 'SKIP_DUPLICATE');

    const openingTotals = batch.entity === 'opening_balances' ? await this.#openingCheck(actor, accepted) : null;
    const stockTotal =
      batch.entity === 'opening_stock'
        ? sum(accepted.map((outcome) => (outcome.parsed as OpeningStockRow).value))
        : null;

    return {
      batch,
      outcomes,
      duplicates,
      accepted: accepted.length,
      rejected: rejected.length,
      skipped: skipped.length,
      openingTotals,
      stockTotal,
      errorFile: hasErrors(outcomes) ? buildErrorFile(sheet.headers, outcomes) : null,
      summary: bilingual(
        `${accepted.length} of ${outcomes.length} rows are ready to bring in. ${rejected.length} need fixing first and ${skipped.length} are already here.`,
        `${outcomes.length} mein se ${accepted.length} rows laane ke liye taiyaar hain. ${rejected.length} ko pehle theek karna hoga aur ${skipped.length} pehle se maujood hain.`,
      ),
    };
  }

  /** The error file on its own, for the download button. */
  async errorFile(actor: ActorContext, batchId: string): Promise<string | null> {
    const preview = await this.preview(actor, batchId);
    return preview.errorFile;
  }

  // ------------------------------------------------------------------- commit

  /**
   * Writes the accepted rows.
   *
   * Committing twice is safe: a batch that is already committed hands back what it did the first
   * time. Every write is keyed on the batch and the row, so even a retry that gets through mid-way
   * lands on the same records rather than making second copies.
   *
   * If a write fails part-way, everything this batch already wrote is taken back out before the
   * error is raised — a half-migrated business is worse than one that has not started.
   */
  async commit(actor: ActorContext, batchId: string, command: CommitCommand): Promise<CommitResult> {
    this.#permissions.require(actor, MIGRATION_PERMISSIONS.commit, 'bring this data into your books');
    const batch = await this.#require(actor, batchId);

    if (batch.state === 'COMMITTED') {
      return {
        batch,
        reconciliation: batch.reconciliation as Reconciliation,
        created: {
          parties: batch.written.partyIds.length,
          items: batch.written.itemIds.length,
          stockLines: batch.written.movementIds.length,
        },
        openingVoucherId: batch.written.voucherId,
      };
    }
    if (batch.state === 'REJECTED_DUPLICATE') {
      throw conflict(
        'MIGRATION_ALREADY_IMPORTED',
        'This is the same file you brought in earlier, so it has not been read a second time. Bringing it in again would double your figures.',
        { details: { earlierImport: batch.duplicateOfBatchId ?? '' } },
      );
    }
    if (batch.state === 'ROLLED_BACK') {
      throw notAllowed('MIGRATION_ROLLED_BACK', 'This import was taken back out. Start it again from the file.');
    }
    if (batch.state !== 'MAPPING_APPROVED' || batch.approvedMapping === null) {
      throw notAllowed(
        'MIGRATION_MAPPING_NOT_APPROVED',
        'Nobody has confirmed which column is which yet, so nothing can be brought in.',
      );
    }
    if (batch.approvedFingerprint !== fingerprintOf(batch.approvedMapping)) {
      throw conflict('MIGRATION_MAPPING_CHANGED', 'The columns changed after they were approved. Confirm them again.');
    }

    const { outcomes } = await this.#read(actor, batch);
    const accepted = outcomes.filter((outcome) => outcome.decision === 'ACCEPT');
    if (accepted.length === 0) {
      throw notAllowed(
        'MIGRATION_NOTHING_TO_IMPORT',
        'Not one row in this file can be brought in yet. Download the list of problems, fix them, and try again.',
      );
    }

    const written = { partyIds: [] as string[], itemIds: [] as string[], movementIds: [] as string[], voucherId: null as string | null };
    let reconciliation: Reconciliation;
    try {
      reconciliation =
        batch.entity === 'items'
          ? await this.#commitItems(actor, batch, accepted, outcomes, written)
          : batch.entity === 'opening_stock'
            ? await this.#commitStock(actor, batch, accepted, outcomes, written)
            : batch.entity === 'opening_balances'
              ? await this.#commitBalances(actor, batch, accepted, outcomes, written, command)
              : await this.#commitParties(actor, batch, accepted, outcomes, written);
    } catch (error) {
      await this.#unwind(actor, written, 'An import failed part way through, so what it had already written was taken back out.');
      throw error;
    }

    const at = this.#clock.now().toISOString();
    const committed: ImportBatch = {
      ...batch,
      state: 'COMMITTED',
      committedAt: at,
      written: {
        partyIds: written.partyIds,
        itemIds: written.itemIds,
        movementIds: written.movementIds,
        voucherId: written.voucherId,
      },
      reconciliation,
      version: batch.version + 1,
    };
    await this.#batches.update(committed, batch.version);
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: 'migration.committed',
      subjectType: 'migration_batch',
      subjectId: batch.id,
      summary: reconciliation.sentence['en-IN'],
      details: {
        fileName: batch.fileName,
        entity: batch.entity,
        accepted: String(reconciliation.accepted),
        rejected: String(reconciliation.rejected),
        parties: String(written.partyIds.length),
        items: String(written.itemIds.length),
        stockLines: String(written.movementIds.length),
        voucherId: written.voucherId ?? '',
      },
    });

    return {
      batch: committed,
      reconciliation,
      created: { parties: written.partyIds.length, items: written.itemIds.length, stockLines: written.movementIds.length },
      openingVoucherId: written.voucherId,
    };
  }

  // ----------------------------------------------------------------- rollback

  /**
   * Takes a committed import back out.
   *
   * Stock is checked first, all of it, before anything moves: if part of the opening stock has
   * already been sold it cannot be un-received, and the person is told which item and why rather
   * than being left with half an import removed.
   */
  async rollback(actor: ActorContext, batchId: string, input: { readonly reason: string }): Promise<ImportBatch> {
    this.#permissions.require(actor, MIGRATION_PERMISSIONS.rollback, 'undo an import');
    if (input.reason.trim() === '') {
      throw invalid('MIGRATION_ROLLBACK_REASON_REQUIRED', 'Please say why this import is being taken back out.');
    }
    const batch = await this.#require(actor, batchId);
    if (batch.state !== 'COMMITTED') {
      throw notAllowed('MIGRATION_NOT_COMMITTED', 'This import has not been brought in, so there is nothing to take out.');
    }

    if (batch.written.movementIds.length > 0) {
      const writer = this.#requireStock();
      for (const movementId of batch.written.movementIds) {
        const verdict = await writer.canReverse(actor.companyId, movementId);
        if (!verdict.ok) {
          throw notAllowed(
            'MIGRATION_STOCK_ALREADY_USED',
            `Part of the stock this import brought in has already been sold or moved, so the import cannot be taken back out. ${verdict.why ?? ''} Correct the count instead.`,
          );
        }
      }
    }

    await this.#unwind(actor, batch.written, input.reason);

    const at = this.#clock.now().toISOString();
    const rolledBack: ImportBatch = {
      ...batch,
      state: 'ROLLED_BACK',
      rolledBackAt: at,
      rollbackReason: input.reason,
      version: batch.version + 1,
    };
    await this.#batches.update(rolledBack, batch.version);
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: 'migration.rolled_back',
      subjectType: 'migration_batch',
      subjectId: batch.id,
      summary: `The import of ${batch.fileName} was taken back out.`,
      details: { reason: input.reason, entity: batch.entity, voucherId: batch.written.voucherId ?? '' },
      overrideReason: input.reason,
    });
    return rolledBack;
  }

  async batches(actor: ActorContext): Promise<readonly ImportBatch[]> {
    this.#permissions.require(actor, MIGRATION_PERMISSIONS.run, 'see past imports');
    return this.#batches.list(actor.companyId);
  }

  // ---------------------------------------------------------------- internals

  async #require(actor: ActorContext, id: string): Promise<ImportBatch> {
    const batch = await this.#batches.findById(actor.companyId, id);
    if (batch === null) throw notFound('MIGRATION_BATCH_NOT_FOUND', 'That import does not exist for this business.');
    if (batch.companyId !== actor.companyId) {
      throw forbidden('MIGRATION_WRONG_COMPANY', 'That import belongs to a different business.');
    }
    return batch;
  }

  #refuseIfSettled(batch: ImportBatch): void {
    if (batch.state === 'COMMITTED' || batch.state === 'ROLLED_BACK') {
      throw notAllowed('MIGRATION_ALREADY_FINISHED', 'This import is finished. Start a new one from the file.');
    }
    if (batch.state === 'REJECTED_DUPLICATE') {
      throw conflict('MIGRATION_ALREADY_IMPORTED', 'This is the same file you brought in earlier, so it has not been read again.');
    }
  }

  #requireStock(): OpeningStockWriter {
    if (this.#stock === undefined) {
      throw notAllowed(
        'MIGRATION_STOCK_NOT_AVAILABLE',
        'Stock cannot be brought in on this setup yet. Bring in your items first, and add the counts from the stock screen.',
      );
    }
    return this.#stock;
  }

  /** Reads the file through the approved mapping — or the proposal, when previewing before approval. */
  async #read(
    actor: ActorContext,
    batch: ImportBatch,
  ): Promise<{ sheet: Sheet; outcomes: readonly RowOutcome[]; duplicates: DuplicateSummary }> {
    const content = await this.#batches.source(actor.companyId, batch.id);
    if (content === null) {
      throw notFound('MIGRATION_FILE_GONE', 'The file for this import is no longer here. Upload it again.');
    }
    const sheet = readDelimited(content, {
      ...(batch.readOptions.delimiter === null ? {} : { delimiter: batch.readOptions.delimiter }),
      ...(batch.readOptions.headerRow === null ? {} : { headerRow: batch.readOptions.headerRow }),
    });
    const mapping = batch.approvedMapping ?? batch.proposal.columns;
    const parsed = readRows(batch.entity, sheet, mapping, {
      asOn: batch.readOptions.asOn,
      defaultUnit: batch.readOptions.defaultUnit,
      ...(batch.readOptions.defaultWarehouseRef === null ? {} : { defaultWarehouseRef: batch.readOptions.defaultWarehouseRef }),
      ...(batch.readOptions.partyKind === null ? {} : { partyKind: batch.readOptions.partyKind }),
    });

    const existing =
      batch.entity === 'items'
        ? await this.#existing.items(actor.companyId)
        : batch.entity === 'customers' || batch.entity === 'suppliers'
          ? await this.#existing.parties(actor.companyId, batch.readOptions.partyKind ?? 'CUSTOMER')
          : [];
    const marked = markDuplicates(batch.entity, parsed, existing);
    return { sheet, outcomes: marked.outcomes, duplicates: marked.summary };
  }

  /** The two sides of a trial balance, in the ledger's own words (issue #36 owns the wording). */
  async #openingCheck(actor: ActorContext, accepted: readonly RowOutcome[]): Promise<PreviewResult['openingTotals']> {
    const entries = await this.#entriesFor(actor, accepted.map((outcome) => outcome.parsed as OpeningBalanceRow));
    const check = checkOpeningBalances(entries);
    const unbalanced = check.problems.find((problem) => problem.code === 'OPENING_UNBALANCED');
    return {
      debit: check.totalDebit,
      credit: check.totalCredit,
      difference: check.difference,
      balanced: check.balanced,
      message: unbalanced === undefined ? null : unbalanced.message,
    };
  }

  /**
   * Decides, for every line of a trial balance, whether it is an account or a person.
   *
   * A trial balance mixes the two without saying which is which: "Hotel Rajmahal" is a customer,
   * "Cash in hand" is an account, and both are just names in the first column. The order is:
   *
   *  1. an account code, if the file gave one;
   *  2. a customer or supplier, if the file said so — a "Sundry Debtors" group, say;
   *  3. an account of that name in the chart, matched on the name the shopkeeper sees;
   *  4. otherwise a customer or supplier, which is what the great majority of unmatched names are.
   *
   * Getting this wrong does not unbalance anything — which is exactly why it has to be got right
   * here: a "Capital" account quietly opened as a supplier would balance perfectly and be wrong.
   */
  async #entriesFor(actor: ActorContext, rows: readonly OpeningBalanceRow[]): Promise<OpeningBalanceEntry[]> {
    const accounts = await this.#store.read().accounts.listAll(actor.companyId);
    const byName = new Map(accounts.filter((account) => !account.isGroup).map((account) => [account.name.trim().toLowerCase(), account]));

    return rows.map((row) => {
      const base = { label: row.label, debit: row.debit, credit: row.credit };
      if (row.accountCode !== null) return { ...base, accountCode: row.accountCode };
      const name = (row.partyRef ?? '').trim();
      if (!row.partyKindStated) {
        const account = byName.get(name.toLowerCase());
        if (account !== undefined) return { ...base, accountCode: account.code };
      }
      return {
        ...base,
        party: {
          partyId: `migrated:${name.toLowerCase().replace(/\s+/g, '-')}`,
          name,
          kind: row.partyKind ?? 'CUSTOMER',
        },
      };
    });
  }

  /**
   * The counts, with any row master data refused at the last moment moved from accepted to skipped
   * — so the numbers the person is shown are what actually happened, not what was intended.
   */
  #baseReconciliation(
    outcomes: readonly RowOutcome[],
    refusedLate = 0,
  ): Omit<Reconciliation, 'openingTotals' | 'stockTotals' | 'sentence'> {
    return {
      rowsInFile: outcomes.length,
      accepted: outcomes.filter((outcome) => outcome.decision === 'ACCEPT').length - refusedLate,
      rejected: outcomes.filter((outcome) => outcome.decision === 'REJECT').length,
      skippedAsDuplicate: outcomes.filter((outcome) => outcome.decision === 'SKIP_DUPLICATE').length + refusedLate,
    };
  }

  async #commitParties(
    actor: ActorContext,
    batch: ImportBatch,
    accepted: readonly RowOutcome[],
    outcomes: readonly RowOutcome[],
    written: { partyIds: string[] },
  ): Promise<Reconciliation> {
    const refused: string[] = [];
    for (const outcome of accepted) {
      const row = outcome.parsed as CustomerRow;
      const created = await this.#masters.createParty(actor.companyId, actor.userId, row, {
        idempotencyKey: `migration:${batch.id}:party:${outcome.row}`,
        effectiveFrom: batch.readOptions.asOn,
      });
      if (created.status === 'refused_as_duplicate') {
        refused.push(`Row ${outcome.row}: ${created.why}`);
        continue;
      }
      written.partyIds.push(created.record.partyId);
    }
    const base = this.#baseReconciliation(outcomes, refused.length);
    const carried = accepted.filter((outcome) => (outcome.parsed as CustomerRow).openingBalance !== null).length;
    return {
      ...base,
      openingTotals: null,
      stockTotals: null,
      sentence: bilingual(
        `${written.partyIds.length} ${batch.entity === 'suppliers' ? 'suppliers' : 'customers'} were brought in.${carried > 0 ? ` ${carried} of them had a balance in the old system — bring those in as opening balances so your books start with them.` : ''}${refused.length > 0 ? ` ${refused.length} were left out because they are all but identical to somebody you already have: ${refused[0] as string}` : ''}`,
        `${written.partyIds.length} ${batch.entity === 'suppliers' ? 'supplier' : 'customer'} laaye gaye.${carried > 0 ? ` Inmein se ${carried} ke purane system mein baaki thi — unhe shuruaati baaki ke roop mein laayein.` : ''}${refused.length > 0 ? ` ${refused.length} ko chhod diya gaya kyunki wo pehle se maujood kisi se lagbhag ek jaise hain.` : ''}`,
      ),
    };
  }

  async #commitItems(
    actor: ActorContext,
    batch: ImportBatch,
    accepted: readonly RowOutcome[],
    outcomes: readonly RowOutcome[],
    written: { itemIds: string[] },
  ): Promise<Reconciliation> {
    const refused: string[] = [];
    for (const outcome of accepted) {
      const row = outcome.parsed as ItemRow;
      const created = await this.#masters.createItem(actor.companyId, actor.userId, row, {
        idempotencyKey: `migration:${batch.id}:item:${outcome.row}`,
        effectiveFrom: batch.readOptions.asOn,
      });
      if (created.status === 'refused_as_duplicate') {
        refused.push(`Row ${outcome.row}: ${created.why}`);
        continue;
      }
      written.itemIds.push(created.record.itemId);
    }
    return {
      ...this.#baseReconciliation(outcomes, refused.length),
      openingTotals: null,
      stockTotals: null,
      sentence: bilingual(
        `${written.itemIds.length} items were brought in.${refused.length > 0 ? ` ${refused.length} were left out because they are all but identical to something you already have: ${refused[0] as string}` : ''} Their counts come next, from your stock summary.`,
        `${written.itemIds.length} saman laaye gaye.${refused.length > 0 ? ` ${refused.length} ko chhod diya gaya kyunki wo pehle se maujood kisi cheez se lagbhag ek jaise hain.` : ''} Ab inki ginti stock summary se laayein.`,
      ),
    };
  }

  async #commitStock(
    actor: ActorContext,
    batch: ImportBatch,
    accepted: readonly RowOutcome[],
    outcomes: readonly RowOutcome[],
    written: { movementIds: string[] },
  ): Promise<Reconciliation> {
    const writer = this.#requireStock();

    // Resolve everything first, so a file that names an item we do not have fails before any of it
    // has moved. Anything unresolved is a refusal with the name the file used, not a silent skip.
    const lines: { outcome: RowOutcome; row: OpeningStockRow; itemId: string; warehouseId: string }[] = [];
    for (const outcome of accepted) {
      const row = outcome.parsed as OpeningStockRow;
      const item = await writer.resolveItem(actor.companyId, row.itemRef);
      if (item === null) {
        throw invalid(
          'MIGRATION_ITEM_UNKNOWN',
          `Your stock file has "${row.itemRef}", which is not one of your items yet. Bring your item list in first, then this file.`,
          { details: { itemRef: row.itemRef, row: String(outcome.row) } },
        );
      }
      const warehouse = await writer.resolveWarehouse(actor.companyId, row.warehouseRef);
      if (warehouse === null) {
        throw invalid(
          'MIGRATION_WAREHOUSE_UNKNOWN',
          `Your stock file mentions the godown "${row.warehouseRef ?? ''}", which we do not have. Add it first, or leave the column out to use your main godown.`,
          { details: { warehouseRef: row.warehouseRef ?? '', row: String(outcome.row) } },
        );
      }
      lines.push({ outcome, row, itemId: item.itemId, warehouseId: warehouse.warehouseId });
    }

    // What stock says before, so the reconciliation measures what this import actually added.
    const before = new Map<string, Money>();
    for (const line of lines) {
      const key = `${line.itemId}|${line.warehouseId}`;
      if (!before.has(key)) before.set(key, await writer.valueOf(actor.companyId, line.itemId, line.warehouseId));
    }

    for (const line of lines) {
      const recorded = await writer.record(
        actor.companyId,
        actor.userId,
        {
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          batchId: line.row.batchNumber,
          quantity: line.row.quantity,
          value: line.row.value,
        },
        {
          idempotencyKey: `migration:${batch.id}:stock:${line.outcome.row}`,
          asOn: line.row.asOn,
          batchId: line.row.batchNumber,
        },
      );
      written.movementIds.push(recorded.movementId);
    }

    let recordedValue = zero('INR');
    for (const [key, was] of before) {
      const [itemId, warehouseId] = key.split('|') as [string, string];
      const now = await writer.valueOf(actor.companyId, itemId, warehouseId);
      recordedValue = { currency: 'INR', minor: recordedValue.minor + (now.minor - was.minor) };
    }
    const fileValue = sum(lines.map((line) => line.row.value));
    const matchesFile = recordedValue.minor === fileValue.minor;

    return {
      ...this.#baseReconciliation(outcomes),
      openingTotals: null,
      stockTotals: { fileValue, recordedValue, lines: lines.length, matchesFile },
      sentence: matchesFile
        ? bilingual(
            `${lines.length} stock lines were brought in, worth ${formatINR(recordedValue)}, which is exactly what the file said.`,
            `${lines.length} stock lines laayi gayin, keemat ${formatINR(recordedValue)} — bilkul wahi jo file mein thi.`,
          )
        : bilingual(
            `${lines.length} stock lines were brought in. Your stock now shows ${formatINR(recordedValue)} more, and the file said ${formatINR(fileValue)}. Check the difference before you bill anything.`,
            `${lines.length} stock lines laayi gayin. Aapka stock ab ${formatINR(recordedValue)} zyada dikha raha hai, jabki file mein ${formatINR(fileValue)} tha. Bill banane se pehle antar dekh lein.`,
          ),
    };
  }

  async #commitBalances(
    actor: ActorContext,
    batch: ImportBatch,
    accepted: readonly RowOutcome[],
    outcomes: readonly RowOutcome[],
    written: { voucherId: string | null },
    command: CommitCommand,
  ): Promise<Reconciliation> {
    const rows = accepted.map((outcome) => outcome.parsed as OpeningBalanceRow);
    const entries = await this.#entriesFor(actor, rows);
    const check = checkOpeningBalances(entries);
    if (!check.balanced && command.acceptDifference === undefined) {
      throw notAllowed(
        'MIGRATION_OPENING_UNBALANCED',
        `The two sides of this file do not agree — it is out by ${formatINR(subtract(check.totalDebit, check.totalCredit))}. Find the missing line, or record the difference and say why.`,
        { details: { difference: formatINR(subtract(check.totalDebit, check.totalCredit)) } },
      );
    }
    const finalEntries = check.balanced
      ? entries
      : withAcceptedDifference(entries, check.difference, command.acceptDifference?.reason ?? '');

    // A customer or supplier who owed money on day one gets their account opened here, exactly as
    // business setup (#36) does it, so both routes into the books produce the same accounts.
    const resolved: { accountId: string; partyId: string | null; entry: OpeningBalanceEntry }[] = [];
    const uow = this.#store.read();
    for (const entry of finalEntries) {
      if (entry.party !== undefined) {
        const account = await this.#ledger.openPartyAccount(actor, {
          partyId: entry.party.partyId,
          name: entry.party.name,
          kind: entry.party.kind,
        });
        resolved.push({ accountId: account.id, partyId: entry.party.partyId, entry });
        continue;
      }
      const account = await uow.accounts.findByCode(actor.companyId, entry.accountCode as string);
      if (account === null) {
        throw invalid(
          'MIGRATION_ACCOUNT_UNKNOWN',
          `There is no account "${entry.accountCode}" in your books, so "${entry.label}" cannot be recorded. Name the customer or supplier instead, and we will open their account.`,
        );
      }
      if (account.isGroup) {
        throw invalid(
          'MIGRATION_ACCOUNT_IS_HEADING',
          `"${account.name}" is a heading that holds other accounts, so a balance cannot sit on it. If "${entry.label}" is a customer or a supplier, name them instead.`,
        );
      }
      resolved.push({ accountId: account.id, partyId: null, entry });
    }

    const posted = await this.#ledger.postVoucher(actor, {
      idempotencyKey: `migration:opening:${batch.id}`,
      type: 'OPENING_BALANCE',
      date: batch.readOptions.asOn,
      narration: `What the business already had, brought in from ${batch.fileName}`,
      source: { kind: 'migration', id: batch.id, number: null },
      lines: resolved.map((line) => ({
        accountId: line.accountId as never,
        partyId: line.partyId,
        debit: line.entry.debit,
        credit: line.entry.credit,
        narration: line.entry.label,
      })),
    });
    written.voucherId = posted.voucher.id;

    // Read the posting back rather than trusting what we sent: this is the whole point of the
    // reconciliation, and it is the only figure that proves the books took what the file said.
    const stored = await this.#ledger.getVoucher(actor, posted.voucher.id);
    const postedLines = stored?.lines ?? [];
    const postedDebit = sum(postedLines.map((line) => line.debit));
    const postedCredit = sum(postedLines.map((line) => line.credit));
    const fileDebit = check.totalDebit;
    const fileCredit = check.totalCredit;
    const matchesFile = check.balanced
      ? postedDebit.minor === fileDebit.minor && postedCredit.minor === fileCredit.minor
      : postedDebit.minor - postedCredit.minor === 0n;

    return {
      ...this.#baseReconciliation(outcomes),
      openingTotals: {
        fileDebit,
        fileCredit,
        postedDebit,
        postedCredit,
        balanced: postedDebit.minor === postedCredit.minor,
        matchesFile,
      },
      stockTotals: null,
      sentence: check.balanced
        ? bilingual(
            `Your opening balances are in the books: ${formatINR(postedDebit)} on each side, matching the file exactly.`,
            `Aapki shuruaati baaki khaaton mein aa gayi hai: dono taraf ${formatINR(postedDebit)}, file se bilkul milti hui.`,
          )
        : bilingual(
            `Your opening balances are in the books. The file was out by ${formatINR(subtract(fileDebit, fileCredit))}, and that difference was recorded separately with the reason you gave, so nothing is hidden.`,
            `Aapki shuruaati baaki khaaton mein aa gayi hai. File mein ${formatINR(subtract(fileDebit, fileCredit))} ka antar tha, jo aapke diye kaaran ke saath alag se darj kiya gaya hai.`,
          ),
    };
  }

  /** Takes back out whatever a batch wrote. Used by rollback, and by a commit that failed. */
  async #unwind(
    actor: ActorContext,
    written: ImportBatch['written'],
    reason: string,
  ): Promise<void> {
    if (written.movementIds.length > 0) {
      const writer = this.#requireStock();
      const on = isoDate(this.#clock.now().toISOString().slice(0, 10));
      for (const movementId of written.movementIds) {
        await writer.reverse(actor.companyId, actor.userId, movementId, {
          idempotencyKey: `migration:undo:${movementId}`,
          reason,
          on,
        });
      }
    }
    if (written.voucherId !== null) {
      await this.#ledger.reverseVoucher(actor, {
        idempotencyKey: `migration:undo:${written.voucherId}`,
        voucherId: written.voucherId as never,
        date: isoDate(this.#clock.now().toISOString().slice(0, 10)),
        reason,
      });
    }
    for (const itemId of written.itemIds) {
      await this.#masters.deactivate(actor.companyId, actor.userId, 'item', itemId, {
        idempotencyKey: `migration:undo:item:${itemId}`,
        reason,
      });
    }
    for (const partyId of written.partyIds) {
      await this.#masters.deactivate(actor.companyId, actor.userId, 'party', partyId, {
        idempotencyKey: `migration:undo:party:${partyId}`,
        reason,
      });
    }
  }
}
