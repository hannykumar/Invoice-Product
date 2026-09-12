/**
 * Issue #147 — how one line of the generated picture library is written.
 *
 * Kept in its own file so the build script and the reader share one definition. Two control
 * characters that can never appear in SVG path data or in a search word are used as the joins.
 */

/** Between the picture's id, its words, and its drawing. */
export const FIELD_SEPARATOR = '\u0001';

/** Between the strokes that make up one drawing. */
export const PATH_SEPARATOR = '\u0002';
