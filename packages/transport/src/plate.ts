// Issue #28 [E28] — reading a number plate from a photograph, and comparing it honestly.
//
// The comparison is the whole point, and it is easy to get wrong in a way that is worse than not
// doing it at all. Two failure modes:
//
//   - **False alarms.** Indian plates are read by machines as often as by people, and O/0, I/1,
//     S/5, B/8, Z/2 and G/6 are routinely swapped by both. A reader that stops every lorry whose
//     plate contains a zero is a reader everybody switches off within a week. So a difference that
//     is only in look-alike characters is reported as its own verdict, for a person's eye, and not
//     as a mismatch.
//   - **False confidence.** A blurred photograph in the rain is not evidence that the plate is
//     wrong, and it is not evidence that it is right either. A low-confidence reading is
//     `CANNOT_READ`, which is a question, never a pass.
//
// Nothing here looks at the image. Reading it is the OCR provider's job, behind a port; this file
// decides what the reading means.

import { normaliseVehicleNumber } from "./validity.ts";
import type { PlateComparison, PlateComparisonVerdict, PlateReadBy } from "./suitability-types.ts";

/**
 * Characters a plate reader confuses, in both directions.
 *
 * Kept small and specific. Adding a pair here makes real mismatches slip through as "worth a look",
 * so each one has to be a confusion that genuinely happens on a dusty plate.
 */
const LOOKALIKES: readonly (readonly [string, string])[] = Object.freeze([
  ["0", "O"], ["0", "D"], ["0", "Q"],
  ["1", "I"], ["1", "L"], ["1", "T"],
  ["2", "Z"], ["5", "S"], ["6", "G"], ["8", "B"], ["4", "A"], ["7", "T"], ["9", "P"],
  ["U", "V"], ["M", "N"], ["C", "G"], ["E", "F"], ["K", "X"],
]);

const looksLike = (left: string, right: string): boolean =>
  left === right || LOOKALIKES.some(([a, b]) => (a === left && b === right) || (a === right && b === left));

/**
 * How far apart two plates are, counting only positions that differ.
 *
 * Length differences count as differences: "KA01AB123" is not "KA01AB1234" with one character
 * missed, it is a different plate, and treating a missing character as a near-match would let a
 * genuinely different lorry through.
 */
const compareCharacters = (read: string, declared: string): { readonly differing: number; readonly lookalikeOnly: boolean } => {
  if (read.length !== declared.length) return { differing: Math.abs(read.length - declared.length) + 1, lookalikeOnly: false };
  let differing = 0;
  let lookalikeOnly = true;
  for (let index = 0; index < read.length; index += 1) {
    const left = read[index] ?? "";
    const right = declared[index] ?? "";
    if (left === right) continue;
    differing += 1;
    if (!looksLike(left, right)) lookalikeOnly = false;
  }
  return { differing, lookalikeOnly };
};

export interface PlateReading {
  readonly text: string;
  /**
   * 0 to 1, as the reader reported it.
   *
   * A person reading a plate has no confidence score, and inventing 1.0 for them would put a
   * human eye and a vision model on the same footing. So this is absent for a typed reading, and
   * the confidence floor below does not apply to one.
   */
  readonly confidence?: number;
  readonly photoId?: string;
  /** Defaults to a photograph, because that is what the reader port produces. */
  readonly readBy?: PlateReadBy;
}

/**
 * What a photograph says about the vehicle number that was entered.
 *
 * `minimumConfidence` comes from the company's policy rather than from a constant here, because how
 * sure a reader has to be before its word counts is a business decision, not a fact about plates.
 */
export const comparePlateReading = (
  reading: PlateReading | null,
  declaredNumber: string,
  minimumConfidence: number,
): PlateComparison => {
  const declared = normaliseVehicleNumber(declaredNumber ?? "");
  if (reading === null) {
    return {
      verdict: "CANNOT_READ",
      readBy: "PHOTO",
      declaredNumber: declared,
      explanation: "Nobody has read the number plate — no photograph and nothing typed in — so the vehicle number on this movement has not been checked against the lorry itself.",
    };
  }

  const readBy: PlateReadBy = reading.readBy ?? "PHOTO";
  const source = readBy === "PERSON" ? "the plate somebody read off the lorry" : "the photograph";
  const read = normaliseVehicleNumber(reading.text ?? "");
  const shared = {
    declaredNumber: declared,
    readBy,
    ...(reading.confidence === undefined ? {} : { confidence: reading.confidence }),
    ...(reading.photoId === undefined ? {} : { photoId: reading.photoId }),
  };

  if (read === "") {
    return {
      ...shared,
      verdict: "CANNOT_READ",
      explanation: readBy === "PERSON"
        ? "Nothing was typed in for what the plate says, so the vehicle number has not been checked against the lorry."
        : "Nothing could be read from the number plate photograph. This is not a mismatch — the plate simply could not be made out, so somebody has to look at the lorry.",
    };
  }
  // The confidence floor is about a machine's reading. A person's reading has no score, and
  // holding it to one would throw away the very reading we asked for when there was no photo.
  if (readBy === "PHOTO" && reading.confidence !== undefined && reading.confidence < minimumConfidence) {
    return {
      ...shared,
      verdict: "CANNOT_READ",
      readNumber: read,
      explanation: `The photograph reads as "${read}", but the reader is only ${Math.round(reading.confidence * 100)}% sure of it, and this business treats anything under ${Math.round(minimumConfidence * 100)}% as unreadable. It has not been counted either way.`,
    };
  }

  if (read === declared) {
    return {
      ...shared,
      verdict: "MATCH",
      readNumber: read,
      explanation: readBy === "PERSON"
        ? `The plate on the lorry was read as ${read}, which is the vehicle number on this movement.`
        : `The number plate in the photograph reads ${read}, which is the vehicle number on this movement.`,
    };
  }

  const { differing, lookalikeOnly } = compareCharacters(read, declared);
  const verdict: PlateComparisonVerdict = lookalikeOnly && differing <= 2 ? "LOOKALIKE_DIFFERENCE" : "MISMATCH";
  return {
    ...shared,
    verdict,
    readNumber: read,
    explanation: verdict === "LOOKALIKE_DIFFERENCE"
      ? `${source === "the photograph" ? "The photograph reads" : "The plate was read as"} ${read} and the movement says ${declared}. They differ only where the characters look alike, which readers and people both get wrong, so somebody should glance at the lorry rather than treat this as the wrong vehicle.`
      : `${source === "the photograph" ? "The photograph reads" : "The plate was read as"} ${read} and the movement says ${declared}. These are ${differing === 1 ? "not the same plate" : "different plates"}, so either the wrong vehicle number was entered or the goods are being loaded onto a different lorry.`,
  };
};
