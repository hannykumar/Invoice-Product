/**
 * Issue #358 — where the API's reported errors go: always its structured log (#357), and the error
 * tracker as well once `SENTRY_DSN` names a project in Sentry's EU region (ADR 0007). Each report
 * carries the request it happened in — its id, route, company and user — without the caller
 * passing them, because the log keeps them for the request.
 */
import { reportError, useErrorReporter, type ErrorReporter } from '../../../packages/platform/src/error-reporting.ts';
import { errorFields, log, requestScope } from './log.ts';
import { parseDsn, sentryReporter } from './sentry.ts';

const logReporter: ErrorReporter = {
  report({ where, error, context }) { log.error('An error was reported', { where, ...context, ...errorFields(error) }); },
};

/** The reporter for this process's environment. A DSN that cannot be used is said once, in the log. */
export const apiErrorReporter = (environment: NodeJS.ProcessEnv = process.env): ErrorReporter => {
  const dsn = environment.SENTRY_DSN?.trim();
  if (dsn === undefined || dsn === '') return logReporter;
  const problem = parseDsn(dsn);
  if (typeof problem === 'string') {
    log.warn('Error reports go to the log only', { reason: problem });
    return logReporter;
  }
  const tracker = sentryReporter({
    dsn,
    environment: environment.NODE_ENV ?? 'development',
    release: environment.KAROBAR_RELEASE,
    onSendFailure: (error) => log.warn('An error report could not be sent to the tracker', errorFields(error)),
  });
  return {
    report(report) {
      logReporter.report(report);
      tracker.report({ ...report, context: { ...requestScope(), ...report.context } });
    },
  };
};

let installed = false;
/**
 * Installs the API's reporter, and catches what nothing else did: a promise rejected with nobody
 * waiting for it, or an exception that reached the top of the event loop. The first is reported and
 * the process carries on; the second is reported, then the process exits, because its state is no
 * longer known (the host restarts it).
 */
export const installErrorReporting = (): void => {
  if (installed) return;
  installed = true;
  useErrorReporter(apiErrorReporter());
  process.on('unhandledRejection', (reason) => reportError('process.unhandledRejection', reason));
  process.on('uncaughtException', (error) => {
    reportError('process.uncaughtException', error);
    process.exitCode = 1;
    // A moment for the tracker's request to leave; the host restarts the process.
    setTimeout(() => process.exit(1), 2_000).unref();
  });
};
