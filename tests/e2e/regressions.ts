/**
 * Issue #44 — the regression register.
 *
 * One of this issue's acceptance criteria is that **every production regression receives a permanent
 * test**. That is a promise about a habit, and habits decay, so it is written down as data and
 * checked by a test rather than left in a contributing guide nobody reads.
 *
 * A regression goes in here when something that used to work stopped working, or when something
 * that was always broken is found by a real user or a real integration. Each entry names the test
 * that would fail again if the fault came back, and `regressions.test.ts` fails the build if that
 * test does not exist. A register that points at a test somebody deleted is worse than no register.
 *
 * What does not go in here: a feature that was never built, a design disagreement, or a bug caught
 * by the module's own tests before it ever reached anybody. Those are ordinary work.
 */

export interface Regression {
  /** Stable, shouted, and greppable. Referenced from the test that pins it. */
  readonly id: string;
  /** When it was found, not when it was introduced — nobody ever knows the second one. */
  readonly foundOn: string;
  /** How it was found: a customer, an integration, a scenario in this directory. */
  readonly foundBy: string;
  /** What actually went wrong, in the words somebody would use to describe the damage. */
  readonly symptom: string;
  /** The guarantee it broke. Every entry must break one, or it is not a regression. */
  readonly invariant: string;
  /** Where the fault was, so the register doubles as a map of the thin ice. */
  readonly cause: string;
  /** The exact name of the test that fails if this comes back. Checked, not trusted. */
  readonly pinnedBy: string;
  /** The file that test lives in, relative to this directory. */
  readonly inFile: string;
}

export const REGRESSIONS: readonly Regression[] = Object.freeze([
  {
    id: 'PURCHASE_DUPLICATE_BILL_ON_CONCURRENT_POST',
    foundOn: '2026-09-01',
    foundBy: 'The concurrency scenarios in this directory, on the first run.',
    symptom:
      'Posting the same approved supplier bill twice at the same moment recorded the bill twice. '
      + 'The money and the stock were right — the ledger and the godown each deduplicated on their own '
      + 'keys — but the purchase register showed the same supplier invoice number twice, both marked '
      + 'posted, both pointing at the one voucher. The second caller was told "already recorded" while '
      + 'being handed a bill that had just been created for them.',
    invariant: 'Creating duplicate purchase invoices during retries is one of the things this product exists to prevent.',
    cause:
      'The duplicate check in `PurchasePostingService.post` ran before the transaction opened, so two '
      + 'posts in flight together both found nothing and both went on to insert. The check now also runs '
      + 'inside the unit of work, where the store serialises them.',
    pinnedBy: 'a supplier bill posted twice at once creates one bill and one payable',
    inFile: 'concurrency.test.ts',
  },
  {
    id: 'GSTR1_ADAPTER_SHAPE_MISMATCH',
    foundOn: '2026-09-01',
    foundBy: 'The GST-output scenarios in this directory, the first time a real sales invoice was put on a return.',
    symptom:
      'No real sale could be put on GSTR-1 at all. The adapter read the bill total from a field the '
      + 'sales module does not have, so every converted document carried an undefined invoice value and '
      + 'the return crashed while fingerprinting it; and it declared the line quantity as a string while '
      + 'the sales module holds an amount and a unit, so the HSN summary either crashed or — where a '
      + 'caller had already flattened it to "100 KGS" — silently reported a quantity of zero.',
    invariant: 'GST outputs must trace back to the books that produced them. A return nobody can build traces back to nothing.',
    cause:
      'Both modules were correct against their own fixtures. The GST-return module tested its adapter '
      + 'with an invented invoice shaped like its own idea of a sales invoice, and the sales module never '
      + 'saw a return. Nothing composed the two until this issue did.',
    pinnedBy: 'the GST return built from a real sale agrees with the ledger that sale posted',
    inFile: 'gst-outputs.test.ts',
  },
]);
