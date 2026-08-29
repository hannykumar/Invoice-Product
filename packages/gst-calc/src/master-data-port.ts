/**
 * Issue #25 [E25] — the small slice of GPT 3's master data (#5) this module reads.
 *
 * See docs/contracts/master-data-ports.v1.md. Only these three read-only shapes are consumed, so
 * when #5 lands the change is an import, not a rewrite.
 */
export type Registration = 'REGULAR' | 'COMPOSITION' | 'UNREGISTERED';
export type PartyRegistration = Registration | 'UNKNOWN';

export interface CompanyTaxProfile {
  readonly companyId: string;
  readonly gstin: string | null;
  readonly stateCode: string;
  readonly registration: Registration;
}

export interface PartyTaxProfile {
  readonly partyId: string;
  readonly gstin: string | null;
  /** `null` is a real answer: we do not know where they are, and we will not assume. */
  readonly stateCode: string | null;
  readonly registration: PartyRegistration;
}

export type TaxTreatment = 'TAXABLE' | 'NIL_RATED' | 'EXEMPT' | 'NON_GST' | 'UNKNOWN';

export interface ItemTaxClassification {
  readonly itemId: string;
  readonly name: string;
  readonly kind: 'GOODS' | 'SERVICES';
  readonly hsnOrSac: string | null;
  readonly treatment: TaxTreatment;
  readonly reverseCharge: boolean;
  readonly baseUnit: string;
}

export interface MasterDataReader {
  company(companyId: string): CompanyTaxProfile | undefined;
  party(companyId: string, partyId: string): PartyTaxProfile | undefined;
  item(companyId: string, itemId: string): ItemTaxClassification | undefined;
}

/** The mock. Replaced by GPT 3's #5; nothing else in this module changes when it is. */
export class InMemoryMasterData implements MasterDataReader {
  readonly #companies = new Map<string, CompanyTaxProfile>();
  readonly #parties = new Map<string, PartyTaxProfile>();
  readonly #items = new Map<string, ItemTaxClassification>();

  putCompany(profile: CompanyTaxProfile): this {
    this.#companies.set(profile.companyId, profile);
    return this;
  }
  putParty(companyId: string, profile: PartyTaxProfile): this {
    this.#parties.set(`${companyId}:${profile.partyId}`, profile);
    return this;
  }
  putItem(companyId: string, item: ItemTaxClassification): this {
    this.#items.set(`${companyId}:${item.itemId}`, item);
    return this;
  }

  company(companyId: string): CompanyTaxProfile | undefined {
    return this.#companies.get(companyId);
  }
  party(companyId: string, partyId: string): PartyTaxProfile | undefined {
    return this.#parties.get(`${companyId}:${partyId}`);
  }
  item(companyId: string, itemId: string): ItemTaxClassification | undefined {
    return this.#items.get(`${companyId}:${itemId}`);
  }
}
