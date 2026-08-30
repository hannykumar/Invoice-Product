/**
 * Issue #37 [E37] — moving a business in from whatever it uses today.
 *
 * A shopkeeper leaving Tally, BUSY or Vyapar does not have an API; they have an Excel file their
 * accountant exported, with headings nobody agreed on and amounts written the way that software
 * writes them. This module reads that file and turns it into the same records the product would
 * have made if the person had typed them, which means three things it must never do:
 *
 *  1. **Never guess a number.** A cell that cannot be read exactly is a rejected row with a reason,
 *     not a rounded figure. The reason goes into an error file the person can hand back to their
 *     accountant.
 *  2. **Never commit a mapping nobody looked at.** The product proposes which column is which; a
 *     person approves it. The approval is pinned to a fingerprint of the mapping, so a mapping that
 *     changed after approval cannot be committed.
 *  3. **Never leave half an import.** Every batch is one unit of work, and every committed batch
 *     can be rolled back to exactly the state before it.
 */
import type { CompanyId, IsoDate, Money, UserId } from '@invoice/kernel';
import type { Quantity } from '../../masters/src/units.ts';

/** Every user-facing string is bilingual, as the running app expects (see apps/web). */
export interface Bilingual {
  readonly 'en-IN': string;
  readonly 'hi-IN': string;
}

/**
 * What a file is a list of. One file is one kind of thing, because that is how every one of these
 * products exports: a customer list, an item list, a stock summary, a trial balance.
 */
export type EntityKind = 'customers' | 'suppliers' | 'items' | 'opening_stock' | 'opening_balances';

export const ENTITY_KINDS: readonly EntityKind[] = [
  'customers',
  'suppliers',
  'items',
  'opening_stock',
  'opening_balances',
];

/**
 * Which product the file looks like it came from. This only ever changes the column *guesses* and
 * the wording of the help; it never changes what a value means.
 */
export type SourceSystem = 'TALLY' | 'BUSY' | 'VYAPAR' | 'MARG' | 'GENERIC';

export type BatchState =
  /** Read and understood; a mapping has been proposed and is waiting for a person. */
  | 'ANALYSED'
  /** A person approved the mapping. Only from here can it be committed. */
  | 'MAPPING_APPROVED'
  | 'COMMITTED'
  | 'ROLLED_BACK'
  /** The same file was already brought in. Nothing was read into the books a second time. */
  | 'REJECTED_DUPLICATE';

export type Severity = 'BLOCKING' | 'WARNING';

export interface RowProblem {
  /** 1-based row number **in the file the person is looking at**, header included. */
  readonly row: number;
  readonly column: string | null;
  readonly code: string;
  readonly severity: Severity;
  readonly message: Bilingual;
  /** The cell exactly as it was written, so the person can find it. Never reformatted. */
  readonly value: string;
}

/** One column of the file, and what the product thinks it is. */
export interface ColumnMapping {
  readonly header: string;
  readonly index: number;
  /** A canonical field id from `columns.ts`, or null when the column is being ignored. */
  readonly field: string | null;
  /** 0 to 1. Below `CONFIRM_BELOW` the screen must ask rather than assume. */
  readonly confidence: number;
  /** Other fields this header could plausibly be, best first. */
  readonly alternatives: readonly string[];
}

export interface MappingProposal {
  readonly entity: EntityKind;
  readonly sourceSystem: SourceSystem;
  readonly columns: readonly ColumnMapping[];
  /** Headers the product could not place. They are ignored unless the person maps them. */
  readonly unmapped: readonly string[];
  /** Fields this kind of import cannot do without, and which no column supplies. */
  readonly missingRequired: readonly string[];
  /** A digest of `columns`. The approval is pinned to it. */
  readonly fingerprint: string;
}

/** A confidence at or below this must be shown to the person as a question, not a statement. */
export const CONFIRM_BELOW = 0.8;

export interface CustomerRow {
  readonly kind: 'customers' | 'suppliers';
  readonly externalId: string | null;
  readonly name: string;
  readonly tradeName: string | null;
  readonly gstin: string | null;
  readonly pan: string | null;
  readonly phones: readonly string[];
  readonly emails: readonly string[];
  readonly addressLine: string | null;
  readonly city: string | null;
  readonly stateCode: string | null;
  readonly pincode: string | null;
  readonly creditDays: number | null;
  readonly creditLimit: Money | null;
  /** What the old system said this party owed or was owed, when the file carries it. */
  readonly openingBalance: Money | null;
  readonly openingSide: 'DEBIT' | 'CREDIT' | null;
}

export interface ItemRow {
  readonly externalId: string | null;
  readonly name: string;
  readonly itemKind: 'goods' | 'service';
  readonly hsnSac: string;
  readonly baseUnit: string;
  readonly barcodes: readonly string[];
  readonly sellingRate: Money | null;
  readonly purchaseRate: Money | null;
  readonly gstRateBasisPoints: number | null;
}

export interface OpeningStockRow {
  /** How the file named the item. Resolved against what is already in the books. */
  readonly itemRef: string;
  readonly warehouseRef: string | null;
  readonly batchNumber: string | null;
  readonly quantity: Quantity;
  /** Total value of the quantity, not a rate. A rate column is multiplied out before this. */
  readonly value: Money;
  readonly asOn: IsoDate;
}

export interface OpeningBalanceRow {
  readonly accountCode: string | null;
  readonly partyRef: string | null;
  readonly partyKind: 'CUSTOMER' | 'SUPPLIER' | null;
  /**
   * True when the file itself said this line belongs to a customer or a supplier — a "Sundry
   * Debtors" group, say. When it is false the name is matched against the chart of accounts first,
   * because "Cash in hand" on a trial balance is an account, not a customer.
   */
  readonly partyKindStated: boolean;
  readonly label: string;
  readonly debit: Money;
  readonly credit: Money;
}

export type ImportRow = CustomerRow | ItemRow | OpeningStockRow | OpeningBalanceRow;

/** One row of the file after reading: either usable, or refused with reasons. */
export interface RowOutcome<TRow = ImportRow> {
  readonly row: number;
  /** The raw cells, kept so the error file can hand the person back their own line. */
  readonly raw: Readonly<Record<string, string>>;
  readonly parsed: TRow | null;
  readonly problems: readonly RowProblem[];
  readonly decision: 'ACCEPT' | 'REJECT' | 'SKIP_DUPLICATE';
  /** Set on SKIP_DUPLICATE: what it is a duplicate of, in words. */
  readonly duplicateOf: string | null;
}

export interface DuplicateSummary {
  /** Rows that repeat another row of the same file. */
  readonly withinFile: number;
  /** Rows matching something the business already has. Skipped, never overwritten. */
  readonly alreadyPresent: number;
  /** Rows that look similar to something present but are not certainly the same. */
  readonly needsALook: readonly {
    readonly row: number;
    readonly name: string;
    readonly existing: string;
    readonly why: Bilingual;
  }[];
}

/** What the person is told before anything is written, and what is checked again after. */
export interface Reconciliation {
  readonly rowsInFile: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly skippedAsDuplicate: number;
  /** Present for opening_balances: the two sides of the file, and of what was posted. */
  readonly openingTotals: {
    readonly fileDebit: Money;
    readonly fileCredit: Money;
    readonly postedDebit: Money;
    readonly postedCredit: Money;
    readonly balanced: boolean;
    readonly matchesFile: boolean;
  } | null;
  /** Present for opening_stock: what the file said, and what stock actually reads back as. */
  readonly stockTotals: {
    readonly fileValue: Money;
    readonly recordedValue: Money;
    readonly lines: number;
    readonly matchesFile: boolean;
  } | null;
  readonly sentence: Bilingual;
}

/** The decisions about reading this particular file, made once and then never changed. */
export interface BatchReadOptions {
  readonly asOn: IsoDate;
  readonly defaultUnit: string;
  readonly defaultWarehouseRef: string | null;
  readonly partyKind: 'CUSTOMER' | 'SUPPLIER' | null;
  readonly delimiter: string | null;
  readonly headerRow: number | null;
}

export interface ImportBatch {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly fileName: string;
  /** SHA-256 of the file's bytes. The same file is never brought in twice by accident. */
  readonly digest: string;
  readonly entity: EntityKind;
  readonly sourceSystem: SourceSystem;
  readonly state: BatchState;
  readonly proposal: MappingProposal;
  /** How the file is to be read. Fixed when the batch is created so preview and commit agree. */
  readonly readOptions: BatchReadOptions;
  /** The mapping a person approved, and the fingerprint they approved it at. */
  readonly approvedMapping: readonly ColumnMapping[] | null;
  readonly approvedFingerprint: string | null;
  readonly approvedBy: UserId | null;
  readonly createdBy: UserId;
  readonly createdAt: string;
  readonly committedAt: string | null;
  readonly rolledBackAt: string | null;
  readonly rollbackReason: string | null;
  /** What this batch wrote, so it can be taken back out again. */
  readonly written: {
    readonly partyIds: readonly string[];
    readonly itemIds: readonly string[];
    readonly movementIds: readonly string[];
    readonly voucherId: string | null;
  };
  readonly reconciliation: Reconciliation | null;
  /** Set when the file repeats one already committed: the batch that brought it in. */
  readonly duplicateOfBatchId: string | null;
  readonly version: number;
}

export const MIGRATION_PERMISSIONS = {
  run: 'migration.run',
  commit: 'migration.commit',
  rollback: 'migration.rollback',
} as const;

export const emptyWritten = (): ImportBatch['written'] => ({
  partyIds: [],
  itemIds: [],
  movementIds: [],
  voucherId: null,
});
