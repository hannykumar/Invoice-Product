const sensitiveKey = /(?:authorization|cookie|credential|secret|password|passphrase|token|pin|private.?key|session|raw|content|document|attachment|pdf|bank.?statement)/i;
const bearerToken = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const connectionPassword = /(:\/\/[^:/\s]+:)[^@/\s]+@/g;

export type SafeLogValue = null | boolean | number | string | readonly SafeLogValue[] | { readonly [key: string]: SafeLogValue };
export interface SafeLogEvent { readonly level: "debug" | "info" | "warn" | "error"; readonly message: string; readonly fields: Readonly<Record<string, SafeLogValue>>; }

export function redactForLog(value: unknown, key = ""): SafeLogValue {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.replace(bearerToken, "Bearer [REDACTED]").replace(connectionPassword, "$1[REDACTED]@");
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
    this.#sink(Object.freeze({ level, message, fields: redactForLog(fields) as Readonly<Record<string, SafeLogValue>> }));
  }
}
