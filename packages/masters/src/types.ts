// Master-data records for issue #5.
//
// Money is always paise as bigint. Quantities are micro-units as bigint (see units.ts).
// Percentages are basis points (1825 = 18.25%) so no rate is ever a float.
// Every record that a transaction can reference is versioned and effective-dated, and
// transactions keep a snapshot of the version they used (see snapshots.ts).

import type { Quantity } from "./units.ts";

export type Id = string;
/** ISO date, YYYY-MM-DD. Master changes take effect on a date, not an instant. */
export type IsoDate = string;
export type Paise = bigint;
/** 1825 means 18.25 percent. */
export type BasisPoints = number;

export type MasterKind =
  | "party"
  | "party_address"
  | "item"
  | "warehouse"
  | "batch"
  | "serial"
  | "price_list"
  | "tax_default"
  | "transporter"
  | "vehicle"
  | "bank_account";

export type PartyRole = "customer" | "supplier" | "both";

/**
 * How the party is registered under GST. This drives place-of-supply, reverse charge
 * and e-invoice decisions downstream, so it is stored explicitly rather than inferred
 * from whether a GSTIN happens to be present.
 */
export type GstRegistrationType = "regular" | "composition" | "unregistered" | "sez_with_payment" | "sez_without_payment" | "overseas" | "deemed_export" | "uin";

export interface Party {
  readonly id: Id;
  readonly companyId: Id;
  /** Short code the user types or speaks. Unique within a company when present. */
  readonly code?: string;
  readonly legalName: string;
  /** The name on the signboard, often different from the legal name. */
  readonly tradeName?: string;
  readonly role: PartyRole;
  readonly gstRegistrationType: GstRegistrationType;
  readonly pan?: string;
  readonly phones: readonly string[];
  readonly emails: readonly string[];
  /** Other spellings a user has confirmed refer to this party. */
  readonly aliases: readonly string[];
  readonly creditLimitPaise?: Paise;
  readonly creditDays?: number;
  readonly defaultPriceListId?: Id;
  readonly defaultAddressId?: Id;
  readonly notes?: string;
  readonly active: boolean;
  /** Set when this record was merged into another; reads follow the pointer. */
  readonly mergedIntoId?: Id;
}

export type AddressUse = "billing" | "shipping" | "both";

export interface PartyAddress {
  readonly id: Id;
  readonly companyId: Id;
  readonly partyId: Id;
  readonly label: string;
  readonly line1: string;
  readonly line2?: string;
  readonly city: string;
  readonly district?: string;
  /** GST state code, e.g. "29" for Karnataka. Place of supply is derived from this. */
  readonly stateCode: string;
  readonly pincode: string;
  /** A party may hold one GSTIN per state; the address carries the one it belongs to. */
  readonly gstin?: string;
  readonly use: AddressUse;
  readonly isPrimary: boolean;
  readonly active: boolean;
}

export type ItemKind = "goods" | "service";

export interface Item {
  readonly id: Id;
  readonly companyId: Id;
  readonly code?: string;
  readonly name: string;
  readonly kind: ItemKind;
  readonly hsnSac: string;
  /** The unit stock is held in. Sales and purchases may use any convertible unit. */
  readonly baseUnit: string;
  readonly aliases: readonly string[];
  readonly barcodes: readonly string[];
  readonly trackBatches: boolean;
  readonly trackSerials: boolean;
  readonly shelfLifeDays?: number;
  readonly reorderLevel?: Quantity;
  readonly active: boolean;
  readonly mergedIntoId?: Id;
}

export interface Warehouse {
  readonly id: Id;
  readonly companyId: Id;
  readonly code: string;
  readonly name: string;
  readonly addressLine: string;
  readonly city: string;
  readonly stateCode: string;
  readonly pincode: string;
  /** The company GSTIN this location files under, when the company holds several. */
  readonly gstin?: string;
  readonly active: boolean;
}

export interface Batch {
  readonly id: Id;
  readonly companyId: Id;
  readonly itemId: Id;
  readonly batchNumber: string;
  readonly manufacturedOn?: IsoDate;
  readonly expiresOn?: IsoDate;
  readonly mrpPaise?: Paise;
  readonly active: boolean;
}

export interface SerialNumber {
  readonly id: Id;
  readonly companyId: Id;
  readonly itemId: Id;
  readonly serial: string;
  readonly batchId?: Id;
  readonly status: "in_stock" | "sold" | "returned" | "scrapped";
}

/** Opening balances are master data: they seed stock without being a purchase. */
export interface OpeningStock {
  readonly id: Id;
  readonly companyId: Id;
  readonly itemId: Id;
  readonly warehouseId: Id;
  readonly batchId?: Id;
  readonly asOn: IsoDate;
  readonly quantity: Quantity;
  /** Total value of the opening quantity, used for valuation by the accounting module. */
  readonly valuePaise: Paise;
}

export interface PriceList {
  readonly id: Id;
  readonly companyId: Id;
  readonly name: string;
  /** True when the listed rate already contains GST, common in retail price lists. */
  readonly ratesIncludeTax: boolean;
  readonly active: boolean;
}

export interface PriceListEntry {
  readonly id: Id;
  readonly companyId: Id;
  readonly priceListId: Id;
  readonly itemId: Id;
  readonly unit: string;
  readonly ratePaise: Paise;
  /** Slab pricing: this rate applies from this quantity upwards. */
  readonly minimumQuantity?: Quantity;
}

/**
 * The GST rate a transaction should default to for an item or an HSN code. This is a
 * default, not a ruling: it carries the notification it came from and an effective
 * date so a document raised last year keeps last year's rate.
 */
export interface TaxDefault {
  readonly id: Id;
  readonly companyId: Id;
  /** Exactly one of these is set. Item defaults win over HSN defaults. */
  readonly itemId?: Id;
  readonly hsnSac?: string;
  readonly gstRateBasisPoints: BasisPoints;
  readonly cessRateBasisPoints?: BasisPoints;
  readonly cessPerUnitPaise?: Paise;
  readonly reverseCharge: boolean;
  /** Citation for the rate, e.g. "Notification 1/2017-Central Tax (Rate), Schedule III". */
  readonly source: string;
}

export interface Transporter {
  readonly id: Id;
  readonly companyId: Id;
  readonly name: string;
  /** GSTIN, or the 15-character transporter ID issued to unregistered transporters. */
  readonly transporterId: string;
  readonly phone?: string;
  readonly active: boolean;
}

export type VehicleBodyType = "open" | "closed" | "tanker" | "trailer" | "container" | "refrigerated" | "two_wheeler" | "three_wheeler" | "other";

export interface Vehicle {
  readonly id: Id;
  readonly companyId: Id;
  readonly registrationNumber: string;
  /** "regular" or "over dimensional cargo", the two values the e-way bill accepts. */
  readonly vehicleType: "regular" | "odc";
  readonly bodyType: VehicleBodyType;
  /** Declared laden capacity. Issue #28 uses it for plausibility, never as proof. */
  readonly ratedCapacityKg?: number;
  readonly transporterId?: Id;
  readonly active: boolean;
}

export interface BankAccount {
  readonly id: Id;
  readonly companyId: Id;
  /** Company accounts fund payments; party accounts are payee details for suppliers. */
  readonly ownerType: "company" | "party";
  readonly partyId?: Id;
  readonly accountName: string;
  readonly accountNumber: string;
  readonly ifsc: string;
  readonly bankName: string;
  readonly branchName?: string;
  readonly accountType: "current" | "savings" | "cash_credit" | "overdraft";
  readonly active: boolean;
}

/** Union of every master record body the store can hold. */
export type MasterRecord =
  | Party | PartyAddress | Item | Warehouse | Batch | SerialNumber
  | OpeningStock | PriceList | PriceListEntry | TaxDefault | Transporter | Vehicle | BankAccount;
