// Issue #27 [E27] — how long an e-way bill lasts, and when it may still be extended.
//
// Validity is the part of an e-way bill that catches people out. Three facts drive everything here:
//
//   1. Validity is measured in **days of road distance**, not in hours of driving: one day for
//      every 200 km or part of it, and one day for every 20 km for over-dimensional cargo.
//   2. A "day" ends at **midnight Indian time**, not 24 hours after the bill was made. A bill
//      generated at 11 p.m. for a 150 km trip expires at midnight the *next* night, giving about
//      25 hours; the same bill made at 6 a.m. gives about 42. Both are correct, and a business
//      planning a dispatch needs to be told which one it has.
//   3. The clock only starts when **Part B** is filled in. A Part A number sitting with a
//      transporter is not running down.
//
// Everything below therefore works in Indian Standard Time explicitly. Doing this in UTC "because
// the server is in UTC" silently moves every expiry five and a half hours, which at midnight is a
// whole day.

import { readIndianTimestamp, writeIndianTimestamp } from "@invoice/kernel";
import type { EwayBillPolicy, VehicleType } from "./types.ts";

/** IST is UTC+5:30, with no daylight saving, ever. */
const IST_OFFSET_MINUTES = 330;
const MINUTE = 60_000;
const HOUR = 3_600_000;

/**
 * The e-way bill portal writes Indian wall-clock time with no zone. Issue #283 moved the reading
 * into the kernel so the e-invoice module reads its acknowledgement time the same way.
 */
export const readPortalTimestamp = (raw: string): Date => readIndianTimestamp(raw);

/** An instant as the portal writes it. */
export const writePortalTimestamp = (at: Date): string => writeIndianTimestamp(at, "DD/MM/YYYY");

/**
 * Days of validity for a distance.
 *
 * "Or part thereof" means 201 km is two days, not one and a bit — so this rounds up, and a distance
 * of zero still gets the one day the portal gives.
 */
export const validityDays = (distanceKm: number, vehicleType: VehicleType, policy: EwayBillPolicy): number => {
  const perDay = vehicleType === "ODC" ? policy.kilometresPerDayOdc : policy.kilometresPerDayRegular;
  if (!Number.isFinite(distanceKm) || distanceKm < 0) throw new Error(`"${distanceKm}" is not a distance we can read.`);
  return Math.max(1, Math.ceil(distanceKm / perDay));
};

/**
 * The instant an e-way bill stops being valid.
 *
 * The portal's own counting, which surprises people: a day does **not** end at the midnight after
 * the bill was made. The government's example is a bill generated at 00:04 on 14 March — its first
 * day runs to the midnight between 15 and 16 March, and its second to the midnight between 16 and
 * 17. So one day of validity from a bill made on the 21st expires at the midnight ending the 22nd,
 * which is why the arithmetic below adds a day beyond the days of distance.
 */
export const validUntilFrom = (
  partBEnteredAt: Date,
  distanceKm: number,
  vehicleType: VehicleType,
  policy: EwayBillPolicy,
): Date => {
  const days = validityDays(distanceKm, vehicleType, policy);
  const indian = new Date(partBEnteredAt.getTime() + IST_OFFSET_MINUTES * MINUTE);
  // Midnight at the end of (that Indian day + days), expressed back in real time.
  const midnightIndian = Date.UTC(indian.getUTCFullYear(), indian.getUTCMonth(), indian.getUTCDate() + days + 1, 0, 0, 0);
  return new Date(midnightIndian - IST_OFFSET_MINUTES * MINUTE);
};

export const isExpired = (validUntil: string | undefined, now: Date): boolean =>
  validUntil !== undefined && new Date(validUntil).getTime() <= now.getTime();

/**
 * When an expiring bill may be extended.
 *
 * The portal accepts an extension only in a narrow window around expiry — eight hours either side —
 * which is exactly the window a driver stuck at a check post needs and exactly the one nobody
 * remembers. Knowing it opens ahead of time is the difference between extending the bill and
 * unloading the lorry.
 */
export const extensionWindow = (validUntil: string, policy: EwayBillPolicy): { readonly opensAt: string; readonly closesAt: string } => {
  const expiry = new Date(validUntil).getTime();
  return {
    opensAt: new Date(expiry - policy.extensionWindowHours * HOUR).toISOString(),
    closesAt: new Date(expiry + policy.extensionWindowHours * HOUR).toISOString(),
  };
};

/** Whether an extension would be accepted right now, and plain words when it would not. */
export const canExtendNow = (validUntil: string, now: Date, policy: EwayBillPolicy): { readonly ok: boolean; readonly explanation: string } => {
  const window = extensionWindow(validUntil, policy);
  const at = now.getTime();
  if (at < new Date(window.opensAt).getTime()) {
    return {
      ok: false,
      explanation: `This e-way bill is valid until ${describeExpiry(validUntil)}. The portal only accepts an extension in the last ${policy.extensionWindowHours} hours before it runs out, so it is too early to extend it.`,
    };
  }
  if (at > new Date(window.closesAt).getTime()) {
    return {
      ok: false,
      explanation: `This e-way bill ran out at ${describeExpiry(validUntil)} and the portal stops accepting extensions ${policy.extensionWindowHours} hours after that, which has passed. A fresh e-way bill has to be raised for the rest of the journey.`,
    };
  }
  return { ok: true, explanation: "This e-way bill can be extended now." };
};

/**
 * The moment written the way a person reads it, in Indian time.
 *
 * Issue #234 — a validity that runs out at midnight is written as the last second of the day it
 * covers, the way the portal prints it ("valid upto 03/10/2026 11:59 PM"). Written as "04/10/2026
 * 00:00:00" a 5-day bill raised on 28 Sep reads as if it ran into a sixth day.
 */
export const describeExpiry = (validUntil: string): string => {
  const at = readPortalTimestamp(validUntil);
  const endOfDay = writePortalTimestamp(at).endsWith(" 00:00:00") ? new Date(at.getTime() - 1000) : at;
  return `${writePortalTimestamp(endOfDay)} (Indian time)`;
};

/** How long is left, in plain words, for the screen a dispatch clerk is looking at. */
export const describeTimeLeft = (validUntil: string, now: Date): string => {
  const left = readPortalTimestamp(validUntil).getTime() - now.getTime();
  if (left <= 0) return "This e-way bill has already run out.";
  const hours = Math.floor(left / HOUR);
  if (hours < 1) return `About ${Math.max(1, Math.round(left / MINUTE))} minutes left.`;
  if (hours < 24) return `About ${hours} hour${hours === 1 ? "" : "s"} left.`;
  const days = Math.floor(hours / 24);
  return `About ${days} day${days === 1 ? "" : "s"} and ${hours % 24} hour${hours % 24 === 1 ? "" : "s"} left.`;
};

/** The portal's own vehicle-number format. "KA01AB1234", and a few older shapes. */
export const VEHICLE_NUMBER = /^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$/;

export const normaliseVehicleNumber = (raw: string): string => raw.toUpperCase().replace(/[\s-]/g, "");
