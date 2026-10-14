/**
 * Issue #358 — the one place a fault is reported, so no error is swallowed in silence.
 *
 * A module that catches an error and carries on (a provider that did not answer, a courtesy
 * check that could not run) calls `reportError` with where it happened; the shopkeeper still
 * sees the friendly outcome, and the detail goes to whoever is listening. The host installs the
 * reporter with `useErrorReporter`: the API sends to its structured log and, when configured, the
 * error tracker (ADR 0007). Until a host installs one, reports go to stderr as one JSON line, so a
 * package used on its own (a demo, a test) is not silent either.
 */
import { DomainError } from "@invoice/kernel";
import { redactSecretText } from "./credentials.ts";
import { ConnectorError } from "./connectors.ts";

/** Ids and short labels only: never names, phone numbers, GST numbers or amounts (ADR 0007). */
export type ReportContext = Readonly<Record<string, string | number | boolean | undefined>>;

export interface ErrorReport {
  /** Where it was caught, as `module.operation`, e.g. `delivery.send`. */
  readonly where: string;
  readonly error: unknown;
  readonly context: ReportContext;
}

export interface ErrorReporter { report(report: ErrorReport): void }

const stderrReporter: ErrorReporter = {
  report({ where, error, context }) {
    const detail = error instanceof Error ? { error: error.name, error_message: error.message, stack: error.stack } : { error: typeof error, error_message: String(error) };
    process.stderr.write(`${redactSecretText(JSON.stringify({ time: new Date().toISOString(), level: "error", message: "An error was reported", where, ...context, ...detail }))}\n`);
  },
};

let current: ErrorReporter = stderrReporter;

/** Reports `error`, caught at `where`. Never throws: reporting must not turn a handled fault into a crash. */
export const reportError = (where: string, error: unknown, context: ReportContext = {}): void => {
  try {
    current.report({ where, error, context });
  } catch (failure) {
    try { stderrReporter.report({ where: "error-reporting.report", error: failure, context: { reporting: where } }); } catch { /* stderr itself is gone; nothing is left to tell */ }
  }
};

/**
 * For a catch that carries on: reports `error` unless it is an outcome the product already shows.
 * A refusal the services meant (DomainError) and a provider that did not answer (ConnectorError)
 * are on the record the shopkeeper sees, and an ordinary outage must not flood the tracker.
 * Anything else is a fault in our own code, and is reported.
 */
export const reportUnexpected = (where: string, error: unknown, context: ReportContext = {}): void => {
  if (error instanceof DomainError || error instanceof ConnectorError) return;
  reportError(where, error, context);
};

/** Installs the host's reporter. Returns the function that puts the previous one back. */
export const useErrorReporter = (reporter: ErrorReporter): (() => void) => {
  const previous = current;
  current = reporter;
  return () => { current = previous; };
};

/** For tests: keeps every report, in order. */
export class RecordingErrorReporter implements ErrorReporter {
  readonly reports: ErrorReport[] = [];
  report(report: ErrorReport): void { this.reports.push(report); }
  wheres(): string[] { return this.reports.map((report) => report.where); }
}
