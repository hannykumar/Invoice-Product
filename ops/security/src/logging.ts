const sensitiveKey = /(?:authorization|cookie|credential|secret|password|passphrase|token|pin|private.?key|session|raw|content|document|attachment|pdf|bank.?statement)/i;
/**
 * Issue #357 — personal and payee data, matched on the whole key so that `company` (which contains
 * "pan") and `phoneVerified` are left alone. PAN, the bank account, IFSC and UPI id are where a
 * customer's money goes; phone, email, Aadhaar and a signature identify a person.
 */
const personalKey = /^(?:pan(?:_?(?:no|number))?|(?:bank_?)?account_?(?:no|number)|bank_?account|ifsc(?:_?code)?|upi(?:_?id)?|(?:phone|mobile)(?:_?(?:no|number))?|e_?mail(?:_?address)?|aadhaa?r(?:_?(?:no|number))?|signature\w*)$/i;
const emailAddress = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const bearerToken = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const connectionPassword = /(:\/\/[^:/\s]+:)[^@/\s]+@/g;

export type SafeLogValue = null | boolean | number | string | readonly SafeLogValue[] | { readonly [key: string]: SafeLogValue };
export interface SafeLogEvent { readonly level: "debug" | "info" | "warn" | "error"; readonly message: string; readonly fields: Readonly<Record<string, SafeLogValue>>; }

export function redactForLog(value: unknown, key = ""): SafeLogValue {
  if (sensitiveKey.test(key) || personalKey.test(key)) return "[REDACTED]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactSecretText(value).replace(bearerToken, "Bearer [REDACTED]").replace(connectionPassword, "$1[REDACTED]@").replace(emailAddress, "[EMAIL]");
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => redactForLog(item));
  if (value instanceof Error) return { name: value.name, message: redactForLog(value.message) };
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, redactForLog(child, childKey)]));
  return String(value);
}

export class SecureLogger {
  readonly #sink: (event: SafeLogEvent) => void;

  constructor(sink: (event: SafeLogEvent) => void) {
    this.#sink = sink;
  }

  write(level: SafeLogEvent["level"], message: string, fields: Readonly<Record<string, unknown>> = {}): void {
    this.#sink(Object.freeze({ level, message: redactSecretText(message), fields: redactForLog(fields) as Readonly<Record<string, SafeLogValue>> }));
  }
}
import { redactSecretText } from "../../../packages/platform/src/credentials.ts";
