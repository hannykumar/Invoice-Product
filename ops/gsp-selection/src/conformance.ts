/**
 * Issue #50 [X02] — what a provider's sandbox has to prove before we build on it.
 *
 * "Obtain sandbox access" should end in a green run, not in a login somebody clicked around once.
 * This harness takes any sandbox — the synthetic one in #33 today, a real provider's tomorrow — and
 * puts it through the capability checklist plus the four behaviours the authorised channel actually
 * depends on. A provider that fails any critical check is not a provider we can build on, whatever
 * the commercial terms say, and the report says exactly which four things to go back to them about.
 *
 * Two checks deserve their own sentence.
 *
 *   - **The one-time password dance is checked with a wrong code first.** A sandbox that accepts any
 *     six digits, or that throws instead of answering "wrong, two tries left", is telling us what
 *     its production behaviour will be on the day a customer fat-fingers an OTP.
 *   - **Every response is scanned for things that look like secrets.** A sandbox that hands back a
 *     portal password, a token or the OTP itself in some field we did not ask for is disqualifying:
 *     #33 has nowhere to put it, and a provider that emits one will emit it in production too.
 *
 * The output feeds the comparison directly: `capabilityEvidence` turns a run into `CONFIRMED`
 * assessments, so a sandbox trial updates the scoring instead of being written up separately and
 * forgotten.
 */
import { ConnectorError, type ConnectorGateway, type ConnectorKind } from '../../../packages/platform/src/connectors.ts';
import type { GspProviderPort } from '@invoice/gsp';
import { CAPABILITIES } from './capabilities.ts';
import { known, type Assessment } from './model.ts';

export type CheckState = 'PASSED' | 'FAILED' | 'NOT_SUPPORTED' | 'NOT_ATTEMPTED';

export interface ConformanceCheck {
  /** The capability this proves, or a behaviour id for the four that are not capabilities. */
  readonly id: string;
  readonly what: string;
  readonly why: string;
  readonly critical: boolean;
  readonly state: CheckState;
  readonly detail: string;
}

export interface ConformanceReport {
  readonly provider: string;
  readonly at: string;
  readonly checks: readonly ConformanceCheck[];
  /** Critical checks that did not pass. Any at all means the provider is not viable. */
  readonly criticalGaps: readonly string[];
  readonly passed: boolean;
  readonly summary: string;
}

/**
 * Values that must never come back from a provider.
 *
 * The OTP is included as a literal because a sandbox that echoes the code it just verified is
 * telling us it logs it somewhere.
 */
const SECRET_SHAPES: readonly { readonly kind: string; readonly match: RegExp }[] = [
  { kind: 'a password field', match: /\b(?:password|passwd|pwd|mpin)\b/i },
  { kind: 'a one-time password field', match: /\botp\b/i },
  { kind: 'a token', match: /\b(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|bearer)\b/i },
  { kind: 'a private key', match: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const secretIn = (value: unknown, otp: string): string | null => {
  const text = JSON.stringify(value ?? '', (_key, item: unknown) => (typeof item === 'bigint' ? '<amount>' : item));
  for (const shape of SECRET_SHAPES) if (shape.match.test(text)) return shape.kind;
  if (otp !== '' && text.includes(otp)) return 'the one-time password it had just verified';
  return null;
};

/**
 * A sandbox, described.
 *
 * `payloads` is per capability, because only the provider knows what their sandbox will accept: a
 * test GSTIN, a test invoice, a test consignment. They are supplied rather than invented, and a
 * capability with no payload is reported `NOT_ATTEMPTED` rather than passed on an empty request.
 */
export interface SandboxUnderTest {
  readonly name: string;
  readonly provider: GspProviderPort;
  readonly gateway: ConnectorGateway;
  readonly companyId: string;
  readonly gstin: string;
  readonly legalName: string;
  /** The code this sandbox expects. Not a secret — there is no real portal behind it. */
  readonly otp: string;
  readonly payloads: Readonly<Record<string, { readonly connector: ConnectorKind; readonly operation: string; readonly payload: Readonly<Record<string, unknown>> }>>;
}

/**
 * Providers do not agree on the spelling.
 *
 * The IRP answers `ErrorCode`, the e-way portal `errorCode`, and a harness that knows only one of
 * them reads a refusal as a success. Tolerating both is not politeness; it is the difference
 * between a trial that finds a gap and one that reports a green run over an error.
 */
const errorCodeIn = (payload: Readonly<Record<string, unknown>>): string | null => {
  for (const key of ['ErrorCode', 'errorCode', 'error_code']) {
    const value = payload[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
};

/**
 * The identifiers one call produces and the next one needs.
 *
 * Cancelling an e-invoice needs the IRN that generating it just returned, and changing a vehicle
 * needs the e-way bill number. A real provider trial has exactly this problem, so the payloads may
 * carry `{{irn}}`, `{{ewayBillNo}}` or `{{ackNo}}` and the harness fills them in from what the
 * sandbox has already answered.
 */
const REFERENCE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  Irn: 'irn', irn: 'irn', ewayBillNo: 'ewayBillNo', EwbNo: 'ewayBillNo', AckNo: 'ackNo',
});

const collectReferences = (payload: Readonly<Record<string, unknown>>, into: Map<string, string>): void => {
  for (const [key, name] of Object.entries(REFERENCE_KEYS)) {
    const value = payload[key];
    if ((typeof value === 'string' && value !== '') || typeof value === 'number') into.set(name, String(value));
  }
};

const fill = (value: unknown, references: ReadonlyMap<string, string>): unknown => {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => references.get(name) ?? whole);
  }
  if (Array.isArray(value)) return value.map((item) => fill(item, references));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, fill(item, references)]));
  }
  return value;
};

const check = (
  id: string,
  what: string,
  why: string,
  critical: boolean,
  state: CheckState,
  detail: string,
): ConformanceCheck => ({ id, what, why, critical, state, detail });

export const runConformance = async (sandbox: SandboxUnderTest): Promise<ConformanceReport> => {
  const at = new Date().toISOString();
  const checks: ConformanceCheck[] = [];
  const references = new Map<string, string>();
  let credentialReference: string | null = null;

  // ------------------------------------------------------------------ the authorisation dance
  try {
    const user = await sandbox.provider.createApiUser({
      companyId: sandbox.companyId as never,
      gstin: sandbox.gstin,
      legalName: sandbox.legalName,
      signatoryHint: 'conformance run',
      scopes: ['EINVOICE_GENERATE'],
    });
    if (user.kind !== 'CREATED' && user.kind !== 'EXISTS') {
      checks.push(check('api_user_otp', 'Authorise a GST number with a one-time password', 'Without it we would have to hold the customer’s portal password, which this product will not do.', true, 'FAILED', `Creating an API user answered ${user.kind}.`));
    } else {
      const sent = await sandbox.provider.requestOtp({ gstin: sandbox.gstin, apiUserId: user.apiUserId });
      if (sent.kind !== 'SENT') {
        checks.push(check('api_user_otp', 'Authorise a GST number with a one-time password', 'The only route that does not need a portal password.', true, 'FAILED', `Requesting the code answered ${sent.kind}.`));
      } else {
        // Wrong code first, deliberately. A sandbox that accepts anything, or throws instead of
        // answering, will do the same to a customer who mistypes on a Tuesday evening.
        const wrong = await sandbox.provider.verifyOtp({ gstin: sandbox.gstin, requestId: sent.requestId, otp: '000000' });
        const rejectsWrong = wrong.kind === 'WRONG_OTP';
        const right = await sandbox.provider.verifyOtp({ gstin: sandbox.gstin, requestId: sent.requestId, otp: sandbox.otp });
        if (right.kind !== 'AUTHORISED') {
          checks.push(check('api_user_otp', 'Authorise a GST number with a one-time password', 'The only route that does not need a portal password.', true, 'FAILED', `The correct code answered ${right.kind}.`));
        } else {
          credentialReference = right.credentialReference;
          checks.push(check(
            'api_user_otp', 'Authorise a GST number with a one-time password',
            'The only route that does not need a portal password.',
            true, 'PASSED',
            `Authorised${rejectsWrong ? ', and a wrong code was refused with the tries remaining' : ' — but a wrong code was not refused cleanly, which is worth asking about'}.`,
          ));
        }
      }
    }
  } catch (error) {
    checks.push(check('api_user_otp', 'Authorise a GST number with a one-time password', 'The only route that does not need a portal password.', true, 'FAILED', `It threw: ${message(error)}.`));
  }

  // ------------------------------------------------------------------ the capabilities
  for (const capability of CAPABILITIES) {
    if (capability.id === 'api_user_otp') continue;
    const call = sandbox.payloads[capability.id];
    if (call === undefined) {
      checks.push(check(capability.id, capability.label['en-IN'], capability.why, capability.critical, 'NOT_ATTEMPTED', 'The provider gave us no sandbox request for this, so it is unproven rather than absent.'));
      continue;
    }
    try {
      const response = await sandbox.gateway.execute(call.connector, {
        tenantId: sandbox.companyId,
        operation: call.operation,
        payload: fill(call.payload, references) as Readonly<Record<string, unknown>>,
        idempotencyKey: `conformance:${capability.id}`,
        correlationId: `conformance-${capability.id}`,
      });
      collectReferences(response.payload, references);
      const errorCode = errorCodeIn(response.payload);
      const leak = secretIn(response.payload, sandbox.otp);
      if (leak !== null) {
        checks.push(check(capability.id, capability.label['en-IN'], capability.why, capability.critical, 'FAILED', `The response carried ${leak}. This product has nowhere to put one, and a sandbox that emits it will emit it in production.`));
      } else if (errorCode !== null) {
        checks.push(check(capability.id, capability.label['en-IN'], capability.why, capability.critical, 'NOT_SUPPORTED', `The sandbox answered error ${errorCode}: ${String(response.payload.ErrorMessage ?? response.payload.errorMessage ?? 'no message')}.`));
      } else {
        checks.push(check(capability.id, capability.label['en-IN'], capability.why, capability.critical, 'PASSED', 'The sandbox accepted it and answered.'));
      }
    } catch (error) {
      const detail = error instanceof ConnectorError ? `The call failed as ${error.code}.` : `It threw: ${message(error)}.`;
      checks.push(check(capability.id, capability.label['en-IN'], capability.why, capability.critical, 'FAILED', detail));
    }
  }

  // ------------------------------------------------------------------ the behaviours
  const duplicate = sandbox.payloads.irn_generate;
  if (duplicate === undefined) {
    checks.push(check('idempotent_retry', 'The same request twice produces one document', 'A retry after a timeout is the ordinary case; a provider that registers two invoices for it is unusable.', true, 'NOT_ATTEMPTED', 'No sandbox invoice was supplied to try it with.'));
  } else {
    try {
      const request = {
        tenantId: sandbox.companyId,
        operation: duplicate.operation,
        payload: duplicate.payload,
        idempotencyKey: 'conformance:retry',
        correlationId: 'conformance-retry',
      };
      const first = await sandbox.gateway.execute(duplicate.connector, request);
      const second = await sandbox.gateway.execute(duplicate.connector, request);
      const same = first.providerRequestId === second.providerRequestId || JSON.stringify(first.payload) === JSON.stringify(second.payload);
      checks.push(check(
        'idempotent_retry', 'The same request twice produces one document',
        'A retry after a timeout is the ordinary case, and two IRNs for one invoice is a correction the customer pays for.',
        true, same ? 'PASSED' : 'FAILED',
        same ? 'The second attempt returned the first answer.' : 'The second attempt produced a different answer, so a retry would create a second document.',
      ));
    } catch (error) {
      checks.push(check('idempotent_retry', 'The same request twice produces one document', 'A retry after a timeout is the ordinary case.', true, 'FAILED', `It threw: ${message(error)}.`));
    }
  }

  try {
    const health = await sandbox.provider.health();
    checks.push(check('health', 'It can say whether it is up', 'A settings screen that cannot tell "the portal is down" from "you are not connected" sends people to the wrong place.', false, health === 'healthy' ? 'PASSED' : 'FAILED', `It answered ${health}.`));
  } catch (error) {
    checks.push(check('health', 'It can say whether it is up', 'Needed by the settings screen.', false, 'FAILED', `It threw: ${message(error)}.`));
  }

  checks.push(
    credentialReference === null
      ? check('credential_is_a_reference', 'What it hands back is a reference, not a secret', 'This product stores a vault address and has no field for a credential.', true, 'NOT_ATTEMPTED', 'The authorisation did not complete, so there was nothing to inspect.')
      : check(
          'credential_is_a_reference', 'What it hands back is a reference, not a secret',
          'This product stores a vault address and has no field for a credential.',
          true,
          secretIn({ credentialReference }, sandbox.otp) === null ? 'PASSED' : 'FAILED',
          secretIn({ credentialReference }, sandbox.otp) === null ? 'It is an opaque reference.' : 'It looks like a secret rather than a reference.',
        ),
  );

  const criticalGaps = checks.filter((item) => item.critical && item.state !== 'PASSED').map((item) => item.id);
  const passed = criticalGaps.length === 0;
  return Object.freeze({
    provider: sandbox.name,
    at,
    checks,
    criticalGaps,
    passed,
    summary: passed
      ? `${sandbox.name}: every critical capability and behaviour passed in the sandbox.`
      : `${sandbox.name}: ${criticalGaps.length} critical ${criticalGaps.length === 1 ? 'check' : 'checks'} did not pass — ${criticalGaps.join(', ')}.`,
  });
};

/**
 * A sandbox run, turned into evidence the comparison can use.
 *
 * This is the loop that keeps the two honest. A trial that passes updates the candidate's
 * capabilities to `CONFIRMED` with the run as the source; one that fails records the `false` just as
 * firmly. A `NOT_ATTEMPTED` check produces nothing at all, because "we did not try" is not a finding.
 */
export const capabilityEvidence = (report: ConformanceReport): Readonly<Record<string, Assessment<boolean>>> => {
  const evidence: Record<string, Assessment<boolean>> = {};
  const source = `sandbox conformance run against ${report.provider}`;
  const day = report.at.slice(0, 10);
  for (const item of report.checks) {
    if (!CAPABILITIES.some((capability) => capability.id === item.id)) continue;
    if (item.state === 'NOT_ATTEMPTED') continue;
    evidence[item.id] = known(item.state === 'PASSED', 'CONFIRMED', source, day, item.detail);
  }
  return Object.freeze(evidence);
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
