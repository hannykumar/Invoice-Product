import { readFileSync } from "node:fs";
import type { ConnectorKind, CredentialVault } from "./connectors.ts";

const registeredSecrets = new Set<string>();

export const registerSecretValues = (values: readonly string[]): void => {
  for (const value of values) if (value !== "") registeredSecrets.add(value);
};

export const redactSecretText = (value: string): string => {
  let redacted = value;
  for (const secret of [...registeredSecrets].sort((left, right) => right.length - left.length)) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted;
};

export const redactSecrets = <T>(value: T): T => {
  if (typeof value === "string") return redactSecretText(value) as T;
  if (Array.isArray(value)) return value.map(redactSecrets) as T;
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSecrets(item)])) as T;
  }
  return value;
};

const decodeEnvValue = (raw: string): string => {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try { return JSON.parse(value) as string; } catch { return value; }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value.replace(/\s+#.*$/, "");
};

const readEnv = (path: string): Readonly<Record<string, string>> => {
  let source: string;
  try { source = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const values: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) values[match[1]] = decodeEnvValue(match[2]);
  }
  return Object.freeze(values);
};

/** A startup-only vault: values are read once and can only be handed to a connector factory. */
export class FileCredentialVault implements CredentialVault {
  readonly #values: Readonly<Record<string, string>>;
  readonly #connectors: ReadonlySet<ConnectorKind>;

  private constructor(values: Readonly<Record<string, string>>, connectors: readonly ConnectorKind[], secretKeys: readonly string[]) {
    this.#values = Object.freeze({ ...values });
    this.#connectors = new Set(connectors);
    registerSecretValues(secretKeys.map((key) => this.#values[key] ?? ""));
  }

  static open(
    path: string,
    requiredKeys: readonly string[],
    secretKeys: readonly string[],
    connectors: readonly ConnectorKind[],
  ): FileCredentialVault | null {
    const env = readEnv(path);
    if (!requiredKeys.some((key) => (env[key] ?? "") !== "")) return null;
    const missing = requiredKeys.filter((key) => (env[key] ?? "") === "");
    if (missing.length > 0) throw new Error(`WhiteBooks credentials are incomplete. Run npm run gsp:credentials; missing: ${missing.join(", ")}.`);
    return new FileCredentialVault(Object.fromEntries(requiredKeys.map((key) => [key, env[key]!])), connectors, secretKeys);
  }

  async credentialReference(tenantId: string, connector: ConnectorKind): Promise<string> {
    if (!tenantId || !this.#connectors.has(connector)) throw new Error("No credential is configured for this connector.");
    return `vault://whitebooks/${connector}`;
  }

  use<T>(connector: ConnectorKind, factory: (values: Readonly<Record<string, string>>) => T): T {
    if (!this.#connectors.has(connector)) throw new Error("No credential is configured for this connector.");
    return factory(this.#values);
  }
}
