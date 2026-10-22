import { readFileSync } from 'node:fs';
import type { Migration } from '../../platform/src/migration-definitions.ts';
import { tenantPolicy } from '../../platform/src/immutability-migrations.ts';

/** Issue #366 — every ledger table, each holding one company's rows. */
const TABLES = ['account', 'voucher', 'journal_line', 'fiscal_period', 'ledger_sequence', 'ledger_settings', 'idempotency_record'] as const;

// Issue #201 — `0001_ledger.sql` was written before the migration runner existed and was applied
// by hand. The runner now applies it like every other module's schema. The file is not edited
// (merged migrations never are); only its own BEGIN/COMMIT is dropped, because the runner decides
// the transaction.
const schema = readFileSync(new URL('../migrations/0001_ledger.sql', import.meta.url), 'utf8').replace(/^(BEGIN|COMMIT);$/gm, '');

export const ledgerMigrations: readonly Migration[] = Object.freeze([{
  id: '20260921T220435615Z_ledger_668ff62a3b9a_ledger_schema',
  up: schema,
  down: `
    DROP TABLE IF EXISTS journal_line, voucher, idempotency_record, ledger_sequence, fiscal_period, account, ledger_settings;
    DROP FUNCTION IF EXISTS ledger_voucher_immutable(), ledger_voucher_no_delete(), ledger_line_immutable(), ledger_voucher_balanced();
    DROP TYPE IF EXISTS period_state, voucher_state, voucher_type, account_type;
  `,
}, {
  // Issue #366 — a company sees and writes only its own books. `PostgresLedgerStore` reads through
  // `tenantTransaction` and writes inside the unit of work, both of which set `app.company_id`; a
  // connection that sets no company sees no rows at all. The trigger functions run as the caller,
  // so the balance check now looks only at the acting company's entries.
  id: '20261016T014720841Z_ledger_02932a3a6748_row_level_security',
  up: TABLES.map(tenantPolicy).join(''),
  down: TABLES.map((table) => `
    DROP POLICY IF EXISTS ${table}_tenant ON ${table};
    ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`).join(''),
}, {
  // Issue #366 — a journal line can only belong to an entry of its own company. Under row-level
  // security nobody can see such a line, but it should not exist at all. Rests on
  // voucher_company_id_id_key (#365).
  id: '20261022T165155765Z_ledger_ddbad2c97938_journal_line_same_company',
  up: `ALTER TABLE journal_line ADD CONSTRAINT journal_line_same_company_fk FOREIGN KEY (company_id, voucher_id) REFERENCES voucher (company_id, id);`,
  down: `ALTER TABLE journal_line DROP CONSTRAINT IF EXISTS journal_line_same_company_fk;`,
}]);
