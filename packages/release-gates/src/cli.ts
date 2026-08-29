/**
 * Issue #48 [E48] — the gate CI runs.
 *
 *   npm run gates
 *
 * Exits non-zero when a critical invariant is violated, which is what makes this a gate rather
 * than a report. It also exits non-zero if the observation itself cannot be gathered: a build we
 * cannot inspect is not a build we may ship.
 */
import { observeEverything } from './observe.ts';
import { renderReport, runGates } from './runner.ts';

const main = async (): Promise<void> => {
  let report;
  try {
    report = runGates(await observeEverything());
  } catch (error) {
    console.error('Financial correctness gates (issue #48)\n');
    console.error(`The build could not be inspected at all: ${error instanceof Error ? error.message : String(error)}`);
    console.error('\nA build that cannot be checked must not be released.');
    process.exitCode = 1;
    return;
  }

  console.log(renderReport(report));
  if (!report.mayRelease) process.exitCode = 1;
};

await main();
