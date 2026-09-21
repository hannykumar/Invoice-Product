/**
 * Issue #201 — the ledger on PostgreSQL, over the schema in `migrations/0001_ledger.sql`.
 *
 * It has the same shape as the in-memory store: one transaction per command, one command at a
 * time per company (a transaction-scoped advisory lock stands in for the in-memory promise chain),
 * and nothing half-written when a command fails.
 *
 * Another module's repository joins the posting's transaction through `withSql`: called inside
 * `transaction`, it gets that transaction's connection, so a note and the voucher it posts commit
 * or roll back together. This file never imports `pg`; the caller hands in a database.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { conflict, money, type CompanyId, type IsoDate, type UserId } from '@invoice/kernel';
import type { Account } from '../domain/account.ts';
import type { FiscalPeriod } from '../domain/period.ts';
import type { JournalLine, Voucher } from '../domain/voucher.ts';
import type { LedgerStore, UnitOfWork } from '../ports.ts';

export interface Sql {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** What `createDatabase()` in `packages/platform/src/database.ts` returns. */
export interface SqlDatabase extends Sql {
  tenantTransaction<T>(companyId: string, work: (sql: Sql) => Promise<T>): Promise<T>;
}

type Row = Record<string, unknown>;
const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
const UNIQUE_VIOLATION = '23505';
const isUnique = (error: unknown, constraint: string): boolean =>
  (error as { code?: string; constraint?: string }).code === UNIQUE_VIOLATION &&
  (error as { constraint?: string }).constraint === constraint;

const ACCOUNT_COLUMNS = 'id, company_id, code, name, type, parent_id, is_group, active, party_id, system_role';
const toAccount = (r: Row): Account => ({
  id: r.id as Account['id'], companyId: r.company_id as CompanyId, code: String(r.code), name: String(r.name),
  type: r.type as Account['type'], parentId: text(r.parent_id) as Account['parentId'], isGroup: Boolean(r.is_group),
  active: Boolean(r.active), partyId: text(r.party_id) as Account['partyId'], systemRole: text(r.system_role) as Account['systemRole'],
});

const VOUCHER_COLUMNS = `id, company_id, branch_id, type, number, document_date::text AS document_date, state, narration,
  source_kind, source_id, source_number, idempotency_key, created_by, created_at, reversed_by_voucher_id,
  reverses_voucher_id, amends_voucher_id, reason`;

const unitOfWork = (sql: Sql): UnitOfWork => {
  const vouchersWithLines = async (companyId: CompanyId, headers: Row[]): Promise<Voucher[]> => {
    if (headers.length === 0) return [];
    const lines = await sql.query(
      `SELECT id, voucher_id, line_no, account_id, party_id, debit_minor::text AS debit, credit_minor::text AS credit, narration
         FROM journal_line WHERE company_id = $1 AND voucher_id = ANY($2::uuid[]) ORDER BY voucher_id, line_no`,
      [companyId, headers.map((h) => h.id)],
    );
    const byVoucher = new Map<string, JournalLine[]>();
    for (const l of lines.rows) {
      const list = byVoucher.get(String(l.voucher_id)) ?? [];
      list.push({
        id: l.id as JournalLine['id'], voucherId: l.voucher_id as JournalLine['voucherId'], lineNo: Number(l.line_no),
        accountId: l.account_id as JournalLine['accountId'], partyId: text(l.party_id) as JournalLine['partyId'],
        debit: money(BigInt(String(l.debit))), credit: money(BigInt(String(l.credit))), narration: text(l.narration),
      });
      byVoucher.set(String(l.voucher_id), list);
    }
    return headers.map((r) => ({
      id: r.id as Voucher['id'], companyId: r.company_id as CompanyId, branchId: text(r.branch_id) as Voucher['branchId'],
      type: r.type as Voucher['type'], number: String(r.number), date: r.document_date as IsoDate,
      state: r.state as Voucher['state'], narration: text(r.narration),
      source: r.source_kind === null ? null : { kind: String(r.source_kind), id: String(r.source_id), number: text(r.source_number) },
      lines: byVoucher.get(String(r.id)) ?? [], idempotencyKey: String(r.idempotency_key), createdBy: r.created_by as UserId,
      createdAt: iso(r.created_at), reversedByVoucherId: text(r.reversed_by_voucher_id) as Voucher['reversedByVoucherId'],
      reversesVoucherId: text(r.reverses_voucher_id) as Voucher['reversesVoucherId'],
      amendsVoucherId: text(r.amends_voucher_id) as Voucher['amendsVoucherId'], reason: text(r.reason),
    }));
  };
  const oneAccount = async (where: string, values: unknown[]): Promise<Account | null> => {
    const { rows } = await sql.query(`SELECT ${ACCOUNT_COLUMNS} FROM account WHERE ${where} LIMIT 1`, values);
    return rows[0] === undefined ? null : toAccount(rows[0]);
  };
  const toPeriod = (r: Row): FiscalPeriod => ({
    id: r.id as FiscalPeriod['id'], companyId: r.company_id as CompanyId, monthKey: String(r.month_key),
    financialYear: String(r.financial_year), state: r.state as FiscalPeriod['state'], lockedBy: text(r.locked_by) as UserId | null,
    lockedAt: r.locked_at === null ? null : iso(r.locked_at), reason: text(r.reason),
  });

  return {
    accounts: {
      findById: (companyId, id) => oneAccount('company_id = $1 AND id = $2', [companyId, id]),
      async findManyByIds(companyId, ids) {
        const { rows } = await sql.query(`SELECT ${ACCOUNT_COLUMNS} FROM account WHERE company_id = $1 AND id = ANY($2::uuid[])`, [companyId, ids]);
        return rows.map(toAccount);
      },
      findByCode: (companyId, code) => oneAccount('company_id = $1 AND code = $2', [companyId, code]),
      findBySystemRole: (companyId, role) => oneAccount('company_id = $1 AND system_role = $2', [companyId, role]),
      findByPartyId: (companyId, partyId) => oneAccount('company_id = $1 AND party_id = $2 ORDER BY code', [companyId, partyId]),
      async listAll(companyId) {
        const { rows } = await sql.query(`SELECT ${ACCOUNT_COLUMNS} FROM account WHERE company_id = $1 ORDER BY code`, [companyId]);
        return rows.map(toAccount);
      },
      async insertMany(accounts) {
        // Parents first, so the parent_id foreign key is satisfied whatever order the chart came in.
        const pending = [...accounts];
        const inserted = new Set<string>();
        while (pending.length > 0) {
          const ready = pending.findIndex((a) => a.parentId === null || inserted.has(a.parentId) || !pending.some((p) => p.id === a.parentId));
          const [a] = pending.splice(ready === -1 ? 0 : ready, 1) as [Account];
          await sql.query(
            `INSERT INTO account (${ACCOUNT_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [a.id, a.companyId, a.code, a.name, a.type, a.parentId, a.isGroup, a.active, a.partyId, a.systemRole],
          );
          inserted.add(a.id);
        }
      },
    },
    vouchers: {
      async findById(companyId, id) {
        const { rows } = await sql.query(`SELECT ${VOUCHER_COLUMNS} FROM voucher WHERE company_id = $1 AND id = $2`, [companyId, id]);
        return (await vouchersWithLines(companyId, rows))[0] ?? null;
      },
      async insert(v) {
        const debit = v.lines.reduce((total, l) => total + l.debit.minor, 0n);
        const credit = v.lines.reduce((total, l) => total + l.credit.minor, 0n);
        try {
          await sql.query(
            `INSERT INTO voucher (id, company_id, branch_id, type, number, document_date, state, narration, source_kind, source_id,
               source_number, idempotency_key, created_by, created_at, reversed_by_voucher_id, reverses_voucher_id, amends_voucher_id,
               reason, total_debit_minor, total_credit_minor)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
            [v.id, v.companyId, v.branchId, v.type, v.number, v.date, v.state, v.narration, v.source?.kind ?? null, v.source?.id ?? null,
              v.source?.number ?? null, v.idempotencyKey, v.createdBy, v.createdAt, v.reversedByVoucherId, v.reversesVoucherId,
              v.amendsVoucherId, v.reason, debit.toString(), credit.toString()],
          );
        } catch (error) {
          if (isUnique(error, 'voucher_number_unique')) throw conflict('LEDGER_DUPLICATE_NUMBER', `Entry number ${v.number} was already used.`);
          throw error;
        }
        for (const l of v.lines) {
          await sql.query(
            `INSERT INTO journal_line (id, company_id, voucher_id, line_no, account_id, party_id, debit_minor, credit_minor, narration)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [l.id, v.companyId, v.id, l.lineNo, l.accountId, l.partyId, l.debit.minor.toString(), l.credit.minor.toString(), l.narration],
          );
        }
      },
      async markReversed(companyId, id, reversedBy, reason) {
        await sql.query(
          `UPDATE voucher SET state = 'REVERSED', reversed_by_voucher_id = $3, reason = $4 WHERE company_id = $1 AND id = $2`,
          [companyId, id, reversedBy, reason],
        );
      },
      async list(companyId, filter) {
        const where = ['company_id = $1'];
        const values: unknown[] = [companyId];
        const add = (clause: string, value: unknown) => { values.push(value); where.push(clause.replace('?', `$${values.length}`)); };
        if (filter.from !== undefined) add('document_date >= ?', filter.from);
        if (filter.to !== undefined) add('document_date <= ?', filter.to);
        if (filter.types !== undefined) add('type::text = ANY(?::text[])', filter.types);
        if (filter.includeStates !== undefined) add('state::text = ANY(?::text[])', filter.includeStates);
        if (filter.accountId !== undefined) add('id IN (SELECT voucher_id FROM journal_line WHERE account_id = ?)', filter.accountId);
        if (filter.partyId !== undefined) add('id IN (SELECT voucher_id FROM journal_line WHERE party_id = ?)', filter.partyId);
        const { rows } = await sql.query(`SELECT ${VOUCHER_COLUMNS} FROM voucher WHERE ${where.join(' AND ')} ORDER BY document_date, number`, values);
        return vouchersWithLines(companyId, rows);
      },
    },
    periods: {
      async find(companyId, monthKey) {
        const { rows } = await sql.query('SELECT * FROM fiscal_period WHERE company_id = $1 AND month_key = $2', [companyId, monthKey]);
        return rows[0] === undefined ? null : toPeriod(rows[0]);
      },
      async upsertState(companyId, monthKey, financialYear, state, lockedBy, lockedAt, reason) {
        const { rows } = await sql.query(
          `INSERT INTO fiscal_period (id, company_id, month_key, financial_year, state, locked_by, locked_at, reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (company_id, month_key) DO UPDATE SET financial_year = EXCLUDED.financial_year, state = EXCLUDED.state,
             locked_by = EXCLUDED.locked_by, locked_at = EXCLUDED.locked_at, reason = EXCLUDED.reason
           RETURNING *`,
          [crypto.randomUUID(), companyId, monthKey, financialYear, state, lockedBy, lockedAt, reason],
        );
        return toPeriod(rows[0] as Row);
      },
      async list(companyId, financialYear) {
        const { rows } = await sql.query(
          'SELECT * FROM fiscal_period WHERE company_id = $1 AND ($2::text IS NULL OR financial_year = $2) ORDER BY month_key',
          [companyId, financialYear ?? null],
        );
        return rows.map(toPeriod);
      },
    },
    sequences: {
      async next(companyId, scope) {
        const { rows } = await sql.query(
          `INSERT INTO ledger_sequence (company_id, scope, value) VALUES ($1, $2, 1)
           ON CONFLICT (company_id, scope) DO UPDATE SET value = ledger_sequence.value + 1 RETURNING value`,
          [companyId, scope],
        );
        return Number(rows[0]?.value);
      },
    },
    settings: {
      async get(companyId) {
        const { rows } = await sql.query('SELECT books_start_date::text AS books_start_date FROM ledger_settings WHERE company_id = $1', [companyId]);
        return rows[0] === undefined ? null : { companyId, booksStartDate: rows[0].books_start_date as IsoDate };
      },
      async put(value) {
        await sql.query(
          `INSERT INTO ledger_settings (company_id, books_start_date) VALUES ($1, $2)
           ON CONFLICT (company_id) DO UPDATE SET books_start_date = EXCLUDED.books_start_date`,
          [value.companyId, value.booksStartDate],
        );
      },
    },
    idempotency: {
      async lookup(companyId, key) {
        const { rows } = await sql.query('SELECT result_id FROM idempotency_record WHERE company_id = $1 AND key = $2', [companyId, key]);
        return text(rows[0]?.result_id);
      },
      async remember(companyId, key, resultId) {
        try {
          await sql.query('INSERT INTO idempotency_record (company_id, key, result_id) VALUES ($1, $2, $3)', [companyId, key, resultId]);
        } catch (error) {
          if (isUnique(error, 'idempotency_record_pkey')) throw conflict('IDEMPOTENCY_KEY_TAKEN', 'This action was already recorded.');
          throw error;
        }
      },
    },
  };
};

export class PostgresLedgerStore implements LedgerStore {
  readonly #db: SqlDatabase;
  readonly #current = new AsyncLocalStorage<{ companyId: string; sql: Sql }>();

  constructor(db: SqlDatabase) { this.#db = db; }

  transaction<T>(companyId: CompanyId, work: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    return this.#db.tenantTransaction(companyId, async (sql) => {
      // One command at a time per company, as the in-memory store does; released at commit or rollback.
      await sql.query('SELECT pg_advisory_xact_lock(hashtext($1))', [companyId]);
      return this.#current.run({ companyId, sql }, () => work(unitOfWork(sql)));
    });
  }

  read(): UnitOfWork { return unitOfWork(this.#db); }

  /** Runs `work` on the open transaction for this company, or in a short one of its own. */
  withSql<T>(companyId: CompanyId, work: (sql: Sql) => Promise<T>): Promise<T> {
    const open = this.#current.getStore();
    if (open !== undefined && open.companyId === companyId) return work(open.sql);
    return this.#db.tenantTransaction(companyId, work);
  }
}
