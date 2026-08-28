/**
 * Issue #46 [E46] — the only supported way for a screen to produce user-facing wording.
 *
 * A surface never writes its own sentence. It asks for a message id and passes the values.
 * That is what makes the wording testable, translatable and consistent with the glossary
 * defined by issue #1.
 */
import {
  LOCALES,
  loadMessages,
  loadStateLabels,
  loadVocabulary,
  type Locale,
  type Message,
  type NextStep,
} from './catalogue.ts';

export * from './catalogue.ts';

export class UnknownMessageError extends Error {
  readonly messageId: string;
  constructor(messageId: string) {
    super(`No message with id "${messageId}". Add it to packages/ux-vocabulary/src/catalogue/messages.json.`);
    this.name = 'UnknownMessageError';
    this.messageId = messageId;
  }
}

export class MissingPlaceholderValueError extends Error {
  readonly messageId: string;
  readonly placeholder: string;
  constructor(messageId: string, placeholder: string) {
    super(`Message "${messageId}" needs a value for {${placeholder}}. Screens must never show a raw placeholder.`);
    this.name = 'MissingPlaceholderValueError';
    this.messageId = messageId;
    this.placeholder = placeholder;
  }
}

const messages = new Map<string, Message>(loadMessages().messages.map((m) => [m.id, m]));
const vocabulary = loadVocabulary();
const stateLabels = loadStateLabels();

export const allMessages = (): Message[] => [...messages.values()];

export const getMessage = (id: string): Message => {
  const m = messages.get(id);
  if (m === undefined) throw new UnknownMessageError(id);
  return m;
};

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

export const placeholdersIn = (text: string): string[] => [...text.matchAll(PLACEHOLDER)].map((m) => m[1] as string);

const fill = (id: string, template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = values[name];
    if (value === undefined) throw new MissingPlaceholderValueError(id, name);
    return value;
  });

export interface RenderedStep {
  id: string;
  label: string;
  requiresPermission?: string;
}

export interface RenderedMessage {
  id: string;
  severity: Message['severity'];
  text: string;
  why: string;
  nextSteps: RenderedStep[];
}

/**
 * Renders a message for one locale. Every placeholder must have a value: showing a raw
 * `{amount}` to a shopkeeper is treated as a bug, not as a cosmetic problem.
 */
export const renderMessage = (
  id: string,
  locale: Locale,
  values: Readonly<Record<string, string>> = {},
): RenderedMessage => {
  const m = getMessage(id);
  const steps: RenderedStep[] = m.nextSteps.map((s: NextStep) => {
    const step: RenderedStep = { id: s.id, label: fill(id, s.label[locale], values) };
    return s.requiresPermission === undefined ? step : { ...step, requiresPermission: s.requiresPermission };
  });
  return {
    id: m.id,
    severity: m.severity,
    text: fill(id, m.text[locale], values),
    why: fill(id, m.why[locale], values),
    nextSteps: steps,
  };
};

/**
 * Filters the next steps down to the ones this user may actually take. Offering an action a
 * person cannot perform is a dead end, so the caller passes the permissions it already holds.
 */
export const permittedSteps = (
  rendered: RenderedMessage,
  heldPermissions: readonly string[],
): RenderedStep[] =>
  rendered.nextSteps.filter((s) => s.requiresPermission === undefined || heldPermissions.includes(s.requiresPermission));

export const stateLabel = (machine: string, state: string, locale: Locale): string => {
  const label = stateLabels.stateLabels[`${machine}.${state}`];
  if (label === undefined) {
    throw new Error(`No plain wording for state ${machine}.${state}. Add it to state-labels.json (issue #46).`);
  }
  return label[locale];
};

export const groupLabel = (group: string, locale: Locale): string => {
  const label = stateLabels.groupLabels[group];
  if (label === undefined) throw new Error(`No plain wording for state group ${group}.`);
  return label[locale];
};

/** The words we show for an accounting term, or undefined when the term is internal only. */
export const plainWordFor = (glossaryTerm: string, locale: Locale): string | undefined => {
  const entry = vocabulary.entries.find((e) => e.glossaryTerm === glossaryTerm);
  if (entry === undefined || entry.internalOnly === true) return undefined;
  return entry.say[locale];
};

export const supportedLocales = (): readonly Locale[] => LOCALES;
