/**
 * Issue #50 [X02] — the paper trail, and the rule that makes the acceptance criterion computable.
 *
 * "At least two written comparable proposals" is a fact about documents, not a feeling about
 * conversations. So each provider has a state, a date and — for anything that counts — a reference
 * to a document somebody can open. A quotation that exists only as a number somebody remembers from
 * a call cannot be recorded here, because there is no state for it.
 *
 * Sandbox credentials are deliberately absent. What is recorded is *that* access was granted and
 * when; the credentials themselves belong in the vault (#8), like every other secret in this
 * product.
 */
import { isWrittenProposal, type Bilingual, type Candidate, type ProposalRecord, type ProposalState } from './model.ts';

/**
 * Where each provider stands today: nobody has been approached.
 *
 * This is the honest starting state and it is why the recommendation defers. Sending the request in
 * `REQUEST_FOR_PROPOSAL` to the four named providers is the next physical act, and it is a person's
 * to do.
 */
export const PROPOSALS: readonly ProposalRecord[] = Object.freeze([
  record('iris', 'NOT_APPROACHED'),
  record('finagg', 'NOT_APPROACHED'),
  record('mastergst', 'NOT_APPROACHED'),
  record('clear', 'NOT_APPROACHED'),
]);

function record(candidateId: string, state: ProposalState, note?: string): ProposalRecord {
  return {
    candidateId,
    state,
    requestedOn: null,
    receivedOn: null,
    documentRef: null,
    sandboxGrantedOn: null,
    note: note ?? null,
  };
}

export const proposalFor = (records: readonly ProposalRecord[], candidateId: string): ProposalRecord | null =>
  records.find((item) => item.candidateId === candidateId) ?? null;

export const writtenProposals = (records: readonly ProposalRecord[]): readonly ProposalRecord[] =>
  records.filter(isWrittenProposal);

export const sandboxesGranted = (records: readonly ProposalRecord[]): readonly ProposalRecord[] =>
  records.filter((item) => item.sandboxGrantedOn !== null);

/** The issue's own bar: two written, comparable proposals before anybody chooses. */
export const REQUIRED_WRITTEN_PROPOSALS = 2;

export interface EvidenceState {
  readonly written: number;
  readonly sandboxes: number;
  readonly enough: boolean;
  readonly missing: Bilingual | null;
}

export const evidenceState = (records: readonly ProposalRecord[]): EvidenceState => {
  const written = writtenProposals(records).length;
  const sandboxes = sandboxesGranted(records).length;
  const enough = written >= REQUIRED_WRITTEN_PROPOSALS && sandboxes >= 1;
  return {
    written,
    sandboxes,
    enough,
    missing: enough
      ? null
      : {
          'en-IN': `A provider cannot be chosen yet: ${written} written ${written === 1 ? 'quotation' : 'quotations'} of the ${REQUIRED_WRITTEN_PROPOSALS} needed, and ${sandboxes} ${sandboxes === 1 ? 'sandbox' : 'sandboxes'} to test against.`,
          'hi-IN': `Abhi provider nahin chuna ja sakta: ${REQUIRED_WRITTEN_PROPOSALS} mein se ${written} likhit quotation mile hain, aur test karne ke liye ${sandboxes} sandbox.`,
        },
  };
};

/** The providers still to be approached, so the next action is a list of names and nothing else. */
export const stillToApproach = (
  candidates: readonly Candidate[],
  records: readonly ProposalRecord[],
): readonly string[] =>
  candidates
    .filter((candidate) => candidate.id !== 'no_provider')
    .filter((candidate) => {
      const proposal = proposalFor(records, candidate.id);
      return proposal === null || proposal.state === 'NOT_APPROACHED';
    })
    .map((candidate) => candidate.name);
