/**
 * Issue #358, ADR 0007 — the error tracker: Sentry, EU region, ids only.
 *
 * Sent as Sentry's own envelope over `fetch`, so no SDK is added (AGENTS.md: ask before adding a
 * dependency); swapping in @sentry/node later changes this file only. What leaves the country is
 * the error's kind, a scrubbed message, the stack (file names and line numbers, no values) and
 * ids: request, company, user. Never a name, phone number, GST number or amount.
 *
 * There is no build step (Node strips the types and keeps every line where it was), so a stack
 * already points at the real `.ts` line; there are no source maps to upload.
 */
import { randomUUID } from 'node:crypto';
import { redactForLog } from '../../../ops/security/src/logging.ts';
import type { ErrorReport, ErrorReporter } from '../../../packages/platform/src/error-reporting.ts';

export interface SentryConfig {
  readonly dsn: string;
  /** `staging` or `production`: separate environments in the tracker (ADR 0007). */
  readonly environment: string;
  readonly release?: string | undefined;
  readonly fetch?: typeof fetch;
  /** What went wrong while sending; the API passes its log. */
  readonly onSendFailure?: (error: unknown) => void;
}

interface Dsn { readonly endpoint: string; readonly publicKey: string; readonly raw: string }

/** Sentry's EU ingest hosts. A DSN anywhere else is refused, so no event can go to the US by mistake. */
const EU_INGEST = /\.ingest\.de\.sentry\.io$/;

/** The DSN's parts, or why it cannot be used. */
export const parseDsn = (raw: string): Dsn | string => {
  const url = URL.parse(raw);
  if (url === null || url.protocol !== 'https:' || url.username === '') return 'SENTRY_DSN is not a Sentry DSN (https://<key>@<host>/<project>).';
  if (!EU_INGEST.test(url.hostname)) return `SENTRY_DSN points at ${url.hostname}, which is not Sentry's EU region; ADR 0007 keeps error reports in the EU.`;
  const project = url.pathname.replace(/^\/+|\/+$/g, '');
  if (!/^\d+$/.test(project)) return 'SENTRY_DSN has no project number at its end.';
  return { endpoint: `https://${url.host}/api/${project}/envelope/`, publicKey: url.username, raw };
};

/**
 * The message with anything that could be a person's data taken out: quoted text, GST numbers and
 * PANs, email addresses and every run of digits (amounts, phone numbers, account numbers).
 * Property names in a TypeError ('reading "x"') are code, and survive as the error's kind and stack.
 */
export const scrubMessage = (message: string): string => String(redactForLog(message))
  .replace(/"[^"]*"/g, '"…"')
  .replace(/\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b/g, '[GSTIN]')
  .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[PAN]')
  .replace(/\d[\d,.]*/g, '#')
  .slice(0, 500);

interface Frame { readonly function: string; readonly filename: string; readonly lineno: number; readonly colno: number; readonly in_app: boolean }

/** Stack frames, oldest call first as Sentry wants them, with paths made relative to the repository. */
export const framesOf = (stack: string | undefined): Frame[] => {
  const frames: Frame[] = [];
  for (const line of (stack ?? '').split('\n').slice(1)) {
    const match = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (match === null) continue;
    const file = match[2]!.replace(/^file:\/\//, '');
    const repository = file.lastIndexOf('/apps/') >= 0 ? file.slice(file.lastIndexOf('/apps/') + 1) : file.lastIndexOf('/packages/') >= 0 ? file.slice(file.lastIndexOf('/packages/') + 1) : file;
    frames.push({ function: match[1] ?? '<anonymous>', filename: repository, lineno: Number(match[3]), colno: Number(match[4]), in_app: !file.includes('node_modules') && !file.startsWith('node:') });
  }
  return frames.reverse();
};

const idOf = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined;

/** The event Sentry stores: ids as tags and the user id, the error's kind, scrubbed message and stack. */
export const sentryEvent = (report: ErrorReport, config: Pick<SentryConfig, 'environment' | 'release'>, eventId: string) => {
  const error = report.error instanceof Error ? report.error : new Error(String(report.error));
  const { company_id: companyId, user_id: userId, request_id: requestId, route, ...rest } = report.context;
  // The request id and the route pattern are ours, not the caller's; anything else is scrubbed.
  const tags: Record<string, string> = { where: report.where, ...(idOf(requestId) === undefined ? {} : { request_id: idOf(requestId)! }), ...(idOf(route) === undefined ? {} : { route: idOf(route)! }) };
  for (const [key, value] of Object.entries(rest)) if (value !== undefined) tags[key] = scrubMessage(String(value)).slice(0, 200);
  return {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: 'node',
    level: 'error',
    environment: config.environment,
    ...(config.release === undefined ? {} : { release: config.release }),
    tags,
    ...(idOf(userId) === undefined ? {} : { user: { id: idOf(userId) } }),
    ...(idOf(companyId) === undefined ? {} : { contexts: { company: { id: idOf(companyId) } } }),
    exception: { values: [{ type: error.name, value: scrubMessage(error.message), stacktrace: { frames: framesOf(error.stack) } }] },
  };
};

/** A reporter that sends each report to Sentry and does not wait for the answer. */
export const sentryReporter = (config: SentryConfig): ErrorReporter => {
  const dsn = parseDsn(config.dsn);
  if (typeof dsn === 'string') throw new Error(dsn);
  const send = config.fetch ?? fetch;
  return {
    report(report) {
      const eventId = randomUUID().replaceAll('-', '');
      const event = sentryEvent(report, config, eventId);
      const envelope = `${JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString(), dsn: dsn.raw })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}`;
      void send(dsn.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-sentry-envelope', 'x-sentry-auth': `Sentry sentry_version=7, sentry_client=karobar-reporter/1.0, sentry_key=${dsn.publicKey}` },
        body: envelope,
        signal: AbortSignal.timeout(5_000),
      }).then((response) => { if (!response.ok) throw new Error(`Sentry answered ${response.status}`); })
        .catch((error: unknown) => config.onSendFailure?.(error));
    },
  };
};
