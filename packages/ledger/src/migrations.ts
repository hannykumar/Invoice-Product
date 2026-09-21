import { readFileSync } from 'node:fs';
import type { Migration } from '../../platform/src/migration-definitions.ts';

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
}]);
