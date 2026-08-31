/**
 * Issue #49 [X01] — the guard that keeps this register safe to commit.
 *
 * The register lives in git and is read by everybody working on the product. So it must never be
 * the place a PAN, a GSTIN, a CIN, a bank account, an Aadhaar number or a key gets written down —
 * not because somebody would do it on purpose, but because the natural way to fill in "reference"
 * is to paste the number.
 *
 * `safeReference()` throws instead. It is the same idea as the wording guards elsewhere in this
 * product: a rule that depends on everybody remembering it is not a rule.
 */

export class IdentifierInRegisterError extends Error {
  readonly kind: string;
  readonly matched: string;
  constructor(kind: string, matched: string) {
    super(
      `This register records that a document exists and where it is kept — never what it says. ` +
        `What looks like ${kind} ("${matched.slice(0, 4)}…") must live in the company vault instead.`,
    );
    this.name = 'IdentifierInRegisterError';
    this.kind = kind;
    this.matched = matched;
  }
}

interface Pattern {
  readonly kind: string;
  readonly match: RegExp;
}

/**
 * India's real identifier shapes, plus the credential formats that turn up in pasted text.
 *
 * Deliberately narrow: each pattern is anchored on the structure of the real thing, so an ordinary
 * sentence, a file path or a vault item name passes untouched.
 */
const PATTERNS: readonly Pattern[] = [
  { kind: 'a GSTIN', match: /\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/ },
  { kind: 'a PAN', match: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/ },
  { kind: 'a TAN', match: /\b[A-Z]{4}[0-9]{5}[A-Z]\b/ },
  { kind: 'a CIN', match: /\b[ULF][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}\b/ },
  { kind: 'an Aadhaar number', match: /\b[2-9][0-9]{3}[\s-]?[0-9]{4}[\s-]?[0-9]{4}\b/ },
  { kind: 'an IFSC code', match: /\b[A-Z]{4}0[A-Z0-9]{6}\b/ },
  { kind: 'a bank account number', match: /\b[0-9]{9,18}\b/ },
  { kind: 'a private key', match: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: 'an API secret', match: /\b(?:sk_live|sk_test|rzp_live|AKIA)[A-Za-z0-9_-]{6,}\b/ },
  { kind: 'a password', match: /\b(?:password|passphrase|otp|pin)\s*[:=]\s*\S+/i },
];

export const identifierIn = (text: string): { kind: string; matched: string } | null => {
  for (const pattern of PATTERNS) {
    const found = pattern.match.exec(text);
    if (found !== null) return { kind: pattern.kind, matched: found[0] };
  }
  return null;
};

export const safeReference = (text: string | null): string | null => {
  if (text === null) return null;
  const found = identifierIn(text);
  if (found !== null) throw new IdentifierInRegisterError(found.kind, found.matched);
  return text;
};

/** An address at the company's own domain. A personal mailbox is a finding, not a contact. */
export const isCompanyAddress = (email: string, domain: string | null): boolean =>
  domain !== null && email.toLowerCase().endsWith(`@${domain.toLowerCase()}`);
