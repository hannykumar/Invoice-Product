/**
 * Issue #181 — the customers and the items a business actually keeps, behind the Sale screen.
 *
 * Before this existed, the Sale screen let a person type any customer and any item, and then
 * printed one fixed demo customer and one fixed demo product on the bill. The bill described a
 * different sale from the one that was made. CGST Rule 46 asks for the recipient's own name,
 * address and GSTIN (d), the description of the goods (h), their HSN code (g) and the quantity with
 * its unit (i) — the real recipient and the real goods. A bill naming somebody else's business or
 * somebody else's product is not a bill of that sale, and the buyer cannot claim credit on it.
 *
 * Three rules shape this module.
 *
 * 1. **A customer and an item are records, not words.** Every one is a `packages/masters` record,
 *    created through `MasterDataService` with its duplicate checks and its version history. Nothing
 *    here keeps a second copy of master data, and nothing accepts a free-text name that matches no
 *    record.
 * 2. **The state on a registered customer comes from their GST number.** The first two digits of a
 *    GSTIN are the state it is registered in. That is a fact about the registration, not a choice,
 *    so an address in a different state is refused rather than silently billed.
 * 3. **The business declares its own rates (option C, #54).** No rate is guessed from an HSN code
 *    and no fixture table is consulted. What the business declares is what the calculator uses, and
 *    the printed bill says whose figure it is.
 */
import { invalid, isoDate, type CompanyId } from '@invoice/kernel';
import type { RenderableParty } from '@invoice/invoice-templates';
import {
  InMemoryDeclaredRates,
  type ItemTaxClassification,
  type MasterDataReader,
  type CompanyTaxProfile,
  type PartyTaxProfile,
  type TaxTreatment,
} from '@invoice/gst-calc';
import {
  DEFAULT_UNITS,
  GST_STATE_CODES,
  gstinStateCode,
  normaliseIdentifier,
  validateGstin,
  validateHsnOrSac,
  validatePincode,
  type GstRegistrationType,
  type Item,
  type Party,
  type PartyAddress,
  type ValidationResult,
} from '../../../packages/masters/src/index.ts';
import { STATE_NAMES } from '@invoice/transport';
import { masterData, mastersContext } from './master-data.ts';

const str = (value: unknown): string => String(value ?? '').trim();

const require_ = (result: ValidationResult, code: string, fallback: string): void => {
  if (result.ok) return;
  throw invalid(code, result.problems[0]?.message ?? fallback);
};

/**
 * The GST slabs in force on the app's own dates, plus the two answers that are not a slab.
 *
 * 12 and 28 per cent are deliberately absent: they stopped on 22 September 2025 and offering them
 * would invite a business to charge a rate that no longer exists. A rate outside the list — a
 * tobacco product, say — is typed in under "Other".
 */
export const GST_RATE_CHOICES: readonly { readonly ratePercentTimes100: number; readonly label: string }[] = Object.freeze([
  { ratePercentTimes100: 0, label: '0%' },
  { ratePercentTimes100: 25, label: '0.25%' },
  { ratePercentTimes100: 150, label: '1.5%' },
  { ratePercentTimes100: 300, label: '3%' },
  { ratePercentTimes100: 500, label: '5%' },
  { ratePercentTimes100: 1800, label: '18%' },
  { ratePercentTimes100: 4000, label: '40%' },
]);

/** How the business says an item is taxed. Anything but `taxable` carries no rate. */
export type ItemTaxKind = 'taxable' | 'nil_rated' | 'exempt';

/** What the business told us about one item's tax, kept beside the item's own master record. */
interface ItemTax {
  readonly kind: ItemTaxKind;
  readonly ratePercentTimes100: bigint | null;
}

const itemTaxes = new Map<string, ItemTax>();
const declaredRates = new Map<string, InMemoryDeclaredRates>();

const taxKey = (companyId: CompanyId | string, itemId: string): string => `${String(companyId)}:${itemId}`;

/** The rates this company has declared. One register per company, shared with its calculator. */
export const declaredRatesOf = (companyId: CompanyId | string): InMemoryDeclaredRates => {
  const key = String(companyId);
  const existing = declaredRates.get(key);
  if (existing !== undefined) return existing;
  const created = new InMemoryDeclaredRates();
  declaredRates.set(key, created);
  return created;
};

// -------------------------------------------------------------------------------- reading them

const context = (companyId: CompanyId | string) => mastersContext(companyId);

export const customers = (companyId: CompanyId | string): readonly Party[] =>
  masterData().parties(context(companyId)).filter((party) => party.role === 'customer' || party.role === 'both');

export const items = (companyId: CompanyId | string): readonly Item[] => masterData().items(context(companyId));

export const addressesOf = (companyId: CompanyId | string, partyId: string): readonly PartyAddress[] =>
  masterData().addressesOfParty(String(companyId), partyId);

/** The billing address to print and to decide the place of supply from. */
export const billingAddressOf = (companyId: CompanyId | string, partyId: string): PartyAddress | null => {
  const all = addressesOf(companyId, partyId).filter((address) => address.use === 'billing' || address.use === 'both');
  return all.find((address) => address.isPrimary) ?? all[0] ?? null;
};

/** A customer as the Sale screen shows them, and as the bill will print them. */
export interface CustomerView {
  readonly id: string;
  readonly name: string;
  readonly gstin: string | null;
  readonly registration: GstRegistrationType;
  readonly addressLines: readonly string[];
  readonly line1: string | null;
  readonly line2: string | null;
  readonly city: string | null;
  readonly pincode: string | null;
  readonly stateCode: string | null;
  readonly stateName: string | null;
  readonly phone: string | null;
}

const viewOf = (companyId: CompanyId | string, party: Party): CustomerView => {
  const address = billingAddressOf(companyId, party.id);
  const stateCode = address?.stateCode ?? (party.gstRegistrationType === 'unregistered' ? null : null);
  return {
    id: party.id,
    name: party.legalName,
    gstin: address?.gstin ?? null,
    registration: party.gstRegistrationType,
    addressLines: address === null || address === undefined
      ? []
      : [address.line1, ...(address.line2 === undefined || address.line2 === '' ? [] : [address.line2]), `${address.city} ${address.pincode}`],
    line1: address?.line1 ?? null,
    line2: address?.line2 ?? null,
    city: address?.city ?? null,
    pincode: address?.pincode ?? null,
    stateCode,
    stateName: stateCode === null ? null : STATE_NAMES[stateCode] ?? stateCode,
    phone: party.phones[0] ?? null,
  };
};

export const customerView = (companyId: CompanyId | string, partyId: string): CustomerView => {
  const found = customers(companyId).find((party) => party.id === partyId);
  if (found === undefined) {
    throw invalid('CUSTOMER_NOT_FOUND', 'That customer is not in your customer list. Add them first, so the bill can carry their name, address and GST number.');
  }
  return viewOf(companyId, found);
};

/** An item as the Sale screen shows it: what it is called, its code, its unit and its declared rate. */
export interface ItemView {
  readonly id: string;
  readonly name: string;
  readonly kind: 'goods' | 'service';
  readonly hsnSac: string;
  readonly unit: string;
  readonly taxKind: ItemTaxKind;
  readonly ratePercent: number | null;
}

const itemViewOf = (companyId: CompanyId | string, item: Item): ItemView => {
  const tax = itemTaxes.get(taxKey(companyId, item.id));
  return {
    id: item.id,
    name: item.name,
    kind: item.kind,
    hsnSac: item.hsnSac,
    unit: item.baseUnit,
    taxKind: tax?.kind ?? 'taxable',
    ratePercent: tax?.ratePercentTimes100 === null || tax?.ratePercentTimes100 === undefined ? null : Number(tax.ratePercentTimes100) / 100,
  };
};

export const itemView = (companyId: CompanyId | string, itemId: string): ItemView => {
  const found = items(companyId).find((item) => item.id === itemId);
  if (found === undefined) {
    throw invalid('ITEM_NOT_FOUND', 'That item is not in your item list. Add it first, so the bill can carry its description, code and unit.');
  }
  return itemViewOf(companyId, found);
};

/** Everything the Sale, challan and quotation screens need when they open. */
export const readCatalogue = (companyId: CompanyId | string) => ({
  customers: customers(companyId).map((party) => viewOf(companyId, party)),
  items: items(companyId).map((item) => itemViewOf(companyId, item)),
  units: DEFAULT_UNITS.map((unit) => ({ code: unit.code, name: unit.name })),
  rates: GST_RATE_CHOICES,
  states: Object.entries(GST_STATE_CODES)
    .filter(([, state]) => state.retired !== true)
    .map(([code, state]) => ({ code, name: state.name })),
});

/**
 * Finds the customer somebody named. An exact record id wins; otherwise the name is resolved
 * against the customer list, and a name that matches no record is refused rather than invented.
 */
export const resolveCustomer = (companyId: CompanyId | string, idOrName: string): Party => {
  const wanted = idOrName.trim();
  if (wanted === '') throw invalid('CUSTOMER_REQUIRED', 'Choose the customer this bill is for.');
  const byId = customers(companyId).find((party) => party.id === wanted);
  if (byId !== undefined) return byId;
  const outcome = masterData().resolveParty(context(companyId), wanted);
  if (outcome.status === 'resolved') return outcome.record;
  if (outcome.status === 'ambiguous') {
    throw invalid('CUSTOMER_AMBIGUOUS', `More than one customer is called something like "${wanted}": ${outcome.candidates.map((candidate) => candidate.record.legalName).join(', ')}. Pick one from the list.`);
  }
  throw invalid('CUSTOMER_NOT_FOUND', `"${wanted}" is not in your customer list yet. Add them first, so the bill can carry their name, address and GST number.`);
};

export const resolveItem = (companyId: CompanyId | string, idOrName: string): Item => {
  const wanted = idOrName.trim();
  if (wanted === '') throw invalid('ITEM_REQUIRED', 'Choose what is being sold.');
  const byId = items(companyId).find((item) => item.id === wanted);
  if (byId !== undefined) return byId;
  const outcome = masterData().resolveItem(context(companyId), wanted);
  if (outcome.status === 'resolved') return outcome.record;
  if (outcome.status === 'ambiguous') {
    throw invalid('ITEM_AMBIGUOUS', `More than one item is called something like "${wanted}": ${outcome.candidates.map((candidate) => candidate.record.name).join(', ')}. Pick one from the list.`);
  }
  throw invalid('ITEM_NOT_FOUND', `"${wanted}" is not in your item list yet. Add it first, so the bill can carry its description, code and unit.`);
};

// -------------------------------------------------------------------------------- creating them

const REGISTRATIONS: readonly GstRegistrationType[] = ['regular', 'composition', 'unregistered'];

/**
 * Adds a customer, with the billing address the bill prints.
 *
 * A registered customer's state is taken from their GST number and may not be set to another one:
 * the two disagreeing is how a Karnataka GST number ends up printed above a Delhi address, which is
 * exactly the defect this issue exists to remove.
 */
export const createCustomer = (companyId: CompanyId | string, body: unknown) => {
  const input = (body ?? {}) as Record<string, unknown>;
  const legalName = str(input.legalName || input.name);
  if (legalName.length < 2) throw invalid('CUSTOMER_NAME', 'Type the name the customer is billed under.');

  const registration = str(input.registration).toLowerCase() as GstRegistrationType;
  if (!REGISTRATIONS.includes(registration)) {
    throw invalid('CUSTOMER_REGISTRATION', 'Say whether this customer is registered for GST — regular, composition, or not registered.');
  }

  const gstin = normaliseIdentifier(str(input.gstin));
  if (registration !== 'unregistered') {
    if (gstin === '') throw invalid('CUSTOMER_GSTIN_REQUIRED', 'A registered customer has a GST number, and the bill must carry it.');
    require_(validateGstin(gstin), 'CUSTOMER_GSTIN', 'That is not a GST number.');
  } else if (gstin !== '') {
    throw invalid('CUSTOMER_GSTIN_UNEXPECTED', 'This customer is marked as not registered, so remove the GST number or change the registration.');
  }

  const line1 = str(input.line1 || input.address1);
  if (line1 === '') throw invalid('CUSTOMER_ADDRESS1', 'Type the first line of the customer’s address — the law asks for the street, not only the town.');
  const city = str(input.city);
  if (city === '') throw invalid('CUSTOMER_CITY', 'Type the town or city the customer is in.');
  const pincode = str(input.pincode);
  require_(validatePincode(pincode), 'CUSTOMER_PINCODE', 'A PIN code has 6 digits.');

  const typedState = str(input.stateCode);
  const registeredState = gstin === '' ? '' : gstinStateCode(gstin);
  if (registeredState !== '' && typedState !== '' && typedState !== registeredState) {
    throw invalid(
      'CUSTOMER_STATE_MISMATCH',
      `This GST number is registered in ${STATE_NAMES[registeredState] ?? registeredState} (${registeredState}), but the address says ${STATE_NAMES[typedState] ?? typedState} (${typedState}). A bill cannot carry both.`,
    );
  }
  const stateCode = registeredState !== '' ? registeredState : typedState;
  if (stateCode === '' || GST_STATE_CODES[stateCode] === undefined) {
    throw invalid('CUSTOMER_STATE', 'Choose the state the customer is in. It decides whether the bill carries IGST, or CGST and SGST.');
  }

  const phone = str(input.phone);
  const service = masterData();
  const ctx = context(companyId);
  const reference = str(input.reference) || `${legalName.toLowerCase()}:${gstin || pincode}`;

  const created = service.createParty(
    ctx,
    {
      legalName,
      role: 'customer',
      gstRegistrationType: registration,
      ...(phone === '' ? {} : { phones: [phone] }),
    },
    { idempotencyKey: `customer:${String(companyId)}:${reference}`, acknowledgeSimilar: input.acknowledgeSimilar === true },
  );

  const address = service.addAddress(
    ctx,
    {
      partyId: created.record.id,
      label: 'Billing',
      line1,
      ...(str(input.line2 || input.address2) === '' ? {} : { line2: str(input.line2 || input.address2) }),
      city,
      stateCode,
      pincode,
      ...(gstin === '' ? {} : { gstin }),
      use: 'both',
      isPrimary: true,
    },
    { idempotencyKey: `customer-address:${String(companyId)}:${created.record.id}` },
  );

  return {
    state: 'recorded' as const,
    title: 'Customer added',
    message: `${created.record.legalName} is in your customer list. Bills to them will carry this name, address${gstin === '' ? '' : ' and GST number'}.`,
    customer: viewOf(companyId, created.record),
    addressId: address.record.id,
  };
};

/**
 * Adds an item, with the rate the business says it charges.
 *
 * The rate is stored as a declaration — whose figure it is, when they set it and where they say it
 * came from — never as a fact about the law. The printed bill carries that notice already.
 */
export const createItem = (companyId: CompanyId | string, body: unknown, declaredBy = 'the business') => {
  const input = (body ?? {}) as Record<string, unknown>;
  const name = str(input.name);
  if (name.length < 2) throw invalid('ITEM_NAME', 'Type what this item is called on the bill.');

  const kind = str(input.kind).toLowerCase() === 'service' ? 'service' as const : 'goods' as const;
  const hsnSac = normaliseIdentifier(str(input.hsnSac || input.hsn));
  if (hsnSac === '') {
    throw invalid('ITEM_HSN_REQUIRED', kind === 'service' ? 'Type the service code (SAC). The law asks for it on the bill.' : 'Type the HSN code. The law asks for it on the bill.');
  }
  require_(validateHsnOrSac(hsnSac, kind), 'ITEM_HSN', 'That is not an HSN or SAC code.');

  const unit = normaliseIdentifier(str(input.unit));
  if (DEFAULT_UNITS.find((known) => known.code === unit) === undefined) {
    throw invalid('ITEM_UNIT', `Choose how this item is counted — ${DEFAULT_UNITS.map((known) => known.code).join(', ')}.`);
  }

  const taxKind = str(input.taxKind).toLowerCase();
  const kindOfTax: ItemTaxKind = taxKind === 'nil_rated' ? 'nil_rated' : taxKind === 'exempt' ? 'exempt' : 'taxable';

  let ratePercentTimes100: bigint | null = null;
  if (kindOfTax === 'taxable') {
    const typed = str(input.ratePercentTimes100) === '' ? str(input.ratePercent) : str(input.ratePercentTimes100);
    if (typed === '') throw invalid('ITEM_RATE_REQUIRED', 'Choose the GST rate this business charges on this item, or say it is exempt or nil-rated.');
    const scaled = str(input.ratePercentTimes100) !== ''
      ? BigInt(str(input.ratePercentTimes100))
      : BigInt(Math.round(Number(str(input.ratePercent)) * 100));
    if (scaled < 0n || scaled > 10000n) throw invalid('ITEM_RATE_RANGE', 'A GST rate is between 0 and 100 per cent.');
    ratePercentTimes100 = scaled;
  }

  const basis = str(input.basis) || 'The rate this business charges on this item';
  const service = masterData();
  const ctx = context(companyId);

  const created = service.createItem(
    ctx,
    { name, kind, hsnSac, baseUnit: unit, trackBatches: false, trackSerials: false },
    { idempotencyKey: `item:${String(companyId)}:${str(input.reference) || `${name.toLowerCase()}:${hsnSac}`}`, acknowledgeSimilar: input.acknowledgeSimilar === true },
  );

  itemTaxes.set(taxKey(companyId, created.record.id), { kind: kindOfTax, ratePercentTimes100 });
  if (ratePercentTimes100 !== null) {
    declaredRatesOf(companyId).declare({
      companyId: String(companyId),
      code: hsnSac,
      kind: kind === 'service' ? 'SERVICES' : 'GOODS',
      ratePercentTimes100,
      effectiveFrom: isoDate(str(input.effectiveFrom) || '2017-07-01'),
      effectiveTo: null,
      declaredBy: str(input.declaredBy) || declaredBy,
      declaredOn: isoDate(str(input.declaredOn) || new Date().toISOString().slice(0, 10)),
      basis,
    });
  }

  return {
    state: 'recorded' as const,
    title: 'Item added',
    message: `${created.record.name} is in your item list, counted in ${unit}${ratePercentTimes100 === null ? ', with no GST on it' : ` and charged at ${Number(ratePercentTimes100) / 100}%`}.`,
    item: itemViewOf(companyId, created.record),
  };
};

// ------------------------------------------------------------- what the calculator and bill read

const treatmentOf = (kind: ItemTaxKind): TaxTreatment =>
  kind === 'nil_rated' ? 'NIL_RATED' : kind === 'exempt' ? 'EXEMPT' : 'TAXABLE';

const REGISTRATION_FOR_TAX: Readonly<Record<string, 'REGULAR' | 'COMPOSITION' | 'UNREGISTERED'>> = {
  regular: 'REGULAR',
  composition: 'COMPOSITION',
  unregistered: 'UNREGISTERED',
};

/**
 * The calculator's view of this company's master data: the company itself, its customers and its
 * items, read live from `packages/masters`. Nothing is copied and nothing is cached, so a customer
 * added a second ago is taxed correctly on the bill issued a second later.
 */
export const catalogueTaxReader = (company: { readonly companyId: CompanyId | string; readonly gstin: string }): MasterDataReader => ({
  company(companyId: string): CompanyTaxProfile | undefined {
    if (companyId !== String(company.companyId)) return undefined;
    return { companyId, gstin: company.gstin, stateCode: gstinStateCode(company.gstin), registration: 'REGULAR' };
  },
  party(companyId: string, partyId: string): PartyTaxProfile | undefined {
    const party = customers(companyId).find((candidate) => candidate.id === partyId);
    if (party === undefined) return undefined;
    const address = billingAddressOf(companyId, partyId);
    return {
      partyId,
      gstin: address?.gstin ?? null,
      stateCode: address?.stateCode ?? null,
      registration: REGISTRATION_FOR_TAX[party.gstRegistrationType] ?? 'UNKNOWN',
    };
  },
  item(companyId: string, itemId: string): ItemTaxClassification | undefined {
    const item = items(companyId).find((candidate) => candidate.id === itemId);
    if (item === undefined) return undefined;
    const tax = itemTaxes.get(taxKey(companyId, itemId));
    return {
      itemId,
      name: item.name,
      kind: item.kind === 'service' ? 'SERVICES' : 'GOODS',
      hsnOrSac: item.hsnSac,
      treatment: treatmentOf(tax?.kind ?? 'taxable'),
      reverseCharge: false,
      baseUnit: item.baseUnit,
    };
  },
});

/** The buyer block, as the bill prints it: the customer's own name, address, state and GSTIN. */
export const customerPrint = (companyId: CompanyId | string, partyId: string): RenderableParty => {
  const view = customerView(companyId, partyId);
  const stateCode = view.stateCode ?? '';
  return {
    name: view.name,
    addressLines: view.addressLines,
    gstin: view.gstin,
    stateCode,
    stateName: view.stateName ?? stateCode,
  };
};

// ------------------------------------------------------------------------------ the demo company

/** One customer and one item, as a business would have typed them in on its first day. */
export interface CatalogueSeed {
  readonly customerId: string;
  readonly customerName: string;
  readonly customerGstin: string;
  readonly customerAddress1: string;
  readonly customerCity: string;
  readonly customerPincode: string;
  readonly items: readonly {
    readonly id: string;
    readonly name: string;
    readonly kind: 'goods' | 'service';
    readonly hsnSac: string;
    readonly unit: string;
    readonly ratePercentTimes100: bigint;
    readonly effectiveFrom: string;
    readonly basis: string;
  }[];
}

/**
 * Puts the local app's synthetic customer and items into master data, so it opens with a customer
 * list and an item list rather than an empty screen. They are ordinary records: the screens can add
 * more beside them, and nothing anywhere falls back to them. Every name, GST number and address is
 * invented and belongs to nobody.
 */
export const seedCatalogue = (companyId: CompanyId | string, seed: CatalogueSeed): void => {
  const service = masterData();
  const ctx = context(companyId);
  if (customers(companyId).find((party) => party.id === seed.customerId) === undefined) {
    service.createParty(
      ctx,
      { id: seed.customerId, legalName: seed.customerName, role: 'customer', gstRegistrationType: 'regular' },
      { idempotencyKey: `seed-customer:${String(companyId)}:${seed.customerId}` },
    );
    service.addAddress(
      ctx,
      {
        partyId: seed.customerId,
        label: 'Billing',
        line1: seed.customerAddress1,
        city: seed.customerCity,
        stateCode: gstinStateCode(seed.customerGstin),
        pincode: seed.customerPincode,
        gstin: normaliseIdentifier(seed.customerGstin),
        use: 'both',
        isPrimary: true,
      },
      { idempotencyKey: `seed-customer-address:${String(companyId)}:${seed.customerId}` },
    );
  }
  const known = items(companyId);
  for (const item of seed.items) {
    if (known.find((existing) => existing.id === item.id) !== undefined) continue;
    service.createItem(
      ctx,
      { id: item.id, name: item.name, kind: item.kind, hsnSac: item.hsnSac, baseUnit: item.unit, trackBatches: false, trackSerials: false },
      { idempotencyKey: `seed-item:${String(companyId)}:${item.id}` },
    );
    itemTaxes.set(taxKey(companyId, item.id), { kind: 'taxable', ratePercentTimes100: item.ratePercentTimes100 });
    declaredRatesOf(companyId).declare({
      companyId: String(companyId),
      code: item.hsnSac,
      kind: item.kind === 'service' ? 'SERVICES' : 'GOODS',
      ratePercentTimes100: item.ratePercentTimes100,
      effectiveFrom: isoDate(item.effectiveFrom),
      effectiveTo: null,
      declaredBy: `${String(companyId)}:owner`,
      declaredOn: isoDate(item.effectiveFrom),
      basis: item.basis,
    });
  }
};

/** Test support: forgets this company's declared rates and tax choices with its records. */
export const forgetCatalogue = (companyId: CompanyId | string): void => {
  declaredRates.delete(String(companyId));
  for (const key of [...itemTaxes.keys()]) {
    if (key.startsWith(`${String(companyId)}:`)) itemTaxes.delete(key);
  }
};
