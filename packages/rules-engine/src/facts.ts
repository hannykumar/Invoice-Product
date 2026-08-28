/**
 * Issue #7 [E07] — typed facts.
 *
 * A fact is something we know, together with **where we learned it**. Provenance is not
 * decoration: a value a user typed and a value a model guessed from a photograph must not be
 * treated the same way, and a decision has to be able to say which it used.
 */
import { type IsoDate, type Money, type Quantity } from '@invoice/kernel';

export type FactType = 'money' | 'quantity' | 'date' | 'text' | 'number' | 'boolean' | 'stateCode' | 'enum';

/**
 * Where a fact came from. `MODEL` values are always shown to the user for confirmation before a
 * decision that depends on them is acted upon; the engine records the distinction so the caller
 * cannot lose it.
 */
export type FactSource = 'USER' | 'DOCUMENT' | 'MASTER_DATA' | 'DERIVED' | 'MODEL' | 'DEFAULT';

export type FactValue = string | number | bigint | boolean | Money | Quantity | IsoDate;

export interface FactDefinition {
  readonly id: string;
  readonly type: FactType;
  /** How this fact is named to a business owner. Checked against the issue #46 wording rules. */
  readonly label: { readonly 'en-IN': string; readonly 'hi-IN': string };
  readonly enumValues?: readonly string[];
  /** Why a rule needs it, shown when it is missing. */
  readonly whyNeeded: { readonly 'en-IN': string; readonly 'hi-IN': string };
}

export interface KnownFact {
  readonly value: FactValue;
  readonly source: FactSource;
  /** 0 to 1, present only for facts a model produced. */
  readonly confidence?: number;
}

/**
 * The facts of one transaction. Immutable: an engine may never write back into its input, because
 * a decision must be reproducible from exactly what it was given.
 */
export class FactSet {
  readonly #facts: ReadonlyMap<string, KnownFact>;

  constructor(entries: Readonly<Record<string, KnownFact>>) {
    this.#facts = new Map(Object.entries(entries));
  }

  static of(plain: Readonly<Record<string, FactValue>>, source: FactSource = 'USER'): FactSet {
    return new FactSet(Object.fromEntries(Object.entries(plain).map(([k, v]) => [k, { value: v, source }])));
  }

  has(id: string): boolean {
    return this.#facts.has(id);
  }

  get(id: string): KnownFact | undefined {
    return this.#facts.get(id);
  }

  value(id: string): FactValue | undefined {
    return this.#facts.get(id)?.value;
  }

  ids(): string[] {
    return [...this.#facts.keys()].sort();
  }

  entries(): [string, KnownFact][] {
    return this.ids().map((id) => [id, this.#facts.get(id) as KnownFact]);
  }

  /** A new set with extra facts. The original is untouched. */
  with(extra: Readonly<Record<string, KnownFact>>): FactSet {
    return new FactSet({ ...Object.fromEntries(this.entries()), ...extra });
  }

  /** Facts whose value a model produced below the given confidence. */
  lowConfidence(threshold: number): string[] {
    return this.entries()
      .filter(([, f]) => f.source === 'MODEL' && (f.confidence ?? 0) < threshold)
      .map(([id]) => id);
  }
}

/** A stable, order-independent fingerprint of the facts, used to prove a replay used the same input. */
export const fingerprintFacts = (facts: FactSet): string => {
  const canonical = facts
    .entries()
    .map(([id, f]) => `${id}=${describeValue(f.value)}@${f.source}`)
    .join('|');
  return hashString(canonical);
};

export const describeValue = (value: FactValue): string => {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object' && 'minor' in value) return `${value.currency}:${value.minor.toString()}`;
  if (typeof value === 'object' && 'scaled' in value) return `${value.unit}:${value.scaled.toString()}`;
  return String(value);
};

/**
 * A small, dependency-free FNV-1a hash. It identifies an input; it is not a security primitive and
 * is never used for one.
 */
export const hashString = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};
