/**
 * Issue #32 [E32] — proving a deadline was met, and asking to be left alone for a while.
 *
 * Marking an obligation done is the one action here that permanently silences a warning, so it is
 * the one action that has to carry proof. The rule is simple: a completion says *what* happened
 * — an acknowledgement number, a challan, an IRN — and when.
 *
 * `TYPED_CONFIRMATION` exists because the proof is very often on a screen the product cannot reach.
 * An accountant files on the portal from their own laptop and tells the shop over the phone. The
 * honest options are to accept that, recorded as what it is, or to keep shouting at a business that
 * has already filed — which teaches everyone to ignore the alerts. So a typed confirmation is a
 * first-class completion and not a lesser one, and what it costs is a note: who says so, and where
 * they saw it. Evidence with somebody's name against it can be checked later; a bare "done" cannot.
 *
 * The acknowledgement number is not pattern-checked. Its format has changed before, this product
 * cannot verify one against the portal, and a validator that rejects a number the portal itself
 * issued would stop a business recording something true. A length check is the honest limit of what
 * we know.
 */
import { invalid, type IsoDate } from '@invoice/kernel';
import { daysBetween } from './schedule.ts';
import type { CompletionEvidence, ObligationOccurrence } from './types.ts';

const REFERENCE_KINDS = ['ARN', 'PORTAL_RECEIPT', 'IRN', 'PAYMENT_CHALLAN', 'SOURCE_MODULE'] as const;

export const validateEvidence = (evidence: CompletionEvidence): void => {
  const reference = evidence.reference.trim();
  const note = evidence.note.trim();

  if ((REFERENCE_KINDS as readonly string[]).includes(evidence.kind)) {
    if (reference.length < 4) {
      throw invalid(
        'COMPLIANCE_EVIDENCE_REFERENCE_REQUIRED',
        'Add the acknowledgement or reference number the portal gave you, so this can be checked later.',
      );
    }
    if (reference.length > 64) {
      throw invalid('COMPLIANCE_EVIDENCE_REFERENCE_TOO_LONG', 'That reference number is longer than any the portal issues. Check it and enter it again.');
    }
    return;
  }

  // A typed confirmation: no number, so the note carries the whole weight.
  if (note.length < 10) {
    throw invalid(
      'COMPLIANCE_EVIDENCE_NOTE_REQUIRED',
      'Write down who filed it and where they saw it done, so this can be checked later. For example: "Filed by Meena on the portal, she read out the acknowledgement over the phone".',
    );
  }
};

/**
 * A snooze is a decision about a reminder, not about a deadline.
 *
 * Three limits, each with a reason.
 *
 *   - **It must end.** Silence with no end date is how a business discovers a return in March that
 *     stopped being mentioned in August.
 *   - **It cannot pass the deadline.** A reminder silenced until after the due date is a reminder
 *     that never happens. If somebody genuinely intends to file late, the overdue notice is exactly
 *     the thing they should still receive.
 *   - **It needs a reason.** Not to police anybody: so the person who finds a late return next month
 *     can read what was known at the time instead of guessing.
 */
export const validateSnooze = (
  occurrence: ObligationOccurrence,
  until: IsoDate,
  reason: string,
  today: IsoDate,
): void => {
  if (reason.trim().length < 3) {
    throw invalid('COMPLIANCE_SNOOZE_REASON_REQUIRED', 'Say briefly why this can wait, so it is clear later what was known at the time.');
  }
  if (until <= today) {
    throw invalid('COMPLIANCE_SNOOZE_IN_PAST', 'Choose a date in the future to be reminded again.');
  }
  if (until > occurrence.dueDate) {
    throw invalid(
      'COMPLIANCE_SNOOZE_PAST_DUE_DATE',
      'A reminder cannot be pushed past the deadline itself. Choose a date on or before the due date; if it is missed, you will still be told.',
    );
  }
  if (daysBetween(today, until) > 30) {
    throw invalid('COMPLIANCE_SNOOZE_TOO_LONG', 'A reminder can be put off by at most a month at a time.');
  }
};
