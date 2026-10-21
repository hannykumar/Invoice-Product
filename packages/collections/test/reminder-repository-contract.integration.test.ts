/**
 * Issue #366 — the reminder repository contract on a real PostgreSQL, connected as the application
 * role (`invoice_app`), so row-level security and the missing DELETE grant are really in force.
 *
 * Needs DATABASE_URL. Without it the tests are skipped locally, and fail in CI so they can never
 * pass there by not running.
 */
import { randomBytes } from 'node:crypto';
import { after, before } from 'node:test';
import type { BranchId, CompanyId } from '@invoice/kernel';
import type { TransactionalExecutor } from '../../platform/src/database.ts';
import type { ReminderRepository } from '../src/ports.ts';
import { reminderRepositoryContract } from './reminder-repository-contract.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the collections database tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';

let owner: TransactionalExecutor;
let app: TransactionalExecutor;
let repository: ReminderRepository;
const login = `invoice_app_test_${randomBytes(6).toString('hex')}`;

before(async () => {
  if (url === undefined) return;
  const { createDatabase } = await import('../../platform/src/database.ts');
  const { migrate } = await import('../../platform/src/migrations.ts');
  const { PostgresReminderRepository } = await import('../src/postgres-repository.ts');
  owner = createDatabase(url);
  await migrate(owner);
  const password = randomBytes(18).toString('hex');
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const appUrl = new URL(url);
  appUrl.username = login;
  appUrl.password = password;
  app = createDatabase(appUrl.toString());
  repository = new PostgresReminderRepository(app);
});
after(async () => {
  await app?.close();
  if (owner !== undefined) { await owner.query(`DROP ROLE IF EXISTS ${login}`); await owner.close(); }
});

reminderRepositoryContract('postgres', () => ({
  repository,
  company: async () => {
    const ids = { companyId: crypto.randomUUID() as CompanyId, branchId: crypto.randomUUID() as BranchId };
    // The owner sets the scene; the repository under test only ever runs as the application role.
    await owner.query("INSERT INTO companies (id, legal_name) VALUES ($1, 'Synthetic Collections Traders')", [ids.companyId]);
    await owner.query("INSERT INTO branches (id, company_id, name) VALUES ($1, $2, 'Main shop')", [ids.branchId, ids.companyId]);
    return ids;
  },
  write: (companyId, work) => app.unitOfWork(companyId, () => work()),
  transactional: true,
}), skip);
