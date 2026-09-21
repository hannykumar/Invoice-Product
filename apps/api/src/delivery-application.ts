/**
 * Issue #182 — where the goods are going, who is carrying them, and what the bill refers back to.
 *
 * The printed bill has boxes for Dispatched through, Vehicle No., e-Way Bill No., LR/RR No.,
 * Destination, Buyer's Order No., Terms of Delivery, Other References, Mode / Terms of Payment and
 * a Consignee (Ship to) block. Until now the Sale screen could fill none of them, so every bill
 * printed them empty and the consignee block only repeated the buyer.
 *
 * Two of those boxes are not decoration.
 *
 * 1. **The delivery address.** CGST Rule 46(o) requires the address of delivery whenever it differs
 *    from the place of supply, and for an unregistered customer billed ₹50,000 or more Rule 46(e)
 *    requires it with the state's name and code.
 * 2. **The vehicle and the e-way bill number.** Rule 138A puts the invoice and the e-way bill in the
 *    hands of the person driving the lorry. A goods bill travelling without them is what gets a
 *    lorry stopped and questioned.
 *
 * The place of supply follows from where the goods go, and the two cases are different in law
 * (IGST Act, section 10(1)):
 *
 * - **(a)** goods that move end their journey somewhere, and that is the place of supply. A
 *   customer's own godown in another state moves the supply to that state.
 * - **(b)** goods delivered to a **third person** on the buyer's instructions are supplied where the
 *   **buyer who is billed** has their principal place of business — not where the third person is.
 *
 * Nothing here is ever defaulted from an earlier sale. A suggestion list is fine; a silent default
 * would put a lorry number on a bill nobody typed one for.
 */
import { invalid, isoDate, type CompanyId } from '@invoice/kernel';
import type { RenderableParty, RenderableReferences, RenderableTransport } from '@invoice/invoice-templates';
import { shipToFromDelivery } from '@invoice/invoice-templates';
import { STATE_NAMES, normaliseVehicleNumber } from '@invoice/transport';
import {
  GST_STATE_CODES,
  normaliseIdentifier,
  validateGstin,
  validatePincode,
  validateVehicleNumber,
  OVERSEAS_STATE_CODE,
  type PartyAddress,
  type Transporter,
  type ValidationResult,
} from '../../../packages/masters/src/index.ts';
import { masterData, mastersContext } from './master-data.ts';
import { OUTSIDE_INDIA, addressesOf, billingAddressOf, customerPrint, customerView, resolveCustomer } from './catalogue-application.ts';

const str = (value: unknown): string => String(value ?? '').trim();

const require_ = (result: ValidationResult, code: string, fallback: string): void => {
  if (result.ok) return;
  throw invalid(code, result.problems[0]?.message ?? fallback);
};

const stateName = (code: string): string => code === OVERSEAS_STATE_CODE ? OUTSIDE_INDIA : STATE_NAMES[code] ?? GST_STATE_CODES[code]?.name ?? code;

// ------------------------------------------------------------------------------ the transporters

export const transporters = (companyId: CompanyId | string): readonly Transporter[] =>
  masterData().transporters(mastersContext(companyId));

/**
 * Adds a transporter. The 15-character identifier is either their GST number or the transporter ID
 * the portal issues to a transporter who is not registered — the e-way bill takes the same field
 * either way, which is why one box holds both.
 */
export const createTransporter = (companyId: CompanyId | string, body: unknown) => {
  const input = (body ?? {}) as Record<string, unknown>;
  const name = str(input.name);
  if (name.length < 2) throw invalid('TRANSPORTER_NAME', 'Type the transporter’s name, as it should print on the bill.');
  const transporterId = normaliseIdentifier(str(input.transporterId));
  if (transporterId.length !== 15) {
    throw invalid('TRANSPORTER_ID', 'A transporter ID, or a transporter’s GST number, has 15 characters. Both go in this box.');
  }
  // A GST number is checkable; a transporter ID issued to an unregistered transporter is not, so
  // only the ones shaped like a GSTIN are put through the checksum.
  if (/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(transporterId)) {
    require_(validateGstin(transporterId), 'TRANSPORTER_GSTIN', 'That is not a GST number.');
  }
  const phone = str(input.phone);
  const created = masterData().createTransporter(
    mastersContext(companyId),
    { name, transporterId, ...(phone === '' ? {} : { phone }) },
    { idempotencyKey: `transporter:${String(companyId)}:${transporterId}` },
  );
  return {
    state: 'recorded' as const,
    title: 'Transporter added',
    message: `${created.record.name} is in your transporter list.`,
    transporter: { id: created.record.id, name: created.record.name, transporterId: created.record.transporterId },
  };
};

// -------------------------------------------------------------- another address of this customer

/** Adds a delivery address to a customer, so a godown they ship to is kept rather than retyped. */
export const addShippingAddress = (companyId: CompanyId | string, body: unknown) => {
  const input = (body ?? {}) as Record<string, unknown>;
  const customer = resolveCustomer(companyId, str(input.customerId ?? input.customer));
  const line1 = str(input.line1);
  if (line1 === '') throw invalid('SHIPPING_ADDRESS1', 'Type the first line of the delivery address.');
  const city = str(input.city);
  if (city === '') throw invalid('SHIPPING_CITY', 'Type the town or city the goods are going to.');
  const pincode = str(input.pincode);
  require_(validatePincode(pincode), 'SHIPPING_PINCODE', 'A PIN code has 6 digits.');
  const stateCode = str(input.stateCode);
  if (GST_STATE_CODES[stateCode] === undefined) {
    throw invalid('SHIPPING_STATE', 'Choose the state the goods are going to. It decides which state the sale counts in.');
  }
  // A customer's second address may hold its own GST number — one registration per state — but it
  // is not required, and a wrong one is worse than none.
  const gstin = normaliseIdentifier(str(input.gstin));
  if (gstin !== '') require_(validateGstin(gstin), 'SHIPPING_GSTIN', 'That is not a GST number.');

  const created = masterData().addAddress(
    mastersContext(companyId),
    {
      partyId: customer.id,
      label: str(input.label) || 'Delivery',
      line1,
      ...(str(input.line2) === '' ? {} : { line2: str(input.line2) }),
      city,
      stateCode,
      pincode,
      ...(gstin === '' ? {} : { gstin }),
      use: 'shipping',
      isPrimary: false,
    },
    { idempotencyKey: `shipping-address:${String(companyId)}:${customer.id}:${line1}:${pincode}` },
  );
  return {
    state: 'recorded' as const,
    title: 'Delivery address added',
    message: `Goods for ${customer.legalName} can now be sent to ${city}.`,
    address: describeAddress(created.record),
  };
};

export const describeAddress = (address: PartyAddress) => ({
  id: address.id,
  label: address.label,
  lines: [address.line1, ...(address.line2 === undefined || address.line2 === '' ? [] : [address.line2]), `${address.city} ${address.pincode}`],
  city: address.city,
  pincode: address.pincode,
  stateCode: address.stateCode,
  stateName: stateName(address.stateCode),
  gstin: address.gstin ?? null,
  use: address.use,
});

/** Every address of one customer, for the ship-to picker. */
export const shippingChoices = (companyId: CompanyId | string, partyId: string) =>
  addressesOf(companyId, partyId).map(describeAddress);

// ------------------------------------------------------------------- where the goods actually go

export type ShipToKind = 'same' | 'address' | 'party';

/** What the Sale screen said about delivery, once it has been checked. */
export interface DeliveryDetails {
  readonly shipTo: RenderableParty | null;
  readonly placeOfSupplyStateCode: string;
  /** One line for the screen: which state the sale counts in, and why that one. */
  readonly placeOfSupplyReason: string;
  readonly transport: RenderableTransport | null;
  readonly references: RenderableReferences | null;
  readonly poReference: string | null;
}

const EWAY_BILL_NUMBER = /^[0-9]{12}$/;

const MODE_OF_PAYMENT: Readonly<Record<string, string>> = {
  now: 'Cash / UPI on delivery',
  '7': 'Credit, 7 days',
  '30': 'Credit, 30 days',
};

/** The party block for a delivery address of the customer being billed. */
const partyFromAddress = (name: string, address: PartyAddress): RenderableParty =>
  shipToFromDelivery(
    {
      legalName: name,
      gstin: address.gstin ?? '',
      address1: address.line1,
      ...(address.line2 === undefined || address.line2 === '' ? {} : { address2: address.line2 }),
      place: address.city,
      pincode: address.pincode,
      stateCode: address.stateCode,
    },
    stateName(address.stateCode),
  );

/**
 * Reads the delivery and reference boxes, and decides the place of supply from where the goods go.
 *
 * Called on preview and again on issue with the same input, so what the screen showed and what the
 * bill is priced and frozen with are the same answer.
 */
export const deliveryDetails = (
  companyId: CompanyId | string,
  billedTo: { readonly id: string; readonly legalName: string },
  body: Record<string, unknown>,
): DeliveryDetails => {
  const billing = billingAddressOf(companyId, billedTo.id);
  if (billing === null) {
    throw invalid('CUSTOMER_ADDRESS_MISSING', `${billedTo.legalName} has no address saved, so there is nowhere to bill or deliver.`);
  }

  const kind = ((): ShipToKind => {
    const asked = str(body.shipTo).toLowerCase();
    return asked === 'address' || asked === 'party' ? asked : 'same';
  })();

  let shipTo: RenderableParty | null = null;
  let placeOfSupplyStateCode = billing.stateCode;
  let placeOfSupplyReason = `Place of supply: ${stateName(billing.stateCode)} (${billing.stateCode}) — the goods go to ${billedTo.legalName}'s billing address.`;

  if (kind === 'address') {
    const addressId = str(body.shipToAddressId);
    const address = addressesOf(companyId, billedTo.id).find((candidate) => candidate.id === addressId);
    if (address === undefined) {
      throw invalid('SHIP_TO_ADDRESS_NOT_FOUND', `That delivery address is not saved against ${billedTo.legalName}. Add it first.`);
    }
    shipTo = partyFromAddress(billedTo.legalName, address);
    // Section 10(1)(a) — the movement ends here, so the supply counts in this state.
    placeOfSupplyStateCode = address.stateCode;
    placeOfSupplyReason = `Place of supply: ${stateName(address.stateCode)} (${address.stateCode}) — the goods finish their journey at ${billedTo.legalName}'s ${address.city} address.`;
  }

  if (kind === 'party') {
    const consignee = resolveCustomer(companyId, str(body.shipToPartyId ?? body.shipToParty));
    const block = customerPrint(companyId, consignee.id);
    if (block.addressLines.length === 0) {
      throw invalid('SHIP_TO_PARTY_ADDRESS', `${block.name} has no address saved, so the bill cannot say where the goods went.`);
    }
    shipTo = block;
    // Section 10(1)(b) — goods handed to somebody else on the buyer's instructions are supplied
    // where the buyer is, not where the goods land. Taking the third party's state here would put
    // the wrong tax on the bill and the credit in the wrong state's hands.
    placeOfSupplyStateCode = billing.stateCode;
    const consigneeView = customerView(companyId, consignee.id);
    placeOfSupplyReason = `Place of supply: ${stateName(billing.stateCode)} (${billing.stateCode}) — the goods are delivered to ${block.name}${consigneeView.stateName === null ? '' : ` in ${consigneeView.stateName}`} on ${billedTo.legalName}'s instructions, so the sale counts where ${billedTo.legalName} is.`;
  }

  const transporterId = str(body.transporterId);
  const transporter = transporterId === ''
    ? null
    : transporters(companyId).find((candidate) => candidate.id === transporterId) ?? null;
  if (transporterId !== '' && transporter === null) {
    throw invalid('TRANSPORTER_NOT_FOUND', 'That transporter is not in your transporter list. Add them first.');
  }

  const vehicleTyped = str(body.vehicleNumber);
  let vehicleNumber: string | null = null;
  if (vehicleTyped !== '') {
    require_(validateVehicleNumber(vehicleTyped), 'VEHICLE_NUMBER', 'That does not look like an Indian vehicle number, for example KA01AB1234.');
    vehicleNumber = normaliseVehicleNumber(vehicleTyped);
  }

  const ewayTyped = normaliseIdentifier(str(body.ewayBillNumber));
  if (ewayTyped !== '' && !EWAY_BILL_NUMBER.test(ewayTyped)) {
    throw invalid('EWAY_BILL_NUMBER', `An e-way bill number is exactly 12 digits. "${ewayTyped}" has ${ewayTyped.length}.`);
  }

  const lrNumber = str(body.lrNumber);
  const lrDate = str(body.lrDate);
  // The destination is suggested from where the goods are going, and the person may change it.
  const destination = str(body.destination) || (shipTo === null ? billing.city : shipTo.addressLines[shipTo.addressLines.length - 1]?.replace(/\s+\d{6}$/, '') ?? billing.city);

  const transport: RenderableTransport | null =
    transporter === null && vehicleNumber === null && ewayTyped === '' && lrNumber === '' && str(body.destination) === ''
      ? null
      : {
        transporter: transporter?.name ?? null,
        vehicleNumber,
        eWayBillNumber: ewayTyped === '' ? null : ewayTyped,
        lrNumber: lrNumber === '' ? null : lrNumber,
        // The transporter's docket is the same piece of paper the bill's "Transport doc" box
        // refers to, so the box reads as a number and a date rather than a bare date.
        documentNumber: lrNumber === '' ? null : lrNumber,
        documentDate: lrDate === '' ? null : isoDate(lrDate),
        destination,
      };

  const poReference = str(body.buyerOrderNumber) || null;
  const paymentTerms = str(body.paymentTerms) || MODE_OF_PAYMENT[str(body.terms)] || null;
  const referenceNumber = str(body.referenceNumber) || null;
  const referenceDate = str(body.referenceDate);
  const otherReferences = str(body.otherReferences) || null;
  const termsOfDelivery = str(body.termsOfDelivery) || null;

  const references: RenderableReferences | null =
    referenceNumber === null && otherReferences === null && termsOfDelivery === null && paymentTerms === null
      ? null
      : {
        referenceNumber,
        referenceDate: referenceDate === '' ? null : isoDate(referenceDate),
        otherReferences,
        termsOfDelivery,
        paymentTerms,
      };

  return { shipTo, placeOfSupplyStateCode, placeOfSupplyReason, transport, references, poReference };
};

/**
 * The e-way bill number as it stands now, for a bill already issued.
 *
 * It arrives after the bill is frozen — somebody raises the e-way bill once the lorry is loaded —
 * and is layered on at print time exactly as the government's IRN is. The frozen document is never
 * edited: a reprint simply carries the fact that exists by then.
 */
export const printableEwayNumber = (
  records: readonly { readonly movementId: string; readonly status: string; readonly acknowledgement?: { readonly ewayBillNumber: string } }[],
  invoiceId: string,
): string | null => {
  const live = records.filter((record) => record.movementId === invoiceId && record.acknowledgement !== undefined
    && record.status !== 'CANCELLED' && record.status !== 'REJECTED' && record.status !== 'FAILED');
  return live[live.length - 1]?.acknowledgement?.ewayBillNumber ?? null;
};
