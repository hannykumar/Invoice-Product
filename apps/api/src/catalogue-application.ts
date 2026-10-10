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
import { appToday } from './app-clock.ts';
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
  MasterDataError,
  OVERSEAS_PINCODE,
  OVERSEAS_STATE_CODE,
  gstinStateCode,
  normaliseIdentifier,
  stateOfPincode,
  validateGstin,
  validateHsnOrSac,
  validatePincode,
  validatePincodeForState,
  type GstRegistrationType,
  type Item,
  type Party,
  type UnregisteredBasis,
  type PartyAddress,
  type ValidationResult,
} from '../../../packages/masters/src/index.ts';
import { STATE_NAMES } from '@invoice/transport';
import { masterData, mastersContext } from './master-data.ts';
import { businessDetailsOf, currentStates, turnoverAnswersOf } from './business-details-application.ts';
import { turnoverAnswerOn } from '../../../packages/masters/src/hsn-digits.ts';

const str = (value: unknown): string => String(value ?? '').trim();

/** Issue #143 — what the bill prints where a state would be, for a customer outside India. */
export const OUTSIDE_INDIA = 'Outside India';

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
/**
 * Issue #308 — the price the business usually sells an item at, in paise. A suggestion for a new
 * line only: the bill carries whatever price is on the line, and last time's price to the same
 * customer comes first.
 */
const itemPrices = new Map<string, bigint>();

/** "250", "1,250.50" → paise. Empty is `null`; anything else is refused rather than guessed. */
const pricePaise = (value: unknown): bigint | null => {
  const text = str(value).replace(/,/g, '');
  if (text === '') return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw invalid('ITEM_PRICE', 'Type the selling price in rupees, like 250 or 250.50, or leave it empty.');
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
};

/**
 * Issue #308 — a barcode as the scanner types it. Checked against every other item, because one
 * code that finds two items would put the wrong goods on a bill.
 */
const barcodeOf = (companyId: CompanyId | string, value: unknown, exceptItemId?: string): string | null => {
  const code = str(value).replace(/\s+/g, '');
  if (code === '') return null;
  if (!/^[A-Za-z0-9-]{4,48}$/.test(code)) throw invalid('ITEM_BARCODE', 'A barcode is the letters and digits printed under the lines, 4 to 48 of them. Scan it, or type it without spaces.');
  const other = items(companyId).find((item) => item.id !== exceptItemId && item.barcodes.includes(code));
  if (other !== undefined) throw invalid('ITEM_BARCODE_TAKEN', `This barcode is already on ${other.name}. One barcode can find only one item.`);
  return code;
};
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

/** Issue #228 — the businesses this company buys from, as master-data records. */
export const suppliers = (companyId: CompanyId | string): readonly Party[] =>
  masterData().parties(context(companyId)).filter((party) => party.role === 'supplier' || party.role === 'both');

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
  /** Issue #235 — the most this customer may owe, in rupees, or null when the business set none. */
  readonly creditLimit: number | null;
  /** Issue #288 — the built-in walk-in / cash customer of a counter sale. */
  readonly walkIn: boolean;
}

/**
 * Issue #235 — a credit limit as typed, in rupees ("5000", "5,000", "5000.50"), in paise. Blank is
 * no limit, which is not the same as a limit of nothing and is never replaced by a made-up figure.
 */
export const creditLimitPaiseOf = (value: unknown): bigint | null => {
  const typed = str(value).replace(/[₹,\s]/g, '');
  if (typed === '') return null;
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(typed);
  if (match === null) throw invalid('CUSTOMER_CREDIT_LIMIT', 'Type the credit limit in rupees, such as 50000, or leave it empty for no limit.');
  return BigInt(match[1] ?? '0') * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
};

/** Issue #235 — sets or removes the credit limit on a customer. Bills already issued are not touched. */
export const setCustomerCreditLimit = (companyId: CompanyId | string, customerId: string, value: unknown): Party => {
  const customer = resolveCustomer(companyId, customerId);
  const paise = creditLimitPaiseOf(value);
  if ((customer.creditLimitPaise ?? null) === paise) return customer;
  return masterData().updateParty(
    context(companyId),
    customer.id,
    // Removing a limit clears the field; the record's other fields are kept as they are.
    (paise === null ? { creditLimitPaise: undefined } : { creditLimitPaise: paise }) as Partial<Omit<Party, 'id' | 'companyId'>>,
    { idempotencyKey: `customer-credit-limit:${String(companyId)}:${customer.id}:${crypto.randomUUID()}` },
  ).record;
};

const viewOf = (companyId: CompanyId | string, party: Party): CustomerView => {
  const address = billingAddressOf(companyId, party.id);
  const stateCode = address?.stateCode ?? (party.gstRegistrationType === 'unregistered' ? null : null);
  // Issue #143 — PIN 999999 is the government's placeholder for "abroad", not something to print.
  const overseas = stateCode === OVERSEAS_STATE_CODE;
  return {
    id: party.id,
    name: party.legalName,
    gstin: address?.gstin ?? null,
    registration: party.gstRegistrationType,
    addressLines: address === null || address === undefined
      ? []
      : [address.line1, ...(address.line2 === undefined || address.line2 === '' ? [] : [address.line2]), overseas ? address.city : `${address.city} ${address.pincode}`],
    line1: address?.line1 ?? null,
    line2: address?.line2 ?? null,
    city: address?.city ?? null,
    pincode: address?.pincode ?? null,
    stateCode,
    stateName: stateCode === null ? null : overseas ? OUTSIDE_INDIA : STATE_NAMES[stateCode] ?? stateCode,
    phone: party.phones[0] ?? null,
    creditLimit: party.creditLimitPaise === undefined || party.creditLimitPaise === null ? null : Number(party.creditLimitPaise) / 100,
    walkIn: isWalkIn(party),
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
  /** Issue #308 — what the item picker searches besides the name: short code, barcodes, other names (Hindi too). */
  readonly code: string | null;
  readonly barcodes: readonly string[];
  readonly aliases: readonly string[];
  /** Issue #308 — the usual selling price in rupees, or `null` when none was set. */
  readonly price: number | null;
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
    code: item.code ?? null,
    barcodes: item.barcodes,
    aliases: item.aliases,
    price: itemPrices.has(taxKey(companyId, item.id)) ? Number(itemPrices.get(taxKey(companyId, item.id))) / 100 : null,
  };
};

export const itemView = (companyId: CompanyId | string, itemId: string): ItemView => {
  const found = items(companyId).find((item) => item.id === itemId);
  if (found === undefined) {
    throw invalid('ITEM_NOT_FOUND', 'That item is not in your item list. Add it first, so the bill can carry its description, code and unit.');
  }
  return itemViewOf(companyId, found);
};

// ------------------------------------------------------------ issue #288: the walk-in customer

/** The code that marks the one built-in walk-in customer of a company. */
export const WALK_IN_CODE = 'WALK-IN';
export const WALK_IN_NAME = 'Walk-in / cash customer';
/** What the bill prints where a walk-in customer's street would be. */
const COUNTER_SALE = 'Counter sale';

export const isWalkIn = (party: Pick<Party, 'code'>): boolean => party.code === WALK_IN_CODE;

/**
 * Issue #288 — the customer of a counter sale: nobody's name, no GST number, and the shop's own state.
 *
 * Goods handed over at the counter are supplied where the shop is (IGST Act s.10(1)(c)), so the
 * walk-in customer's one address is the shop's own town, PIN code and state, printed under "Counter
 * sale". Everything downstream (the tax, the return, the e-way check) reads that address like any
 * other customer's, and so counts the sale in the shop's state. CGST Rule 46(e) asks for an
 * unregistered buyer's name and address only from ₹50,000 of taxable value; the sale refuses a walk-in
 * above that (see `DemoApplication.previewSale`).
 *
 * Made once per company, the first time it is asked for, and kept in step with the town and PIN code
 * in Business details. Needs Business details, because a bill cannot be issued without them anyway.
 */
export const walkInCustomer = (companyId: CompanyId | string): Party => {
  const us = businessDetailsOf(companyId);
  if (us === null) {
    throw invalid('WALK_IN_NEEDS_BUSINESS_ADDRESS', 'Add your shop’s address in Business details first. A counter sale is billed at your shop, so the bill takes its state from there.');
  }
  const service = masterData();
  const ctx = context(companyId);
  const party = customers(companyId).find(isWalkIn) ?? service.createParty(
    ctx,
    { legalName: WALK_IN_NAME, code: WALK_IN_CODE, role: 'customer', gstRegistrationType: 'unregistered' },
    { idempotencyKey: `walk-in:${String(companyId)}`, acknowledgeSimilar: true },
  ).record;
  const address = billingAddressOf(companyId, party.id);
  if (address === null) {
    service.addAddress(
      ctx,
      { partyId: party.id, label: 'Counter', line1: COUNTER_SALE, city: us.city, stateCode: us.stateCode, pincode: us.pincode, use: 'both', isPrimary: true },
      { idempotencyKey: `walk-in-address:${String(companyId)}` },
    );
  } else if (address.city !== us.city || address.pincode !== us.pincode) {
    service.correctAddress(ctx, address.id, { city: us.city, pincode: us.pincode }, { idempotencyKey: `walk-in-address:${String(companyId)}:${us.city}:${us.pincode}` });
  }
  return party;
};

/** Everything the Sale, challan and quotation screens need when they open. */
export const readCatalogue = (companyId: CompanyId | string) => ({
  customers: customers(companyId).map((party) => viewOf(companyId, party)),
  // Issue #228 — the Purchase screen picks its supplier from here, never from a typed name.
  suppliers: suppliers(companyId).map((party) => viewOf(companyId, party)),
  items: items(companyId).map((item) => itemViewOf(companyId, item)),
  units: DEFAULT_UNITS.map((unit) => ({ code: unit.code, name: unit.name })),
  rates: GST_RATE_CHOICES,
  states: currentStates(),
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

/**
 * Issue #228 — the supplier a purchase is from. Only a supplier on the list can be named: a bill
 * posted to a name that matches no record is posted to nobody the books know, and the state its
 * GST was charged from would be a guess.
 */
export const resolveSupplier = (companyId: CompanyId | string, idOrName: string): Party => {
  const wanted = idOrName.trim();
  if (wanted === '') throw invalid('SUPPLIER_REQUIRED', 'Choose the supplier this bill is from.');
  const list = suppliers(companyId);
  const byId = list.find((party) => party.id === wanted);
  if (byId !== undefined) return byId;
  const outcome = masterData().resolveParty(context(companyId), wanted);
  if (outcome.status === 'resolved' && list.some((party) => party.id === outcome.record.id)) return outcome.record;
  if (outcome.status === 'ambiguous') {
    const candidates = outcome.candidates.filter((candidate) => list.some((party) => party.id === candidate.record.id));
    if (candidates.length === 1) return candidates[0]!.record;
    if (candidates.length > 1) {
      throw invalid('SUPPLIER_AMBIGUOUS', `More than one supplier is called something like "${wanted}": ${candidates.map((candidate) => candidate.record.legalName).join(', ')}. Pick one from the list.`);
    }
  }
  throw invalid('SUPPLIER_NOT_FOUND', `"${wanted}" is not in your supplier list yet. Add them first, with their GST number, so the bill is recorded against the right business and the right state.`);
};

// -------------------------------------------------------------------------------- creating them

// Issue #143 — a buyer abroad, an SEZ unit, and a buyer whose purchases are deemed exports. The last
// three are registered in India and carry a GST number; the first has none.
const REGISTRATIONS: readonly GstRegistrationType[] = ['regular', 'composition', 'unregistered', 'overseas', 'sez_with_payment', 'sez_without_payment', 'deemed_export'];
const WITHOUT_GSTIN: readonly GstRegistrationType[] = ['unregistered', 'overseas'];

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
    throw invalid('CUSTOMER_REGISTRATION', 'Say whether this customer is registered for GST — regular, composition, not registered, outside India, in an SEZ, or buying as a deemed export.');
  }
  const overseas = registration === 'overseas';

  const gstin = normaliseIdentifier(str(input.gstin));
  if (!WITHOUT_GSTIN.includes(registration)) {
    if (gstin === '') throw invalid('CUSTOMER_GSTIN_REQUIRED', 'A registered customer has a GST number, and the bill must carry it.');
    require_(validateGstin(gstin), 'CUSTOMER_GSTIN', 'That is not a GST number.');
  } else if (gstin !== '') {
    throw invalid('CUSTOMER_GSTIN_UNEXPECTED', overseas
      ? 'A customer outside India has no Indian GST number, so remove it or change the registration.'
      : 'This customer is marked as not registered, so remove the GST number or change the registration.');
  }

  const line1 = str(input.line1 || input.address1);
  if (line1 === '') throw invalid('CUSTOMER_ADDRESS1', 'Type the first line of the customer’s address — the law asks for the street, not only the town.');
  const city = str(input.city);
  if (city === '') throw invalid('CUSTOMER_CITY', overseas ? 'Type the city and country the customer is in, such as "Dubai, United Arab Emirates".' : 'Type the town or city the customer is in.');
  // Issue #143 — abroad has no PIN code; it is saved the way the e-invoice writes it.
  const pincode = overseas ? OVERSEAS_PINCODE : str(input.pincode);
  require_(validatePincode(pincode), 'CUSTOMER_PINCODE', 'A PIN code has 6 digits.');

  // Issue #288 — a customer with no GST number: their state is read from the PIN code when none was chosen.
  const typedState = str(input.stateCode) || (gstin === '' && !overseas ? stateOfPincode(pincode) ?? '' : '');
  const registeredState = gstin === '' ? '' : gstinStateCode(gstin);
  if (registeredState !== '' && typedState !== '' && typedState !== registeredState) {
    throw invalid(
      'CUSTOMER_STATE_MISMATCH',
      `This GST number is registered in ${STATE_NAMES[registeredState] ?? registeredState} (${registeredState}), but the address says ${STATE_NAMES[typedState] ?? typedState} (${typedState}). A bill cannot carry both.`,
    );
  }
  const stateCode = overseas ? OVERSEAS_STATE_CODE : registeredState !== '' ? registeredState : typedState;
  // Issue #237 — a retired code (25, 28) is not a state anybody can be in today.
  if (!overseas && (stateCode === '' || GST_STATE_CODES[stateCode] === undefined || (registeredState === '' && GST_STATE_CODES[stateCode]?.retired === true))) {
    throw invalid('CUSTOMER_STATE', 'Choose the state the customer is in. It decides whether the bill carries IGST, or CGST and SGST.');
  }
  // Issue #224 — a PIN from another state prints a wrong address on every bill to this customer.
  if (!overseas) require_(validatePincodeForState(pincode, stateCode), 'CUSTOMER_PINCODE_STATE', 'That PIN code is not in the customer’s state.');

  const phone = str(input.phone);
  // Issue #235 — optional. Left empty, the customer has no limit and is never warned about one.
  const creditLimitPaise = creditLimitPaiseOf(input.creditLimit);
  const service = masterData();
  const ctx = context(companyId);
  const reference = str(input.reference) || `${legalName.toLowerCase()}:${gstin || pincode}`;

  const create = (acknowledgeSimilar: boolean) => service.createParty(
    ctx,
    {
      legalName,
      role: 'customer',
      gstRegistrationType: registration,
      ...(phone === '' ? {} : { phones: [phone] }),
      ...(creditLimitPaise === null ? {} : { creditLimitPaise }),
    },
    { idempotencyKey: `customer:${String(companyId)}:${reference}`, acknowledgeSimilar },
  );
  let created: ReturnType<typeof create>;
  try {
    created = create(input.acknowledgeSimilar === true);
  } catch (error) {
    // Issue #288 — a name only like the built-in walk-in customer's ("Walk-in Customer") is somebody's
    // own record, not a second copy of it, so it is not held up by it.
    const onlyWalkIn = error instanceof MasterDataError && error.code === 'DUPLICATE_BLOCKED'
      && error.candidates.length > 0 && error.candidates.every((candidate) => candidate.record.code === WALK_IN_CODE);
    if (!onlyWalkIn) throw error;
    created = create(true);
  }

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
 * Issue #228 — adds a supplier, with the address on their bills.
 *
 * The same checks as a customer's (#181, #224): the GST number must pass its own check digit, the
 * state is the first two digits of that number and is never asked for separately, and the PIN code
 * must belong to that state. Whether a purchase carries IGST or CGST and SGST is decided from this
 * state and ours, so there is no second answer anywhere that could disagree with it.
 *
 * A business we already sell to can also be a supplier: its record is marked as both rather than a
 * second record being made for the same GST number.
 */
export const createSupplier = (companyId: CompanyId | string, body: unknown) => {
  const input = (body ?? {}) as Record<string, unknown>;
  const legalName = str(input.legalName || input.name);
  if (legalName.length < 2) throw invalid('SUPPLIER_NAME', 'Type the name the supplier bills you under.');

  // Issue #289 — three kinds of supplier the law allows: registered (GSTIN, may charge GST),
  // composition (GSTIN, may not charge GST — CGST s.10(4)) and not registered (no GSTIN — s.22, s.23).
  const registration = str(input.registration) || 'regular';
  if (registration !== 'regular' && registration !== 'composition' && registration !== 'unregistered') {
    throw invalid('SUPPLIER_REGISTRATION', 'Choose whether the supplier is registered for GST, a composition dealer, or not registered.');
  }
  if (registration === 'unregistered') return createUnregisteredSupplier(companyId, input, legalName);

  const gstin = normaliseIdentifier(str(input.gstin));
  if (gstin === '') throw invalid('SUPPLIER_GSTIN_REQUIRED', 'Type the supplier’s GST number. It is on every bill they give you, and it decides which GST you can claim back.');
  require_(validateGstin(gstin), 'SUPPLIER_GSTIN', 'That is not a GST number.');
  const stateCode = gstinStateCode(gstin);
  if (GST_STATE_CODES[stateCode] === undefined) throw invalid('SUPPLIER_GSTIN', 'The first two digits of this GST number are not a state.');

  const line1 = str(input.line1 || input.address1);
  if (line1 === '') throw invalid('SUPPLIER_ADDRESS1', 'Type the first line of the supplier’s address, as it is on their bill.');
  const city = str(input.city);
  if (city === '') throw invalid('SUPPLIER_CITY', 'Type the town or city the supplier is in.');
  const pincode = str(input.pincode);
  require_(validatePincode(pincode), 'SUPPLIER_PINCODE', 'A PIN code has 6 digits.');
  require_(validatePincodeForState(pincode, stateCode), 'SUPPLIER_PINCODE_STATE', 'That PIN code is not in the supplier’s state.');

  const service = masterData();
  const ctx = context(companyId);
  const phone = str(input.phone);

  // The same GST number already on a customer is the same business.
  const holder = service.parties(ctx).find((party) =>
    addressesOf(companyId, party.id).some((address) => address.gstin !== undefined && normaliseIdentifier(address.gstin) === gstin));
  if (holder !== undefined) {
    if (holder.role === 'supplier' || holder.role === 'both') {
      throw invalid('SUPPLIER_EXISTS', `${holder.legalName} is already in your supplier list with GST number ${gstin}. Pick them from the list.`);
    }
    const updated = service.updateParty(ctx, holder.id, { role: 'both' }, { idempotencyKey: `supplier-role:${String(companyId)}:${holder.id}` });
    return {
      state: 'recorded' as const,
      title: 'Supplier added',
      message: `${updated.record.legalName} is already your customer with GST number ${gstin}, and is now in your supplier list as well.`,
      supplier: viewOf(companyId, updated.record),
    };
  }

  const reference = str(input.reference) || `${legalName.toLowerCase()}:${gstin}`;
  const created = service.createParty(
    ctx,
    { legalName, role: 'supplier', gstRegistrationType: registration, ...(phone === '' ? {} : { phones: [phone] }) },
    { idempotencyKey: `supplier:${String(companyId)}:${reference}`, acknowledgeSimilar: input.acknowledgeSimilar === true },
  );
  service.addAddress(
    ctx,
    {
      partyId: created.record.id,
      label: 'Billing',
      line1,
      ...(str(input.line2 || input.address2) === '' ? {} : { line2: str(input.line2 || input.address2) }),
      city,
      stateCode,
      pincode,
      gstin,
      use: 'both',
      isPrimary: true,
    },
    { idempotencyKey: `supplier-address:${String(companyId)}:${created.record.id}` },
  );
  return {
    state: 'recorded' as const,
    title: 'Supplier added',
    message: registration === 'composition'
      ? `${created.record.legalName} is in your supplier list as a composition dealer, in ${STATE_NAMES[stateCode] ?? stateCode} (${stateCode}). A composition dealer may not charge GST (CGST s.10(4)), so their bills carry none and no GST credit comes from them.`
      : `${created.record.legalName} is in your supplier list, in ${STATE_NAMES[stateCode] ?? stateCode} (${stateCode}) as their GST number says.`,
    supplier: viewOf(companyId, created.record),
  };
};

const UNREGISTERED_BASES: Readonly<Record<string, { readonly basis: UnregisteredBasis; readonly words: string }>> = {
  BELOW_THRESHOLD: { basis: 'BELOW_THRESHOLD', words: 'their turnover is below the limit for registration (CGST s.22)' },
  AGRICULTURIST: { basis: 'AGRICULTURIST', words: 'they are a farmer selling their own produce (CGST s.23(1)(b))' },
  EXEMPT_ONLY: { basis: 'EXEMPT_ONLY', words: 'they sell only goods or services that are exempt from GST (CGST s.23(1)(a))' },
};

/**
 * Issue #289 — a supplier with no GST registration. Lawful on the grounds of s.22 and s.23, and
 * their bill is a lawful bill; but they may not charge GST (s.32(1)) and no credit can be taken on
 * it (s.16(2)(a) needs a tax invoice from a registered supplier). The ground is recorded because the
 * law treats them differently: a farmer's raw cotton, for one, is under reverse charge.
 */
const createUnregisteredSupplier = (companyId: CompanyId | string, input: Record<string, unknown>, legalName: string) => {
  if (str(input.gstin) !== '') {
    throw invalid('SUPPLIER_UNREGISTERED_HAS_GSTIN', 'This supplier has a GST number, so they are registered. Choose "Registered" and type the number.');
  }
  const ground = UNREGISTERED_BASES[str(input.unregisteredBasis)];
  if (ground === undefined) {
    throw invalid('SUPPLIER_UNREGISTERED_BASIS', 'Choose why the supplier is not registered: their turnover is below the limit, they are a farmer selling their own produce, or they sell only exempt goods or services. Only these let a business trade without GST registration.');
  }
  const line1 = str(input.line1 || input.address1);
  if (line1 === '') throw invalid('SUPPLIER_ADDRESS1', 'Type the first line of the supplier’s address, as it is on their bill.');
  const city = str(input.city);
  if (city === '') throw invalid('SUPPLIER_CITY', 'Type the town or city the supplier is in.');
  const pincode = str(input.pincode);
  require_(validatePincode(pincode), 'SUPPLIER_PINCODE', 'A PIN code has 6 digits.');
  const stateCode = str(input.stateCode) || stateOfPincode(pincode) || '';
  if (GST_STATE_CODES[stateCode] === undefined) throw invalid('SUPPLIER_STATE', 'Choose the state the supplier is in. With no GST number, their state is not known otherwise, and it decides IGST against CGST and SGST.');
  require_(validatePincodeForState(pincode, stateCode), 'SUPPLIER_PINCODE_STATE', 'That PIN code is not in the supplier’s state.');

  const service = masterData();
  const ctx = context(companyId);
  const phone = str(input.phone);
  const reference = str(input.reference) || `${legalName.toLowerCase()}:${pincode}:unregistered`;
  const created = service.createParty(
    ctx,
    { legalName, role: 'supplier', gstRegistrationType: 'unregistered', unregisteredBasis: ground.basis, ...(phone === '' ? {} : { phones: [phone] }) },
    { idempotencyKey: `supplier:${String(companyId)}:${reference}`, acknowledgeSimilar: input.acknowledgeSimilar === true },
  );
  service.addAddress(
    ctx,
    {
      partyId: created.record.id, label: 'Billing', line1,
      ...(str(input.line2 || input.address2) === '' ? {} : { line2: str(input.line2 || input.address2) }),
      city, stateCode, pincode, use: 'both', isPrimary: true,
    },
    { idempotencyKey: `supplier-address:${String(companyId)}:${created.record.id}` },
  );
  return {
    state: 'recorded' as const,
    title: 'Supplier added',
    message: `${created.record.legalName} is in your supplier list with no GST number, because ${ground.words}. Their bills carry no GST (CGST s.32(1)) and give no GST credit (s.16(2)(a)).`,
    supplier: viewOf(companyId, created.record),
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
  // Issue #308 — a barcode, a selling price and another name (in Hindi, say), all optional.
  const barcode = barcodeOf(companyId, input.barcode);
  const price = pricePaise(input.price);
  const otherName = str(input.otherName);
  const service = masterData();
  const ctx = context(companyId);

  const created = service.createItem(
    ctx,
    {
      name, kind, hsnSac, baseUnit: unit, trackBatches: false, trackSerials: false,
      barcodes: barcode === null ? [] : [barcode], aliases: otherName === '' ? [] : [otherName],
    },
    {
      idempotencyKey: `item:${String(companyId)}:${str(input.reference) || `${name.toLowerCase()}:${hsnSac}`}`,
      acknowledgeSimilar: input.acknowledgeSimilar === true,
      turnoverAbove5Crore: turnoverAnswerOn(turnoverAnswersOf(companyId), appToday()),
    },
  );

  itemTaxes.set(taxKey(companyId, created.record.id), { kind: kindOfTax, ratePercentTimes100 });
  if (price !== null) itemPrices.set(taxKey(companyId, created.record.id), price);
  if (ratePercentTimes100 !== null) {
    declaredRatesOf(companyId).declare({
      companyId: String(companyId),
      code: hsnSac,
      kind: kind === 'service' ? 'SERVICES' : 'GOODS',
      ratePercentTimes100,
      effectiveFrom: isoDate(str(input.effectiveFrom) || '2017-07-01'),
      effectiveTo: null,
      declaredBy: str(input.declaredBy) || declaredBy,
      declaredOn: isoDate(str(input.declaredOn) || appToday()),
      basis,
    });
  }

  return {
    state: 'recorded' as const,
    title: 'Item added',
    message: `${created.record.name} is in your item list, counted in ${unit}${ratePercentTimes100 === null ? ', with no GST on it' : ` and charged at ${Number(ratePercentTimes100) / 100}%`}.${created.warnings.map((warning) => ` ${warning.message}`).join('')}`,
    warnings: created.warnings.map((warning) => warning.message),
    item: itemViewOf(companyId, created.record),
  };
};

/**
 * Issue #187 — corrects an item's HSN or SAC code, which is what a bill held up for a code that is
 * too short asks the person to do. The GST rate the business declared is kept: it is stored against
 * the code, so it is declared again under the new one, with the same figure and the same basis.
 */
export const changeItemCode = (companyId: CompanyId | string, body: unknown, declaredBy = 'the business') => {
  const input = (body ?? {}) as Record<string, unknown>;
  const itemId = str(input.itemId);
  const current = items(companyId).find((candidate) => candidate.id === itemId);
  if (current === undefined) throw invalid('ITEM_NOT_FOUND', 'That item is not in your item list.');
  const hsnSac = normaliseIdentifier(str(input.hsnSac || input.hsn));
  if (hsnSac === '') throw invalid('ITEM_HSN_REQUIRED', 'Type the new code.');
  require_(validateHsnOrSac(hsnSac, current.kind), 'ITEM_HSN', 'That is not an HSN or SAC code.');
  const today = appToday();

  const updated = masterData().updateItem(context(companyId), current.id, { hsnSac }, {
    idempotencyKey: `item-code:${String(companyId)}:${current.id}:${hsnSac}`,
    turnoverAbove5Crore: turnoverAnswerOn(turnoverAnswersOf(companyId), today),
  });

  const tax = itemTaxes.get(taxKey(companyId, current.id));
  const taxKind = current.kind === 'service' ? 'SERVICES' : 'GOODS';
  // A declaration for "39" already covers "3901"; one is only added when the new code is not covered.
  if (tax?.ratePercentTimes100 != null && declaredRatesOf(companyId).find(String(companyId), hsnSac, taxKind, today) === undefined) {
    const earlier = declaredRatesOf(companyId).find(String(companyId), current.hsnSac, taxKind, today);
    declaredRatesOf(companyId).declare({
      companyId: String(companyId),
      code: hsnSac,
      kind: taxKind,
      ratePercentTimes100: tax.ratePercentTimes100,
      effectiveFrom: earlier?.effectiveFrom ?? isoDate('2017-07-01'),
      effectiveTo: null,
      declaredBy: earlier?.declaredBy ?? declaredBy,
      declaredOn: today,
      basis: earlier?.basis ?? 'The rate this business charges on this item',
    });
  }

  return {
    state: 'recorded' as const,
    title: 'Item code changed',
    message: `${updated.record.name} now carries the code ${hsnSac}.${updated.warnings.map((warning) => ` ${warning.message}`).join('')}`,
    warnings: updated.warnings.map((warning) => warning.message),
    item: itemViewOf(companyId, updated.record),
  };
};

/**
 * Issue #308 — the item's own edit dialog: its HSN code (moved here from the sale line), barcode,
 * usual selling price and other name. The code goes through `changeItemCode`, so the declared rate
 * follows it exactly as before. Every field is checked before anything is saved.
 */
export const editItem = (companyId: CompanyId | string, body: unknown, declaredBy = 'the business') => {
  const input = (body ?? {}) as Record<string, unknown>;
  const itemId = str(input.itemId);
  const current = items(companyId).find((candidate) => candidate.id === itemId);
  if (current === undefined) throw invalid('ITEM_NOT_FOUND', 'That item is not in your item list.');
  const barcode = 'barcode' in input ? barcodeOf(companyId, input.barcode, current.id) : undefined;
  const price = 'price' in input ? pricePaise(input.price) : undefined;
  const otherName = 'otherName' in input ? str(input.otherName) : undefined;
  const hsnSac = normaliseIdentifier(str(input.hsnSac || input.hsn));
  const warnings: string[] = [];
  if (hsnSac !== '' && hsnSac !== current.hsnSac) warnings.push(...changeItemCode(companyId, { itemId, hsnSac }, declaredBy).warnings);
  if (barcode !== undefined || otherName !== undefined) {
    masterData().updateItem(context(companyId), current.id, {
      ...(barcode === undefined ? {} : { barcodes: barcode === null ? [] : [barcode] }),
      ...(otherName === undefined ? {} : { aliases: otherName === '' ? [] : [otherName] }),
    }, { idempotencyKey: `item-edit:${String(companyId)}:${current.id}:${crypto.randomUUID()}` });
  }
  if (price === null) itemPrices.delete(taxKey(companyId, current.id));
  else if (price !== undefined) itemPrices.set(taxKey(companyId, current.id), price);
  const item = itemView(companyId, current.id);
  return {
    state: 'recorded' as const,
    title: 'Item saved',
    message: `${item.name} is saved.${warnings.map((warning) => ` ${warning}`).join('')}`,
    warnings,
    item,
  };
};

// ------------------------------------------------------------- what the calculator and bill read

const treatmentOf = (kind: ItemTaxKind): TaxTreatment =>
  kind === 'nil_rated' ? 'NIL_RATED' : kind === 'exempt' ? 'EXEMPT' : 'TAXABLE';

const REGISTRATION_FOR_TAX: Readonly<Record<string, 'REGULAR' | 'COMPOSITION' | 'UNREGISTERED'>> = {
  regular: 'REGULAR',
  composition: 'COMPOSITION',
  unregistered: 'UNREGISTERED',
  // Issue #143 — an SEZ unit and a deemed-export buyer hold ordinary GST registrations; a buyer
  // abroad holds none. Which export treatment applies is decided by `packages/gst`, not here.
  overseas: 'UNREGISTERED',
  sez_with_payment: 'REGULAR',
  sez_without_payment: 'REGULAR',
  deemed_export: 'REGULAR',
};

/**
 * The calculator's view of this company's master data: the company itself, its customers and its
 * items, read live from `packages/masters`. Nothing is copied and nothing is cached, so a customer
 * added a second ago is taxed correctly on the bill issued a second later.
 */
export const catalogueTaxReader = (company: { readonly companyId: CompanyId | string; readonly gstin: string }): MasterDataReader => ({
  company(companyId: string): CompanyTaxProfile | undefined {
    if (companyId !== String(company.companyId)) return undefined;
    return {
      companyId,
      gstin: company.gstin,
      stateCode: gstinStateCode(company.gstin),
      registration: 'REGULAR',
      // Issue #187 — decides how many HSN digits each bill needs. Read live, like everything here.
      turnoverAbove5Crore: turnoverAnswersOf(companyId),
    };
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
  /** Issue #228 — the supplier the company opens with, as a master-data record like the customer. */
  readonly supplier?: {
    readonly id: string;
    readonly name: string;
    readonly gstin: string;
    readonly address1: string;
    readonly city: string;
    readonly pincode: string;
  };
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
  const supplier = seed.supplier;
  if (supplier !== undefined && suppliers(companyId).find((party) => party.id === supplier.id) === undefined) {
    service.createParty(
      ctx,
      { id: supplier.id, legalName: supplier.name, role: 'supplier', gstRegistrationType: 'regular' },
      { idempotencyKey: `seed-supplier:${String(companyId)}:${supplier.id}` },
    );
    service.addAddress(
      ctx,
      {
        partyId: supplier.id,
        label: 'Billing',
        line1: supplier.address1,
        city: supplier.city,
        stateCode: gstinStateCode(supplier.gstin),
        pincode: supplier.pincode,
        gstin: normaliseIdentifier(supplier.gstin),
        use: 'both',
        isPrimary: true,
      },
      { idempotencyKey: `seed-supplier-address:${String(companyId)}:${supplier.id}` },
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
