/**
 * Issue #500 — seal the print copies of bills issued before field encryption (#352) existed.
 *
 * Those rows are `frozen`: the database refuses any UPDATE, so the app role (and the boot sweep
 * `sealStoredAppRecords`) can never encrypt them. This is the one-off the owner signs off on, run
 * as the migration role — the table's owner — never as the server's login.
 *
 * What it changes: only `value`, from plain JSON to the same JSON sealed by `field-encryption.ts`
 * (bound to company, kind and key). `updated_at`, `created_at`, `frozen` and the key are left as
 * issued. Before each row is written the sealed value is opened again and compared with the
 * original; a row that does not round-trip stops the run and nothing is kept.
 *
 * What it never does: delete a row, change a sealed row, or touch a `null` tombstone. The books are
 * kept for the statutory period (CGST Act s.36, CGST Rules rule 56; Companies Act s.128) — this
 * changes how a record is stored at rest, not what it says.
 *
 * Safe to repeat: a row already sealed is skipped, so a second run reports zero. The default is a
 * preview that writes nothing; `apply` needs the name of whoever approved it.
 */
import { deepStrictEqual } from 'node:assert/strict';
import type { AesGcmEncryptionService } from '../../../ops/security/src/encryption.ts';
import type { TransactionalExecutor } from '../../../packages/platform/src/database.ts';
import { APP_FIELD_KEY_ID, appRecordBoundTo, isEncryptedPayload, sealJson, unsealJson } from './field-encryption.ts';

export interface SealFrozenReceipt {
  readonly mode: 'preview' | 'applied';
  readonly approvedBy: string | undefined;
  readonly at: string;
  /** Plain frozen rows found (preview) or sealed (applied), per company. */
  readonly perCompany: Readonly<Record<string, number>>;
  readonly total: number;
}

export const sealFrozenAppRecords = async (
  db: TransactionalExecutor, encryption: AesGcmEncryptionService,
  options: { readonly apply: boolean; readonly approvedBy?: string | undefined; readonly now?: () => Date },
): Promise<SealFrozenReceipt> => {
  const approvedBy = options.approvedBy?.trim() || undefined;
  if (options.apply && approvedBy === undefined) throw new Error('Sealing old bills needs the name of the person who approved it.');
  const perCompany: Record<string, number> = {};
  // One transaction for every company: it all lands or none of it does.
  await db.transaction(async (sql) => {
    await sql.query("SET LOCAL lock_timeout = '30s'");
    const { rows: companies } = await sql.query('SELECT id FROM companies ORDER BY id');
    if (options.apply) await sql.query('ALTER TABLE app_records DISABLE TRIGGER app_records_keep_frozen');
    for (const company of companies) {
      const companyId = String(company.id);
      // Forced row-level security applies to the owner too: act as this company, one at a time.
      await sql.query("SELECT set_config('app.company_id', $1, true)", [companyId]);
      const { rows } = await sql.query(
        "SELECT kind, key, value FROM app_records WHERE company_id = $1 AND frozen = true AND value <> 'null'::jsonb", [companyId]);
      let count = 0;
      for (const row of rows) {
        if (isEncryptedPayload(row.value)) continue;
        count += 1;
        if (!options.apply) continue;
        const kind = String(row.kind); const key = String(row.key);
        const boundTo = appRecordBoundTo(companyId, kind, key);
        const sealed = await sealJson(encryption, APP_FIELD_KEY_ID, JSON.stringify(row.value), boundTo);
        deepStrictEqual(await unsealJson(encryption, sealed, boundTo), row.value);
        const { rows: written } = await sql.query(
          'UPDATE app_records SET value = $4::jsonb WHERE company_id = $1 AND kind = $2 AND key = $3 AND frozen = true RETURNING key', [companyId, kind, key, JSON.stringify(sealed)]);
        if (written.length !== 1) throw new Error(`A bill copy could not be sealed (${companyId}/${kind}/${key}); nothing was changed.`);
      }
      if (count > 0) perCompany[companyId] = count;
    }
    if (options.apply) await sql.query('ALTER TABLE app_records ENABLE TRIGGER app_records_keep_frozen');
  });
  const total = Object.values(perCompany).reduce((sum, n) => sum + n, 0);
  return { mode: options.apply ? 'applied' : 'preview', approvedBy, at: (options.now?.() ?? new Date()).toISOString(), perCompany, total };
};
