/**
 * Issue #342 — signing a test in the way the page does: ask for a code, type it in. The session
 * comes back only as the `Set-Cookie` header; this reads it from there, as the browser would.
 * Synthetic people from `packages/platform/src/seed.ts` only.
 */
import assert from 'node:assert/strict';
import { DEMO_SIGN_IN_CODE } from '../../../packages/platform/src/seed.ts';
import { handleApi } from '../src/server.ts';
import { SESSION_COOKIE } from '../src/sign-in.ts';

export const SAMPOORNA_OWNER = 'owner@sampoorna.example.invalid';
export const KONKAN_OWNER = 'owner@konkan.example.invalid';
export const SAMPOORNA_VIEWER = 'viewer@sampoorna.example.invalid';
export const SYNTHETIC_CA = 'ca@example.invalid';

/** The session token in a reply's `Set-Cookie`, or `undefined`. */
export const tokenFrom = (headers: Readonly<Record<string, string>>): string | undefined =>
  new RegExp(`^${SESSION_COOKIE}=([^;]+)`).exec(headers['set-cookie'] ?? '')?.[1];

/**
 * Signs in in-process and returns the session token, for `handleApi(…, \`Bearer ${token}\`)`. The
 * demo provider needs no code sent first, and asking for one would count against #350's code limits.
 */
export const signIn = async (address = SAMPOORNA_OWNER, companyId?: string): Promise<string> => {
  const opened = await handleApi('POST', '/api/auth/sign-in', { address, code: DEMO_SIGN_IN_CODE, ...(companyId === undefined ? {} : { companyId }) });
  assert.equal(opened.status, 200, String(opened.body));
  const token = tokenFrom(opened.headers);
  assert.ok(token, 'signing in sets the session cookie');
  return token;
};

/** Over HTTP: signs in against `base` and returns the `Cookie` header value to send back. */
export const signInOverHttp = async (base: string, address = SAMPOORNA_OWNER, companyId?: string): Promise<string> => {
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) });
  const opened = await post('/api/auth/sign-in', { address, code: DEMO_SIGN_IN_CODE, ...(companyId === undefined ? {} : { companyId }) });
  assert.equal(opened.status, 200);
  const token = tokenFrom({ 'set-cookie': opened.headers.get('set-cookie') ?? '' });
  assert.ok(token, 'signing in sets the session cookie');
  return `${SESSION_COOKIE}=${token}`;
};

/** In a Puppeteer page showing the sign-in dialog: type the address, ask for the code, type it, sign in. */
export const signInInBrowser = async (page: { waitForSelector(selector: string, options?: object): Promise<unknown>; type(selector: string, text: string): Promise<void>; click(selector: string): Promise<void>; waitForFunction(fn: () => boolean): Promise<unknown> }, address = SAMPOORNA_OWNER): Promise<void> => {
  await page.waitForSelector('#login-form [name="address"]', { visible: true });
  await page.type('#login-form [name="address"]', address);
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector('#login-form [name="code"]', { visible: true });
  await page.type('#login-form [name="code"]', DEMO_SIGN_IN_CODE);
  await page.click('#login-form button[type="submit"]');
  await page.waitForFunction(() => !(document.querySelector('#login-dialog') as HTMLDialogElement).open);
};
