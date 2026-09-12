/**
 * Issues #146 and #147 — everything a business has said about how its own bill should look.
 *
 * Three things, and no more: its logo, the mark of its trade, and the colour the headings and rules
 * are drawn in. They are kept together because they are one decision as far as a business is
 * concerned — "make this bill look like mine" — and because all three are frozen onto a bill the
 * moment it is issued, so an old bill reprints as the paper the customer was actually given.
 *
 * Nothing here is ever filled in on a business's behalf. Every field starts empty, and a bill with
 * all three empty is a complete and lawful bill.
 */
import { invalid } from '@invoice/kernel';
import type { Locale, TemplateSnapshot } from './document.ts';
import type { TemplateDefinition } from './template.ts';
import { captureSnapshot } from './snapshot.ts';
import { validateTradeMark, type TradeMarkChoice } from './marks.ts';

export interface CompanyBranding {
  /**
   * The business's own logo, carried as the picture itself rather than as an address, so a bill
   * prints years later with no network and no file server to depend on.
   */
  readonly logoDataUri: string | null;
  /** Issue #147 — the faint mark of the trade behind the items. */
  readonly tradeMark: TradeMarkChoice | null;
  /**
   * The colour headings and rules are drawn in, when the business would rather have its own than
   * the design's.
   *
   * Usually read out of the logo it just uploaded, which is why a bill ends up looking like the
   * business without anybody being asked to choose a colour. It is only ever a colour: it cannot
   * hide a field, move one, or change what the bill says.
   */
  readonly accent: string | null;
}

export const EMPTY_BRANDING: CompanyBranding = { logoDataUri: null, tradeMark: null, accent: null };

/**
 * How large a logo may be, in characters of the stored picture.
 *
 * A logo is stored on the company and copied onto every bill, so a four-megabyte photograph
 * straight off a phone would be copied onto every bill too. Around 400 kB is generous for a mark
 * that prints two centimetres tall, and the screen shrinks the picture before it ever gets here.
 */
export const MAX_LOGO_CHARACTERS = 400_000;

const PICTURE_TYPES = ['data:image/png', 'data:image/jpeg', 'data:image/webp', 'data:image/svg+xml'];

/** A plain six-digit colour, the only form that prints predictably on every printer. */
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

/**
 * Refuses a logo a bill could not honestly carry.
 *
 * It throws rather than quietly dropping the picture, because a business that uploaded a logo and
 * was told nothing would believe its bills carry one.
 */
export const validateLogo = (logoDataUri: string): void => {
  if (!PICTURE_TYPES.some((prefix) => logoDataUri.startsWith(prefix))) {
    throw invalid(
      'LOGO_NOT_A_PICTURE',
      'A logo must be a PNG, JPG, WEBP or SVG picture, and it is stored as the picture itself rather than as a link.',
    );
  }
  if (logoDataUri.length > MAX_LOGO_CHARACTERS) {
    throw invalid(
      'LOGO_TOO_LARGE',
      'That picture is too big to sit on every bill. Use a smaller one — a logo prints about two centimetres tall.',
    );
  }
};

export const validateAccent = (accent: string): void => {
  if (!HEX_COLOUR.test(accent)) {
    throw invalid('ACCENT_NOT_A_COLOUR', 'A colour must be written as six characters, like #1f2933.');
  }
};

/** Refuses anything a business has set that the bill could not honour. */
export const validateBranding = (branding: CompanyBranding): void => {
  if (branding.logoDataUri !== null) validateLogo(branding.logoDataUri);
  if (branding.tradeMark !== null) validateTradeMark(branding.tradeMark);
  if (branding.accent !== null) validateAccent(branding.accent);
};

/**
 * The design a bill is actually printed with: the chosen template, in the business's own colour.
 *
 * The colour is the only thing a business may change, and it is applied here rather than inside
 * `captureSnapshot` so that the rule stays visible: a business picks a colour, never a layout and
 * never a field. What a tax invoice must contain is not a matter of taste.
 */
export const brandedSnapshot = (
  template: TemplateDefinition,
  locale: Locale,
  capturedOn: string,
  branding: CompanyBranding = EMPTY_BRANDING,
): TemplateSnapshot => {
  const snapshot = captureSnapshot(template, locale, capturedOn);
  if (branding.accent === null) return snapshot;
  validateAccent(branding.accent);
  return { ...snapshot, palette: { ...snapshot.palette, accent: branding.accent } };
};
