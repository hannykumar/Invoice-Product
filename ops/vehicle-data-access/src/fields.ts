/**
 * Issue #53 [X05] — the field list on the application, and the far longer list we are not asking for.
 *
 * The registering authority's record holds a great deal about a lorry and about the person who owns
 * it. A dispatch desk needs to know what the vehicle is and what it may lawfully carry today. It
 * does not need a chassis number, an engine number, an owner's address or a father's name, and
 * asking for them would be a privacy failure whether or not anybody ever read them.
 *
 * The requested list is not written here. It is #29's `PERMITTED_VEHICLE_FIELDS` — the allow-list
 * the code already applies at the boundary before anything reaches storage — and the tests fail if
 * this file and that one disagree. That is deliberate: an application that asks for one set of
 * fields while the software reads another is either taking data without permission or holding
 * permission it does not use, and both are things an authority is entitled to be told about.
 */
import {
  PERMITTED_VEHICLE_FIELDS,
  PERMITTED_VEHICLE_FIELD_NAMES,
} from '../../../packages/transport/src/vehicle-record-types.ts';
import type { PermittedVehicleField } from '../../../packages/transport/src/vehicle-record-types.ts';
import type { DeclinedField, FieldRequest } from './model.ts';

/**
 * Why each field is on the application.
 *
 * `decidesRules` names the checks in #28 that read the field. The necessity review does not take
 * these on trust; it reads the rule source and compares. A field whose rules are listed here but
 * which the source no longer reads is a field we should stop asking for, and the review says so.
 */
const REASONS: Readonly<Record<PermittedVehicleField, Omit<FieldRequest, 'field' | 'plainName'>>> = Object.freeze({
  /**
   * The number we send, not a fact we are given.
   *
   * It is on the application because the authority is entitled to know what we transmit, but no
   * suitability rule reads it off a record — the rules check the number the movement was entered
   * with, which is a different thing and comes from the business, not from the authority.
   */
  registrationNumber: {
    isRequestKey: true,
    why: 'It is the question. Without the number there is nothing to ask about, and it is the only field that travels to the authority rather than coming back from it.',
    decidesRules: [],
    personalData: false,
    storedAs: 'AS_GIVEN',
    humanUseOnly: null,
  },
  vehicleClass: {
    isRequestKey: false,
    why: 'Whether the vehicle is built to carry goods at all. This is what stops five tonnes of steel being booked out on a scooter, and no other field can answer it.',
    decidesRules: ['VEHICLE.CLASS.NOT_GOODS_CARRYING', 'VEHICLE.CLASS.OVER_CEILING'],
    personalData: false,
    storedAs: 'AS_GIVEN',
    humanUseOnly: null,
  },
  bodyType: {
    isRequestKey: false,
    why: 'Whether the body suits the goods: a refrigerated load on an open truck, or bulk liquid on a flatbed, is a consignment that never arrives in a saleable state.',
    decidesRules: ['VEHICLE.BODY.NOT_REFRIGERATED', 'VEHICLE.BODY.NOT_TANKER', 'VEHICLE.BODY.HAZARDOUS'],
    personalData: false,
    storedAs: 'AS_GIVEN',
    humanUseOnly: null,
  },
  grossVehicleWeightKg: {
    isRequestKey: false,
    why: 'Half of the payload arithmetic. Where the record does not state a payload directly, gross weight less unladen weight is the registration certificate’s own way of arriving at one.',
    decidesRules: ['VEHICLE.CAPACITY.EXCEEDED', 'VEHICLE.CAPACITY.NEAR_LIMIT'],
    personalData: false,
    storedAs: 'AS_GIVEN',
    humanUseOnly: null,
  },
  unladenWeightKg: {
    isRequestKey: false,
    why: 'The other half of the same arithmetic, and useless on its own.',
    decidesRules: ['VEHICLE.CAPACITY.EXCEEDED', 'VEHICLE.CAPACITY.NEAR_LIMIT'],
    personalData: false,
    storedAs: 'AS_GIVEN',
    humanUseOnly: null,
  },
  ratedPayloadKg: {
    isRequestKey: false,
    why: 'What the vehicle may carry, where the record states it outright. Preferred over the subtraction because it is the authority’s own figure rather than ours.',
    decidesRules: ['VEHICLE.CAPACITY.EXCEEDED', 'VEHICLE.CAPACITY.NEAR_LIMIT'],
    personalData: false,
    storedAs: 'AS_GIVEN',
    humanUseOnly: null,
  },
  permitType: {
    isRequestKey: false,
    why: 'A state permit does not let a lorry cross a border. It is the fact that most often stops a movement at a check post, and it cannot be inferred from anything else on the record.',
    decidesRules: ['VEHICLE.PERMIT.WRONG_KIND', 'VEHICLE.PERMIT.EXPIRED'],
    personalData: false,
    storedAs: 'AS_GIVEN',
    humanUseOnly: null,
  },
  permitValidUpto: {
    isRequestKey: false,
    why: 'A permit that ran out last month is not a permit. The date is what makes the permit field mean anything on the day of the movement.',
    decidesRules: ['VEHICLE.PERMIT.EXPIRED'],
    personalData: false,
    storedAs: 'AS_GIVEN',
    humanUseOnly: null,
  },
  fitnessValidUpto: {
    isRequestKey: false,
    why: 'A goods vehicle without a current fitness certificate is not road-legal, and the consignor is the one whose goods are detained.',
    decidesRules: ['VEHICLE.FITNESS.EXPIRED'],
    personalData: false,
    storedAs: 'AS_GIVEN',
    humanUseOnly: null,
  },
  insuranceValidUpto: {
    isRequestKey: false,
    why: 'An uninsured lorry carrying somebody else’s goods is a loss nobody has provided for.',
    decidesRules: ['VEHICLE.INSURANCE.EXPIRED'],
    personalData: false,
    storedAs: 'AS_GIVEN',
    humanUseOnly: null,
  },
  registrationStatus: {
    isRequestKey: false,
    why: 'A vehicle the authority records as scrapped or cancelled is on record and not allowed on the road. Treating that as "no problem found" is the worst answer this product could give.',
    decidesRules: ['VEHICLE.REGISTRATION.NOT_ACTIVE'],
    personalData: false,
    storedAs: 'AS_GIVEN',
    humanUseOnly: null,
  },
  /**
   * The one field on the application that names a person, and the one no rule reads.
   *
   * It is here because a gate check is a real thing that happens: a lorry arrives, the paperwork
   * says one transporter, and somebody has to be able to tell whether the vehicle belongs to them.
   * For that job "S******** T******" is exactly as useful as the full name and far less to lose, so
   * that is all that is ever stored. If the authority declines this field, nothing in the product
   * stops working — which is the honest thing to say on the application, and it is said.
   */
  registeredOwnerName: {
    isRequestKey: false,
    why: 'A person at the loading bay checks that the lorry in front of them belongs to the transporter who was booked. Stored as initials only, because initials answer that question and a full name is only a liability.',
    decidesRules: [],
    personalData: true,
    storedAs: 'MASKED',
    humanUseOnly: 'Shown, masked, on the vehicle check screen so a dispatch clerk can compare it with the transporter’s own paperwork. No rule reads it, no decision turns on it, and refusing it costs the product nothing.',
  },
});

/** The application's field list, derived from the allow-list the code actually enforces. */
export const REQUESTED_FIELDS: readonly FieldRequest[] = Object.freeze(
  PERMITTED_VEHICLE_FIELDS.map((field) => ({
    field,
    plainName: PERMITTED_VEHICLE_FIELD_NAMES[field],
    ...REASONS[field],
  })),
);

export const requestedFieldNames = (): readonly string[] => REQUESTED_FIELDS.map((request) => request.field);

/** Fields on the application that say something about a person. Exactly one, and it is masked. */
export const personalDataFields = (): readonly FieldRequest[] =>
  REQUESTED_FIELDS.filter((request) => request.personalData);

/**
 * What the authority holds and we are not asking for, with the provider's own key for each.
 *
 * The keys matter: the tests look for them in a real provider response and fail if any of them
 * survives as far as storage. A provider that adds a field to its payload tomorrow cannot quietly
 * widen what this product holds, because the boundary in #29 keeps only what is on the allow-list.
 */
export const DECLINED_FIELDS: readonly DeclinedField[] = Object.freeze([
  {
    providerKey: 'rc_chasi_no',
    describedAs: 'the chassis number',
    why: 'It identifies the vehicle uniquely across every database in the country. Nothing in a suitability check needs a second identifier when we already have the registration number.',
  },
  {
    providerKey: 'rc_eng_no',
    describedAs: 'the engine number',
    why: 'Same reason as the chassis number, and it is the pair of them together that makes a stolen copy of a database worth something.',
  },
  {
    providerKey: 'rc_present_address',
    describedAs: 'the owner’s current address',
    why: 'A home address. No check about whether a lorry can carry a load has ever needed one.',
  },
  {
    providerKey: 'rc_permanent_address',
    describedAs: 'the owner’s permanent address',
    why: 'A home address, and often a different one from the current address, which makes holding both worse rather than more complete.',
  },
  {
    providerKey: 'rc_f_name',
    describedAs: 'the owner’s father’s name',
    why: 'An identity-verification field. This product is not verifying anybody’s identity.',
  },
  {
    providerKey: 'rc_mobile_no',
    describedAs: 'the owner’s mobile number',
    why: 'We contact transporters through the details the business itself holds, not through the registering authority.',
  },
  {
    providerKey: 'rc_owner_dob',
    describedAs: 'the owner’s date of birth',
    why: 'Nothing about a consignment turns on how old anybody is.',
  },
  {
    providerKey: 'rc_financer',
    describedAs: 'the financier the vehicle is hypothecated to',
    why: 'A commercial fact about the owner’s borrowing. It is not ours to hold, and no rule reads it.',
  },
  {
    providerKey: 'rc_maker_model',
    describedAs: 'the make and model',
    why: 'Interesting and useless: the class, the body and the registered weights already answer everything the rules ask.',
  },
  {
    providerKey: 'rc_colour',
    describedAs: 'the colour',
    why: 'It would be tempting for the number-plate photograph check. It is not necessary for it, and a colour is one more thing to be wrong about at dusk.',
  },
  {
    providerKey: 'rc_fuel_desc',
    describedAs: 'the fuel type',
    why: 'No suitability rule depends on it.',
  },
  {
    providerKey: 'rc_pucc_upto',
    describedAs: 'the pollution certificate expiry',
    why: 'A real obligation, and the transporter’s rather than the consignor’s. We do not block a movement on it, so we do not ask for it.',
  },
  {
    providerKey: 'rc_blacklist_status',
    describedAs: 'blacklisting and enforcement flags',
    why: 'Enforcement history is about the owner’s conduct. The registration status field already tells us whether the vehicle may be on the road, which is the only part that concerns a consignment.',
  },
]);

export const declinedFieldKeys = (): readonly string[] => DECLINED_FIELDS.map((field) => field.providerKey);
