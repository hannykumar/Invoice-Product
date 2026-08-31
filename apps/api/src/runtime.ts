/** Authenticated HTTP runtime: credentials -> session -> membership -> tenant application. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { asId, notFound } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import { AccessControl, AuthenticationService, PlatformError, type Permission, type RequestContext } from '../../../packages/platform/src/index.ts';
import { PRODUCT_OWNER_PERMISSIONS, SYNTHETIC_PLATFORM_COMPANIES } from '../../../packages/platform/src/seed.ts';
import { DemoApplication } from './demo-application.ts';
import type { CompanySeed } from './company-shop.ts';
import { createOperations } from '../../../ops/operations/src/index.ts';

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
  },
  '00000000-0000-4000-8000-000000000011': {
    name: 'Konkan Fresh Foods', location: 'Panaji · Market godown', gstin: '30AAAAA0000A1ZF',
    customerId: asId<'Party'>('konkan:party:customer'), customerName: 'Mapusa Family Stores', customerGstin: '30BBBBB1111B1Z0',
    supplierId: asId<'Party'>('konkan:party:supplier'), supplierName: 'Western Coast Supplies',
    supplierGstin: '30AAFCW7788Q1ZE',
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

export class ApiRuntime {
  readonly #access = new AccessControl();
  readonly #authentication = new AuthenticationService(this.#access);
  readonly #applications = new Map<string, Promise<DemoApplication>>();
  readonly #operations = createOperations();
  readonly #operationsSeeded = new Set<string>();
  readonly #credentials: readonly Credential[];

  constructor() {
    const owners = SYNTHETIC_PLATFORM_COMPANIES.map((company): Credential => ({
      email: company.email,
      password: passwordHash(process.env.DEMO_OWNER_PASSWORD ?? 'karobar-demo'),
      companyId: company.companyId,
      branchId: company.branchId,
      userId: company.userId,
      permissions: PRODUCT_OWNER_PERMISSIONS,
    }));
    const viewer: Credential = {
      email: 'viewer@sampoorna.example.invalid',
      password: passwordHash(process.env.DEMO_VIEWER_PASSWORD ?? 'viewer-demo'),
      companyId: SYNTHETIC_PLATFORM_COMPANIES[0].companyId,
      branchId: SYNTHETIC_PLATFORM_COMPANIES[0].branchId,
      userId: '00000000-0000-4000-8000-000000000004',
      permissions: ['dashboard.read'],
    };
    this.#credentials = [...owners, viewer];
    for (const credential of this.#credentials) {
      this.#access.grant({
        companyId: credential.companyId,
        userId: credential.userId,
        branchIds: new Set([credential.branchId]),
        active: true,
        permissions: new Set(credential.permissions),
      });
    }
    const demo = owners[0]!;
    const incidentActor: RequestContext = { companyId: demo.companyId, branchId: demo.branchId, actorId: demo.userId, sessionId: 'operations-seed', permissions: new Set(demo.permissions) };
    const incident = this.#operations.status.openIncident(incidentActor, 'E-invoice registration delay', 'Invoice Registration Portal', 'Some registrations were delayed. Customer invoices remained unchanged.');
    this.#operations.status.updateIncident(incidentActor, incident.id, 'resolved', 'The portal recovered. Safe queued registrations can now be replayed by an authorised operator.');
  }

  signIn(input: Record<string, unknown>) {
    const email = String(input.email ?? '').trim().toLowerCase();
    const companyId = String(input.companyId ?? '').trim();
    const credential = this.#credentials.find((candidate) => candidate.email === email && candidate.companyId === companyId);
    if (credential === undefined || !passwordMatches(String(input.password ?? ''), credential.password)) {
      throw new AuthenticationError('The email, password, or company is not correct.');
    }
    const session = this.#authentication.createSession(credential.companyId, credential.branchId, credential.userId);
    return { sessionId: session.id, company: this.companySummary(credential.companyId), expiresAt: new Date(session.expiresAt).toISOString() };
  }

  authenticate(authorization: string | undefined): RequestContext {
    const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
    if (match?.[1] === undefined) throw new AuthenticationError();
    try {
      return this.#authentication.authenticate(match[1]);
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
      application = DemoApplication.create({
        companyId: asId<'Company'>(company.companyId),
        branchId: asId<'Branch'>(company.branchId),
        setupUserId: asId<'User'>(company.userId),
        ...details,
      });
      this.#applications.set(context.companyId, application);
    }
    return application;
  }

  companySummary(companyId: string) {
    const company = SYNTHETIC_PLATFORM_COMPANIES.find((candidate) => candidate.companyId === companyId);
    if (company === undefined) throw new AuthenticationError('That company is not available.');
    return { id: company.companyId, name: company.legalName, branch: company.branchName };
  }

  async operationsWorkspace(context: RequestContext) {
    if (!this.#operationsSeeded.has(context.companyId)) {
      this.#operations.telemetry.registerHealthCheck('api', () => true);
      this.#operations.telemetry.registerHealthCheck('queue', () => true);
      this.#operations.telemetry.externalFailure(context, { correlationId: `irp-demo-${context.companyId}`, connector: 'irp', operation: 'register-einvoice', errorCode: 'IRP_TEMPORARILY_UNAVAILABLE' });
      const job = this.#operations.queue.enqueue(context, { kind: 'irp-register', idempotencyKey: `demo-invoice-${context.companyId}`, idempotent: true, maxAttempts: 1, correlationId: `irp-demo-${context.companyId}` });
      this.#operations.queue.begin(context, job.id);
      this.#operations.queue.fail(context, job.id, 'IRP_TEMPORARILY_UNAVAILABLE');
      this.#operationsSeeded.add(context.companyId);
    }
    return { health: await this.#operations.telemetry.health(), failures: this.#operations.telemetry.failures(context), jobs: this.#operations.queue.list(context), incidents: this.#operations.status.publicStatus() };
  }

  replayOperationalJob(context: RequestContext, input: Record<string, unknown>) {
    return this.#operations.queue.replay(context, String(input.jobId ?? ''));
  }

  grantSupportAccess(context: RequestContext, input: Record<string, unknown>) {
    const scopes = Array.isArray(input.scopes) ? input.scopes.filter((scope): scope is 'external-failures' | 'queue-state' | 'health' => scope === 'external-failures' || scope === 'queue-state' || scope === 'health') : [];
    const grant = this.#operations.support.grant(context, { supportActorId: String(input.supportActorId ?? ''), reason: String(input.reason ?? ''), scopes, durationMs: Number(input.durationMinutes ?? 30) * 60 * 1000 });
    return { ...grant, scopes: [...grant.scopes] };
  }

  publicStatus() { return { incidents: this.#operations.status.publicStatus() }; }
}

let runtimeInstance: ApiRuntime | undefined;
export const apiRuntime = (): ApiRuntime => (runtimeInstance ??= new ApiRuntime());
