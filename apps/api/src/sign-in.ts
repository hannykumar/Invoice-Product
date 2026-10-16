/**
 * Issue #342 — signing in for real (ADRs D1, D2). A person proves a phone number or an email with a
 * one-time code from the identity provider; the API then gives the browser its own session, in a
 * cookie page JavaScript cannot read. The session names one company and one branch. Switching to
 * another company the person belongs to issues a new session without signing in again; every
 * request still takes its company from the session alone (rule 6).
 *
 * The store is the platform's: `AuthenticationService` in memory, `PostgresAuthenticationService`
 * in production (`signInStore`, the one place #340 swaps it). No password exists anywhere here.
 */
import {
  AccessControl, AuthenticationService, ConnectorError, PlatformError, SESSION_ABSOLUTE_MS,
  type Id, type Membership, type RequestContext, type Session,
} from '../../../packages/platform/src/index.ts';
import { AddressNotReadable, CodeNotAccepted, identityProviderFor, readSignInAddress, type IdentityProvider, type VerifiedIdentity } from '../../../packages/platform/src/identity.ts';
import { DEMO_PEOPLE, DEMO_SIGN_IN_CODE } from '../../../packages/platform/src/seed.ts';
import { createDatabase } from '../../../packages/platform/src/database.ts';
import { PostgresAccessControl, PostgresAuthenticationService } from '../../../packages/platform/src/postgres-platform.ts';

type Maybe<T> = T | Promise<T>;
/** What signing in needs from the platform: methods both of its session services already have. */
export interface SignInStore {
  userFor(identity: VerifiedIdentity): Maybe<Id>;
  companiesOf(userId: Id): Maybe<readonly Membership[]>;
  createSession(companyId: Id, branchId: Id, userId: Id): Maybe<Session>;
  authenticate(token: string): Maybe<RequestContext>;
  revokeSession(sessionIdOrToken: string): Maybe<void>;
}

export class AuthenticationError extends Error {
  readonly status = 401;
  constructor(message = 'Sign in to continue.') { super(message); }
}

/** The provider could not be reached. Nothing about the person is said, and they can simply try again. */
export class SignInUnavailable extends Error {
  readonly status = 503;
  constructor() { super('Sign-in is not working just now. Nothing was changed. Please try again in a minute.'); }
}

/** One message for a wrong code, an old code and an address nobody uses, so nobody can probe for accounts. */
export const CODE_NOT_ACCEPTED = 'That code is not right, or it is too old. Ask for a new code and type it in.';

/** The cookie: `__Host-` so only this exact site can set it, `HttpOnly` so page script cannot read it (ADR D2). */
export const SESSION_COOKIE = '__Host-karobar_session';
export const sessionCookie = (token: string): string =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_ABSOLUTE_MS / 1000)}`;
export const clearedSessionCookie = (): string => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
/** The session token in a `Cookie` header, if there is one. */
export const sessionTokenFrom = (cookieHeader: string | undefined): string | undefined => {
  for (const part of (cookieHeader ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === SESSION_COOKIE && value.length > 0 && value.join('=') !== '') return value.join('=');
  }
  return undefined;
};

export interface Opened { readonly token: string; readonly companyId: Id; readonly expiresAt: string }

export class SignIn {
  readonly #store: SignInStore;
  readonly #identity: IdentityProvider;
  constructor(store: SignInStore, identity: IdentityProvider) { this.#store = store; this.#identity = identity; }

  get provider(): IdentityProvider['kind'] { return this.#identity.kind; }

  async sendCode(typed: string): Promise<{ sent: true; hint?: string }> {
    const address = this.#address(typed);
    const { hint } = await this.#provider(() => this.#identity.sendCode(address));
    return hint === undefined ? { sent: true } : { sent: true, hint };
  }

  /**
   * The code is checked, the person found (or, the first time, recorded), and a session opened in the
   * company they asked for — if it is one of theirs — or else the first of theirs.
   */
  async checkCode(typed: string, code: string, companyId?: string): Promise<Opened> {
    const address = this.#address(typed);
    let identity: VerifiedIdentity;
    try { identity = await this.#provider(() => this.#identity.checkCode(address, code)); }
    catch (error) { if (error instanceof CodeNotAccepted) throw new AuthenticationError(CODE_NOT_ACCEPTED); throw error; }
    const userId = await this.#store.userFor(identity);
    const companies = await this.#store.companiesOf(userId);
    if (companies.length === 0) throw new PlatformError('FORBIDDEN', 'You are signed up, but no business has added you yet. Ask the owner of the business to add you, then sign in again.');
    const chosen = companies.find((membership) => membership.companyId === companyId) ?? companies[0]!;
    return this.#open(chosen.companyId, chosen.branchIds[0]!, userId);
  }

  async authenticate(authorization: string | undefined): Promise<RequestContext> {
    const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];
    if (token === undefined) throw new AuthenticationError();
    try { return await this.#store.authenticate(token); }
    catch (error) {
      if (error instanceof PlatformError && (error.code === 'SESSION_EXPIRED' || error.code === 'SESSION_REVOKED')) throw new AuthenticationError('Sign in again to continue.');
      throw error;
    }
  }

  async signOut(context: RequestContext): Promise<void> { await this.#store.revokeSession(context.sessionId); }

  /** The companies this person may switch to. */
  companies(context: RequestContext): Maybe<readonly Membership[]> { return this.#store.companiesOf(context.actorId); }

  /**
   * Another of the person's companies: a new session for it, and the old one ended, so one cookie
   * never opens two companies. A company that is not theirs is "not found" — its existence is not told.
   */
  async switchCompany(context: RequestContext, companyId: string, branchId?: string): Promise<Opened> {
    const membership = (await this.#store.companiesOf(context.actorId)).find((candidate) => candidate.companyId === companyId);
    const branch = branchId === undefined || branchId === '' ? membership?.branchIds[0] : membership?.branchIds.find((candidate) => candidate === branchId);
    if (membership === undefined || branch === undefined) throw new PlatformError('NOT_FOUND', 'That business is not one you have been added to.');
    const opened = await this.#open(membership.companyId, branch, context.actorId);
    await this.#store.revokeSession(context.sessionId);
    return opened;
  }

  async #open(companyId: Id, branchId: Id, userId: Id): Promise<Opened> {
    const session = await this.#store.createSession(companyId, branchId, userId);
    return { token: session.id, companyId, expiresAt: new Date(session.expiresAt).toISOString() };
  }

  #address(typed: string) {
    try { return readSignInAddress(typed); }
    catch (error) { if (error instanceof AddressNotReadable) throw new Error(error.message); throw error; }
  }

  async #provider<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) { if (error instanceof ConnectorError) throw new SignInUnavailable(); throw error; }
  }
}

const DEVELOPMENT = new Set(['', 'development', 'test']);

/**
 * Where sessions and members live. In production, PostgreSQL, so a restart signs nobody out. On a
 * developer's machine and in tests, memory, holding the seed's demo people — and only there.
 * #340 replaces this with its composition root's PostgreSQL instance.
 */
export const signInStore = (env: Readonly<Record<string, string | undefined>> = process.env): SignInStore => {
  if (!DEVELOPMENT.has((env.NODE_ENV ?? '').trim().toLowerCase())) {
    if (!env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is not set. Sessions are kept in the database outside development, so the server will not start.');
    const database = createDatabase(env.DATABASE_URL);
    return new PostgresAuthenticationService(database, new PostgresAccessControl(database));
  }
  const access = new AccessControl();
  const store = new AuthenticationService(access);
  for (const person of DEMO_PEOPLE) {
    store.addUser({ id: person.userId, email: person.email });
    for (const membership of person.memberships) {
      access.grant({ companyId: membership.companyId, userId: person.userId, branchIds: new Set([membership.branchId]), active: true, permissions: new Set(membership.permissions) });
    }
  }
  return store;
};

export const createSignIn = (env: Readonly<Record<string, string | undefined>> = process.env): SignIn =>
  new SignIn(signInStore(env), identityProviderFor(env, DEMO_SIGN_IN_CODE));
