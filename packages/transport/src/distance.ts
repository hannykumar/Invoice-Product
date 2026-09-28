// Issue #240 — the road distance on an e-way bill, worked out from the two PIN codes.
//
// The portal keeps its own table of road distances between PIN codes. Sent a distance of 0, it
// looks the two PIN codes up and uses its own figure; sent a typed distance, it accepts it only up
// to 10% more than its own figure. So this product never invents a distance:
//
//   1. By default it sends 0 and lets the portal work the distance out.
//   2. It remembers what the portal said for a pair of PIN codes (the portal's reply carries it),
//      so the next bill between the same two places can say in advance how long it will last.
//   3. A typed distance is checked against that remembered figure before anything is sent, and
//      refused above 10% more, in words, because the portal would refuse it anyway.
//   4. Where the two PIN codes have never been sent before, nothing is guessed: validity is shown
//      once the portal has answered.

/** The portal accepts a typed distance up to this much more than its own PIN-to-PIN figure. */
export const TYPED_DISTANCE_ALLOWANCE_PERCENT = 10;

/**
 * Both ends in one PIN code: the portal cannot work a distance out, so it must be typed, at least
 * 1 km and at most this many.
 */
export const SAME_PIN_MAX_KM = 100;

/**
 * The longest distance the portal will accept for a pair of PIN codes it knows as `knownKm` apart.
 * Whole kilometres, rounded down, so what we allow is never more than the portal allows.
 */
export const longestAllowedDistance = (knownKm: number): number =>
  Math.floor((knownKm * (100 + TYPED_DISTANCE_ALLOWANCE_PERCENT)) / 100);

/**
 * The PIN-to-PIN distance from the portal's reply.
 *
 * The portal says it in its `alert`, for example ", Distance between these two pincodes is 840, ".
 * Anything else in the alert is left alone; no figure means the reply did not say.
 */
export const distanceFromPortalAlert = (alert: string | undefined): number | undefined => {
  if (alert === undefined) return undefined;
  const found = /distance between[^0-9]*?(\d{1,4})/i.exec(alert);
  if (found === null) return undefined;
  const km = Number(found[1]);
  return Number.isFinite(km) && km > 0 ? km : undefined;
};

/** The two PIN codes a route runs between, the same way round every time. */
export const pinPairKey = (fromPincode: string, toPincode: string): string => `${fromPincode.trim()}>${toPincode.trim()}`;

/** How the distance will be settled for one e-way bill, said in plain words. */
export interface EwayDistancePlan {
  readonly fromPincode: string;
  readonly toPincode: string;
  /** What goes to the portal: 0 for "work it out yourself", or the typed distance. */
  readonly sentKm: number;
  /** The distance typed on the form, when one was. */
  readonly typedKm?: number;
  /** The portal's own PIN-to-PIN figure, from an earlier reply for the same two PIN codes. */
  readonly knownKm?: number;
  /** The most that may be typed, when the portal's figure is known. */
  readonly longestAllowedKm?: number;
  /** The distance validity follows: the typed one, else the portal's, else unknown until it answers. */
  readonly validityKm?: number;
  readonly message: string;
  /** Set when the typed distance is more than the portal will accept, or one must be typed. */
  readonly refusal?: string;
  /** Why it was refused: too far, or (same PIN code at both ends) a distance must be typed. */
  readonly refusalKind?: "TOO_FAR" | "NEEDED";
  /** True when both ends are in the same PIN code: then the distance is typed, 1 to 100 km. */
  readonly samePin?: boolean;
}

export const planDistance = (input: {
  readonly fromPincode: string;
  readonly toPincode: string;
  readonly typedKm?: number;
  readonly knownKm?: number;
}): EwayDistancePlan => {
  const { fromPincode, toPincode, typedKm, knownKm } = input;
  const route = `PIN ${fromPincode} to PIN ${toPincode}`;

  // Both ends in one PIN code: the portal has no distance to work out, so 0 is not accepted. The
  // distance is typed, at least 1 km and at most 100 km.
  if (fromPincode.trim() !== "" && fromPincode.trim() === toPincode.trim()) {
    const same = { fromPincode, toPincode, samePin: true, longestAllowedKm: SAME_PIN_MAX_KM };
    if (typedKm === undefined || typedKm === 0) {
      return {
        ...same, sentKm: 0,
        message: `The goods leave from and arrive at the same PIN code, ${fromPincode}.`,
        refusalKind: "NEEDED",
        refusal: `The goods leave from and arrive at the same PIN code, ${fromPincode}, so the portal cannot work the distance out. Type the road distance: at least 1 km and at most ${SAME_PIN_MAX_KM} km.`,
      };
    }
    if (typedKm > SAME_PIN_MAX_KM) {
      return {
        ...same, sentKm: typedKm, typedKm,
        message: `You typed ${typedKm} km.`,
        refusalKind: "TOO_FAR",
        refusal: `You typed ${typedKm} km, but the goods leave from and arrive at the same PIN code, ${fromPincode}. For that the portal accepts at most ${SAME_PIN_MAX_KM} km, and ${typedKm} is ${typedKm - SAME_PIN_MAX_KM} km more. Type ${SAME_PIN_MAX_KM} km or less.`,
      };
    }
    return {
      ...same, sentKm: typedKm, typedKm, validityKm: typedKm,
      message: `You typed ${typedKm} km. The goods stay inside PIN code ${fromPincode}, where the portal accepts 1 to ${SAME_PIN_MAX_KM} km.`,
    };
  }
  const base = { fromPincode, toPincode, ...(knownKm === undefined ? {} : { knownKm, longestAllowedKm: longestAllowedDistance(knownKm) }) };

  if (typedKm === undefined || typedKm === 0) {
    return {
      ...base,
      sentKm: 0,
      ...(knownKm === undefined ? {} : { validityKm: knownKm }),
      message: knownKm === undefined
        ? `The distance is not typed. The portal works it out from ${route} when the e-way bill is raised, and how long the bill lasts is shown once it answers.`
        : `The distance is not typed. The portal works it out from ${route}; for these two PIN codes it has said ${knownKm} km before.`,
    };
  }

  if (knownKm !== undefined && typedKm > longestAllowedDistance(knownKm)) {
    const longest = longestAllowedDistance(knownKm);
    return {
      ...base,
      sentKm: typedKm,
      typedKm,
      message: `You typed ${typedKm} km.`,
      refusalKind: "TOO_FAR",
      refusal: `You typed ${typedKm} km, but the portal counts ${knownKm} km from ${route}. It accepts at most 10% more: ${knownKm} + ${longest - knownKm} = ${longest} km. Type ${longest} km or less, or leave the distance empty and the portal will use ${knownKm} km.`,
    };
  }

  return {
    ...base,
    sentKm: typedKm,
    typedKm,
    validityKm: typedKm,
    message: knownKm === undefined
      ? `You typed ${typedKm} km. The portal checks it against its own distance from ${route}, and accepts it up to 10% more than that.`
      : `You typed ${typedKm} km. The portal counts ${knownKm} km from ${route} and accepts up to ${longestAllowedDistance(knownKm)} km.`,
  };
};

/**
 * How many days a distance buys, with the sum written out: "840 ÷ 200 = 4.2, and part of a day
 * counts as a whole day, so 5 days". Nobody should have to do the division in their head.
 */
export const describeValiditySum = (km: number, kilometresPerDay: number, days: number): string => {
  const exact = km / kilometresPerDay;
  const shown = Number.isInteger(exact) ? String(exact) : String(Math.round(exact * 100) / 100);
  if (km === 0) return `1 day`;
  if (Number.isInteger(exact) && exact >= 1) return `${km} ÷ ${kilometresPerDay} = ${shown}, so ${days} day${days === 1 ? "" : "s"}`;
  return `${km} ÷ ${kilometresPerDay} = ${shown}, and part of a day counts as a whole day, so ${days} day${days === 1 ? "" : "s"}`;
};
