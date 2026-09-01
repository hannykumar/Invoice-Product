/**
 * Issue #33 [E33] — keeping secrets out of the record.
 *
 * The audit trail is the most-read thing this module produces and the most dangerous place to be
 * careless. A one-time password, a client secret or an API key written into it once is written into
 * every backup of it forever, and nobody discovers this until an incident.
 *
 * So nothing reaches storage without passing through here, and the rule is the conservative one: a
 * field whose *name* looks like a secret is replaced, whatever it contains. The cost of redacting a
 * harmless field called `token` is nothing; the cost of storing a real one is an incident.
 *
 * `containsSecretField` exists for the other half of the same problem. A caller that hands this
 * module a portal password — even meaning well, even to "verify" it — is refused outright rather
 * than quietly redacted, because a product that accepts a password and drops it is one careless
 * change away from a product that accepts a password and keeps it.
 */

const SECRET_NAMES = [
  'password', 'passwd', 'pwd', 'secret', 'token', 'otp', 'apikey', 'api_key', 'clientsecret',
  'client_secret', 'authorization', 'auth', 'credential', 'privatekey', 'private_key', 'signature',
  'sek', 'appkey', 'app_key', 'accesstoken', 'access_token', 'refreshtoken', 'refresh_token',
];

const looksSecret = (key: string): boolean => {
  const normalised = key.toLowerCase().replace(/[^a-z_]/g, '');
  return SECRET_NAMES.some((name) => normalised.includes(name.replace(/[^a-z_]/g, '')));
};

export const REDACTED = '[redacted]';

/** Recursively replaces anything that looks like a secret. Structure is kept; values are not. */
export const redact = (value: unknown, depth = 0): unknown => {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = looksSecret(key) ? REDACTED : redact(item, depth + 1);
  }
  return output;
};

/** Audit details are flat strings, so this is the version the audit port actually takes. */
export const redactDetails = (details: Readonly<Record<string, string>>): Record<string, string> => {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(details)) output[key] = looksSecret(key) ? REDACTED : value;
  return output;
};

/** True when a payload carries a field this module refuses to be handed at all. */
export const containsSecretField = (value: unknown, depth = 0): boolean => {
  if (depth > 8 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsSecretField(item, depth + 1));
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    // A one-time password is typed by a person and passed straight through as its own argument; it
    // never travels inside a payload, so finding one there is a mistake worth stopping.
    if (looksSecret(key)) return true;
    if (containsSecretField(item, depth + 1)) return true;
  }
  return false;
};
