/**
 * Issue #34 [E34] — fetching only what this person is allowed to see.
 *
 * The assistant never reads the books directly. It asks issue #35's `ReportService`, which checks
 * the actor's permission for every report and derives the company from the authenticated actor —
 * so there is no path here through which one business's figures could be fetched from another's
 * session, and no permission this assistant could accidentally hold on the asker's behalf.
 *
 * When a report is refused, the refusal is **kept and spoken**: the answer says which part is
 * missing and why. Silently leaving a section out would let somebody read a partial total as a
 * whole one, which is the same failure as showing them data they may not see, pointed the other
 * way.
 */
import { DomainError } from '@invoice/kernel';
import type { Report } from '@invoice/reports';
import type { Bilingual } from './model.ts';

export type Fetched<TBody> =
  | { readonly ok: true; readonly report: Report<TBody> }
  /** The asker may not see this. Named on the answer, never dropped. */
  | { readonly ok: false; readonly kind: 'NOT_ALLOWED'; readonly withheld: Bilingual }
  /** The books cannot answer for that period — they may not go back that far. */
  | { readonly ok: false; readonly kind: 'NOT_AVAILABLE'; readonly withheld: Bilingual };

export const fetchReport = async <TBody>(
  what: Bilingual,
  load: () => Promise<Report<TBody>>,
): Promise<Fetched<TBody>> => {
  try {
    return { ok: true, report: await load() };
  } catch (error) {
    if (error instanceof DomainError && error.kind === 'FORBIDDEN') {
      return {
        ok: false,
        kind: 'NOT_ALLOWED',
        withheld: {
          'en-IN': `You are not allowed to see ${what['en-IN']} in this business, so it is left out of this answer. Ask the owner to give you that permission.`,
          'hi-IN': `Is business mein aapko ${what['hi-IN']} dekhne ki ijazat nahin hai, isliye yeh jawab mein shaamil nahin hai. Malik se ijazat maangein.`,
        },
      };
    }
    if (error instanceof DomainError) {
      return {
        ok: false,
        kind: 'NOT_AVAILABLE',
        withheld: {
          'en-IN': `${what['en-IN']} cannot be shown for that period: ${error.message}`,
          'hi-IN': `Us samay ke liye ${what['hi-IN']} nahin dikhaya ja sakta: ${error.message}`,
        },
      };
    }
    throw error;
  }
};
