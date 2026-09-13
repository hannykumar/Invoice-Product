/**
 * Issue #51 [X03] — reading the register back as findings, and refusing to flatter it.
 *
 * The one thing this file must never do is report "ready" when it is not, so the rule is blunt:
 * production is allowed only when every step is `DONE`. A step deliberately not being pursued does
 * not count as satisfied — it is the clearest possible reason production is not available, and it
 * is reported as such rather than quietly excluded from the denominator.
 *
 * The last check compares this register with `PRODUCTION_ACCESS` in `packages/gst`, which is the
 * switch the connector actually obeys. A document that says one thing while the code does another
 * is worse than no document, so the two disagreeing is itself a blocking finding.
 */
import { PRODUCTION_ACCESS, type ProductionAccess } from '@invoice/gst';
import { GO_LIVE_STEPS } from './checklist.ts';
import { bilingual, type Finding, type GoLiveReport, type GoLiveStep, type ProductionRegister, type StepRecord } from './model.ts';

const finding = (
  level: Finding['level'],
  code: string,
  what: Finding['what'],
  whatToDo: Finding['whatToDo'],
  blocks: readonly string[] = ['#51'],
): Finding => ({ level, code, what, whatToDo, blocks });

export const assess = (
  register: ProductionRegister,
  asOf: string,
  access: ProductionAccess = PRODUCTION_ACCESS,
): GoLiveReport => {
  const byId = new Map<string, StepRecord>(register.steps.map((record) => [record.id, record]));
  const steps: (GoLiveStep & StepRecord)[] = GO_LIVE_STEPS.map((step) => {
    const record = byId.get(step.id) ?? { id: step.id, state: 'NOT_STARTED' as const, evidence: null, note: null };
    return { ...step, ...record };
  });

  const findings: Finding[] = [];

  for (const step of steps.filter((candidate) => candidate.state === 'ON_HOLD_BY_DECISION')) {
    findings.push(finding(
      'INFORMATION',
      `ON_HOLD_BY_DECISION:${step.id}`,
      bilingual(
        `${step.label['en-IN']} — deliberately not being pursued.`,
        `${step.label['hi-IN']} — jaan-boojhkar abhi nahin kiya ja raha.`,
      ),
      bilingual(
        `${step.note ?? ''} ${step.evidence === null ? '' : `See: ${step.evidence}.`}`.trim(),
        `${step.note ?? ''} ${step.evidence === null ? '' : `Dekhein: ${step.evidence}.`}`.trim(),
      ),
    ));
  }

  const outstanding = steps.filter((step) => step.state !== 'DONE');
  for (const step of outstanding.filter((candidate) => candidate.state !== 'ON_HOLD_BY_DECISION')) {
    findings.push(finding(
      'BLOCKING',
      `GO_LIVE_STEP_OUTSTANDING:${step.id}`,
      bilingual(
        `${step.label['en-IN']} — ${step.state === 'IN_PROGRESS' ? 'started, not finished' : 'not started'}.`,
        `${step.label['hi-IN']} — ${step.state === 'IN_PROGRESS' ? 'shuru hua hai, poora nahin' : 'shuru hi nahin hua'}.`,
      ),
      bilingual(
        `${step.why} This one needs ${step.answerable === 'PERSON' ? 'a person with authority to act' : step.answerable === 'PROVIDER' ? 'an answer from the provider' : 'work in this repository'}.`,
        step.answerable === 'PERSON'
          ? 'Iske liye aise vyakti chahiye jo faisla le sake.'
          : step.answerable === 'PROVIDER' ? 'Iske liye provider ka jawab chahiye.' : 'Yeh kaam is repository mein hona hai.',
      ),
      step.blocks,
    ));
  }

  if (register.contractedProvider === null && register.sandboxProvider !== null) {
    findings.push(finding(
      'INFORMATION',
      'SANDBOX_ONLY_TODAY',
      bilingual(
        `Today this product talks to ${register.sandboxProvider}, and to nothing else.`,
        `Aaj yeh product sirf ${register.sandboxProvider} se baat karta hai, aur kisi se nahin.`,
      ),
      bilingual(
        'A sandbox IRN is not a legally valid IRN. Anything a customer is shown from it must say so.',
        'Sandbox ka IRN kaanooni taur par asli IRN nahin hai. Customer ko jo bhi dikhe, usmein yeh saaf likha ho.',
      ),
      [],
    ));
  }

  // The register and the switch the connector obeys must agree, or one of them is a lie.
  const registerSaysProduction = register.environment === 'PRODUCTION';
  if (registerSaysProduction !== access.active) {
    findings.push(finding(
      'BLOCKING',
      'REGISTER_DISAGREES_WITH_CODE',
      bilingual(
        `This register says ${register.environment} while the connector's own switch says production access is ${access.active ? 'active' : 'not active'}.`,
        `Yeh register ${register.environment} kehta hai, jabki connector ka switch kehta hai ki production access ${access.active ? 'chaalu' : 'band'} hai.`,
      ),
      bilingual(
        'Fix whichever is wrong before anything else. The switch is PRODUCTION_ACCESS in packages/gst/src/environments.ts.',
        'Kuch aur karne se pehle jo galat hai use theek karein. Switch packages/gst/src/environments.ts mein PRODUCTION_ACCESS hai.',
      ),
    ));
  }

  const productionAllowed = outstanding.length === 0 && access.active && registerSaysProduction;
  const done = steps.length - outstanding.length;

  return {
    asOf,
    productionAllowed,
    register,
    steps,
    findings,
    summary: bilingual(
      productionAllowed
        ? `Production access is active with ${register.contractedProvider ?? 'the contracted provider'}; all ${steps.length} go-live conditions are satisfied.`
        : `Production access is not active. ${done} of ${steps.length} go-live conditions are satisfied; ${outstanding.length} are outstanding.`,
      productionAllowed
        ? `Production access chaalu hai; sabhi ${steps.length} sharten poori hain.`
        : `Production access band hai. ${steps.length} mein se ${done} sharten poori hain, ${outstanding.length} baaki hain.`,
    ),
  };
};
