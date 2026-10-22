/**
 * The real API and worker as operating-system processes, against PostgreSQL as a login that is only
 * a member of `invoice_app` — for the tests that stop a process and start it again (#340, #345).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { TransactionalExecutor } from '../../../packages/platform/src/database.ts';
import { SESSION_COOKIE } from '../src/sign-in.ts';

export const SERVER = fileURLToPath(new URL('../src/server.ts', import.meta.url));
export const WORKER = fileURLToPath(new URL('../src/worker.ts', import.meta.url));

export const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const address = probe.address();
    probe.close(() => (typeof address === 'object' && address !== null ? resolve(address.port) : reject(new Error('no port'))));
  });
});

/** Migrates and seeds as the owner, then makes a login that is only a member of `invoice_app`. */
export async function appDatabase(url: string): Promise<{ owner: TransactionalExecutor; appUrl: string; close(): Promise<void> }> {
  const { createDatabase } = await import('../../../packages/platform/src/database.ts');
  const { migrate } = await import('../../../packages/platform/src/migrations.ts');
  const { seed } = await import('../../../packages/platform/src/seed.ts');
  const owner = createDatabase(url);
  await migrate(owner);
  await seed(owner);
  const login = `invoice_app_proc_${randomBytes(6).toString('hex')}`;
  const password = randomBytes(18).toString('hex');
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE invoice_app`);
  const app = new URL(url);
  app.username = login;
  app.password = password;
  return {
    owner,
    appUrl: app.toString(),
    async close() {
      // The role owns nothing; its sessions are ended with it.
      await owner.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${login}'`);
      await owner.query(`DROP ROLE IF EXISTS ${login}`);
      await owner.close();
    },
  };
}

/** Starts a Node entrypoint with this environment added. */
export const startProcess = (script: string, env: Record<string, string>): ChildProcess =>
  spawn(process.execPath, ['--experimental-strip-types', script], { env: { ...process.env, NODE_ENV: 'development', ...env }, stdio: ['ignore', 'ignore', 'inherit'] });

/** Kills it outright, as a crash or a lost machine would: no clean-up runs. */
export const killProcess = async (child: ChildProcess | undefined): Promise<void> => {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
};

/** Polls until `check` returns something, or fails after `ms`. */
export async function waitFor<T>(what: string, check: () => Promise<T | undefined | null | false>, ms = 20_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const found = await check();
    if (found !== undefined && found !== null && found !== false) return found;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Starts the API on `port` and waits until it answers. */
export async function startApi(appUrl: string, port: number, env: Record<string, string> = {}): Promise<ChildProcess> {
  const api = startProcess(SERVER, { DATABASE_URL: appUrl, API_PORT: String(port), ...env });
  // Slow on a busy CI machine: the process composes the whole app before it listens.
  await waitFor('the API to start', async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/status`)).ok; } catch { return false; } }, 90_000);
  return api;
}

/** A JSON call to the API on `port`, signed in with the session `token` (its cookie, #342) when given. */
export const callApi = (port: number) => async (method: string, path: string, body?: unknown, token?: string): Promise<Record<string, any>> => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, ...(token === undefined ? {} : { cookie: `${SESSION_COOKIE}=${token}` }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, ...(await response.json() as Record<string, unknown>) };
};
