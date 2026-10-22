/**
 * Issue #366 — the bank-feed records (#24) in PostgreSQL, behind the same port as the in-memory store.
 *
 * Built on the transaction executor; it never opens a transaction of its own. Every write joins the
 * action's unit of work (`requireUnitOfWork`, which throws `NO_UNIT_OF_WORK` when none is open),
 * every read runs in `tenantTransaction`, and every query names its company as well as relying on
 * row-level security. The audit trail goes to `audit_events` through PostgresAuditLog, which joins
 * the same unit of work. Contracts: docs/contracts/unit-of-work-v1.md, database-immutability-v1.md.
 */
import type { SqlExecutor, TransactionalExecutor } from '../../platform/src/database.ts';
import { PostgresAuditLog } from '../../platform/src/postgres-audit.ts';
import type { BankFeedAccount, BankFeedAuditEvent, BankFeedConnection, BankFeedTransaction, SyncResult } from './model.ts';
import { providerKey, type BankFeedStore, type Page } from './store.ts';

type Row = Record<string, unknown>;

const iso = (value: unknown): string | null => (value === null ? null : value instanceof Date ? value.toISOString() : String(value));
const frozen = <T>(value: T): T => Object.freeze(value);

/** `n` is the first free placeholder; `scope` the columns before seq in the paging index. */
const pageSql = (table: string, scope: string, n: number): string =>
  `AND ($${n}::uuid IS NULL OR t.seq > (SELECT p.seq FROM ${table} p WHERE ${scope.split(',').map((column, index) => `p.${column.trim()} = $${index + 1}`).join(' AND ')} AND p.id = $${n}::uuid))
   ORDER BY t.seq LIMIT $${n + 1}::int`;
const pageValues = (page?: Page): unknown[] => [page?.after ?? null, page?.limit ?? null];

const CONNECTION = `t.id, t.company_id, t.provider, t.provider_consent_id, t.consent_url, t.status, t.consent_expires_at, t.connected_at,
  t.disconnected_at, t.last_synced_at, t.sync_status, t.last_error, t.created_at`;
const connection = (r: Row): BankFeedConnection => frozen({
  id: String(r.id), companyId: String(r.company_id), provider: String(r.provider),
  providerConsentId: r.provider_consent_id === null ? null : String(r.provider_consent_id),
  consentUrl: r.consent_url === null ? null : String(r.consent_url),
  status: r.status as BankFeedConnection['status'], consentExpiresAt: iso(r.consent_expires_at), connectedAt: iso(r.connected_at),
  disconnectedAt: iso(r.disconnected_at), lastSyncedAt: iso(r.last_synced_at), syncStatus: r.sync_status as BankFeedConnection['syncStatus'],
  lastError: r.last_error === null ? null : String(r.last_error), createdAt: iso(r.created_at)!,
});

const ACCOUNT = `t.id, t.company_id, t.connection_id, t.provider_account_id, t.display_name, t.masked_account_number, t.account_type,
  t.currency, t.balance_paise::text AS balance_paise, t.balance_as_of, t.cursor, t.active`;
const account = (r: Row): BankFeedAccount => frozen({
  id: String(r.id), companyId: String(r.company_id), connectionId: String(r.connection_id), providerAccountId: String(r.provider_account_id),
  displayName: String(r.display_name), maskedAccountNumber: String(r.masked_account_number), accountType: r.account_type as BankFeedAccount['accountType'],
  currency: 'INR', balancePaise: r.balance_paise === null ? null : BigInt(String(r.balance_paise)), balanceAsOf: iso(r.balance_as_of),
  cursor: r.cursor === null ? null : String(r.cursor), active: Boolean(r.active),
});

const TRANSACTION = `t.id, t.company_id, t.connection_id, t.account_id, t.provider_transaction_id, t.booked_on::text AS booked_on, t.description,
  t.debit_paise::text AS debit_paise, t.credit_paise::text AS credit_paise, t.reference, t.fingerprint, t.imported_at`;
const transaction = (r: Row): BankFeedTransaction => frozen({
  id: String(r.id), companyId: String(r.company_id), connectionId: String(r.connection_id), accountId: String(r.account_id),
  providerTransactionId: String(r.provider_transaction_id), bookedOn: String(r.booked_on), description: String(r.description),
  debitPaise: BigInt(String(r.debit_paise)), creditPaise: BigInt(String(r.credit_paise)),
  ...(r.reference === null ? {} : { reference: String(r.reference) }), fingerprint: String(r.fingerprint), importedAt: iso(r.imported_at)!,
});

export class PostgresBankFeedStore implements BankFeedStore {
  readonly #db: TransactionalExecutor;
  readonly #audit: PostgresAuditLog;
  constructor(db: TransactionalExecutor) { this.#db = db; this.#audit = new PostgresAuditLog(db); }

  /** A unit of work of its own, or a savepoint inside the caller's if one is already open. */
  action<T>(companyId: string, work: () => Promise<T>): Promise<T> { return this.#db.unitOfWork(companyId, () => work()); }
  #read<T>(companyId: string, work: (sql: SqlExecutor) => Promise<T>): Promise<T> { return this.#db.tenantTransaction(companyId, work); }
  #write(companyId: string): SqlExecutor { return this.#db.requireUnitOfWork(companyId).sql; }

  connection(companyId: string, id: string): Promise<BankFeedConnection | null> {
    return this.#read(companyId, async (sql) => {
      const row = (await sql.query(`SELECT ${CONNECTION} FROM bank_feed_connections t WHERE t.company_id = $1 AND t.id = $2::uuid`, [companyId, id])).rows[0];
      return row === undefined ? null : connection(row);
    });
  }

  connections(companyId: string, page?: Page): Promise<readonly BankFeedConnection[]> {
    return this.#read(companyId, async (sql) => frozen((await sql.query(
      `SELECT ${CONNECTION} FROM bank_feed_connections t WHERE t.company_id = $1 ${pageSql('bank_feed_connections', 'company_id', 2)}`,
      [companyId, ...pageValues(page)])).rows.map(connection)));
  }

  async saveConnection(c: BankFeedConnection): Promise<void> {
    await this.#write(c.companyId).query(
      `INSERT INTO bank_feed_connections (id, company_id, provider, provider_consent_id, consent_url, status, consent_expires_at, connected_at,
         disconnected_at, last_synced_at, sync_status, last_error, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (id) DO UPDATE SET provider_consent_id = EXCLUDED.provider_consent_id, consent_url = EXCLUDED.consent_url,
         status = EXCLUDED.status, consent_expires_at = EXCLUDED.consent_expires_at, connected_at = EXCLUDED.connected_at,
         disconnected_at = EXCLUDED.disconnected_at, last_synced_at = EXCLUDED.last_synced_at, sync_status = EXCLUDED.sync_status,
         last_error = EXCLUDED.last_error
       WHERE bank_feed_connections.company_id = EXCLUDED.company_id`,
      [c.id, c.companyId, c.provider, c.providerConsentId, c.consentUrl, c.status, c.consentExpiresAt, c.connectedAt, c.disconnectedAt, c.lastSyncedAt, c.syncStatus, c.lastError, c.createdAt],
    );
  }

  accounts(companyId: string, connectionId: string, page?: Page): Promise<readonly BankFeedAccount[]> {
    return this.#read(companyId, async (sql) => frozen((await sql.query(
      `SELECT ${ACCOUNT} FROM bank_feed_accounts t WHERE t.company_id = $1 AND t.connection_id = $2::uuid ${pageSql('bank_feed_accounts', 'company_id, connection_id', 3)}`,
      [companyId, connectionId, ...pageValues(page)])).rows.map(account)));
  }

  async saveAccount(a: BankFeedAccount): Promise<void> {
    await this.#write(a.companyId).query(
      `INSERT INTO bank_feed_accounts (id, company_id, connection_id, provider_account_id, display_name, masked_account_number, account_type,
         currency, balance_paise, balance_as_of, cursor, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::bigint, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, masked_account_number = EXCLUDED.masked_account_number,
         account_type = EXCLUDED.account_type, balance_paise = EXCLUDED.balance_paise, balance_as_of = EXCLUDED.balance_as_of,
         cursor = EXCLUDED.cursor, active = EXCLUDED.active
       WHERE bank_feed_accounts.company_id = EXCLUDED.company_id AND bank_feed_accounts.connection_id = EXCLUDED.connection_id`,
      [a.id, a.companyId, a.connectionId, a.providerAccountId, a.displayName, a.maskedAccountNumber, a.accountType, a.currency, a.balancePaise?.toString() ?? null, a.balanceAsOf, a.cursor, a.active],
    );
  }

  async knownProviderTransactions(companyId: string, keys: readonly { accountId: string; providerTransactionId: string }[]): Promise<ReadonlySet<string>> {
    if (keys.length === 0) return new Set();
    return this.#read(companyId, async (sql) => new Set((await sql.query(
      `SELECT t.account_id, t.provider_transaction_id FROM bank_feed_transactions t
        JOIN unnest($2::uuid[], $3::text[]) AS k(account_id, provider_transaction_id)
          ON t.account_id = k.account_id AND t.provider_transaction_id = k.provider_transaction_id
       WHERE t.company_id = $1`,
      [companyId, keys.map((key) => key.accountId), keys.map((key) => key.providerTransactionId)])).rows
      .map((r) => providerKey(String(r.account_id), String(r.provider_transaction_id)))));
  }

  async addTransactions(transactions: readonly BankFeedTransaction[]): Promise<void> {
    const companyId = transactions[0]?.companyId;
    if (companyId === undefined) return;
    if (transactions.some((t) => t.companyId !== companyId)) throw new Error('Bank transactions of two companies cannot be saved together.');
    // One statement for the whole page, in the order given (WITH ORDINALITY), so seq keeps it.
    await this.#write(companyId).query(
      `INSERT INTO bank_feed_transactions (id, company_id, connection_id, account_id, provider_transaction_id, booked_on, description,
         debit_paise, credit_paise, reference, fingerprint, imported_at)
       SELECT r.id, $1, r.connection_id, r.account_id, r.provider_transaction_id, r.booked_on, r.description, r.debit_paise, r.credit_paise,
              r.reference, r.fingerprint, r.imported_at
         FROM ROWS FROM (jsonb_to_recordset($2::jsonb) AS (id uuid, connection_id uuid, account_id uuid, provider_transaction_id text,
              booked_on date, description text, debit_paise bigint, credit_paise bigint, reference text, fingerprint text, imported_at timestamptz))
              WITH ORDINALITY AS r(id, connection_id, account_id, provider_transaction_id, booked_on, description, debit_paise, credit_paise,
              reference, fingerprint, imported_at, n)
        ORDER BY r.n`,
      [companyId, JSON.stringify(transactions.map((t) => ({
        id: t.id, connection_id: t.connectionId, account_id: t.accountId, provider_transaction_id: t.providerTransactionId, booked_on: t.bookedOn,
        description: t.description, debit_paise: t.debitPaise.toString(), credit_paise: t.creditPaise.toString(), reference: t.reference ?? null,
        fingerprint: t.fingerprint, imported_at: t.importedAt,
      })))],
    );
  }

  transactions(companyId: string, connectionId: string, page?: Page): Promise<readonly BankFeedTransaction[]> {
    return this.#read(companyId, async (sql) => frozen((await sql.query(
      `SELECT ${TRANSACTION} FROM bank_feed_transactions t WHERE t.company_id = $1 AND t.connection_id = $2::uuid ${pageSql('bank_feed_transactions', 'company_id, connection_id', 3)}`,
      [companyId, connectionId, ...pageValues(page)])).rows.map(transaction)));
  }

  countTransactions(companyId: string, connectionId: string): Promise<number> {
    return this.#read(companyId, async (sql) => Number((await sql.query(
      'SELECT count(*)::int AS n FROM bank_feed_transactions WHERE company_id = $1 AND connection_id = $2::uuid', [companyId, connectionId])).rows[0]!.n));
  }

  syncResult(companyId: string, connectionId: string, idempotencyKey: string): Promise<SyncResult | null> {
    return this.#read(companyId, async (sql) => {
      const row = (await sql.query(
        `SELECT connection, imported, duplicates, transaction_ids FROM bank_feed_syncs
          WHERE company_id = $1 AND connection_id = $2::uuid AND idempotency_key = $3`, [companyId, connectionId, idempotencyKey])).rows[0];
      if (row === undefined) return null;
      const lines = (await sql.query(
        `SELECT ${TRANSACTION} FROM bank_feed_transactions t WHERE t.company_id = $1 AND t.id = ANY($2::uuid[]) ORDER BY t.seq`,
        [companyId, row.transaction_ids])).rows.map(transaction);
      return frozen({ connection: frozen(row.connection as BankFeedConnection), imported: Number(row.imported), duplicates: Number(row.duplicates), transactions: frozen(lines) });
    });
  }

  async saveSyncResult(companyId: string, connectionId: string, idempotencyKey: string, result: SyncResult): Promise<void> {
    await this.#write(companyId).query(
      `INSERT INTO bank_feed_syncs (company_id, connection_id, idempotency_key, connection, imported, duplicates, transaction_ids)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::uuid[])`,
      [companyId, connectionId, idempotencyKey, JSON.stringify(result.connection), result.imported, result.duplicates, result.transactions.map((t) => t.id)],
    );
  }

  async record(event: BankFeedAuditEvent): Promise<void> {
    this.#write(event.companyId); // refuses outside a unit of work, as every other write here does
    await this.#audit.append({ companyId: event.companyId, actorId: event.actorId, action: event.action, correlationId: event.connectionId, before: null, after: { ...event.details } }, event.occurredAt);
  }

  audit(companyId: string, connectionId?: string, page?: Page): Promise<readonly BankFeedAuditEvent[]> {
    return this.#read(companyId, async (sql) => frozen((await sql.query(
      `SELECT t.id, t.company_id, t.actor_id, t.action, t.correlation_id, t.after_json, t.occurred_at FROM audit_events t
        WHERE t.company_id = $1 AND t.action LIKE 'bank_feed.%' AND ($2::text IS NULL OR t.correlation_id = $2)
          AND ($3::uuid IS NULL OR t.seq > (SELECT p.seq FROM audit_events p WHERE p.company_id = $1 AND p.id = $3::uuid))
        ORDER BY t.seq LIMIT $4::int`,
      [companyId, connectionId ?? null, ...pageValues(page)])).rows.map((r) => frozen({
      id: String(r.id), companyId: String(r.company_id), actorId: String(r.actor_id), action: r.action as BankFeedAuditEvent['action'],
      connectionId: String(r.correlation_id), occurredAt: iso(r.occurred_at)!, details: frozen((r.after_json ?? {}) as Record<string, unknown>),
    }))));
  }
}
