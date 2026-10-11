/**
 * Issue #357 — one JSON line per event, redacted, carrying the request it belongs to.
 *
 * Every line names its `request_id`, and its `company_id` and `user_id` once the caller has signed
 * in, without anyone passing them along: the request's scope is held in AsyncLocalStorage, so code
 * deep inside a package that logs later needs no plumbing. Fields go through the redactor in
 * ops/security/src/logging.ts (passwords, tokens, sessions, PAN, bank account, phone, email…).
 *
 * The ops CLIs and the demos print reports for a person at a terminal, not logs, and keep `console`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { SecureLogger, type SafeLogEvent } from '../../../ops/security/src/logging.ts';

export type LogLevel = SafeLogEvent['level'];
const RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/** What every line of one request carries: its id, then its route, company and user as they become known. */
interface Scope { readonly request_id: string; route?: string; company_id?: string; user_id?: string }
const scope = new AsyncLocalStorage<Scope>();

/**
 * Runs `work` as one request: every line it logs, however deep, carries `requestId`. Inside a
 * request with the same id already (the HTTP edge, then the dispatcher) it joins that one.
 */
export const inRequest = <T>(requestId: string, work: () => T): T =>
  scope.getStore()?.request_id === requestId ? work() : scope.run({ request_id: requestId }, work);

/** Adds what has become known about the request (its route; who is calling) to its remaining lines. */
export const annotate = (known: { readonly route?: string; readonly company_id?: string; readonly user_id?: string }): void => {
  const current = scope.getStore();
  if (current !== undefined) Object.assign(current, known);
};

/** The least level written. Debug is never written in production, whatever LOG_LEVEL says. */
const threshold = (): number => {
  const production = process.env.NODE_ENV === 'production';
  const asked = process.env.LOG_LEVEL as LogLevel | undefined;
  const level = asked !== undefined && asked in RANK ? asked : production ? 'info' : 'debug';
  return production && level === 'debug' ? RANK.info : RANK[level];
};

type Sink = (level: LogLevel, line: string) => void;
const standardStreams: Sink = (level, line) => { (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`); };
let sink: Sink = standardStreams;

/** For tests: send lines somewhere else. Returns the function that puts the standard streams back. */
export const captureLog = (capture: Sink): (() => void) => {
  sink = capture;
  return () => { sink = standardStreams; };
};

const logger = new SecureLogger((event) => {
  const current = scope.getStore();
  const line = {
    time: new Date().toISOString(),
    level: event.level,
    message: event.message,
    ...event.fields,
    // After the fields, so no caller can relabel the request a line belongs to.
    ...current,
  };
  sink(event.level, JSON.stringify(line));
});

const write = (level: LogLevel) => (message: string, fields: Readonly<Record<string, unknown>> = {}): void => {
  if (RANK[level] < threshold()) return;
  logger.write(level, message, fields);
};

/** `log.info('request', { route, status })`. An `error` field keeps its name, message and stack. */
export const log = {
  debug: write('debug'),
  info: write('info'),
  warn: write('warn'),
  error: write('error'),
};

/** An error as log fields: its name, message, cause and stack, each through the redactor. */
export const errorFields = (error: unknown): Record<string, unknown> => error instanceof Error
  ? { error: error.name, error_message: error.message, ...(error.cause instanceof Error ? { cause: `${error.cause.name}: ${error.cause.message}` } : {}), stack: error.stack }
  : { error: typeof error, error_message: String(error) };
