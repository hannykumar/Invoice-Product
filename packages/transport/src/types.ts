// Issue #27 [E27] — what an e-way bill is, and when a lorry actually needs one.
//
// An e-way bill is a permit for *moving goods*. It is not a tax document and it is not an
// e-invoice: an invoice can be perfectly valid with no e-way bill against it, and an e-way bill
// can exist for a movement that carries no invoice at all (goods going out for job work, stock
// moving between your own godowns).
//
// The assumption this module exists to kill is "anything over ₹1 lakh in a day needs one". That
// is somebody's uncle's rule of thumb and it is wrong in both directions:
//
//   - The general limit is ₹50,000 for one consignment, not ₹1 lakh, and not per day.
//   - Inside a single state each state sets its own limit, and several of them are ₹1 lakh — but
//     that is *that state's* rule, on *that state's* effective date, not a national one.
//   - Some movements need an e-way bill at any value at all (goods sent inter-state for job work),
//     and some need none however large (a consignment of jewellery, goods on a hand cart).
//
// So every answer here is a decision carrying the facts it applied, the rule that decided it, and
// the notification behind that rule. Where a fact is missing the answer is `CANNOT_DECIDE` and the
// movement goes to a person, never to a guess.

import type { Id, IsoDate, Paise } from "../../masters/src/types.ts";

// ------------------------------------------------------------------ the movement being judged

/**
 * Why the goods are moving. The government calls this the "sub-supply type" and it matters,
 * because two of these need an e-way bill whatever the consignment is worth.
 */
export type MovementReason =
  /** An ordinary sale. */
  | "SUPPLY"
  | "EXPORT"
  | "IMPORT"
  /** Sent to somebody else to work on and send back. Inter-state, this needs a bill at any value. */
  | "JOB_WORK"
  /** Your own goods moving between your own places. Still a movement, still needs a bill. */
  | "BRANCH_TRANSFER"
  | "SALES_RETURN"
  /** Machinery or exhibits going out and coming back. */
  | "EXHIBITION_OR_FAIRS"
  | "FOR_OWN_USE"
  /** Sent knocked down, in more than one vehicle. */
  | "SKD_CKD"
  /** Sent out on a van to be sold on the way, buyer not known when it leaves. */
  | "LINE_SALES"
  | "OTHERS";

/** How the goods travel. Non-motorised is here because it is exempt outright. */
export type TransportMode = "ROAD" | "RAIL" | "AIR" | "SHIP" | "NON_MOTORISED";

/** The government accepts these two, and they give very different validity per day. */
export type VehicleType = "REGULAR" | "ODC";

/** Who is actually driving. A consignor's own lorry still needs Part B filled in. */
export type ConveyanceOwner = "OWN_VEHICLE" | "HIRED_VEHICLE" | "TRANSPORTER";

/**
 * One thing on the lorry, with the facts the rules read.
 *
 * `exemptFromEwayBill` is stated on the item, not guessed from its name or its GST rate: a rate of
 * zero does not make goods e-way-bill-exempt, and inventing that link would be exactly the sort of
 * quiet guess the brief forbids.
 */
export interface ConsignmentLine {
  readonly description: string;
  readonly hsnCode: string;
  readonly quantity: string;
  readonly unit: string;
  /** Value before tax, in paise. */
  readonly taxableValuePaise: Paise;
  readonly cgstPaise: Paise;
  readonly sgstPaise: Paise;
  readonly igstPaise: Paise;
  readonly cessPaise: Paise;
  /** True when this line is an exempt or nil-rated supply. Excluded from consignment value. */
  readonly isExemptSupply?: boolean;
  /** Set when the goods are on the annexure to Rule 138(14) — no e-way bill at any value. */
  readonly exemptFromEwayBill?: boolean;
}

/** One invoice, delivery challan or bill of supply travelling in this consignment. */
export interface ConsignmentDocument {
  readonly documentId: Id;
  readonly documentType: "TAX_INVOICE" | "BILL_OF_SUPPLY" | "DELIVERY_CHALLAN" | "CREDIT_NOTE" | "BILL_OF_ENTRY";
  readonly documentNumber: string;
  readonly documentDate: IsoDate;
  readonly lines: readonly ConsignmentLine[];
}

/**
 * A party as the e-way bill needs it.
 *
 * `gstin` may be the literal "URP" — unregistered person — which is what the portal expects when
 * goods go to somebody with no GST number. It is not a missing value, and it must not be treated
 * as one.
 */
export interface MovementParty {
  readonly legalName: string;
  readonly gstin: string;
  readonly address1: string;
  readonly address2?: string;
  readonly place: string;
  readonly pincode: string;
  /** GST state code, "29" for Karnataka. */
  readonly stateCode: string;
}

/**
 * Everything known about one movement of goods.
 *
 * Bill-to and ship-to are separate on purpose. When a Mumbai buyer asks for the goods to be
 * delivered to their customer in Hyderabad, the *movement* is Bengaluru → Hyderabad while the
 * *bill* is Bengaluru → Mumbai, and the two decide different things: the movement decides which
 * state's rules apply, and the bill decides the tax. Collapsing them is a common and expensive
 * mistake.
 */
export interface Movement {
  readonly movementId: Id;
  readonly reason: MovementReason;
  /** Who is sending. */
  readonly consignor: MovementParty;
  /** Who is being billed. */
  readonly billTo: MovementParty;
  /** Where the goods physically go, when that is not the buyer's own address. */
  readonly shipTo?: MovementParty;
  /** Where the goods physically start, when that is not the consignor's own address. */
  readonly dispatchFrom?: MovementParty;
  readonly documents: readonly ConsignmentDocument[];
  readonly transportMode: TransportMode;
  readonly vehicleType: VehicleType;
  readonly conveyance: ConveyanceOwner;
  /** Road distance in kilometres. Decides how long the bill is valid for. */
  readonly approximateDistanceKm?: number;
  /** Set when the goods are moving under a customs bond or between customs stations. */
  readonly underCustomsBond?: boolean;
  /**
   * Set for the leg between a port, airport or land customs station and an inland container
   * depot for customs clearance, which Rule 138(14)(g) exempts.
   */
  readonly customsClearanceLeg?: boolean;
  /** Handicraft goods moved by a person exempt from registration: a bill at any value. */
  readonly handicraftsByExemptPerson?: boolean;
  /**
   * Whether both ends are inside the same city or town.
   *
   * Only some states ask this — Gujarat exempts movement within one city at any value — so it is
   * optional, and where a state's rule turns on it and we have not been told, the answer is a
   * question rather than a guess.
   */
  readonly withinSameCity?: boolean;
  readonly transporter?: TransporterAssignment;
  readonly vehicle?: VehicleAssignment;
}

export interface TransporterAssignment {
  readonly name: string;
  /** GSTIN, or the 15-character transporter ID given to unregistered transporters. */
  readonly transporterId: string;
  readonly documentNumber?: string;
  readonly documentDate?: IsoDate;
}

export interface VehicleAssignment {
  /** "KA01AB1234". Checked against the portal's format before anything is sent. */
  readonly registrationNumber: string;
  readonly vehicleType: VehicleType;
  /** Where the vehicle is picking up or changing over, for the audit trail on Part B. */
  readonly fromPlace: string;
  readonly fromStateCode: string;
  /** Why the vehicle changed, when this is not the first one. */
  readonly reason?: VehicleChangeReason;
  readonly reasonNote?: string;
}

/** The government's list. A vehicle change must say which of these it was. */
export type VehicleChangeReason = "FIRST_TIME" | "BREAKDOWN" | "TRANSSHIPMENT" | "OTHERS";

// ------------------------------------------------------------------ the applicability decision

export type EwayApplicabilityOutcome =
  /** The lorry may not leave without an e-way bill. */
  | "REQUIRED"
  /** No e-way bill is needed for this movement. */
  | "NOT_REQUIRED"
  /** A fact we were not given decides it. Goes to a person, not to a default. */
  | "CANNOT_DECIDE";

/**
 * One fact the decision actually used, in plain words.
 *
 * The first acceptance criterion of the issue is that every decision lists the facts it applied
 * and where the rule came from. This is that list, and it is built as the rules run rather than
 * written afterwards, so it cannot drift from what really decided the answer.
 */
export interface AppliedFact {
  readonly label: string;
  readonly value: string;
}

export interface EwayApplicabilityDecision {
  readonly outcome: EwayApplicabilityOutcome;
  /** Written for a shopkeeper: what was decided and why. */
  readonly reason: string;
  readonly ruleId: string;
  readonly ruleSetVersion: string;
  /** The rule, notification or state order behind it. */
  readonly sourceRef?: string;
  /** The date the rule applied from, so an old movement is judged by its own day's rules. */
  readonly effectiveFrom?: IsoDate;
  readonly appliedFacts: readonly AppliedFact[];
  /** Only on `CANNOT_DECIDE`. */
  readonly missingFacts?: readonly string[];
  /** The money limit that was compared against, when value was the deciding fact. */
  readonly thresholdApplied?: ValueThreshold;
  /** The consignment value the rules computed, so the arithmetic can be checked. */
  readonly consignmentValuePaise?: Paise;
}

/** One money limit, whose state it belongs to, and the order that set it. */
export interface ValueThreshold {
  /** "IN" for the national inter-state limit, or a GST state code such as "27". */
  readonly scope: string;
  readonly thresholdPaise: Paise;
  readonly effectiveFrom: IsoDate;
  readonly sourceRef: string;
  readonly ruleId: string;
  /** Plain words about anything unusual in this state's order. */
  readonly note?: string;
}

// ------------------------------------------------------------------------ the e-way bill record

/**
 * Where a movement stands with the portal.
 *
 * `PART_A_ONLY` is a real state and not a half-finished one: a consignor may fill Part A and hand
 * the number to a transporter who fills in the vehicle later. Goods must not move on it, and the
 * screens say so.
 */
export type EwayBillStatus =
  | "NOT_REQUIRED"
  | "PENDING"
  /** Part A accepted, no vehicle yet. The goods may not move on this. */
  | "PART_A_ONLY"
  /** Part B filled, validity running. This is the one the lorry travels on. */
  | "ACTIVE"
  | "EXPIRED"
  | "CANCELLED"
  /** The other party said this movement is not theirs. */
  | "REJECTED"
  | "FAILED";

/** What the portal sent back for a generated bill. Kept exactly as received. */
export interface EwayBillAcknowledgement {
  /** The 12-digit e-way bill number. */
  readonly ewayBillNumber: string;
  /** The portal's own timestamp, "DD/MM/YYYY HH:mm:ss". */
  readonly generatedAt: string;
  /** Absent until Part B is filled: validity does not start before the vehicle is known. */
  readonly validUntil?: string;
  readonly providerRequestId: string;
  readonly receivedAt: string;
  /** Only set when the portal returned an alert alongside a successful generation. */
  readonly alert?: string;
}

/** The government's four cancellation reasons. */
export type EwayCancelReasonCode = "DUPLICATE" | "ORDER_CANCELLED" | "DATA_ENTRY_MISTAKE" | "OTHERS";

/** Why the other party rejected the movement. */
export type EwayRejectReasonCode = "NOT_MY_CONSIGNMENT" | "DATA_ENTRY_MISTAKE" | "OTHERS";

export interface EwayVehicleLeg {
  readonly registrationNumber: string;
  readonly vehicleType: VehicleType;
  readonly fromPlace: string;
  readonly fromStateCode: string;
  readonly mode: TransportMode;
  readonly reason: VehicleChangeReason;
  readonly reasonNote?: string;
  readonly recordedAt: string;
  readonly recordedBy: Id;
}

export interface EwayBillRecord {
  readonly id: Id;
  readonly companyId: Id;
  /** The movement this permits. One live e-way bill per movement, ever. */
  readonly movementId: Id;
  /** The main document number on the lorry, for people to recognise it by. */
  readonly documentNumber: string;
  readonly documentDate: IsoDate;
  readonly status: EwayBillStatus;
  readonly applicability: EwayApplicabilityDecision;
  readonly consignmentValuePaise: Paise;
  readonly fromStateCode: string;
  readonly toStateCode: string;
  readonly distanceKm?: number;
  readonly acknowledgement?: EwayBillAcknowledgement;
  /** Every vehicle this consignment has travelled on, oldest first. */
  readonly vehicleLegs: readonly EwayVehicleLeg[];
  readonly transporter?: TransporterAssignment;
  /** The consolidated bill this one is travelling under, when it is. */
  readonly consolidatedTripNumber?: string;
  /** Plain words about the last thing that happened. */
  readonly message: string;
  readonly failure?: { readonly code: string; readonly message: string; readonly retryable: boolean };
  /** The last moment the portal will still accept a cancellation. */
  readonly cancellableUntil?: string;
  readonly cancelledAt?: string;
  readonly cancelReasonCode?: EwayCancelReasonCode;
  readonly cancelReason?: string;
  readonly rejectedAt?: string;
  readonly rejectReasonCode?: EwayRejectReasonCode;
  readonly createdBy: Id;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly idempotencyKey: string;
}

/** A consolidated e-way bill: many consignments, one lorry, one trip sheet. */
export interface ConsolidatedTripRecord {
  readonly id: Id;
  readonly companyId: Id;
  readonly tripNumber: string;
  readonly vehicleNumber: string;
  readonly fromPlace: string;
  readonly fromStateCode: string;
  readonly transportMode: TransportMode;
  readonly ewayBillNumbers: readonly string[];
  readonly createdBy: Id;
  readonly createdAt: string;
  readonly message: string;
}

/**
 * Per company and effective-dated, as every other policy in this product is held.
 *
 * None of these numbers is invented here: they are the portal's own, kept in one place so a change
 * in a circular is a data change rather than a code change.
 */
export interface EwayBillPolicy {
  /** Hours after generation during which the portal still accepts a cancellation. */
  readonly cancellationWindowHours: number;
  /** Hours the other party has to reject a bill raised against them. */
  readonly rejectionWindowHours: number;
  /** Kilometres of ordinary cargo covered by one day of validity. */
  readonly kilometresPerDayRegular: number;
  /** Kilometres of over-dimensional cargo covered by one day of validity. */
  readonly kilometresPerDayOdc: number;
  /** Hours either side of expiry during which validity may still be extended. */
  readonly extensionWindowHours: number;
  readonly effectiveFrom: IsoDate;
}

export const DEFAULT_EWAY_BILL_POLICY: EwayBillPolicy = Object.freeze({
  cancellationWindowHours: 24,
  rejectionWindowHours: 72,
  kilometresPerDayRegular: 200,
  kilometresPerDayOdc: 20,
  extensionWindowHours: 8,
  effectiveFrom: "2026-04-01",
});
