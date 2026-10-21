/** Authenticated HTTP runtime: credentials -> session -> membership -> tenant application. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { asId, notFound } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import { AccessControl, AuthenticationService, PlatformError, type Permission, type RequestContext } from '../../../packages/platform/src/index.ts';
import { PostgresAccessControl, PostgresAuthenticationService } from '../../../packages/platform/src/postgres-platform.ts';
import { SYNTHETIC_PLATFORM_COMPANIES, SYNTHETIC_PLATFORM_USERS } from '../../../packages/platform/src/seed.ts';
import { DemoApplication } from './demo-application.ts';
import { businessDetailsOf, saveBusinessDetails } from './business-details-application.ts';
import type { CompanySeed } from './company-shop.ts';
import type { CatalogueSeed } from './catalogue-application.ts';
import { createOperations } from '../../../ops/operations/src/index.ts';
import { MEMORY, recordId, type Persistence } from './persistence.ts';
import { recordMasterDataAs } from './master-data.ts';
import { asOneAction, enableDurability, loadCompany } from './durable.ts';

export class AuthenticationError extends Error {
  readonly status = 401;
  constructor(message = 'Sign in to continue.') { super(message); }
}

const passwordHash = (password: string): Buffer => createHash('sha256').update(password).digest();
const passwordMatches = (supplied: string, expected: Buffer): boolean => {
  const actual = passwordHash(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

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

interface Credential {
  readonly email: string;
  readonly password: Buffer;
  readonly companyId: string;
  readonly branchId: string;
  readonly userId: string;
  readonly permissions: readonly Permission[];
}

/** Sessions and memberships: in memory for the demo, in PostgreSQL (#364) when the app has a database. */
interface SessionStore {
  createSession(companyId: string, branchId: string, userId: string): { id: string; expiresAt: number } | Promise<{ id: string; expiresAt: number }>;
  authenticate(token: string): RequestContext | Promise<RequestContext>;
}

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
  readonly #access = new AccessControl();
  readonly #authentication: SessionStore;
  readonly #applications = new Map<string, Promise<DemoApplication>>();
  readonly #operations = createOperations();
  readonly #operationsSeeded = new Set<string>();
  readonly #recurringRegistered = new Set<string>();
  readonly #credentials: readonly Credential[];

  constructor(persistence: Persistence = MEMORY) {
    this.#persistence = persistence;
    this.#authentication = persistence.kind === 'postgres'
      ? new PostgresAuthenticationService(persistence.db, new PostgresAccessControl(persistence.db))
      : new AuthenticationService(this.#access);
    // Issue #340 — the same three people per company that `npm run db:seed` writes. Owners sign in
    // with DEMO_OWNER_PASSWORD, everybody else with DEMO_VIEWER_PASSWORD (#342 replaces all of this).
    const credentials = SYNTHETIC_PLATFORM_USERS.map((user): Credential => ({
      email: user.email,
      password: passwordHash(user.role === 'owner' ? process.env.DEMO_OWNER_PASSWORD ?? 'karobar-demo' : process.env.DEMO_VIEWER_PASSWORD ?? 'viewer-demo'),
      companyId: user.companyId,
      branchId: user.branchId,
      userId: user.userId,
      permissions: user.permissions,
    }));
    this.#credentials = credentials;
    for (const credential of persistence.kind === 'memory' ? this.#credentials : []) {
      this.#access.grant({
        companyId: credential.companyId,
        userId: credential.userId,
        branchIds: new Set([credential.branchId]),
        active: true,
        permissions: new Set(credential.permissions),
      });
    }
    // In PostgreSQL the memberships are rows (`npm run db:seed` writes the synthetic ones), and the
    // made-up incident below is demo data, which a database never receives.
    if (persistence.kind === 'postgres') return;
    const demo = credentials[0]!;
    const incidentActor: RequestContext = { companyId: demo.companyId, branchId: demo.branchId, actorId: demo.userId, sessionId: 'operations-seed', permissions: new Set(demo.permissions) };
    const incident = this.#operations.status.openIncident(incidentActor, 'E-invoice registration delay', 'Invoice Registration Portal', 'Some registrations were delayed. Customer invoices remained unchanged.');
    this.#operations.status.updateIncident(incidentActor, incident.id, 'resolved', 'The portal recovered. Safe queued registrations can now be replayed by an authorised operator.');
  }

  async signIn(input: Record<string, unknown>) {
    const email = String(input.email ?? '').trim().toLowerCase();
    const companyId = String(input.companyId ?? '').trim();
    const credential = this.#credentials.find((candidate) => candidate.email === email && candidate.companyId === companyId);
    if (credential === undefined || !passwordMatches(String(input.password ?? ''), credential.password)) {
      throw new AuthenticationError('The email, password, or company is not correct.');
    }
    const session = await this.#authentication.createSession(credential.companyId, credential.branchId, credential.userId);
    return { sessionId: session.id, company: this.companySummary(credential.companyId), expiresAt: new Date(session.expiresAt).toISOString() };
  }

  async authenticate(authorization: string | undefined): Promise<RequestContext> {
    const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
    if (match?.[1] === undefined) throw new AuthenticationError();
    try {
      return await this.#authentication.authenticate(match[1]);
    } catch (error) {
      if (error instanceof PlatformError && (error.code === 'SESSION_EXPIRED' || error.code === 'SESSION_REVOKED')) throw new AuthenticationError(error.message);
      throw error;
    }
  }

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
      const db = this.database;
      for (const job of resolved.recurringJobs()) {
        // Issue #340 — on PostgreSQL each run is one action for its company. #345 moves these runs
        // to a separate worker; until then they run on the API's own tick.
        this.#operations.recurring.register(serviceContext, db === null ? job : { ...job, run: (ctx, at, signal) => asOneAction(db, ctx.companyId, () => job.run(ctx, at, signal)) });
      }
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
    // The made-up portal failure is demo data: shown in memory, never written for a real company.
    if (this.#persistence.kind === 'memory' && !this.#operationsSeeded.has(context.companyId)) {
      this.#operations.telemetry.registerHealthCheck('api', () => true);
      this.#operations.telemetry.registerHealthCheck('queue', () => true);
      this.#operations.telemetry.externalFailure(context, { correlationId: `irp-demo-${context.companyId}`, connector: 'irp', operation: 'register-einvoice', errorCode: 'IRP_TEMPORARILY_UNAVAILABLE' });
      const job = this.#operations.queue.enqueue(context, { kind: 'irp-register', idempotencyKey: `demo-invoice-${context.companyId}`, idempotent: true, maxAttempts: 1, correlationId: `irp-demo-${context.companyId}` });
      this.#operations.queue.begin(context, job.id);
      this.#operations.queue.fail(context, job.id, 'IRP_TEMPORARILY_UNAVAILABLE');
      this.#operationsSeeded.add(context.companyId);
    }
    return { health: await this.#operations.telemetry.health(), failures: this.#operations.telemetry.failures(context), jobs: this.#operations.queue.list(context), recurring: this.#operations.recurring.status(context), incidents: this.#operations.status.publicStatus() };
  }

  runRecurringWork(companyId?: string) { return this.#operations.recurring.runDue(companyId); }

  replayOperationalJob(context: RequestContext, input: Record<string, unknown>) {
    return this.#operations.queue.replay(context, String(input.jobId ?? ''));
  }

  grantSupportAccess(context: RequestContext, input: Record<string, unknown>) {
    const scopes = Array.isArray(input.scopes) ? input.scopes.filter((scope): scope is 'external-failures' | 'queue-state' | 'health' => scope === 'external-failures' || scope === 'queue-state' || scope === 'health') : [];
    const grant = this.#operations.support.grant(context, { supportActorId: String(input.supportActorId ?? ''), reason: String(input.reason ?? ''), scopes, durationMs: Number(input.durationMinutes ?? 30) * 60 * 1000 });
    return { ...grant, scopes: [...grant.scopes] };
  }

  publicStatus() { return { incidents: this.#operations.status.publicStatus() }; }

  /** Whether write requests run as one unit of work, and on which database. */
  get database() { return this.#persistence.kind === 'postgres' ? this.#persistence.db : null; }
}

let runtimeInstance: ApiRuntime | undefined;
export const apiRuntime = (): ApiRuntime => (runtimeInstance ??= new ApiRuntime());

/** Issue #340 — the server picks its persistence once, before it takes a request. */
export const startRuntime = (persistence: Persistence): ApiRuntime => {
  if (runtimeInstance !== undefined) throw new Error('The API runtime has already started.');
  if (persistence.kind === 'postgres') {
    // A record written outside anybody's request (the main godown, on first opening) is the owner's.
    enableDurability(persistence.db);
    recordMasterDataAs((companyId) => SYNTHETIC_PLATFORM_COMPANIES.find((company) => company.companyId === companyId)?.userId ?? companyId);
  }
  return (runtimeInstance = new ApiRuntime(persistence));
};
