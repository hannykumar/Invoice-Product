/**
 * Issue #298 — the language a request answers in.
 *
 * The screens send `locale` on every call (`en-IN` or `hi-IN`). The dispatcher writes it into the
 * request's scope, so a handler deep in the code picks the right sentence of a bilingual pair
 * without the locale being passed down every signature. English and Hindi ship together
 * (`docs/ux/00-design-principles.md` §6): `hi-IN` means Hindi in Devanagari — the owner's choice
 * (26 Oct 2026).
 */
import { requestScope } from './log.ts';

export type ShopLanguage = 'en-IN' | 'hi-IN';

/** The language the current request answers in; English outside a request or when it was not asked. */
export const requestLanguage = (): ShopLanguage => (requestScope().locale === 'hi-IN' ? 'hi-IN' : 'en-IN');

/** A sentence in both languages; services produce these, handlers turn one out. */
export interface Bilingual {
  readonly 'en-IN': string;
  readonly 'hi-IN': string;
}

/** Picks the request's language from a bilingual pair; a missing Hindi falls back to English. */
export const say = (pair: Bilingual | { readonly 'en-IN': string; readonly 'hi-IN'?: string }): string =>
  pair[requestLanguage()] ?? pair['en-IN'];

/** Builds the pair inline: `both('Return recorded', 'वापसी दर्ज हुई')`. */
export const both = (en: string, hi: string): string => say({ 'en-IN': en, 'hi-IN': hi });
