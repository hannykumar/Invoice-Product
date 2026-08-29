/**
 * Issue #10 [E10] — the two things this module talks to.
 *
 * `TranscriptionPort` is the **only** place a model appears in this feature, and all it may do is
 * turn sound into text with a confidence. It never sees a rate, never resolves a customer and
 * never decides anything. Everything downstream of it is a lexicon and a lookup.
 */
import type { CompanyId } from '@invoice/kernel';

export interface TranscriptionAlternative {
  readonly text: string;
  /** 0 to 1, as reported by the provider. Carried through to every field it produced. */
  readonly confidence: number;
}

export interface Transcription {
  readonly alternatives: readonly TranscriptionAlternative[];
  readonly languageHint?: string;
  /** Where the recording is kept, so a person can listen to what was actually said. */
  readonly audioRef?: string;
}

export interface TranscriptionPort {
  transcribe(audio: { ref: string; languageHint?: string }): Promise<Transcription>;
}

export interface ResolvedParty {
  readonly partyId: string;
  readonly name: string;
}

export interface ResolvedItem {
  readonly itemId: string;
  readonly name: string;
  readonly baseUnit: string;
}

/** GPT 3's #5 outcome, narrowed to what this module needs. `ambiguous` is never treated as resolved. */
export type Resolution<T> =
  | { readonly status: 'resolved'; readonly record: T; readonly score: number }
  | { readonly status: 'ambiguous'; readonly candidates: readonly { record: T; score: number }[] }
  | { readonly status: 'not_found' };

export interface EntityResolver {
  party(companyId: CompanyId, spokenName: string): Resolution<ResolvedParty>;
  item(companyId: CompanyId, spokenName: string): Resolution<ResolvedItem>;
}
