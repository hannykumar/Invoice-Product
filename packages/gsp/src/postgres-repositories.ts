/**
 * Issue #366 — this module's records in PostgreSQL: each GST number's authorisation with its
 * consent, credential references and one-time-password challenge, and the log of every call.
 *
 * Each class implements the same port as its in-memory twin and behaves the same. They are built on
 * the transaction executor and never open a transaction of their own: every write joins the
 * action's unit of work (`requireUnitOfWork`, which throws `NO_UNIT_OF_WORK` when none is open),
 * every read runs in `tenantTransaction`, and every query names its company as well as relying on
 * row-level security. Contracts: unit-of-work-v1, database-immutability-v1, government-access-v1.
 *
 * Nothing secret is written. A credential is a vault reference (connector-v1's `CredentialVault`
 * resolves it); a one-time password is never on the record, only the challenge's id, expiry, tries
 * left and the last digits of the phone.
 *
 * Provider callbacks are kept by `PostgresWebhookEvents` (#389). The two cross-company lookups of
 * the call log find nothing here: a callback names no company, and these tables are closed to a
 * connection that has none. That waits for #345 (see government-access-v1, "Storage").
 */
import { notAllowed, type CompanyId, type UserId } from '@invoice/kernel';
import type { SqlExecutor, TransactionalExecutor } from '../../platform/src/database.ts';
import type { AuthorisationRepository, CallLogRepository, Page } from './ports.ts';
import type { ConsentRecord, CredentialHandle, GstinAuthorisation, OtpChallenge, ProviderCall } from './types.ts';

type Row = Record<string, unknown>;

/** A timestamptz as the clock writes it. jsonb carries one as text, so both forms are read. */
const iso = (value: unknown): string => (value instanceof Date ? value : new Date(String(value))).toISOString();
const isoOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : iso(value));
const textOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
/** `{ key: value }`, or nothing when the column is null: the records use absent, never undefined. */
const opt = <K extends string, T>(key: K, value: unknown, as: (raw: unknown) => T): Partial<Record<K, T>> =>
  (value === null || value === undefined ? {} : { [key]: as(value) }) as Partial<Record<K, T>>;

// ----------------------------------------------------------------------------- authorisations

const AUTHORISATION_COLUMNS = [
  'id', 'company_id', 'gstin', 'legal_name', 'status', 'provider', 'environment', 'scopes', 'api_user_id',
  'credential_reference', 'credential_issued_at', 'credential_expires_at', 'valid_until', 'suspended_reason',
  'revoked_at', 'revoked_by', 'revocation_reason', 'created_at', 'updated_at',
] as const;
/** What a later save may change. The id, the company, the GST number and the creation time may not. */
const AUTHORISATION_UPDATES = AUTHORISATION_COLUMNS.filter((column) => !['id', 'company_id', 'gstin', 'created_at'].includes(column));

/** One query for the authorisation and everything on it: the newest consent, every credential, the open challenge. */
const AUTHORISATION_SELECT = `a.id, a.company_id, a.gstin, a.legal_name, a.status, a.provider, a.environment, a.scopes, a.api_user_id,
  a.credential_reference, a.valid_until, a.suspended_reason, a.revoked_at, a.revoked_by, a.revocation_reason, a.created_at, a.updated_at,
  (SELECT to_jsonb(c) FROM (SELECT c.id, c.scopes, c.wording_shown, c.method, c.granted_by, c.granted_at, c.withdrawn_at, c.withdrawn_by, c.withdrawal_reason
     FROM gstin_consents c WHERE c.company_id = a.company_id AND c.authorisation_id = a.id ORDER BY c.seq DESC LIMIT 1) c) AS consent,
  (SELECT jsonb_agg(to_jsonb(k) ORDER BY k.seq) FROM (SELECT k.seq, k.reference, k.issued_at, k.expires_at, k.rotated_by, k.rotation_reason
     FROM gsp_credentials k WHERE k.company_id = a.company_id AND k.authorisation_id = a.id) k) AS credentials,
  (SELECT to_jsonb(o) FROM (SELECT o.request_id, o.requested_at, o.expires_at, o.attempts_remaining, o.sent_to_hint
     FROM gsp_otp_challenges o WHERE o.company_id = a.company_id AND o.authorisation_id = a.id AND o.settled_at IS NULL) o) AS otp`;

const toHandle = (row: Row): CredentialHandle => ({
  reference: String(row.reference),
  issuedAt: iso(row.issued_at),
  expiresAt: isoOrNull(row.expires_at),
  ...opt('rotatedBy', row.rotated_by, (raw) => String(raw) as UserId),
  ...opt('rotationReason', row.rotation_reason, String),
});

const toConsent = (row: Row): ConsentRecord => ({
  id: String(row.id),
  grantedBy: String(row.granted_by) as UserId,
  grantedAt: iso(row.granted_at),
  scopes: row.scopes as ConsentRecord['scopes'],
  wordingShown: row.wording_shown as ConsentRecord['wordingShown'],
  method: row.method as ConsentRecord['method'],
  ...opt('withdrawnAt', row.withdrawn_at, iso),
  ...opt('withdrawnBy', row.withdrawn_by, (raw) => String(raw) as UserId),
  ...opt('withdrawalReason', row.withdrawal_reason, String),
});

const toOtp = (row: Row): OtpChallenge => ({
  requestId: String(row.request_id),
  requestedAt: iso(row.requested_at),
  expiresAt: iso(row.expires_at),
  attemptsRemaining: Number(row.attempts_remaining),
  sentToHint: String(row.sent_to_hint),
});

const toAuthorisation = (row: Row): GstinAuthorisation => {
  const handles = ((row.credentials as Row[] | null) ?? []).map(toHandle);
  // The live credential is the newest one, while the authorisation still holds a reference.
  const live = row.credential_reference === null ? null : handles[handles.length - 1] ?? null;
  return {
    id: String(row.id),
    companyId: String(row.company_id) as CompanyId,
    gstin: String(row.gstin),
    legalName: String(row.legal_name),
    status: row.status as GstinAuthorisation['status'],
    provider: String(row.provider),
    environment: row.environment as GstinAuthorisation['environment'],
    scopes: row.scopes as GstinAuthorisation['scopes'],
    consent: row.consent === null ? null : toConsent(row.consent as Row),
    credential: live,
    credentialHistory: live === null ? handles : handles.slice(0, -1),
    otp: row.otp === null ? null : toOtp(row.otp as Row),
    apiUserId: textOrNull(row.api_user_id),
    validUntil: isoOrNull(row.valid_until),
    suspendedReason: textOrNull(row.suspended_reason),
    revokedAt: isoOrNull(row.revoked_at),
    revokedBy: textOrNull(row.revoked_by) as UserId | null,
    revocationReason: textOrNull(row.revocation_reason),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
};

export class PostgresAuthorisations implements AuthorisationRepository {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  async find(companyId: CompanyId, gstin: string): Promise<GstinAuthorisation | null> {
    return (await this.#select(companyId, 'a.gstin = $2', [gstin]))[0] ?? null;
  }

  list(companyId: CompanyId): Promise<readonly GstinAuthorisation[]> {
    return this.#select(companyId, 'true', []);
  }

  /**
   * Saves the whole record, as the in-memory store does, into its four tables. The consent and the
   * credentials are histories: a consent is added once and only its withdrawal is written later; a
   * credential is added once and only the moment it was replaced is written later. Both are frozen
   * by the database (#368), so a save that tried to rewrite either is refused with SQLSTATE 23001.
   */
  async put(authorisation: GstinAuthorisation): Promise<void> {
    const { sql } = this.#db.requireUnitOfWork(authorisation.companyId);
    const a = authorisation;
    const values = [
      a.id, a.companyId, a.gstin, a.legalName, a.status, a.provider, a.environment, [...a.scopes], a.apiUserId,
      a.credential?.reference ?? null, a.credential?.issuedAt ?? null, a.credential?.expiresAt ?? null, a.validUntil, a.suspendedReason,
      a.revokedAt, a.revokedBy, a.revocationReason, a.createdAt, a.updatedAt,
    ];
    await sql.query(
      `INSERT INTO gstin_authorisations (${AUTHORISATION_COLUMNS.join(', ')}) VALUES (${AUTHORISATION_COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})
       ON CONFLICT (company_id, gstin) DO UPDATE SET ${AUTHORISATION_UPDATES.map((column) => `${column} = EXCLUDED.${column}`).join(', ')}`,
      values,
    );
    await this.#keepConsent(sql, a);
    await this.#keepCredentials(sql, a);
    await this.#keepChallenge(sql, a);
  }

  async #keepConsent(sql: SqlExecutor, a: GstinAuthorisation): Promise<void> {
    const c = a.consent;
    if (c === null) return;
    await sql.query(
      `INSERT INTO gstin_consents (id, authorisation_id, company_id, scopes, wording_shown, method, granted_by, granted_at, withdrawn_at, withdrawn_by, withdrawal_reason)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET withdrawn_at = EXCLUDED.withdrawn_at, withdrawn_by = EXCLUDED.withdrawn_by, withdrawal_reason = EXCLUDED.withdrawal_reason`,
      [c.id, a.id, a.companyId, [...c.scopes], JSON.stringify(c.wordingShown), c.method, c.grantedBy, c.grantedAt,
        c.withdrawnAt ?? null, c.withdrawnBy ?? null, c.withdrawalReason ?? null],
    );
  }

  /**
   * The credentials in the order they were issued: the history, then the live one. The service only
   * ever appends to that list, so the rows already kept are its first part and only the rest is
   * added. Every row but the live one is marked replaced.
   */
  async #keepCredentials(sql: SqlExecutor, a: GstinAuthorisation): Promise<void> {
    const handles = [...a.credentialHistory, ...(a.credential === null ? [] : [a.credential])];
    const kept = Number((await sql.query(
      'SELECT count(*)::int AS n FROM gsp_credentials WHERE company_id = $1 AND authorisation_id = $2', [a.companyId, a.id],
    )).rows[0]?.n ?? 0);
    if (handles.length < kept) {
      throw notAllowed('GSP_CREDENTIAL_HISTORY_SHRANK', 'A credential this GST number used has gone missing from its history, so nothing was saved.');
    }
    for (const h of handles.slice(kept)) {
      await sql.query(
        `INSERT INTO gsp_credentials (id, authorisation_id, company_id, reference, issued_at, expires_at, rotated_by, rotation_reason)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
        [a.id, a.companyId, h.reference, h.issuedAt, h.expiresAt, h.rotatedBy ?? null, h.rotationReason ?? null],
      );
    }
    await sql.query(
      `UPDATE gsp_credentials k SET superseded_at = $3 WHERE k.company_id = $1 AND k.authorisation_id = $2 AND k.superseded_at IS NULL
         AND (NOT $4::boolean OR k.seq < (SELECT max(m.seq) FROM gsp_credentials m WHERE m.company_id = $1 AND m.authorisation_id = $2))`,
      [a.companyId, a.id, a.updatedAt, a.credential !== null],
    );
  }

  /** The open challenge, if any. Any other challenge still open is closed: at most one is open per GST number. */
  async #keepChallenge(sql: SqlExecutor, a: GstinAuthorisation): Promise<void> {
    const otp = a.otp;
    await sql.query(
      `UPDATE gsp_otp_challenges SET settled_at = $3
        WHERE company_id = $1 AND authorisation_id = $2 AND settled_at IS NULL AND request_id IS DISTINCT FROM $4`,
      [a.companyId, a.id, a.updatedAt, otp?.requestId ?? null],
    );
    if (otp === null) return;
    await sql.query(
      `INSERT INTO gsp_otp_challenges (company_id, request_id, authorisation_id, requested_at, expires_at, attempts_remaining, sent_to_hint)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (company_id, request_id) DO UPDATE SET requested_at = EXCLUDED.requested_at, expires_at = EXCLUDED.expires_at,
         attempts_remaining = EXCLUDED.attempts_remaining, sent_to_hint = EXCLUDED.sent_to_hint, settled_at = NULL`,
      [a.companyId, otp.requestId, a.id, otp.requestedAt, otp.expiresAt, otp.attemptsRemaining, otp.sentToHint],
    );
  }

  #select(companyId: CompanyId, where: string, values: unknown[]): Promise<GstinAuthorisation[]> {
    return this.#db.tenantTransaction(companyId, async (sql) => (await sql.query(
      `SELECT ${AUTHORISATION_SELECT} FROM gstin_authorisations a WHERE a.company_id = $1 AND ${where} ORDER BY a.created_at, a.gstin`,
      [companyId, ...values],
    )).rows.map(toAuthorisation));
  }
}

// ----------------------------------------------------------------------------- the call log

const CALL_COLUMNS = [
  'id', 'company_id', 'gstin', 'operation', 'scope', 'idempotency_key', 'correlation_id', 'document_ref', 'outcome',
  'provider_request_id', 'government_reference', 'error_code', 'error_message', 'refusal', 'attempts', 'credential_reference',
  'started_at', 'settled_at', 'reconciled_at', 'actor_id',
] as const;
const CALL_SELECT = CALL_COLUMNS.map((column) => `c.${column}`).join(', ');

const callValues = (c: ProviderCall): unknown[] => [
  c.id, c.companyId, c.gstin, c.operation, c.scope, c.idempotencyKey, c.correlationId, c.documentRef, c.outcome,
  c.providerRequestId, c.governmentReference, c.errorCode, c.errorMessage, c.refusal, c.attempts, c.credentialReference,
  c.startedAt, c.settledAt, c.reconciledAt, c.actorId,
];

const toCall = (row: Row): ProviderCall => ({
  id: String(row.id),
  companyId: String(row.company_id) as CompanyId,
  gstin: String(row.gstin),
  operation: String(row.operation),
  scope: row.scope as ProviderCall['scope'],
  idempotencyKey: String(row.idempotency_key),
  correlationId: String(row.correlation_id),
  documentRef: textOrNull(row.document_ref),
  outcome: row.outcome as ProviderCall['outcome'],
  providerRequestId: textOrNull(row.provider_request_id),
  governmentReference: textOrNull(row.government_reference),
  errorCode: textOrNull(row.error_code),
  errorMessage: textOrNull(row.error_message),
  refusal: row.refusal as ProviderCall['refusal'],
  attempts: Number(row.attempts),
  credentialReference: textOrNull(row.credential_reference),
  startedAt: iso(row.started_at),
  settledAt: isoOrNull(row.settled_at),
  actorId: String(row.actor_id) as UserId,
  reconciledAt: isoOrNull(row.reconciled_at),
});

/** Keyset paging in start order, ties by the order written. `n` is the first free placeholder. */
const callPage = (n: number): string =>
  `AND ($${n}::uuid IS NULL OR (c.started_at, c.seq) > (SELECT p.started_at, p.seq FROM government_calls p WHERE p.company_id = $1 AND p.id = $${n}::uuid))
   ORDER BY c.started_at, c.seq LIMIT $${n + 1}::int`;
const pageValues = (page?: Page): unknown[] => [page?.after ?? null, page?.limit ?? null];

export class PostgresCallLog implements CallLogRepository {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  async insert(call: ProviderCall): Promise<void> {
    const { sql } = this.#db.requireUnitOfWork(call.companyId);
    await sql.query(
      `INSERT INTO government_calls (${CALL_COLUMNS.join(', ')}) VALUES (${CALL_COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})`,
      callValues(call),
    );
  }

  /**
   * Saves the whole record. Once a call is settled the database lets only `reconciled_at` change,
   * and the government's reference be filled in once (#368, this module's migration); anything else
   * is refused with SQLSTATE 23001 and passed on unchanged. A call that is not there is left alone.
   */
  async settle(call: ProviderCall): Promise<void> {
    const { sql } = this.#db.requireUnitOfWork(call.companyId);
    await sql.query(
      `UPDATE government_calls SET ${CALL_COLUMNS.slice(2).map((column, i) => `${column} = $${i + 3}`).join(', ')}
        WHERE company_id = $2 AND id = $1`,
      callValues(call),
    );
  }

  async find(companyId: CompanyId, id: string): Promise<ProviderCall | null> {
    return (await this.#select(companyId, 'c.id = $2', [id], 'LIMIT 1'))[0] ?? null;
  }

  /** The first call made under this reference, as in memory: a retry writes a row of its own. */
  async findByIdempotencyKey(companyId: CompanyId, key: string): Promise<ProviderCall | null> {
    return (await this.#select(companyId, 'c.idempotency_key = $2', [key], 'ORDER BY c.seq LIMIT 1'))[0] ?? null;
  }

  listUnsettled(companyId: CompanyId, before: string, page?: Page): Promise<readonly ProviderCall[]> {
    return this.#select(companyId, "c.outcome = 'UNKNOWN' AND c.reconciled_at IS NULL AND c.started_at <= $2::timestamptz", [before, ...pageValues(page)], callPage(3));
  }

  list(companyId: CompanyId, gstin?: string, page?: Page): Promise<readonly ProviderCall[]> {
    return this.#select(companyId, '($2::text IS NULL OR c.gstin = $2)', [gstin ?? null, ...pageValues(page)], callPage(3));
  }

  /**
   * Always null on the database, for now. A callback names no company, and `government_calls` is
   * closed to a connection without one, so the honest answer is what row-level security shows:
   * nothing. The callback is recorded as UNMATCHED and reconciliation settles the call by polling.
   * Today that is also the exact answer, because the running app makes no government calls yet
   * (#51). Before the channel is wired on PostgreSQL, #345 must resolve the company from the
   * provider request id first; no bypass of row-level security is built here.
   */
  async findByProviderRequestId(): Promise<ProviderCall | null> {
    return null;
  }

  async findByCorrelationId(): Promise<ProviderCall | null> {
    return null;
  }

  #select(companyId: CompanyId, where: string, values: unknown[], tail: string): Promise<ProviderCall[]> {
    return this.#db.tenantTransaction(companyId, async (sql) => (await sql.query(
      `SELECT ${CALL_SELECT} FROM government_calls c WHERE c.company_id = $1 AND ${where} ${tail}`, [companyId, ...values],
    )).rows.map(toCall));
  }
}
