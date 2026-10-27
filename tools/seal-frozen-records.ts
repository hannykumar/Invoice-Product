/**
 * Issue #500 — one-off: seal old frozen bill copies. Run as the migration role, never the server's.
 *
 *   DATABASE_URL=… APP_ENCRYPTION_KEYS=… npm run db:seal-frozen                     # preview, writes nothing
 *   DATABASE_URL=… APP_ENCRYPTION_KEYS=… npm run db:seal-frozen -- --apply --approved-by "Owner name"
 *
 * Keep the printed receipt with the release record; it is the audit of this run.
 */
import { appEncryption } from '../apps/api/src/field-encryption.ts';
import { sealFrozenAppRecords } from '../apps/api/src/seal-frozen-records.ts';
import { createDatabase } from '../packages/platform/src/database.ts';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const at = args.indexOf('--approved-by');
const approvedBy = at >= 0 ? args[at + 1] : undefined;
const db = createDatabase();
try {
  const receipt = await sealFrozenAppRecords(db, appEncryption(), { apply, approvedBy });
  console.log(JSON.stringify(receipt, null, 2));
  if (!apply) console.log('Preview only — nothing was changed. Add --apply --approved-by "<name>" to seal these.');
} finally {
  await db.close();
}
