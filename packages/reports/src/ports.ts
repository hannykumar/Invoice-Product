/**
 * Issue #35 [E35] — what the reports read from.
 *
 * Reports compose the modules that already own these facts; they never re-derive them. The ledger,
 * sales, inventory and receivables are this lane's own and are consumed directly. The purchase side
 * is GPT 3's #17 and is not built yet, so it is consumed through the narrowest port that the
 * register, the input-tax figures and the payables ageing actually need — and a mock that returns
 * nothing, so a report shows an honest empty section rather than a wrong one.
 */
import type { BranchId, CompanyId, IsoDate, Money, PartyId } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import type { PartyPosition } from '@invoice/receivables';

/**
 * One purchase bill, as reports need it.
 *
 * Shape assumption, recorded for GPT 3: this mirrors `OpenDocument` from `receivables.v1.md` plus
 * the tax split every register has to print. When #17 publishes its own document type, this port
 * gets an adapter; nothing else in this package changes.
 */
export interface PurchaseDocument {
  readonly documentId: string;
  readonly number: string;
  readonly supplierId: PartyId;
  readonly supplierName: string;
  readonly date: IsoDate;
  readonly branchId: BranchId | null;
  readonly taxableValue: Money;
  readonly cgst: Money;
  readonly sgst: Money;
  readonly igst: Money;
  readonly cess: Money;
  readonly invoiceValue: Money;
  /** Input tax the business may not claim. Reported, never worked out here. */
  readonly ineligibleInputTax: Money;
  readonly reverseCharge: boolean;
}

export interface PurchaseReadPort {
  /** Whether a real implementation is behind this port. A mock says so, and the report says so. */
  readonly available: boolean;
  list(companyId: CompanyId, from: IsoDate, to: IsoDate): Promise<readonly PurchaseDocument[]>;
}

/**
 * The purchase side until #17 lands.
 *
 * It returns nothing rather than plausible figures. A register that prints "no purchases recorded
 * yet, because this part is not built" is honest; one that prints invented bills is not.
 */
export const purchasesNotBuiltYet: PurchaseReadPort = {
  available: false,
  async list() {
    return [];
  },
};

/** A fixed list, for tests and demos that need the purchase side to exist. */
export const purchasesFrom = (documents: readonly PurchaseDocument[]): PurchaseReadPort => ({
  available: true,
  async list(_companyId: CompanyId, from: IsoDate, to: IsoDate) {
    return documents.filter((d) => d.date >= from && d.date <= to);
  },
});

/**
 * Names for ids.
 *
 * A report shows "ABC Traders", not `abc-traders`. Master data is GPT 3's #5; this asks for the
 * three names a report prints and falls back to the id, visibly, when a name is not known.
 */
export interface ReportNames {
  party(companyId: CompanyId, partyId: PartyId): string | undefined;
  item(companyId: CompanyId, itemId: string): string | undefined;
  warehouse(companyId: CompanyId, warehouseId: string): string | undefined;
  branch(companyId: CompanyId, branchId: BranchId): string | undefined;
}

export const namesFrom = (
  tables: {
    parties?: Readonly<Record<string, string>>;
    items?: Readonly<Record<string, string>>;
    warehouses?: Readonly<Record<string, string>>;
    branches?: Readonly<Record<string, string>>;
  } = {},
): ReportNames => ({
  party: (_c, id) => tables.parties?.[id],
  item: (_c, id) => tables.items?.[id],
  warehouse: (_c, id) => tables.warehouses?.[id],
  branch: (_c, id) => tables.branches?.[id],
});

export const nameOr = (name: string | undefined, id: string): string => name ?? id;

/**
 * What is owed, from `@invoice/receivables` (#20).
 *
 * A port rather than the service itself, so a report can be built against a fixed set of positions
 * in a test without standing up a payment desk, and so the purchase side can be swapped in when
 * #17 supplies supplier bills to the same module.
 */
export interface DuesReadPort {
  parties(companyId: CompanyId): Promise<readonly PartyId[]>;
  nameOf(companyId: CompanyId, partyId: PartyId): Promise<string>;
  /** Lateness is counted from `asOn`, which is the report's closing date, never from today. */
  position(actor: ActorContext, partyId: PartyId, asOn: IsoDate): Promise<PartyPosition>;
}

/** Nothing owed either way, for a business that has not started billing on credit. */
export const noDues: DuesReadPort = {
  async parties() {
    return [];
  },
  async nameOf(_companyId: CompanyId, partyId: PartyId) {
    return partyId;
  },
  async position(_actor: ActorContext, partyId: PartyId) {
    const nil = { currency: 'INR' as const, minor: 0n };
    return { partyId, documents: [], totalOutstanding: nil, onAccount: nil, chequesNotCleared: nil };
  },
};

/**
 * Builds the dues port from the two things that already answer these questions: whatever knows
 * which parties have documents (#20's `DocumentLedgerPort`) and whatever works out a position
 * (#20's `ReceivablesService`). Structural, so this package does not depend on either class.
 */
export const duesFrom = (
  directory: {
    parties(companyId: CompanyId): Promise<readonly PartyId[]>;
    nameOf(companyId: CompanyId, partyId: PartyId): Promise<string>;
  },
  positions: { position(actor: ActorContext, partyId: PartyId, asOn: IsoDate): Promise<PartyPosition> },
): DuesReadPort => ({
  parties: (companyId) => directory.parties(companyId),
  nameOf: (companyId, partyId) => directory.nameOf(companyId, partyId),
  position: (actor, partyId, asOn) => positions.position(actor, partyId, asOn),
});
