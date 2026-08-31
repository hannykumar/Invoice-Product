/**
 * Issue #31 [E31] — the implementations of the ports, and the two bridges to other modules.
 *
 * The in-memory stores here are what the tests and the local app run on. They are not toys: they
 * enforce the same tenancy rule as the database will, and `put` implements the same "one row per
 * document, replaced not appended" behaviour the migration's unique index enforces, so a bug in
 * that rule fails in `npm test` rather than in production.
 *
 * The two bridges are the interesting part of the file.
 *
 *   - `itcInwardTaxPort` is what the return workspace (#30) reads for the credit side of GSTR-3B.
 *     It hands over the reconciliation's own conclusion, so a purchase that is held back here is
 *     held back on the return too — by construction rather than by a second rule that could
 *     disagree.
 *   - `gstr2bSignalPort` is the optional input #19 defined for this issue before it existed. The
 *     supplier-risk module has been saying "GSTR-2B was not checked" on every assessment since it
 *     shipped; plugging this in is what stops it saying that.
 */
import type { CompanyId, IsoDate } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import type { InwardTaxPort } from '../../gst-returns/src/ports.ts';
import type { InwardTaxSummary } from '../../gst-returns/src/types.ts';
import type { Gstr2bPort } from '../../purchasing/src/supplier-risk-ports.ts';
import type { Gstr2bSignal } from '../../purchasing/src/supplier-risk-types.ts';
import type {
  ImportBatchRepository,
  ItcDecisionRepository,
  ItcPolicyPort,
  PortalRecordRepository,
  PortalRecordSource,
  PortalFetchOutcome,
  PurchaseBookPort,
} from './ports.ts';
import { lineKeyOf, normaliseNumber } from './match.ts';
import type { ItcReconciliationService } from './service.ts';
import {
  DEFAULT_MATCH_POLICY,
  type BookPurchaseDocument,
  type ImportBatch,
  type ItcDecision,
  type ItcMatchPolicy,
  type PortalDocument,
  type TaxPeriod,
} from './types.ts';

// ---------------------------------------------------------------------------- storage

const documentKey = (document: PortalDocument): string =>
  `${document.supplierGstin.toUpperCase()}|${normaliseNumber(document.number)}|${document.kind}`;

export class InMemoryPortalRecords implements PortalRecordRepository {
  readonly #rows = new Map<string, PortalDocument>();

  #scope(companyId: CompanyId, period: TaxPeriod, key: string): string {
    return `${companyId}|${period}|${key}`;
  }

  async listForPeriod(companyId: CompanyId, period: TaxPeriod): Promise<readonly PortalDocument[]> {
    return [...this.#rows.values()].filter((row) => row.companyId === companyId && row.period === period);
  }

  async findByDocument(
    companyId: CompanyId,
    input: { readonly supplierGstin: string; readonly invoiceNumber: string },
  ): Promise<PortalDocument | null> {
    const wanted = `${input.supplierGstin.toUpperCase()}|${normaliseNumber(input.invoiceNumber)}`;
    for (const row of this.#rows.values()) {
      if (row.companyId !== companyId) continue;
      if (`${row.supplierGstin.toUpperCase()}|${normaliseNumber(row.number)}` === wanted) return row;
    }
    return null;
  }

  async put(
    companyId: CompanyId,
    period: TaxPeriod,
    records: readonly PortalDocument[],
  ): Promise<{ added: number; replaced: number; unchanged: number }> {
    let added = 0;
    let replaced = 0;
    let unchanged = 0;
    for (const record of records) {
      const key = this.#scope(companyId, period, documentKey(record));
      const held = this.#rows.get(key);
      if (held === undefined) {
        added += 1;
      } else if (
        held.amounts.taxableValue.minor === record.amounts.taxableValue.minor
        && held.documentDate === record.documentDate
        && held.itcAvailableOnPortal === record.itcAvailableOnPortal
        && held.reversed === record.reversed
      ) {
        unchanged += 1;
      } else {
        replaced += 1;
      }
      this.#rows.set(key, record);
    }
    return { added, replaced, unchanged };
  }
}

export class InMemoryImportBatches implements ImportBatchRepository {
  readonly #batches: ImportBatch[] = [];

  async insert(batch: ImportBatch): Promise<void> {
    this.#batches.push(batch);
  }

  async findByChecksum(companyId: CompanyId, period: TaxPeriod, checksum: string): Promise<ImportBatch | null> {
    return this.#batches.find(
      (batch) => batch.companyId === companyId && batch.period === period && batch.checksum === checksum,
    ) ?? null;
  }

  async latestFor(companyId: CompanyId, period: TaxPeriod): Promise<ImportBatch | null> {
    const mine = this.#batches.filter((batch) => batch.companyId === companyId && batch.period === period);
    return mine.length === 0 ? null : (mine[mine.length - 1] as ImportBatch);
  }

  async list(companyId: CompanyId, period: TaxPeriod): Promise<readonly ImportBatch[]> {
    return this.#batches.filter((batch) => batch.companyId === companyId && batch.period === period);
  }
}

export class InMemoryItcDecisions implements ItcDecisionRepository {
  readonly #decisions: ItcDecision[] = [];

  async insert(decision: ItcDecision): Promise<void> {
    this.#decisions.push(decision);
  }

  async latestForPeriod(companyId: CompanyId, period: TaxPeriod): Promise<readonly ItcDecision[]> {
    return this.#decisions.filter((decision) => decision.companyId === companyId && decision.period === period);
  }

  async findByIdempotencyKey(companyId: CompanyId, key: string): Promise<ItcDecision | null> {
    return this.#decisions.find((decision) => decision.companyId === companyId && decision.idempotencyKey === key) ?? null;
  }

  async history(companyId: CompanyId, lineKey: string): Promise<readonly ItcDecision[]> {
    return this.#decisions.filter((decision) => decision.companyId === companyId && decision.lineKey === lineKey);
  }
}

/** One policy for everybody, which is what a company that has never changed the defaults has. */
export class StaticItcPolicy implements ItcPolicyPort {
  readonly #policy: ItcMatchPolicy;
  constructor(policy: ItcMatchPolicy = DEFAULT_MATCH_POLICY) {
    this.#policy = policy;
  }
  async policyFor(): Promise<ItcMatchPolicy> {
    return this.#policy;
  }
}

/** A purchase register held in memory, for tests and for the local demo application. */
export class InMemoryPurchaseBooks implements PurchaseBookPort {
  readonly #documents: BookPurchaseDocument[] = [];

  add(...documents: readonly BookPurchaseDocument[]): void {
    this.#documents.push(...documents);
  }

  replace(documents: readonly BookPurchaseDocument[]): void {
    this.#documents.length = 0;
    this.#documents.push(...documents);
  }

  async documentsFor(companyId: CompanyId, period: TaxPeriod): Promise<readonly BookPurchaseDocument[]> {
    return this.#documents.filter((document) => document.companyId === companyId && document.period === period);
  }
}

/**
 * A portal channel that answers out of a file already in hand.
 *
 * Used by the tests to prove the download path and the import path produce the same reconciliation,
 * and by the demo so the "fetch from the portal" button does something honest without a credential.
 */
export class SyntheticPortalSource implements PortalRecordSource {
  readonly provider = 'synthetic-gsp';
  readonly #content: string | null;
  readonly #outcome: PortalFetchOutcome | null;
  readonly #at: () => string;

  constructor(options: { content?: string; outcome?: PortalFetchOutcome; at?: () => string }) {
    this.#content = options.content ?? null;
    this.#outcome = options.outcome ?? null;
    this.#at = options.at ?? (() => new Date().toISOString());
  }

  async fetchGstr2b(): Promise<PortalFetchOutcome> {
    if (this.#outcome !== null) return this.#outcome;
    if (this.#content === null) {
      return { kind: 'NOT_READY', at: this.#at(), detail: 'The statement for this month has not been published.' };
    }
    return { kind: 'FETCHED', content: this.#content, at: this.#at() };
  }

  async health(): Promise<'healthy'> {
    return 'healthy';
  }
}

// ---------------------------------------------------------------------------- the purchase register

/**
 * A posted purchase bill (#17), as this module needs to see it.
 *
 * The supplier's registration is passed in rather than read here, because it lives on the supplier
 * master (#5) and this module has no business reaching into another module's tables. When the
 * caller cannot supply it, `null` travels through and the bill is reported as uncomparable — never
 * matched on its number alone.
 */
export interface PostedBillLike {
  readonly id: string;
  readonly companyId: string;
  readonly supplierPartyId: string;
  readonly supplierName: string;
  readonly invoiceNumber: string;
  readonly invoiceDate: string;
  readonly totalPaise: bigint;
  readonly state: 'POSTED' | 'REVERSED';
  readonly voucherId: string;
  readonly tax: {
    readonly taxableValuePaise: bigint;
    readonly cgstPaise: bigint;
    readonly sgstPaise: bigint;
    readonly igstPaise: bigint;
    readonly cessPaise: bigint;
    readonly ineligibleItcPaise: bigint;
    readonly reverseCharge: boolean;
  };
}

export const purchaseBillToBookDocument = (
  bill: PostedBillLike,
  supplier: { readonly gstin: string | null; readonly imported?: boolean; readonly kind?: BookPurchaseDocument['kind'] },
): BookPurchaseDocument => ({
  sourceKind: 'purchase_bill',
  sourceId: bill.id,
  companyId: bill.companyId as CompanyId,
  supplierPartyId: bill.supplierPartyId,
  supplierName: bill.supplierName,
  supplierGstin: supplier.gstin,
  kind: supplier.kind ?? 'INVOICE',
  number: bill.invoiceNumber,
  documentDate: bill.invoiceDate as IsoDate,
  period: bill.invoiceDate.slice(0, 7) as TaxPeriod,
  amounts: {
    taxableValue: { currency: 'INR', minor: bill.tax.taxableValuePaise },
    cgst: { currency: 'INR', minor: bill.tax.cgstPaise },
    sgst: { currency: 'INR', minor: bill.tax.sgstPaise },
    igst: { currency: 'INR', minor: bill.tax.igstPaise },
    cess: { currency: 'INR', minor: bill.tax.cessPaise },
  },
  invoiceValue: { currency: 'INR', minor: bill.totalPaise },
  ineligibleItc: { currency: 'INR', minor: bill.tax.ineligibleItcPaise },
  reverseCharge: bill.tax.reverseCharge,
  imported: supplier.imported ?? false,
  voucherId: bill.voucherId,
  reversed: bill.state === 'REVERSED',
});

// ---------------------------------------------------------------------------- the two bridges

/**
 * The credit side of GSTR-3B, as #30's `InwardTaxPort` asks for it.
 *
 * The return module deliberately refuses to decide eligibility, and this is the answer it was
 * waiting for. `actorFor` supplies the context the reconciliation runs under; it is a function so
 * that the composition — not this adapter — decides whose permissions a background read carries.
 */
export const itcInwardTaxPort = (
  service: ItcReconciliationService,
  actorFor: (companyId: CompanyId) => ActorContext,
): InwardTaxPort => ({
  async summaryFor(companyId: CompanyId, period): Promise<InwardTaxSummary> {
    const linkage = await service.linkage(actorFor(companyId), period as unknown as TaxPeriod);
    return {
      period,
      allOtherItc: linkage.allOtherItc,
      reverseChargeItc: linkage.reverseChargeItc,
      importItc: linkage.importItc,
      reversedItc: linkage.reversedItc,
      reverseChargeLiability: linkage.reverseChargeLiability,
      exemptInwardValue: linkage.exemptInwardValue,
      contributions: linkage.contributions,
    };
  },
});

/**
 * #19's optional GSTR-2B signal, now that there is something to answer it with.
 *
 * Note what it does not do: it never returns a verdict about the supplier, only what the portal
 * held about one bill. The judgement stays in the supplier-risk module, where the wording rules
 * that keep it defamation-safe live.
 */
export const gstr2bSignalPort = (service: ItcReconciliationService): Gstr2bPort => ({
  async signalFor(companyId, input): Promise<Gstr2bSignal | null> {
    const signal = await service.signalFor(companyId as CompanyId, {
      supplierGstin: input.supplierGstin,
      invoiceNumber: input.invoiceNumber,
      invoiceDate: input.invoiceDate as IsoDate,
    });
    return signal as Gstr2bSignal | null;
  },
});

/** The key a screen uses to talk about one line, exposed so callers need not rebuild the formula. */
export { lineKeyOf };
