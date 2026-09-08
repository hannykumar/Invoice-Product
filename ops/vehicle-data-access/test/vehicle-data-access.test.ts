/**
 * Issue #53 [X05] acceptance criteria, enforced automatically.
 *
 *   - "Application submitted and tracked"
 *   - "Approved fields and usage restrictions documented"
 *   - "Fallback manual evidence workflow defined"
 *
 * plus the testing the issue asks for — a sample response reviewed against #28's needs, and a
 * privacy-minimisation review — and the two non-goals, which are the easy ones to fail: scraping
 * the public portals, and asking for the owner's personal information.
 *
 * The fallback tests are the ones that matter most today, because with no approved access the
 * fallback is not a contingency: it is the whole of the product's vehicle checking. So they drive
 * #28's real rule engine rather than asserting that a document describes a workflow.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkVehicleSuitability } from '../../../packages/transport/src/suitability.ts';
import { transportDetails, fiveTonneShipment } from '../../../packages/transport/src/fixtures.ts';
import { SYNTHETIC_VAHAN_ROWS } from '../../../packages/transport/src/vehicle-record-adapters.ts';
import {
  DEFAULT_VEHICLE_RECORD_FRESHNESS,
  PERMITTED_VEHICLE_FIELDS,
} from '../../../packages/transport/src/vehicle-record-types.ts';
import type { VehicleEvidence } from '../../../packages/transport/src/suitability-types.ts';
import { DECLINED_FIELDS, REQUESTED_FIELDS, personalDataFields, requestedFieldNames } from '../src/fields.ts';
import { evidenceFieldsInSource, reviewNecessity, ruleCodesInSource } from '../src/necessity.ts';
import { CANDIDATES, disqualification } from '../src/providers.ts';
import { RETENTION, permittedUseTerms, reviewCaching } from '../src/permitted-use.ts';
import { MANUAL_FALLBACK } from '../src/fallback.ts';
import { E28_NEEDS, reviewSampleResponse } from '../src/sample-review.ts';
import { approvalGaps, dossier, readyToSubmit, trackerReport, unanswered } from '../src/application.ts';
import { APPLICATIONS } from '../src/state.ts';
import { applicationProblems, DECLARED_PURPOSE } from '../src/model.ts';
import type { ApplicationRecord } from '../src/model.ts';

const TODAY = '2026-09-01';
const AT = `${TODAY}T04:30:00.000Z`;

const row = (number: string): Readonly<Record<string, unknown>> => {
  const found = SYNTHETIC_VAHAN_ROWS.find((item) => item.rc_regn_no === number);
  if (found === undefined) throw new Error(`no synthetic vehicle ${number}`);
  return found;
};

// --------------------------------------------------- the field list is the one the code enforces

test('the application asks for exactly the fields the code is allowed to keep', () => {
  // The failure this prevents is an application that drifts from the software it describes: asking
  // for fields we never use, or — far worse — using fields we never asked for.
  assert.deepEqual([...requestedFieldNames()], [...PERMITTED_VEHICLE_FIELDS]);
});

test('every requested field carries a reason a reviewer could argue with', () => {
  for (const request of REQUESTED_FIELDS) {
    assert.ok(request.why.length > 60, `${request.field} has no real necessity argument`);
    assert.ok(request.plainName.length > 0, `${request.field} has no wording a shopkeeper could read`);
  }
});

test('every rule a field claims to decide is a rule the source actually raises', () => {
  const codes = ruleCodesInSource();
  assert.ok(codes.size >= 15, 'the scan found almost no rule codes, so it is no longer watching anything');
  for (const request of REQUESTED_FIELDS) {
    for (const code of request.decidesRules) {
      assert.ok(codes.has(code), `${request.field} claims to decide ${code}, which no rule raises`);
    }
  }
});

// --------------------------------------------------------------- the privacy-minimisation review

test('the privacy-minimisation review passes, and passes for reasons read out of the rules', () => {
  const review = reviewNecessity(TODAY);
  assert.equal(review.passed, true, review.summary['en-IN']);
  const deciding = review.findings.filter((finding) => finding.verdict === 'DECIDES_A_RULE');
  assert.equal(deciding.length, 10, 'ten of the twelve fields should be read by a deterministic check');
});

test('exactly one requested field names a person, it is stored masked, and no rule reads it', () => {
  const personal = personalDataFields();
  assert.equal(personal.length, 1);
  const owner = personal[0];
  assert.ok(owner !== undefined);
  assert.equal(owner.field, 'registeredOwnerName');
  assert.equal(owner.storedAs, 'MASKED');
  assert.deepEqual([...owner.decidesRules], [], 'a field a rule reads would need a different justification');

  const finding = reviewNecessity(TODAY).findings.find((item) => item.field === 'registeredOwnerName');
  assert.equal(finding?.verdict, 'SHOWN_TO_A_PERSON');
});

test('a field nobody can justify fails the review rather than being quietly averaged away', () => {
  // Pointing the review at a file that reads none of the fields simulates the rules no longer
  // needing them. Everything except the request key and the one human-use field must fail.
  const review = reviewNecessity(TODAY, ['../../../packages/transport/src/fixtures.ts']);
  assert.equal(review.passed, false);
  const unjustified = review.findings.filter((finding) => finding.verdict === 'UNJUSTIFIED');
  assert.ok(unjustified.length >= 9, 'a review that still passes when nothing reads the fields is not a review');
  assert.match(review.summary['en-IN'], /must not be submitted/);
});

test('nothing the rules read off a vehicle record is missing from the application', () => {
  // The other direction, and the one that would be collection without permission rather than
  // over-collection. #29's allow-list makes it impossible today; this keeps it impossible.
  const taken = reviewNecessity(TODAY).findings.filter((finding) => finding.verdict === 'TAKEN_WITHOUT_ASKING');
  assert.deepEqual(taken, []);
  assert.ok(evidenceFieldsInSource().length >= 10, 'the evidence-type scan found nothing, so it is watching nothing');
});

// ------------------------------------------------------------------- the sample-response review

test('a full provider response supports every vehicle check #28 makes', () => {
  const review = reviewSampleResponse('the synthetic authority', row('KA01AB1234'), {
    registrationNumber: 'KA01AB1234',
    retrievedAt: AT,
  });
  assert.equal(review.passed, true);
  assert.deepEqual([...review.checksThatCannotRun], [], review.summary['en-IN']);
  assert.equal(review.coverage.length, Object.keys(E28_NEEDS).length);
});

test('a response missing a field says which check stops working, rather than reading as fine', () => {
  // The scooter's record has no permit validity, because a scooter has no goods permit. The review
  // has to name the check that cannot run rather than reporting full coverage.
  const review = reviewSampleResponse('the synthetic authority', row('KA05MN9012'), {
    registrationNumber: 'KA05MN9012',
    retrievedAt: AT,
  });
  assert.deepEqual([...review.checksThatCannotRun], ['VEHICLE.PERMIT.EXPIRED']);
});

test('fields we did not ask for never reach the stored record, on any sample', () => {
  for (const vehicle of SYNTHETIC_VAHAN_ROWS) {
    const number = String(vehicle.rc_regn_no);
    const review = reviewSampleResponse('the synthetic authority', vehicle, {
      registrationNumber: number,
      retrievedAt: AT,
    });
    assert.deepEqual([...review.declinedFieldsLeaked], [], `${number} leaked a declined field into storage`);
  }
});

test('the review notices when a provider offers what we declined, even though we drop it', () => {
  // Worth knowing before signing: a provider that returns the owner's address every time is a
  // provider whose agreement has to say what happens to it, whatever our boundary does.
  const review = reviewSampleResponse('the synthetic authority', row('KA05MN9012'), {
    registrationNumber: 'KA05MN9012',
    retrievedAt: AT,
  });
  assert.deepEqual(
    [...review.declinedFieldsOffered],
    ['rc_chasi_no', 'rc_eng_no', 'rc_present_address'],
  );
  assert.equal(review.evidence.registeredOwnerName, 'R M********', 'the owner name must arrive masked');
});

test('the owner’s name reaches storage as initials and never as it was sent', () => {
  const review = reviewSampleResponse('the synthetic authority', row('KA01AB1234'), {
    registrationNumber: 'KA01AB1234',
    retrievedAt: AT,
  });
  assert.equal(review.evidence.registeredOwnerName, 'S******** T****** P****** L******');
  assert.ok(!JSON.stringify(review.evidence).includes('Sampoorna Traders Private Limited'));
});

// ------------------------------------------------------------------ the manual fallback workflow

const scooterTypedIn = (): VehicleEvidence => ({
  registrationNumber: 'KA05MN9012',
  source: 'ENTERED_BY_HAND',
  retrievedAt: AT,
  vehicleClass: 'TWO_WHEELER',
  bodyType: 'two_wheeler',
});

test('with no authorised access at all, a scooter carrying five tonnes is still blocked', () => {
  // This is the product's whole promise, and today it has to hold with nothing but what a person
  // typed off the certificate in the driver's hand.
  const result = checkVehicleSuitability({
    transport: transportDetails({ vehicleNumber: 'KA05MN9012' }),
    shipment: fiveTonneShipment(),
    declared: scooterTypedIn(),
  });
  assert.equal(result.outcome, 'BLOCK');
  assert.ok(result.findings.some((finding) => finding.code === 'VEHICLE.CLASS.NOT_GOODS_CARRYING'));
});

test('typed facts fill a gap and never overrule the registering authority', () => {
  // Somebody types in a 20-tonne capacity for a lorry the authority records at 16,400 kg. The
  // government reading has to win, or the fallback becomes a way round the check.
  const result = checkVehicleSuitability({
    transport: transportDetails(),
    shipment: fiveTonneShipment({ grossWeightKg: 18_000 }),
    record: {
      kind: 'FOUND',
      evidence: {
        registrationNumber: 'KA01AB1234',
        source: 'GOVERNMENT_RECORD',
        retrievedAt: AT,
        vehicleClass: 'HEAVY_GOODS_VEHICLE',
        ratedPayloadKg: 16_400,
      },
    },
    declared: {
      registrationNumber: 'KA01AB1234',
      source: 'ENTERED_BY_HAND',
      retrievedAt: AT,
      ratedPayloadKg: 20_000,
    },
  });
  assert.equal(result.capacity?.capacityKg, 16_400);
  assert.equal(result.capacity?.source, 'GOVERNMENT_RECORD');
  assert.ok(result.findings.some((finding) => finding.code === 'VEHICLE.CAPACITY.EXCEEDED'));
});

test('"we could not ask" is never reported as "nothing is wrong"', () => {
  const result = checkVehicleSuitability({
    transport: transportDetails(),
    shipment: fiveTonneShipment(),
    record: { kind: 'UNAVAILABLE', code: 'OUTAGE', message: 'the provider is not responding', retryable: true, checkedAt: AT },
  });
  assert.notEqual(result.outcome, 'OK');
  assert.ok(result.findings.some((finding) => finding.code === 'VEHICLE.RECORD.UNAVAILABLE'));
});

test('the fallback workflow is defined as steps somebody can follow, with limits', () => {
  assert.ok(MANUAL_FALLBACK.steps.length >= 5);
  assert.equal(MANUAL_FALLBACK.recordedAs, 'ENTERED_BY_HAND');
  assert.deepEqual(
    MANUAL_FALLBACK.steps.map((step) => step.order),
    MANUAL_FALLBACK.steps.map((_, index) => index + 1),
    'the steps have to be in an order a person can work through',
  );
  for (const step of MANUAL_FALLBACK.steps) {
    assert.ok(step.what['hi-IN'].length > 0, `step ${step.order} has no Hindi wording`);
    assert.ok(step.why.length > 40, `step ${step.order} does not say why it is a step`);
  }
  assert.ok(MANUAL_FALLBACK.limits.length >= 3);
});

test('the typed-in path never needs a photograph to work', () => {
  // A worn certificate in bad light must not stop a dispatch. The workflow says the photograph
  // corroborates rather than gates, and #28 agrees: typed facts alone produce a real decision.
  const step = MANUAL_FALLBACK.steps.find((item) => item.what['en-IN'].includes('photograph'));
  assert.ok(step !== undefined);
  assert.match(step.why, /not required/);

  const result = checkVehicleSuitability({
    transport: transportDetails({ vehicleNumber: 'KA05MN9012' }),
    shipment: fiveTonneShipment(),
    declared: scooterTypedIn(),
  });
  assert.equal(result.outcome, 'BLOCK', 'a decision has to be reachable with no photograph at all');
});

// ------------------------------------------------------------------- the terms we sign up to

test('every undertaking names the thing in the code that keeps it true', () => {
  const terms = permittedUseTerms();
  assert.ok(terms.length >= 6);
  for (const term of terms) {
    assert.ok(term.enforcedBy.length > 40, `${term.id} is a promise with nothing behind it`);
  }
  assert.ok(terms.some((term) => term.id === 'no_bulk'), 'bulk enumeration is what an authority worries about');
  assert.ok(terms.some((term) => term.id === 'no_scraping'), 'the issue’s own non-goal has to be an undertaking');
});

test('the caching term is checked against the policy the code actually runs', () => {
  const unasked = reviewCaching(null);
  assert.equal(unasked.withinTerms, false, 'a permission nobody has asked for is not a permission');
  assert.equal(unasked.reuseHours, DEFAULT_VEHICLE_RECORD_FRESHNESS.reuseWithinHours);

  assert.equal(reviewCaching(24).withinTerms, true);
  const tighter = reviewCaching(1);
  assert.equal(tighter.withinTerms, false);
  assert.match(tighter.note['en-IN'], /narrowed before going live/);
});

test('retention is stated as a number of years with a reason, not left implicit', () => {
  assert.ok(RETENTION.auditYears >= 6);
  assert.ok(RETENTION.why.length > 60);
});

// ------------------------------------------------------------------------- the non-goals

test('a provider that scrapes the public portals is disqualified, not scored', () => {
  const scraper = { ...(CANDIDATES[0] as (typeof CANDIDATES)[number]), id: 'scraper', route: 'SCRAPER' as const };
  assert.match(disqualification(scraper) ?? '', /authorised/);
});

test('a provider that will only return the whole record is disqualified', () => {
  const base = CANDIDATES[0] as (typeof CANDIDATES)[number];
  const all = {
    ...base,
    fieldNarrowing: { value: 'NONE' as const, confidence: 'CONFIRMED' as const, source: 'their written answer', asOf: TODAY, note: null },
  };
  assert.match(disqualification(all) ?? '', /whole record/);
});

test('none of the routes we would use is the public portal', () => {
  for (const item of CANDIDATES) {
    if (item.id === 'manual_only') continue;
    assert.notEqual(item.route, 'SCRAPER');
  }
});

test('no commercial fact was invented: everything is unknown until somebody is told', () => {
  for (const item of CANDIDATES) {
    for (const assessment of [item.perLookupPaise, item.monthlyMinimumPaise, item.responseSlaSeconds, item.availabilitySlaPercent, item.permittedCacheHours]) {
      assert.equal(assessment.confidence, 'UNKNOWN', `${item.name} has a commercial fact nobody was told`);
      assert.ok((assessment.note ?? '').length > 0, `${item.name} has an unknown with no question next to it`);
    }
  }
});

// ------------------------------------------------------------------- the application and tracker

test('the dossier answers what it can and refuses to invent what it cannot', () => {
  const entries = dossier();
  assert.ok(entries.length >= 10);
  for (const entry of entries) {
    assert.ok(entry.derivedFrom.length > 10, `"${entry.question}" does not say where its answer comes from`);
  }
  const open = unanswered();
  assert.ok(open.some((entry) => entry.question.includes('Who is applying')), 'the company does not exist yet');
  assert.ok(open.some((entry) => entry.question.includes('volume')), 'volume must not be a guess');
});

test('the dossier states the single purpose and the field count from the code', () => {
  const purpose = dossier().find((entry) => entry.question.includes('purpose'));
  assert.match(purpose?.answer ?? '', /transport suitability/);
  assert.equal(DECLARED_PURPOSE, 'TRANSPORT_SUITABILITY');

  const fields = dossier().find((entry) => entry.question.includes('Which fields are requested'));
  assert.match(fields?.answer ?? '', new RegExp(`^${PERMITTED_VEHICLE_FIELDS.length}: `));
});

test('the application cannot be sent, and says the company is the reason', () => {
  const readiness = readyToSubmit();
  assert.equal(readiness.ready, false);
  assert.ok(readiness.blockers.some((blocker) => blocker.startsWith('#49:')), 'the company documents are the real blocker');
  assert.match(readiness.summary['en-IN'], /cannot be sent/);
});

test('the register says nothing has been submitted, and every record is coherent', () => {
  const report = trackerReport(APPLICATIONS, TODAY);
  assert.deepEqual([...report.problems], []);
  assert.deepEqual([...report.approved], []);
  assert.deepEqual([...report.awaitingAnswer], []);
  assert.match(report.summary['en-IN'], /Nothing approved/);
});

test('a state cannot claim more than the evidence behind it', () => {
  const bare: ApplicationRecord = {
    providerId: 'api_setu_vahan',
    state: 'APPROVED',
    preparedOn: null,
    submittedOn: null,
    acknowledgementRef: null,
    outstandingQuestions: [],
    approval: null,
    rejectedReason: null,
    note: null,
  };
  const problems = applicationProblems(bare);
  assert.ok(problems.some((problem) => problem.includes('no approval on file')));
  assert.ok(problems.some((problem) => problem.includes('without a date it was prepared')));
  assert.ok(problems.some((problem) => problem.includes('no date it was submitted')));
});

test('an approval records the fields granted, and refused fields become work to do', () => {
  const granted: ApplicationRecord = {
    providerId: 'api_setu_vahan',
    state: 'APPROVED',
    preparedOn: '2026-10-01',
    submittedOn: '2026-10-05',
    acknowledgementRef: 'ACK-EXAMPLE-1',
    outstandingQuestions: [],
    approval: {
      reference: 'APR-EXAMPLE-1',
      approvedOn: '2026-11-20',
      // The authority granting less than we asked for is the ordinary outcome, not an error.
      approvedFields: REQUESTED_FIELDS.map((request) => request.field).filter((field) => field !== 'registeredOwnerName'),
      restrictions: ['Read only for a movement about to be dispatched.'],
      reviewBy: '2027-11-20',
      documentRef: 'vault://vehicle/approval-letter',
    },
    rejectedReason: null,
    note: null,
  };
  assert.deepEqual([...applicationProblems(granted)], []);
  const gaps = approvalGaps(granted);
  assert.deepEqual([...gaps.refused], ['registeredOwnerName'], 'the code’s allow-list has to be narrowed to what was granted');
  assert.deepEqual([...gaps.grantedButNotRequested], []);
});

test('a field granted that we never asked for is surfaced rather than silently accepted', () => {
  const over: ApplicationRecord = {
    providerId: 'api_setu_vahan',
    state: 'APPROVED',
    preparedOn: '2026-10-01',
    submittedOn: '2026-10-05',
    acknowledgementRef: 'ACK-EXAMPLE-2',
    outstandingQuestions: [],
    approval: {
      reference: 'APR-EXAMPLE-2',
      approvedOn: '2026-11-20',
      approvedFields: [...REQUESTED_FIELDS.map((request) => request.field), 'chassisNumber'],
      restrictions: [],
      reviewBy: null,
      documentRef: 'vault://vehicle/approval-letter',
    },
    rejectedReason: null,
    note: null,
  };
  assert.deepEqual([...approvalGaps(over).grantedButNotRequested], ['chassisNumber']);
});

test('every declined field says what it is and why we are not asking for it', () => {
  assert.ok(DECLINED_FIELDS.length >= 10, 'minimisation is only reviewable if what was declined is written down');
  for (const field of DECLINED_FIELDS) {
    assert.match(field.providerKey, /^rc_/);
    assert.ok(field.why.length > 30, `${field.providerKey} has no reason recorded`);
  }
});
