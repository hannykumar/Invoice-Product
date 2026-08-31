/**
 * Issue #37 [E37] — writing into the real master data (#5).
 *
 * This is the whole reason the ports in `ports.ts` are narrow: everything below the seam is GPT 3's
 * `MasterDataService`, with its own validation, duplicate control, effective-dated versions and
 * platform command trail. An import creates customers and items by exactly the same route as a
 * person typing them in, so an imported record is indistinguishable from a typed one — which is the
 * only way the duplicate rules can stay honest.
 */
import { invalid, type CompanyId, type IsoDate, type UserId } from '@invoice/kernel';
import { MasterDataError, MasterDataService } from '../../../masters/src/masters.ts';
import type { Party, PartyRole } from '../../../masters/src/types.ts';
import type { RequestContext } from '../../../platform/src/types.ts';
import type { CreatedItem, CreatedParty, ExistingMasters, ExistingRecord, MasterWriter, WriteOutcome } from '../ports.ts';
import type { CustomerRow, ItemRow } from '../model.ts';

/** Unit spellings that mean a unit the registry already has. Nothing new is invented. */
const UNIT_ALIASES: Readonly<Record<string, string>> = {
  PC: 'PCS', PCS: 'PCS', PIECE: 'PCS', PIECES: 'PCS', NO: 'NOS', NOS: 'NOS', UNIT: 'PCS', EA: 'PCS',
  KG: 'KGS', KGS: 'KGS', KILO: 'KGS', KILOS: 'KGS', KILOGRAM: 'KGS', KILOGRAMS: 'KGS',
  GM: 'GMS', GMS: 'GMS', GRAM: 'GMS', GRAMS: 'GMS', G: 'GMS',
  LTR: 'LTR', LTRS: 'LTR', L: 'LTR', LITRE: 'LTR', LITRES: 'LTR', LITER: 'LTR',
  ML: 'MLT', MLT: 'MLT', MTR: 'MTR', MTRS: 'MTR', METRE: 'MTR', METER: 'MTR', M: 'MTR',
  CM: 'CMS', CMS: 'CMS', SQFT: 'SQF', SQF: 'SQF', DOZ: 'DOZ', DOZEN: 'DOZ',
  BOX: 'BOX', BOXES: 'BOX', BAG: 'BAG', BAGS: 'BAG', QTL: 'QTL', TON: 'TON', TONNE: 'TON', TONNES: 'TON',
};

export interface MastersAdapterOptions {
  readonly branchId: string;
  readonly sessionId: string;
  /** Permissions the platform command service sees. Approval policies are checked against these. */
  readonly permissions?: readonly string[];
}

const contextFor = (companyId: CompanyId, actorId: UserId, options: MastersAdapterOptions): RequestContext => ({
  companyId,
  branchId: options.branchId,
  actorId,
  permissions: new Set((options.permissions ?? []) as never[]),
  sessionId: options.sessionId,
});

const roleFor = (kind: 'CUSTOMER' | 'SUPPLIER'): PartyRole => (kind === 'CUSTOMER' ? 'customer' : 'supplier');

export class MastersMigrationAdapter implements MasterWriter, ExistingMasters {
  readonly #masters: MasterDataService;
  readonly #options: MastersAdapterOptions;

  constructor(masters: MasterDataService, options: MastersAdapterOptions) {
    this.#masters = masters;
    this.#options = options;
  }

  /** The unit the registry knows, or a refusal naming the ones it does. Never invents a unit. */
  resolveUnit(raw: string): string {
    const code = UNIT_ALIASES[raw.trim().toUpperCase()] ?? raw.trim().toUpperCase();
    try {
      this.#masters.units.unit(code);
      return code;
    } catch {
      throw invalid(
        'MIGRATION_UNIT_UNKNOWN',
        `We do not know the unit "${raw}". Use one your books already have, such as PCS, KGS, LTR, BOX or DOZ, or add it in settings before bringing this file in.`,
        { details: { unit: raw } },
      );
    }
  }

  async parties(companyId: CompanyId, kind: 'CUSTOMER' | 'SUPPLIER'): Promise<readonly ExistingRecord[]> {
    const context = contextFor(companyId, '' as UserId, this.#options);
    const wanted = roleFor(kind);
    return this.#masters
      .parties(context)
      .filter((party: Party) => party.role === wanted || party.role === 'both')
      .map((party: Party) => {
        const gstins = this.#masters
          .addressesOfParty(companyId, party.id)
          .map((address) => address.gstin)
          .filter((gstin): gstin is string => Boolean(gstin));
        return {
          id: party.id,
          name: party.legalName,
          aliases: [party.tradeName, ...party.aliases].filter((alias): alias is string => Boolean(alias)),
          gstins,
          ...(party.pan === undefined ? {} : { pan: party.pan }),
          phones: party.phones,
          emails: party.emails,
          ...(party.code === undefined ? {} : { code: party.code }),
        };
      });
  }

  async items(companyId: CompanyId): Promise<readonly ExistingRecord[]> {
    const context = contextFor(companyId, '' as UserId, this.#options);
    return this.#masters.items(context).map((item) => ({
      id: item.id,
      name: item.name,
      aliases: [...item.aliases, ...item.barcodes],
      ...(item.code === undefined ? {} : { code: item.code }),
    }));
  }

  async createParty(
    companyId: CompanyId,
    actorId: UserId,
    row: CustomerRow,
    options: { readonly idempotencyKey: string; readonly effectiveFrom: IsoDate },
  ): Promise<WriteOutcome<CreatedParty>> {
    const context = contextFor(companyId, actorId, this.#options);
    const kind = row.kind === 'suppliers' ? 'SUPPLIER' : 'CUSTOMER';
    let written;
    try {
      written = this.#masters.createParty(
      context,
      {
        ...(row.externalId === null ? {} : { code: row.externalId }),
        legalName: row.name,
        ...(row.tradeName === null ? {} : { tradeName: row.tradeName }),
        role: roleFor(kind),
        gstRegistrationType: row.gstin === null ? 'unregistered' : 'regular',
        ...(row.pan === null ? {} : { pan: row.pan }),
        phones: row.phones,
        emails: row.emails,
        aliases: [],
        ...(row.creditLimit === null ? {} : { creditLimitPaise: row.creditLimit.minor }),
        ...(row.creditDays === null ? {} : { creditDays: row.creditDays }),
      },
      {
        idempotencyKey: options.idempotencyKey,
        effectiveFrom: options.effectiveFrom,
        reason: 'Brought in from another accounting system',
        // The person has already been shown every "this looks similar" row in the preview and chose
        // to go ahead; anything scoring as the *same* record was skipped before we got here.
        acknowledgeSimilar: true,
      },
      );
    } catch (error) {
      if (error instanceof MasterDataError && error.code === 'DUPLICATE_BLOCKED') {
        return { status: 'refused_as_duplicate', why: error.message };
      }
      throw error;
    }

    // An address is only recorded when the file gave enough of one to be worth keeping. A half
    // address on a bill looks like a mistake the business made, so it is left off instead.
    if (row.addressLine !== null && row.city !== null && row.stateCode !== null && row.pincode !== null) {
      this.#masters.addAddress(
        context,
        {
          partyId: written.record.id,
          label: 'From your old system',
          line1: row.addressLine,
          city: row.city,
          stateCode: row.stateCode,
          pincode: row.pincode,
          ...(row.gstin === null ? {} : { gstin: row.gstin }),
          use: 'both',
          isPrimary: true,
        },
        { idempotencyKey: `${options.idempotencyKey}:address`, effectiveFrom: options.effectiveFrom },
      );
    }

    return { status: 'created', record: { partyId: written.record.id, name: written.record.legalName } };
  }

  async createItem(
    companyId: CompanyId,
    actorId: UserId,
    row: ItemRow,
    options: { readonly idempotencyKey: string; readonly effectiveFrom: IsoDate },
  ): Promise<WriteOutcome<CreatedItem>> {
    const context = contextFor(companyId, actorId, this.#options);
    const baseUnit = this.resolveUnit(row.baseUnit);
    let written;
    try {
      written = this.#masters.createItem(
      context,
      {
        ...(row.externalId === null ? {} : { code: row.externalId }),
        name: row.name,
        kind: row.itemKind,
        hsnSac: row.hsnSac,
        baseUnit,
        barcodes: row.barcodes,
        aliases: [],
        trackBatches: false,
        trackSerials: false,
      },
        {
          idempotencyKey: options.idempotencyKey,
          effectiveFrom: options.effectiveFrom,
          reason: 'Brought in from another accounting system',
          acknowledgeSimilar: true,
        },
      );
    } catch (error) {
      if (error instanceof MasterDataError && error.code === 'DUPLICATE_BLOCKED') {
        return { status: 'refused_as_duplicate', why: error.message };
      }
      throw error;
    }
    return { status: 'created', record: { itemId: written.record.id, name: written.record.name, baseUnit } };
  }

  /**
   * Switching a record off rather than deleting it.
   *
   * Master data is effective-dated and versioned; a delete would take the record's history with it,
   * and something may already point at it. Deactivating leaves the trail and stops it being chosen.
   */
  async deactivate(
    companyId: CompanyId,
    actorId: UserId,
    kind: 'party' | 'item',
    id: string,
    options: { readonly idempotencyKey: string; readonly reason: string },
  ): Promise<void> {
    const context = contextFor(companyId, actorId, this.#options);
    if (kind === 'party') this.#masters.updateParty(context, id, { active: false }, { idempotencyKey: options.idempotencyKey, reason: options.reason });
    else this.#masters.updateItem(context, id, { active: false }, { idempotencyKey: options.idempotencyKey, reason: options.reason });
  }
}
