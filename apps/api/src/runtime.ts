/** Authenticated HTTP runtime: credentials -> session -> membership -> tenant application. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { asId, notFound } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import { AccessControl, AuthenticationService, PlatformError, type Permission, type RequestContext } from '../../../packages/platform/src/index.ts';
import { PRODUCT_OWNER_PERMISSIONS, SYNTHETIC_PLATFORM_COMPANIES } from '../../../packages/platform/src/seed.ts';
import { DemoApplication } from './demo-application.ts';
import type { CompanySeed } from './company-shop.ts';

export class AuthenticationError extends Error {
  readonly status = 401;
  constructor(message = 'Sign in to continue.') { super(message); }
}

const passwordHash = (password: string): Buffer => createHash('sha256').update(password).digest();
const passwordMatches = (supplied: string, expected: Buffer): boolean => {
  const actual = passwordHash(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const COMPANY_DETAILS: Readonly<Record<string, Omit<CompanySeed, 'companyId' | 'branchId' | 'setupUserId'>>> = {
  '00000000-0000-4000-8000-000000000001': {
    name: 'Sampoorna Traders', location: 'Bengaluru · Peenya godown', gstin: '29AAAAA0000A1ZR',
    customerId: asId<'Party'>('sampoorna:party:customer'), customerName: 'ABC Traders', customerGstin: '29BBBBB1111B1Z4',
    supplierId: asId<'Party'>('sampoorna:party:supplier'), supplierName: 'Shree Ram Steels Private Limited',
    supplierGstin: '27AAECS5678D1ZK',
  },
  '00000000-0000-4000-8000-000000000011': {
    name: 'Konkan Fresh Foods', location: 'Panaji · Market godown', gstin: '30AAAAA0000A1ZQ',
    customerId: asId<'Party'>('konkan:party:customer'), customerName: 'Mapusa Family Stores', customerGstin: '30BBBBB1111B1Z3',
    supplierId: asId<'Party'>('konkan:party:supplier'), supplierName: 'Western Coast Supplies',
    supplierGstin: '30AAFCW7788Q1ZP',
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
}

let runtimeInstance: ApiRuntime | undefined;
export const apiRuntime = (): ApiRuntime => (runtimeInstance ??= new ApiRuntime());
