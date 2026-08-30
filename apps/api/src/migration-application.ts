/**
 * Issue #37 [E37] wired into the running app — a business actually moving in.
 *
 * Every call here drives the real `MigrationService` over the real ledger, the real master data and
 * the real stock ledger. The file the browser sends is read, mapped, previewed and — once the
 * person approves the mapping — committed, and what comes back is the new company's own trial
 * balance and stock, read out of those services rather than echoed from the upload.
 *
 * Each visitor gets their own freshly opened company, so one person's half-finished migration can
 * never touch another's, exactly as tenancy requires.
 */
import { asId, isoDate, type CompanyId } from '@invoice/kernel';
import {
  InMemoryAuditPort,
  InMemoryLedgerStore,
  LedgerService,
  buildDefaultChart,
  defaultChartIdFactory,
  permissionPortFromActor,
  trialBalance,
  type ActorContext,
} from '@invoice/ledger';
import { InMemoryInventoryStore } from '../../../packages/inventory/src/repository.ts';
import { InventoryService } from '../../../packages/inventory/src/service.ts';
import { MasterDataService } from '../../../packages/masters/src/masters.ts';
import { syntheticGstin } from '../../../packages/masters/src/fixtures.ts';
import { AuditLog, PlatformCommandService } from '../../../packages/platform/src/platform.ts';
import type { RequestContext } from '../../../packages/platform/src/types.ts';
import { InventoryMigrationAdapter, MastersStockData } from '../../../packages/migration/src/adapters/inventory.ts';
import { MastersMigrationAdapter } from '../../../packages/migration/src/adapters/masters.ts';
import { InMemoryMigrationStore } from '../../../packages/migration/src/repository.ts';
import { MigrationService } from '../../../packages/migration/src/service.ts';
import { FIELDS, fingerprintOf, needsConfirmation, proposeMapping } from '../../../packages/migration/src/columns.ts';
import { ENTITY_KINDS, type ColumnMapping, type EntityKind } from '../../../packages/migration/src/model.ts';

const PERMISSIONS = [
  'migration.run', 'migration.commit', 'migration.rollback',
  'ledger.setup', 'ledger.post.opening_balance', 'ledger.reverse', 'inventory.move', 'inventory.adjust',
];

const BOOKS_START = isoDate('2026-04-01');

interface Workspace {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly actor: ActorContext;
  readonly context: RequestContext;
  readonly service: MigrationService;
  readonly masters: MasterDataService;
  readonly inventory: InventoryService;
  readonly store: InMemoryLedgerStore;
  readonly warehouseId: string;
  usedAt: number;
}

/** A handful of live migrations at a time; the oldest is dropped when a new one arrives. */
const workspaces = new Map<string, Workspace>();
const MAX_WORKSPACES = 8;
let counter = 0;

const openWorkspace = async (): Promise<Workspace> => {
  counter += 1;
  const id = `migration-${counter}-${Date.now()}`;
  const companyId = asId<'Company'>(id);
  const store = new InMemoryLedgerStore();
  const inventoryStore = new InMemoryInventoryStore();
  const migrationStore = new InMemoryMigrationStore();
  store.join(inventoryStore).join(migrationStore);
  const audit = new InMemoryAuditPort();
  const clock = { now: () => new Date() };

  const actor: ActorContext = {
    companyId,
    branchId: asId<'Branch'>('main'),
    userId: asId<'User'>('migration-owner'),
    permissions: PERMISSIONS,
  };
  const ledger = new LedgerService({ store, permissions: permissionPortFromActor, audit, clock });
  await ledger.initialiseCompany(actor, {
    booksStartDate: BOOKS_START,
    accounts: buildDefaultChart(companyId, defaultChartIdFactory(companyId)),
  });

  const platformAudit = new AuditLog();
  const masters = new MasterDataService(new PlatformCommandService(platformAudit), platformAudit);
  const options = { branchId: 'main', sessionId: id, permissions: PERMISSIONS };
  const context: RequestContext = { companyId, branchId: 'main', actorId: 'migration-owner', permissions: new Set(), sessionId: id };
  const warehouse = masters.createWarehouse(
    context,
    { code: 'MAIN', name: 'Main godown', addressLine: 'Sayyaji Rao Road', city: 'Mysuru', stateCode: '29', pincode: '570001' },
    { idempotencyKey: `${id}-warehouse` },
  );

  const inventory = new InventoryService({
    store,
    inventory: inventoryStore,
    masterData: new MastersStockData(masters, options),
    permissions: permissionPortFromActor,
    audit,
    clock,
    policy: { negativeStock: 'BLOCK', reservationMinutes: 120, valuationMethod: 'WEIGHTED_AVERAGE' },
  });
  const mastersAdapter = new MastersMigrationAdapter(masters, options);
  const service = new MigrationService({
    store,
    ledger,
    batches: migrationStore,
    existing: mastersAdapter,
    masters: mastersAdapter,
    stock: new InventoryMigrationAdapter(inventory, inventoryStore, masters, options),
    permissions: permissionPortFromActor,
    audit,
    clock,
  });

  const workspace: Workspace = {
    id, companyId, actor, context, service, masters, inventory, store,
    warehouseId: warehouse.record.id,
    usedAt: Date.now(),
  };
  workspaces.set(id, workspace);
  while (workspaces.size > MAX_WORKSPACES) {
    const oldest = [...workspaces.values()].sort((left, right) => left.usedAt - right.usedAt)[0];
    if (oldest === undefined) break;
    workspaces.delete(oldest.id);
  }
  return workspace;
};

const workspaceOf = async (body: Record<string, unknown>): Promise<Workspace> => {
  const id = String(body.workspaceId ?? '');
  const existing = workspaces.get(id);
  if (existing === undefined) return openWorkspace();
  existing.usedAt = Date.now();
  return existing;
};

const rupees = (amount: { minor: bigint } | null | undefined): number => (amount === null || amount === undefined ? 0 : Number(amount.minor) / 100);

/** The four files a shopkeeper would really have, so the screen can be tried without an export. */
export const SAMPLE_FILES = [
  {
    id: 'customers',
    name: 'Customers exported from Vyapar',
    fileName: 'vyapar-parties.csv',
    content: [
      'Party Name,Phone No,GSTIN,Address,City,State,Pincode,Opening Balance,Dr/Cr',
      `Hotel Rajmahal,98450 12345,${syntheticGstin('29', 'AABCH4321K')},"12, Sayyaji Rao Road",Mysuru,Karnataka,570001,"₹4,500.00",Dr`,
      `Nandini Provision Stores,9880098800,${syntheticGstin('29', 'AAFCN8765J')},Ashoka Road,Mysuru,Karnataka,570001,"₹12,340.50",Dr`,
      'Anand Tea Stall,9448811223,29AABCT9999Z9,Devaraja Market,Mysuru,Karnataka,570001,"₹800",Dr',
      'Hotel Rajmahal,98450 12345,,,,,,"₹4,500.00",Dr',
      ',9000000000,,,,,,"₹100",Dr',
    ].join('\n'),
  },
  {
    id: 'items',
    name: 'Items exported from BUSY',
    fileName: 'busy-items.txt',
    content: [
      'Item Code\tItem Name\tUnit\tHSN Code\tSale Price\tGST %',
      'RICE\tSona Masoori Rice\tKg\t10063020\t54.00\t0',
      'CEM53\tOPC Cement 53 Grade 50kg Bag\tBag\t25232930\t425.00\t28',
      'MISC\tAssorted hardware\tPcs\t\t100.00\t18',
    ].join('\n'),
  },
  {
    id: 'stock',
    name: 'Stock summary from Tally',
    fileName: 'tally-stock.csv',
    content: [
      'Sampoorna Traders',
      'Stock Summary : 1-Apr-2026',
      '',
      'Particulars,Godown,Closing Qty,Rate,Closing Value',
      'Sona Masoori Rice,Main godown,120 KGS,52.00,6240.00',
      'OPC Cement 53 Grade 50kg Bag,Main godown,45 BAG,410.00,18450.00',
      'TMT Steel Bar 12mm,Main godown,-8 KGS,72.00,-576.00',
    ].join('\n'),
  },
  {
    id: 'balances',
    name: 'Last year’s closing balances',
    fileName: 'trial-balance.csv',
    content: [
      'Ledger Name,Group,Debit,Credit',
      'Hotel Rajmahal,Sundry Debtors,4500.00,',
      'Nandini Provision Stores,Sundry Debtors,12340.50,',
      'Shree Ram Steels,Sundry Creditors,,9800.00',
      'Cash in hand,Cash-in-Hand,7000.00,',
      'Capital,Capital Account,,14040.50',
    ].join('\n'),
  },
] as const;

const fieldChoices = (entity: EntityKind) =>
  FIELDS[entity].map((field) => ({ id: field.id, label: field.label, required: field.required === true }));

const columnsView = (entity: EntityKind, columns: readonly ColumnMapping[]) => {
  const unsure = new Set(needsConfirmation({ entity, sourceSystem: 'GENERIC', columns, unmapped: [], missingRequired: [], fingerprint: '' }).map((column) => column.index));
  return columns.map((column) => ({
    header: column.header,
    index: column.index,
    field: column.field,
    confidence: column.confidence,
    pleaseConfirm: unsure.has(column.index),
    alternatives: column.alternatives,
  }));
};

/** Opens a fresh set of books and hands back the sample files. */
export const startMigration = async (): Promise<unknown> => {
  const workspace = await openWorkspace();
  return {
    workspaceId: workspace.id,
    booksFrom: BOOKS_START,
    entities: ENTITY_KINDS,
    samples: SAMPLE_FILES.map((sample) => ({ id: sample.id, name: sample.name, fileName: sample.fileName, content: sample.content })),
  };
};

export const analyseFile = async (body: Record<string, unknown>): Promise<unknown> => {
  const workspace = await workspaceOf(body);
  const entity = ENTITY_KINDS.includes(String(body.entity) as EntityKind) ? (String(body.entity) as EntityKind) : undefined;
  const analysis = await workspace.service.analyse(workspace.actor, {
    fileName: String(body.fileName ?? 'pasted.csv'),
    content: String(body.content ?? ''),
    asOn: BOOKS_START,
    defaultWarehouseRef: 'MAIN',
    ...(entity === undefined ? {} : { entity }),
  });

  return {
    workspaceId: workspace.id,
    batchId: analysis.batch.id,
    state: analysis.batch.state,
    entity: analysis.batch.entity,
    sourceSystem: analysis.batch.sourceSystem,
    entityConfidence: analysis.entityConfidence,
    otherPossibleEntities: analysis.otherPossibleEntities,
    rowsInFile: analysis.rowsInFile,
    preamble: analysis.preamble,
    headers: analysis.headers,
    sample: analysis.sample,
    columns: columnsView(analysis.batch.entity, analysis.batch.proposal.columns),
    fields: fieldChoices(analysis.batch.entity),
    fingerprint: analysis.batch.proposal.fingerprint,
    missingRequired: analysis.batch.proposal.missingRequired,
    duplicateOfBatchId: analysis.batch.duplicateOfBatchId,
  };
};

/**
 * Re-fingerprints a mapping the person has edited on screen.
 *
 * The approval is pinned to the fingerprint of exactly the columns being approved, so a screen that
 * changes a dropdown has to come back through here before it can approve anything.
 */
export const remapColumns = async (body: Record<string, unknown>): Promise<unknown> => {
  const workspace = await workspaceOf(body);
  const batch = await workspace.service.batches(workspace.actor);
  const found = batch.find((candidate) => candidate.id === String(body.batchId ?? ''));
  if (found === undefined) throw new Error('That import is no longer open. Upload the file again.');

  const edits = (Array.isArray(body.columns) ? body.columns : []) as { index: number; field: string | null }[];
  const columns: ColumnMapping[] = found.proposal.columns.map((column) => {
    const edit = edits.find((candidate) => Number(candidate.index) === column.index);
    if (edit === undefined) return column;
    const field = edit.field === null || edit.field === '' ? null : String(edit.field);
    // A column a person chose themselves is certain by definition; it is their answer, not a guess.
    return { ...column, field, confidence: field === column.field ? column.confidence : field === null ? 0 : 1 };
  });

  return {
    workspaceId: workspace.id,
    columns: columnsView(found.entity, columns),
    fingerprint: fingerprintOf(columns),
    missingRequired: proposeMapping(found.proposal.columns.map((column) => column.header), found.entity).missingRequired,
  };
};

const previewPayload = async (workspace: Workspace, batchId: string) => {
  const preview = await workspace.service.preview(workspace.actor, batchId);
  return {
    workspaceId: workspace.id,
    batchId,
    state: preview.batch.state,
    entity: preview.batch.entity,
    accepted: preview.accepted,
    rejected: preview.rejected,
    skipped: preview.skipped,
    summary: preview.summary,
    duplicates: {
      withinFile: preview.duplicates.withinFile,
      alreadyPresent: preview.duplicates.alreadyPresent,
      needsALook: preview.duplicates.needsALook,
    },
    problems: preview.outcomes.flatMap((outcome) =>
      outcome.problems.map((problem) => ({
        row: problem.row,
        severity: problem.severity,
        column: problem.column,
        value: problem.value,
        message: problem.message,
      })),
    ),
    openingTotals:
      preview.openingTotals === null
        ? null
        : {
            debit: rupees(preview.openingTotals.debit),
            credit: rupees(preview.openingTotals.credit),
            difference: rupees(preview.openingTotals.difference),
            balanced: preview.openingTotals.balanced,
            message: preview.openingTotals.message,
          },
    stockTotal: preview.stockTotal === null ? null : rupees(preview.stockTotal),
    errorFile: preview.errorFile,
  };
};

/** Records that the person approved the columns, then shows exactly what would be brought in. */
export const approveAndPreview = async (body: Record<string, unknown>): Promise<unknown> => {
  const workspace = await workspaceOf(body);
  const batchId = String(body.batchId ?? '');
  const open = await workspace.service.batches(workspace.actor);
  const found = open.find((candidate) => candidate.id === batchId);
  if (found === undefined) throw new Error('That import is no longer open. Upload the file again.');

  const edits = (Array.isArray(body.columns) ? body.columns : []) as { index: number; field: string | null }[];
  const columns: ColumnMapping[] = found.proposal.columns.map((column) => {
    const edit = edits.find((candidate) => Number(candidate.index) === column.index);
    if (edit === undefined) return column;
    const field = edit.field === null || edit.field === '' ? null : String(edit.field);
    return { ...column, field, confidence: field === column.field ? column.confidence : field === null ? 0 : 1 };
  });

  await workspace.service.approveMapping(workspace.actor, batchId, {
    columns,
    fingerprint: String(body.fingerprint ?? fingerprintOf(columns)),
  });
  return previewPayload(workspace, batchId);
};

export const previewImport = async (body: Record<string, unknown>): Promise<unknown> => {
  const workspace = await workspaceOf(body);
  return previewPayload(workspace, String(body.batchId ?? ''));
};

const booksNow = async (workspace: Workspace) => {
  const tb = await trialBalance(workspace.store.read(), workspace.companyId);
  const stock = [];
  for (const item of workspace.masters.items(workspace.context)) {
    const balance = await workspace.inventory.balance(workspace.actor, { itemId: item.id, warehouseId: workspace.warehouseId });
    stock.push({ name: item.name, quantity: Number(balance.physical.scaled) / 1_000_000, unit: balance.physical.unit });
  }
  return {
    customers: workspace.masters.parties(workspace.context).filter((party) => party.active).length,
    items: workspace.masters.items(workspace.context).filter((item) => item.active).length,
    trialBalance: {
      balanced: tb.balanced,
      totalDebits: rupees(tb.totalDebit),
      totalCredits: rupees(tb.totalCredit),
      rows: tb.rows.map((row) => ({
        name: row.account.name,
        debit: row.side === 'DEBIT' ? rupees(row.balance) : 0,
        credit: row.side === 'CREDIT' ? rupees(row.balance) : 0,
      })),
    },
    stock,
  };
};

export const commitImport = async (body: Record<string, unknown>): Promise<unknown> => {
  const workspace = await workspaceOf(body);
  const batchId = String(body.batchId ?? '');
  const reason = String(body.acceptDifferenceReason ?? '').trim();
  const result = await workspace.service.commit(workspace.actor, batchId, {
    idempotencyKey: `web-commit-${batchId}`,
    ...(reason === '' ? {} : { acceptDifference: { reason } }),
  });

  return {
    workspaceId: workspace.id,
    batchId,
    state: result.batch.state,
    created: result.created,
    openingVoucherId: result.openingVoucherId,
    reconciliation: {
      rowsInFile: result.reconciliation.rowsInFile,
      accepted: result.reconciliation.accepted,
      rejected: result.reconciliation.rejected,
      skippedAsDuplicate: result.reconciliation.skippedAsDuplicate,
      sentence: result.reconciliation.sentence,
      openingTotals:
        result.reconciliation.openingTotals === null
          ? null
          : {
              fileDebit: rupees(result.reconciliation.openingTotals.fileDebit),
              fileCredit: rupees(result.reconciliation.openingTotals.fileCredit),
              postedDebit: rupees(result.reconciliation.openingTotals.postedDebit),
              postedCredit: rupees(result.reconciliation.openingTotals.postedCredit),
              balanced: result.reconciliation.openingTotals.balanced,
              matchesFile: result.reconciliation.openingTotals.matchesFile,
            },
      stockTotals:
        result.reconciliation.stockTotals === null
          ? null
          : {
              fileValue: rupees(result.reconciliation.stockTotals.fileValue),
              recordedValue: rupees(result.reconciliation.stockTotals.recordedValue),
              lines: result.reconciliation.stockTotals.lines,
              matchesFile: result.reconciliation.stockTotals.matchesFile,
            },
    },
    books: await booksNow(workspace),
  };
};

export const rollbackImport = async (body: Record<string, unknown>): Promise<unknown> => {
  const workspace = await workspaceOf(body);
  const batch = await workspace.service.rollback(workspace.actor, String(body.batchId ?? ''), {
    reason: String(body.reason ?? '').trim(),
  });
  return { workspaceId: workspace.id, batchId: batch.id, state: batch.state, books: await booksNow(workspace) };
};
