/** Authenticated HTTP runtime: session (sign-in.ts) -> membership -> tenant application. */
import { asId, notFound } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import { PlatformError, type Permission, type RequestContext } from '../../../packages/platform/src/index.ts';
import { PRODUCT_OWNER_PERMISSIONS, SYNTHETIC_PLATFORM_COMPANIES } from '../../../packages/platform/src/seed.ts';
import { DemoApplication } from './demo-application.ts';
import { businessDetailsOf, saveBusinessDetails } from './business-details-application.ts';
import type { CompanySeed } from './company-shop.ts';
import type { CatalogueSeed } from './catalogue-application.ts';
import { createOperations, type QueueJob, type RecurringJobDefinition } from '../../../ops/operations/src/index.ts';
import { PostgresOperationsStore } from '../../../ops/operations/src/postgres-store.ts';
import { PostgresRecurringWork } from '../../../ops/operations/src/recurring-postgres.ts';
import { OutboxRelay } from '../../../packages/platform/src/outbox.ts';
import { PostgresAuditLog } from '../../../packages/platform/src/postgres-audit.ts';
import { MEMORY, recordId, securityOf, type Persistence } from './persistence.ts';
import type { TransactionalExecutor } from '../../../packages/platform/src/database.ts';
import { recordMasterDataAs } from './master-data.ts';
import { asOneAction, enableDurability, loadCompany } from './durable.ts';
import { AuthenticationError, createSignIn, signInStore, type SignIn } from './sign-in.ts';
import { Team } from '../../../packages/platform/src/team.ts';
import { MemoryCounterStore, PostgresCounterStore, RateLimiter } from '../../../packages/platform/src/rate-limits.ts';
import { log } from './log.ts';
import { AuditLog } from '../../../packages/platform/src/index.ts';
import { PrivacyService } from '../../../ops/security/src/privacy.ts';
import { BackupRecoveryService, type BackupSource } from '../../../ops/security/src/recovery.ts';
import { APP_BACKUP_KEY_ID } from './field-encryption.ts';
import { MemoryAccountDataStore, PostgresBackupSource } from './privacy-application.ts';

export { AuthenticationError };

/**
 * The two synthetic companies the local app signs into.
 *
 * Every GST number here is checksum-correct — the last character is the check digit of the
 * fourteen before it — and belongs to nobody. It has to be: the GST return workspace (#30) refuses
 * to file a return carrying a number the government would reject, so a demo company with a
 * mistyped registration cannot get past its own validations.
 */
const COMPANY_DETAILS: Readonly<Record<string, Omit<CompanySeed, 'companyId' | 'branchId' | 'setupUserId'>>> = {
  '00000000-0000-4000-8000-000000000001': {
    name: 'Sampoorna Traders', location: 'Bengaluru · Peenya godown', gstin: '29AAAAA0000A1ZY',
    customerId: asId<'Party'>('sampoorna:party:customer'), customerName: 'ABC Traders', customerGstin: '29BBBBB1111B1ZJ',
    supplierId: asId<'Party'>('sampoorna:party:supplier'), supplierName: 'Shree Ram Steels Private Limited',
    supplierGstin: '27AAECS5678D1Z4',
    catalogue: {
      customerId: 'sampoorna:party:customer',
      customerName: 'ABC Traders',
      customerGstin: '29BBBBB1111B1ZJ',
      customerAddress1: 'No. 3, Avenue Road',
      customerCity: 'Bengaluru',
      customerPincode: '560002',
      supplier: { id: 'sampoorna:party:supplier', name: 'Shree Ram Steels Private Limited', gstin: '27AAECS5678D1Z4', address1: 'Plot 7, MIDC Taloja', city: 'Navi Mumbai', pincode: '410208' },
      items: [
      { id: 'sampoorna:item:SOAP', name: 'Herbal Bath Soap 100g', kind: 'goods', hsnSac: '34011190', unit: 'PCS', ratePercentTimes100: 500n, effectiveFrom: '2025-09-22', basis: 'Toilet soap has been 5% since 22 September 2025' },
      { id: 'sampoorna:item:TMT12', name: 'TMT Steel Bar 12mm', kind: 'goods', hsnSac: '72142090', unit: 'KGS', ratePercentTimes100: 1800n, effectiveFrom: '2017-07-01', basis: 'The rate this business has always charged on steel bar' },
      ],
    } satisfies CatalogueSeed,
  },
  '00000000-0000-4000-8000-000000000011': {
    name: 'Konkan Fresh Foods', location: 'Panaji · Market godown', gstin: '30AAAAA0000A1ZF',
    customerId: asId<'Party'>('konkan:party:customer'), customerName: 'Mapusa Family Stores', customerGstin: '30BBBBB1111B1Z0',
    supplierId: asId<'Party'>('konkan:party:supplier'), supplierName: 'Western Coast Supplies',
    supplierGstin: '30AAFCW7788Q1ZE',
    catalogue: {
      customerId: 'konkan:party:customer',
      customerName: 'Mapusa Family Stores',
      customerGstin: '30BBBBB1111B1Z0',
      customerAddress1: 'Shop 12, Municipal Market',
      customerCity: 'Mapusa',
      customerPincode: '403507',
      supplier: { id: 'konkan:party:supplier', name: 'Western Coast Supplies', gstin: '30AAFCW7788Q1ZE', address1: 'Plot 11, Verna Industrial Estate', city: 'Verna', pincode: '403722' },
      items: [
      { id: 'konkan:item:SOAP', name: 'Herbal Bath Soap 100g', kind: 'goods', hsnSac: '34011190', unit: 'PCS', ratePercentTimes100: 500n, effectiveFrom: '2025-09-22', basis: 'Toilet soap has been 5% since 22 September 2025' },
      { id: 'konkan:item:TMT12', name: 'TMT Steel Bar 12mm', kind: 'goods', hsnSac: '72142090', unit: 'KGS', ratePercentTimes100: 1800n, effectiveFrom: '2017-07-01', basis: 'The rate this business has always charged on steel bar' },
      ],
    } satisfies CatalogueSeed,
  },
};

/**
 * Issue #180 — the particulars the two synthetic companies would have typed into Business details.
 *
 * They are seeded so the local app opens with a company that can issue a bill, exactly as a real
 * business does the moment it fills that screen in. They are not a fallback and nothing reads them
 * at print time: the screen can change or clear any of it, and a company with no address is refused
 * a bill like any other. Both addresses are invented and belong to nobody.
 */
const SYNTHETIC_BUSINESS_DETAILS: Readonly<Record<string, Record<string, string>>> = {
  '00000000-0000-4000-8000-000000000001': {
    legalName: 'Sampoorna Traders',
    address1: 'No. 14, 2nd Main, Peenya Industrial Area',
    address2: 'Phase 1',
    city: 'Bengaluru',
    pincode: '560058',
    stateCode: '29',
    phone: '080 4000 1234',
    email: 'billing@sampoorna.example.invalid',
    pan: 'AAAAA0000A',
  },
  '00000000-0000-4000-8000-000000000011': {
    legalName: 'Konkan Fresh Foods',
    address1: 'Shop 7, Municipal Market Road',
    city: 'Panaji',
    pincode: '403001',
    stateCode: '30',
    phone: '0832 240 5678',
    email: 'billing@konkan.example.invalid',
    pan: 'AAAAA0000A',
  },
};

/**
 * Issue #340 — the demo company's named records (its customer, supplier and items), under the ids
 * the database can keep. In memory they keep their readable names.
 */
const storedSeed = (persistence: Persistence, companyId: string, details: Omit<CompanySeed, 'companyId' | 'branchId' | 'setupUserId'>) => {
  if (persistence.kind === 'memory') return details;
  const id = (name: string) => recordId(persistence, companyId, name);
  const supplier = details.catalogue.supplier;
  return {
    ...details,
    customerId: asId<'Party'>(id(details.customerId)),
    supplierId: asId<'Party'>(id(details.supplierId)),
    catalogue: {
      ...details.catalogue,
      customerId: id(details.catalogue.customerId),
      ...(supplier === undefined ? {} : { supplier: { ...supplier, id: id(supplier.id) } }),
      items: details.catalogue.items.map((item) => ({ ...item, id: id(item.id) })),
    },
  };
};

export class ApiRuntime {
  readonly #persistence: Persistence;
  readonly #applications = new Map<string, Promise<DemoApplication>>();
  /** Issue #366 — on PostgreSQL, failures, support grants and incidents are rows (`PostgresOperationsStore`). */
  readonly #operations: ReturnType<typeof createOperations>;
  /** The made-up incident, written once in memory; read only after it is there. */
  readonly #demoIncident: Promise<unknown> = Promise.resolve();
  readonly #operationsSeeded = new Set<string>();
  readonly #recurringRegistered = new Set<string>();
  /** Issue #342 — codes, sessions, signing out and switching company. */
  readonly signIn: SignIn;
  /** Issue #343 — who is in the business, and what each may do. */
  readonly team: Team;
  /** Issue #350 — rate limits and daily spending caps, counted in PostgreSQL when there is a database. */
  readonly limits: RateLimiter;
  /** Issue #345 — on PostgreSQL: the schedule and the outbox are rows, run by the worker. */
  readonly #recurring: PostgresRecurringWork | null;
  readonly #relay: OutboxRelay | null;
  /** #352 — what a backup of the company is taken from. */
  readonly #backupSource: BackupSource | null;

  /** #352 — the account's privacy register and its backups, on PostgreSQL when there is one. */
  readonly privacy: PrivacyService;
  readonly recovery: BackupRecoveryService;
  /** Each company's recurring jobs and the service actor that runs them, once its application is open. */
  readonly #jobs = new Map<string, { readonly context: RequestContext; readonly definitions: readonly RecurringJobDefinition[] }>();

  constructor(persistence: Persistence = MEMORY) {
    this.#persistence = persistence;
    const people = signInStore(persistence);
    this.signIn = createSignIn(people);
    this.team = new Team(people);
    this.limits = new RateLimiter(persistence.kind === 'postgres' ? new PostgresCounterStore(persistence.db) : new MemoryCounterStore());
    // Issue #342 — the stand-in accepts one code for everybody. On a database it can only be there
    // because NODE_ENV says development; say so loudly at every start, so a real server set up that
    // way by mistake is noticed in its first log line rather than by the first stranger who signs in.
    if (this.signIn.provider === 'mock' && persistence.kind === 'postgres') {
      log.warn('The demo sign-in is on, with a database: anyone can sign in with the demo code. This must only ever be a developer\'s machine. A real server needs NODE_ENV=production, SUPABASE_URL and SUPABASE_ANON_KEY.');
    }
    this.#operations = persistence.kind === 'postgres'
      ? createOperations(undefined, undefined, { store: new PostgresOperationsStore(persistence.db), audit: new PostgresAuditLog(persistence.db) })
      : createOperations();
    this.#recurring = persistence.kind === 'postgres' ? new PostgresRecurringWork(persistence.db) : null;
    // A message whose sender died is sent again once its lease has passed (60 s unless set).
    this.#relay = persistence.kind === 'postgres' ? new OutboxRelay(persistence.db, { leaseSeconds: Number(process.env.WORKER_OUTBOX_LEASE_SECONDS ?? 60), maxAttempts: OUTBOX_MAX_ATTEMPTS }) : null;
    // #352 — the privacy register and the backup service, finally composed on the real stores.
    const securityAudit: PostgresAuditLog | AuditLog = persistence.kind === 'postgres' ? new PostgresAuditLog(persistence.db) : new AuditLog();
    const security = securityOf(persistence);
    this.privacy = new PrivacyService(securityAudit, security.accountData, () => new Date(), security.privacyRecords);
    this.recovery = new BackupRecoveryService(securityAudit, security.backups, security.encryption, APP_BACKUP_KEY_ID);
    this.#backupSource = persistence.kind === 'postgres'
      ? new PostgresBackupSource(persistence.db, security.encryption)
      : { snapshot: async (companyId) => Buffer.from(JSON.stringify(await new MemoryAccountDataStore().exportSubject(companyId, companyId))) };
    // The made-up incident below is demo data, which a database never receives.
    if (persistence.kind === 'postgres') return;
    const demo = SYNTHETIC_PLATFORM_COMPANIES[0];
    const incidentActor: RequestContext = { companyId: demo.companyId, branchId: demo.branchId, actorId: demo.userId, sessionId: 'operations-seed', permissions: new Set(PRODUCT_OWNER_PERMISSIONS) };
    const status = this.#operations.status;
    this.#demoIncident = status.openIncident(incidentActor, 'E-invoice registration delay', 'Invoice Registration Portal', 'Some registrations were delayed. Customer invoices remained unchanged.')
      .then((incident) => status.updateIncident(incidentActor, incident.id, 'resolved', 'The portal recovered. Safe queued registrations can now be replayed by an authorised operator.'));
  }

  /** The signed-in context, from the session alone (rule 6). */
  authenticate(authorization: string | undefined): Promise<RequestContext> { return this.signIn.authenticate(authorization); }

  actor(context: RequestContext): ActorContext {
    return {
      companyId: asId<'Company'>(context.companyId),
      branchId: asId<'Branch'>(context.branchId),
      userId: asId<'User'>(context.actorId),
      permissions: [...context.permissions],
    };
  }

  async application(context: RequestContext): Promise<DemoApplication> {
    let application = this.#applications.get(context.companyId);
    if (application === undefined) {
      const company = SYNTHETIC_PLATFORM_COMPANIES.find((candidate) => candidate.companyId === context.companyId);
      const details = COMPANY_DETAILS[context.companyId];
      if (company === undefined || details === undefined) throw notFound('API_COMPANY_NOT_FOUND', 'That company is not available.');
      const seeded = SYNTHETIC_BUSINESS_DETAILS[context.companyId];
      // The made-up address and phone are demo data; a company with a database types its own.
      if (this.#persistence.kind === 'memory' && seeded !== undefined && businessDetailsOf(context.companyId) === null) {
        saveBusinessDetails(context.companyId, { name: details.name, gstin: details.gstin }, seeded);
      }
      application = DemoApplication.create({
        companyId: asId<'Company'>(company.companyId),
        branchId: asId<'Branch'>(company.branchId),
        setupUserId: asId<'User'>(company.userId),
        ...storedSeed(this.#persistence, company.companyId, details),
      }, this.#persistence).then(async (created) => {
        // After a restart: this company's customers, items, business details and bill copies.
        await loadCompany(company.companyId);
        return created;
      });
      // A company whose set-up failed is tried again on the next request, not remembered as broken.
      application.catch(() => this.#applications.delete(context.companyId));
      this.#applications.set(context.companyId, application);
    }
    const resolved = await application;
    // The made-up portal failure is demo data: written in memory when the company opens (#395: never
    // by the Operations screen, which only reads), never written for a real company.
    if (this.#persistence.kind === 'memory' && !this.#operationsSeeded.has(context.companyId)) {
      const seedContext: RequestContext = { companyId: context.companyId, branchId: context.branchId, actorId: `demo-seed:${context.companyId}`, sessionId: `demo-seed:${context.companyId}`, permissions: new Set<Permission>(['operations.read']) };
      this.#operations.telemetry.registerHealthCheck('api', () => true);
      this.#operations.telemetry.registerHealthCheck('queue', () => true);
      await this.#operations.telemetry.externalFailure(seedContext, { correlationId: `irp-demo-${context.companyId}`, connector: 'irp', operation: 'register-einvoice', errorCode: 'IRP_TEMPORARILY_UNAVAILABLE' });
      const job = this.#operations.queue.enqueue(seedContext, { kind: 'irp-register', idempotencyKey: `demo-invoice-${context.companyId}`, idempotent: true, maxAttempts: 1, correlationId: `irp-demo-${context.companyId}` });
      this.#operations.queue.begin(seedContext, job.id);
      this.#operations.queue.fail(seedContext, job.id, 'IRP_TEMPORARILY_UNAVAILABLE');
      this.#operationsSeeded.add(context.companyId);
    }
    if (!this.#recurringRegistered.has(context.companyId)) {
      const serviceContext: RequestContext = {
        companyId: context.companyId,
        branchId: context.branchId,
        actorId: `recurring-service:${context.companyId}`,
        sessionId: `recurring-service:${context.companyId}`,
        permissions: new Set<Permission>([
          'operations.read', 'queue.replay', 'notification.send', 'eway.view', 'collections.reminders.send',
          // Issue #210 part 3 — so a bill whose e-invoice number never came back is sent again.
          'einvoice.generate', 'einvoice.view',
        ]),
      };
      const definitions = resolved.recurringJobs();
      if (this.#recurring === null) for (const job of definitions) this.#operations.recurring.register(serviceContext, job);
      // Issue #345 — on PostgreSQL the company is put on the database's schedule, which the worker runs.
      else await this.#recurring.ensure(serviceContext, definitions);
      this.#jobs.set(context.companyId, { context: serviceContext, definitions });
      this.#recurringRegistered.add(context.companyId);
    }
    return resolved;
  }

  companySummary(companyId: string) {
    const company = SYNTHETIC_PLATFORM_COMPANIES.find((candidate) => candidate.companyId === companyId);
    if (company === undefined) throw new AuthenticationError('That company is not available.');
    return { id: company.companyId, name: company.legalName, branch: company.branchName };
  }

  /**
   * Issue #180 — the two facts about a company that a printed document cannot be built without:
   * the registered name and the GST number. The address is not here; the business types it into
   * Business details, and `business-details-application.ts` holds it.
   */
  companyIdentity(companyId: string): { readonly name: string; readonly gstin: string } {
    const details = COMPANY_DETAILS[companyId];
    if (details === undefined) throw new AuthenticationError('That company is not available.');
    return { name: details.name, gstin: details.gstin };
  }

  async operationsWorkspace(context: RequestContext) {
    if (!context.permissions.has('operations.read')) throw new PlatformError('FORBIDDEN', 'You do not have permission to perform this operational action.');
    const db = this.database;
    const [jobs, recurring] = db === null || this.#recurring === null
      ? [this.#operations.queue.list(context), this.#operations.recurring.status(context)]
      : [await outboxJobs(db, context), await this.#recurring.status(context)];
    const { incidents } = await this.publicStatus();
    return { health: await this.#operations.telemetry.health(), failures: await this.#operations.telemetry.failures(context), jobs, recurring, incidents };
  }

  /** In memory: the in-process schedule. On PostgreSQL the worker runs it (`workOn`). */
  runRecurringWork(companyId?: string) { return this.#operations.recurring.runDue(companyId); }

  /**
   * Issue #345 — replays a failed job. On PostgreSQL a job is an outbox message (work that followed
   * a bill) or a company's recurring job (`recurring:<key>`); either goes back for the next tick.
   */
  async replayOperationalJob(context: RequestContext, input: Record<string, unknown>) {
    const jobId = String(input.jobId ?? '');
    const db = this.database;
    if (db === null || this.#recurring === null) return this.#operations.queue.replay(context, jobId);
    if (!context.permissions.has('queue.replay')) throw new PlatformError('FORBIDDEN', 'You do not have permission to perform this operational action.');
    if (jobId.startsWith('recurring:')) {
      const status = await this.#recurring.replay(context, jobId.slice('recurring:'.length));
      return { id: jobId, state: 'draft', attempts: status.attempts };
    }
    const { rows } = await db.requireUnitOfWork(context.companyId).sql.query(
      `UPDATE outbox_messages SET dead_at = NULL, attempts = 0, available_at = now(), updated_at = now()
        WHERE company_id = $1 AND id = $2::uuid AND sent_at IS NULL AND (dead_at IS NOT NULL OR last_error IS NOT NULL)
        RETURNING id`, [context.companyId, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(jobId) ? jobId : null]);
    if (rows[0] === undefined) throw new Error('ONLY_FAILED_JOBS_CAN_BE_REPLAYED');
    return { id: jobId, state: 'draft', attempts: 0 };
  }

  /**
   * Issue #345 — one company's due work, for the worker: what its bills queued (sent only after they
   * committed), then its recurring jobs. False when this process cannot open that company.
   */
  async workOn(companyId: string): Promise<boolean> {
    if (this.#relay === null || this.#recurring === null) throw new Error('The worker needs the database.');
    const company = SYNTHETIC_PLATFORM_COMPANIES.find((candidate) => candidate.companyId === companyId);
    if (company === undefined) return false;
    const app = await this.application({ companyId, branchId: company.branchId, actorId: company.userId, sessionId: `worker:${companyId}`, permissions: new Set<Permission>(['queue.replay']) });
    await this.#relay.drain(companyId, app.outboxHandlers());
    const jobs = this.#jobs.get(companyId);
    const db = this.database!;
    if (jobs !== undefined) await this.#recurring.runDue(jobs.context, jobs.definitions, (work) => asOneAction(db, companyId, work));
    return true;
  }

  async grantSupportAccess(context: RequestContext, input: Record<string, unknown>) {
    const scopes = Array.isArray(input.scopes) ? input.scopes.filter((scope): scope is 'external-failures' | 'queue-state' | 'health' => scope === 'external-failures' || scope === 'queue-state' || scope === 'health') : [];
    const grant = await this.#operations.support.grant(context, { supportActorId: String(input.supportActorId ?? ''), reason: String(input.reason ?? ''), scopes, durationMs: Number(input.durationMinutes ?? 30) * 60 * 1000 });
    return { ...grant, scopes: [...grant.scopes] };
  }

  async publicStatus() {
    await this.#demoIncident;
    return { incidents: await this.#operations.status.publicStatus() };
  }

  /** Whether write requests run as one unit of work, and on which database. */
  get database() { return this.#persistence.kind === 'postgres' ? this.#persistence.db : null; }

  /** #352 — what a backup of the company is taken from. */
  get backupSource(): BackupSource { return this.#backupSource!; }
}

/** How many times the worker tries a queued job before it is left, dead, for a person. */
const OUTBOX_MAX_ATTEMPTS = 10;

/** Issue #345 — the work that followed this company's bills, as the Operations screen lists jobs. */
const outboxJobs = async (db: TransactionalExecutor, context: RequestContext): Promise<readonly QueueJob[]> => {
  if (!context.permissions.has('operations.read')) throw new PlatformError('FORBIDDEN', 'You do not have permission to perform this operational action.');
  const { rows } = await db.tenantTransaction(context.companyId, (sql) => sql.query(
    `SELECT id, topic, dedupe_key, attempts, last_error, sent_at, dead_at, claim_token, created_at
       FROM outbox_messages WHERE company_id = $1 ORDER BY created_at DESC LIMIT 200`, [context.companyId]));
  return rows.map((r): QueueJob => Object.fromEntries(Object.entries({
    id: String(r.id), companyId: context.companyId, kind: String(r.topic), idempotencyKey: String(r.dedupe_key), idempotent: true,
    state: r.sent_at !== null ? 'success' : r.claim_token !== null ? 'processing' : r.dead_at !== null || r.last_error !== null ? 'failure' : 'draft',
    attempts: Number(r.attempts), maxAttempts: OUTBOX_MAX_ATTEMPTS, correlationId: `outbox:${String(r.id)}`,
    // Only a code-like first word of the error, never its text: it can carry a document's contents.
    lastErrorCode: r.last_error === null ? undefined : /^[A-Z0-9_.-]+/.exec(String(r.last_error))?.[0] ?? 'JOB_FAILED',
    createdAt: (r.created_at as Date).toISOString(),
    completedAt: r.sent_at instanceof Date ? r.sent_at.toISOString() : r.dead_at instanceof Date ? r.dead_at.toISOString() : undefined,
  }).filter(([, value]) => value !== undefined)) as unknown as QueueJob);
};

let runtimeInstance: ApiRuntime | undefined;
export const apiRuntime = (): ApiRuntime => (runtimeInstance ??= new ApiRuntime());

/** Issue #340 — the server picks its persistence once, before it takes a request. */
export const startRuntime = (persistence: Persistence): ApiRuntime => {
  if (runtimeInstance !== undefined) throw new Error('The API runtime has already started.');
  if (persistence.kind === 'postgres') {
    // A record written outside anybody's request (the main godown, on first opening) is the owner's.
    enableDurability(persistence.db, securityOf(persistence).encryption);
    recordMasterDataAs((companyId) => SYNTHETIC_PLATFORM_COMPANIES.find((company) => company.companyId === companyId)?.userId ?? companyId);
  }
  return (runtimeInstance = new ApiRuntime(persistence));
};
