/** Issue #46 [E46] — typed access to the catalogue JSON files. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const catalogueDir = join(dirname(fileURLToPath(import.meta.url)), 'catalogue');

export type Locale = 'en-IN' | 'hi-IN';
export const LOCALES: readonly Locale[] = ['en-IN', 'hi-IN'];

export type Localised = Record<Locale, string>;

export type Severity = 'block' | 'warn' | 'info' | 'success' | 'progress';

export interface NextStep {
  id: string;
  label: Localised;
  requiresPermission?: string;
}

export interface Message {
  id: string;
  severity: Severity;
  surface: string[];
  placeholders: string[];
  text: Localised;
  why: Localised;
  nextSteps: NextStep[];
}

export interface MessageCatalogue {
  version: string;
  locales: Locale[];
  messages: Message[];
}

export interface VocabularyEntry {
  glossaryTerm: string;
  avoid: string[];
  say: Localised;
  inSentence: Localised;
  internalOnly?: boolean;
  glossaryOptional?: boolean;
}

export interface Vocabulary {
  version: string;
  locales: Locale[];
  entries: VocabularyEntry[];
}

export interface StateLabels {
  version: string;
  locales: Locale[];
  groupLabels: Record<string, Localised>;
  stateLabels: Record<string, Localised>;
}

const read = <T>(file: string): T => JSON.parse(readFileSync(join(catalogueDir, file), 'utf8')) as T;

export const loadMessages = (): MessageCatalogue => read<MessageCatalogue>('messages.json');
export const loadVocabulary = (): Vocabulary => read<Vocabulary>('vocabulary.json');
export const loadStateLabels = (): StateLabels => read<StateLabels>('state-labels.json');
