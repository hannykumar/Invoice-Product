/**
 * The error model.
 *
 * A domain error is not an exception about the computer; it is a statement about the business.
 * Each one carries a stable `code` for callers, an optional `messageId` from the issue #46
 * catalogue so the same failure is worded consistently everywhere, and structured `details` for
 * filling that message's placeholders.
 *
 * Errors never carry secrets, credentials or full request payloads, because they are logged.
 */
export type ErrorKind =
  /** The request is not valid on its own terms. */
  | 'INVALID'
  /** The request is valid but the current state does not allow it. */
  | 'NOT_ALLOWED'
  /** The caller lacks the permission required. */
  | 'FORBIDDEN'
  /** Something referenced does not exist, or not for this company. */
  | 'NOT_FOUND'
  /** Someone else changed the same thing first; the caller may retry. */
  | 'CONFLICT'
  /** A fact needed to decide is missing. The caller must ask, never assume. */
  | 'MISSING_FACT';

export interface DomainErrorOptions {
  kind: ErrorKind;
  code: string;
  message: string;
  /** Message id in packages/ux-vocabulary, when there is user-facing wording for this failure. */
  messageId?: string;
  details?: Readonly<Record<string, string>>;
}

export class DomainError extends Error {
  readonly kind: ErrorKind;
  readonly code: string;
  readonly messageId: string | undefined;
  readonly details: Readonly<Record<string, string>>;

  constructor(options: DomainErrorOptions) {
    super(options.message);
    this.name = 'DomainError';
    this.kind = options.kind;
    this.code = options.code;
    this.messageId = options.messageId;
    this.details = options.details ?? {};
  }

  /** True when a caller may safely retry the same command unchanged. */
  get retryable(): boolean {
    return this.kind === 'CONFLICT';
  }
}

export const invalid = (code: string, message: string, extra: Partial<DomainErrorOptions> = {}): DomainError =>
  new DomainError({ kind: 'INVALID', code, message, ...extra });

export const notAllowed = (code: string, message: string, extra: Partial<DomainErrorOptions> = {}): DomainError =>
  new DomainError({ kind: 'NOT_ALLOWED', code, message, ...extra });

export const forbidden = (code: string, message: string, extra: Partial<DomainErrorOptions> = {}): DomainError =>
  new DomainError({ kind: 'FORBIDDEN', code, message, ...extra });

export const notFound = (code: string, message: string, extra: Partial<DomainErrorOptions> = {}): DomainError =>
  new DomainError({ kind: 'NOT_FOUND', code, message, ...extra });

export const conflict = (code: string, message: string, extra: Partial<DomainErrorOptions> = {}): DomainError =>
  new DomainError({ kind: 'CONFLICT', code, message, ...extra });

export const missingFact = (code: string, message: string, extra: Partial<DomainErrorOptions> = {}): DomainError =>
  new DomainError({ kind: 'MISSING_FACT', code, message, ...extra });

/**
 * Issue #358 — a value typed in a form the parsers cannot read ("31-02-2026" as a date, "12,5" as
 * an amount). It is the caller's to correct, so the API answers 400 with this message. A RangeError
 * is a RangeError still, so code that catches one is unchanged; any other RangeError (a zero
 * denominator, a share of nothing) is a fault in our own code and is reported as one.
 */
export class UnreadableValue extends RangeError {}
