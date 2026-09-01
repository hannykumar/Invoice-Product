/**
 * Issue #53 [X05] — what happens when there is no authorised access, and what happens when there is
 * and it does not answer.
 *
 * These are the same workflow, and that is the point. Until an application is approved this is the
 * *only* workflow, which is why it is defined here rather than left as a thing to build later: a
 * product whose vehicle checking depends on an approval nobody has yet is a product that does not
 * check vehicles. And after approval it is still needed, because providers go down, consent lapses
 * and small transporters run lorries the authority's record cannot be read for.
 *
 * The workflow is a person reading the registration certificate the driver is carrying and typing
 * what it says. That is not a degraded mode to be embarrassed about — it is what every business
 * does today, it is available at four in the afternoon when a provider is not, and #28 already
 * ranks it correctly: typed facts fill a gap and never overrule the authority's record.
 *
 * Three rules keep it honest, and #28 enforces all three:
 *
 *   1. **Typed evidence is labelled `ENTERED_BY_HAND` and is never presented as the authority’s.**
 *   2. **It is ranked below both the government record and the business’s own vehicle list**, so
 *      typing a bigger capacity cannot overrule a record that says otherwise.
 *   3. **"We could not ask" is never "nothing is wrong".** A movement checked only against typed
 *      facts says so on the screen and in the audit trail.
 */
import type { Bilingual } from './model.ts';

export interface FallbackStep {
  readonly order: number;
  /** What the person does, in the words the screen uses. */
  readonly what: Bilingual;
  /** Why this step and not a shortcut. */
  readonly why: string;
}

export interface FallbackWorkflow {
  readonly id: string;
  readonly when: string;
  readonly steps: readonly FallbackStep[];
  /** What this workflow must never be allowed to do, however convenient. */
  readonly limits: readonly string[];
  /** The evidence source the typed facts are recorded under. */
  readonly recordedAs: 'ENTERED_BY_HAND';
}

/**
 * The manual evidence workflow.
 *
 * Step 2 is the one that matters and the one a hurried implementation would drop: the certificate
 * is a document that exists, and attaching a photograph of it turns "somebody typed 16,400 kg" into
 * something a person can check afterwards. But the photograph is not required to proceed — a
 * driver's certificate may be a worn paper copy in bad light, and refusing to let a business
 * dispatch because a camera would not focus would make the fallback useless exactly when it is
 * needed. The typed facts stand on their own; the photograph, when there is one, corroborates them.
 */
export const MANUAL_FALLBACK: FallbackWorkflow = Object.freeze({
  id: 'vehicle.evidence.manual',
  when: 'No authorised access yet; or the provider is unreachable, refuses, or holds no record of this vehicle.',
  recordedAs: 'ENTERED_BY_HAND',
  steps: Object.freeze([
    {
      order: 1,
      what: {
        'en-IN': 'The screen says plainly that the vehicle could not be checked against the registering authority, and why.',
        'hi-IN': 'Screen saaf kehti hai ki vaahan ki jaanch pradhikaran se nahi ho payi, aur kyun.',
      },
      why: 'A person deciding whether to load a lorry has to know that nothing was verified. A blank space reads as "fine".',
    },
    {
      order: 2,
      what: {
        'en-IN': 'Ask the driver for the vehicle’s registration certificate. Attach a photograph of it if one can be taken.',
        'hi-IN': 'Driver se vaahan ka registration certificate maangein. Ho sake to uski photo lagayein.',
      },
      why: 'The document exists and is in the cab. A photograph makes the typed figures checkable later; it is not required, because a worn certificate in bad light must not stop a dispatch.',
    },
    {
      order: 3,
      what: {
        'en-IN': 'Type in what the certificate says: the kind of vehicle, the body, the weights, the permit and the dates.',
        'hi-IN': 'Certificate par jo likha hai wahi bharein: vaahan ka prakaar, body, wazan, permit aur tareekhein.',
      },
      why: 'These are the same facts the authority would have given, from the same document. Only the route differs, and the route is recorded.',
    },
    {
      order: 4,
      what: {
        'en-IN': 'The same checks run on the typed facts, and the answer says which facts were typed rather than read from the authority.',
        'hi-IN': 'Wahi jaanchein type ki gayi jaankaari par chalti hain, aur javaab batata hai ki kaunsi baatein type ki gayi thin.',
      },
      why: 'A scooter is a scooter whoever typed it. The checks are worth running on weaker evidence, as long as the evidence is labelled.',
    },
    {
      order: 5,
      what: {
        'en-IN': 'If the checks block the movement and it has to go anyway, someone with permission records why. The typed facts stay exactly as they were.',
        'hi-IN': 'Agar jaanch rok deti hai aur maal phir bhi jaana hai, to adhikaar rakhne wala vyakti kaaran likhta hai. Bhari gayi jaankaari waisi hi rehti hai.',
      },
      why: 'An override is a person taking responsibility on top of the evidence, never an edit to it.',
    },
    {
      order: 6,
      what: {
        'en-IN': 'If the vehicle is one the business uses often, save the typed facts to its own vehicle list so nobody types them again.',
        'hi-IN': 'Agar yeh vaahan baar-baar istemal hota hai, to yeh jaankaari apni vaahan suchi mein save karein.',
      },
      why: 'The company’s own list ranks above one-off typing and below the authority, which is exactly what a remembered-but-unverified fact deserves.',
    },
  ]),
  limits: Object.freeze([
    'Typed facts are never recorded as coming from the registering authority, and never fill the government-record slot.',
    'Typed facts never overrule the authority’s record where one was obtained; they rank below it and below the business’s own vehicle list.',
    'A movement checked only against typed facts is not reported as verified.',
    'Nothing typed here is sent to the authority or to a provider. It is the business’s own record of its own dispatch.',
  ]),
});
