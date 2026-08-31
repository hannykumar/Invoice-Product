/**
 * Issue #49 [X01] — the tests that matter.
 *
 * The issue's own testing section asks for a "document completeness review" and an "access-recovery
 * tabletop check". Both are here as tests rather than as a meeting: a register that says everything
 * is fine when a document has expired, or when one person is the only route into a provider
 * account, is worse than no register.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  CURRENT_STATE,
  FULL_DOCUMENT_PACK,
  IdentifierInRegisterError,
  VENDOR_REQUIREMENTS,
  VendorOnboardingRegister,
  assess,
  identifierIn,
  safeReference,
} from '../src/index.ts';

const TODAY = '2026-09-01';

/** A company that has done everything. Every name and address here is invented. */
const aReadyCompany = () => {
  const register = new VendorOnboardingRegister();
  register.company({
    legalName: 'Karobar Software Private Limited',
    entityType: 'PRIVATE_LIMITED',
    incorporatedOn: '2026-05-02',
    registeredStateCode: '29',
    domain: 'karobar.example',
  });
  for (const kind of FULL_DOCUMENT_PACK) {
    register.document({
      kind, status: 'HELD', heldAt: `vault/company/${kind.toLowerCase()}`,
      custodian: 'Priya', backupCustodian: 'Arun',
    });
  }
  register
    .access({ vendor: 'GSP_IRP', name: 'IRIS sandbox portal', describedAs: 'the company portal login', ownedBy: 'COMPANY', custodian: 'Priya', backupCustodian: 'Arun', recoveryPath: 'Recovery address is ops@karobar.example; the vault holds the backup codes.' })
    .access({ vendor: 'BANK_FEED', name: 'Bank partner console', describedAs: 'the company console login', ownedBy: 'COMPANY', custodian: 'Arun', backupCustodian: 'Priya', recoveryPath: 'Recovery address is ops@karobar.example.' })
    .access({ vendor: 'WHATSAPP_BSP', name: 'BSP dashboard', describedAs: 'the company dashboard login', ownedBy: 'COMPANY', custodian: 'Priya', backupCustodian: 'Arun', recoveryPath: 'Recovery address is ops@karobar.example.' })
    .access({ vendor: 'VEHICLE_DATA', name: 'Vehicle data portal', describedAs: 'the company portal login', ownedBy: 'COMPANY', custodian: 'Arun', backupCustodian: 'Priya', recoveryPath: 'Recovery address is ops@karobar.example.' })
    .access({ vendor: 'PAYMENTS', name: 'Payment gateway dashboard', describedAs: 'the company dashboard login', ownedBy: 'COMPANY', custodian: 'Priya', backupCustodian: 'Arun', recoveryPath: 'Recovery address is ops@karobar.example.' });
  register
    .contact({ role: 'AUTHORISED_SIGNATORY', name: 'Priya', email: 'priya@karobar.example', backupName: 'Arun' })
    .contact({ role: 'TECHNICAL', name: 'Arun', email: 'ops@karobar.example', backupName: 'Priya' })
    .contact({ role: 'BILLING', name: 'Priya', email: 'billing@karobar.example', backupName: 'Arun' });
  return register;
};

describe('the register refuses to become the place a number is written down', () => {
  it('throws on every kind of identifier somebody might paste in', () => {
    const cases: readonly [string, string][] = [
      ['a GSTIN', '29AAAAA0000A1ZR'],
      ['a PAN', 'ABCDE1234F'],
      ['a TAN', 'BLRK12345E'],
      ['a CIN', 'U72200KA2026PTC123456'],
      ['an Aadhaar number', '4321 8765 1234'],
      ['an IFSC code', 'HDFC0001234'],
      ['a bank account number', '50100123456789'],
      ['a private key', '-----BEGIN RSA PRIVATE KEY-----'],
      ['an API secret', 'rzp_live_AbCdEf123456'],
      ['a password', 'password: hunter2'],
    ];
    for (const [kind, value] of cases) {
      assert.equal(identifierIn(value)?.kind, kind, value);
      assert.throws(() => safeReference(`held here ${value}`), (error: unknown) => error instanceof IdentifierInRegisterError);
    }
  });

  it('throws wherever it is written, not only in one field', () => {
    const register = new VendorOnboardingRegister();
    assert.throws(
      () => register.document({ kind: 'COMPANY_PAN', status: 'HELD', heldAt: 'vault, PAN is ABCDE1234F' }),
      (error: unknown) => error instanceof IdentifierInRegisterError,
    );
    assert.throws(
      () => register.access({ vendor: 'GSP_IRP', name: 'portal', describedAs: 'login', ownedBy: 'COMPANY', recoveryPath: 'otp: 448122' }),
      (error: unknown) => error instanceof IdentifierInRegisterError,
    );
    assert.throws(
      () => register.contact({ role: 'BILLING', name: 'Priya', email: 'priya@karobar.example', backupName: 'account 50100123456789' }),
      (error: unknown) => error instanceof IdentifierInRegisterError,
    );
  });

  it('leaves ordinary text alone', () => {
    for (const safe of [
      'vault/company/certificate_of_incorporation',
      'Held by Priya; Arun has the backup codes.',
      '1Password item 4821',
      'Renewal falls due in March 2027.',
    ]) {
      assert.equal(safeReference(safe), safe);
    }
  });

  it('keeps the committed state clean, which is the point of the guard', () => {
    for (const document of CURRENT_STATE.documents) {
      assert.equal(identifierIn(`${document.heldAt ?? ''} ${document.note ?? ''}`), null);
    }
  });
});

describe('document completeness', () => {
  it('says plainly that there is no company yet, and what that holds up', () => {
    const report = assess(CURRENT_STATE, TODAY);
    assert.equal(report.ready, false);
    const noCompany = report.findings.find((finding) => finding.code === 'NO_COMPANY_YET');
    assert.ok(noCompany, 'the first finding is the honest one');
    assert.ok(noCompany.blocks.includes('#50') && noCompany.blocks.includes('#52'));
    assert.match(noCompany.whatToDo['en-IN'], /chartered accountant or company secretary/);
  });

  it('names, per provider, exactly which documents are missing and which issues wait on them', () => {
    const report = assess(CURRENT_STATE, TODAY);
    for (const vendor of report.vendors) {
      assert.equal(vendor.ready, false);
      assert.deepEqual([...vendor.missing].sort(), [...VENDOR_REQUIREMENTS[vendor.vendor]].sort());
      assert.ok(vendor.blocks.length > 0, 'and the cost of not doing it is visible');
    }
    assert.ok(report.vendors.find((vendor) => vendor.vendor === 'GSP_IRP')?.blocks.includes('#51'));
  });

  it('passes once everything is in hand', () => {
    const report = assess(aReadyCompany().build(), TODAY);
    assert.equal(report.ready, true, JSON.stringify(report.findings.map((finding) => finding.code)));
    assert.ok(report.vendors.every((vendor) => vendor.ready));
  });

  it('treats an expired document as blocking, not as paperwork', () => {
    const register = aReadyCompany();
    register.document({
      kind: 'GST_REGISTRATION', status: 'HELD', heldAt: 'vault/company/gst',
      custodian: 'Priya', backupCustodian: 'Arun', expiresOn: '2026-08-01',
    });
    const report = assess(register.build(), TODAY);
    assert.equal(report.ready, false);
    const expired = report.findings.find((finding) => finding.code === 'DOCUMENT_EXPIRED:GST_REGISTRATION');
    assert.ok(expired);
    assert.ok(expired.blocks.includes('#50'), 'and names what stops when it lapses');
  });

  it('warns before a renewal falls due rather than after', () => {
    const register = aReadyCompany();
    register.document({
      kind: 'PROFESSIONAL_INDEMNITY_INSURANCE', status: 'HELD', heldAt: 'vault/company/insurance',
      custodian: 'Priya', backupCustodian: 'Arun', expiresOn: '2026-10-01',
    });
    const report = assess(register.build(), TODAY);
    assert.equal(report.ready, true, 'not blocking yet');
    assert.ok(report.findings.some((finding) => finding.code === 'DOCUMENT_EXPIRING:PROFESSIONAL_INDEMNITY_INSURANCE'));
  });
});

describe('the access-recovery drill', () => {
  it('fails when only one person can get into a provider account', () => {
    const register = aReadyCompany();
    register.access({
      vendor: 'GSP_IRP', name: 'IRIS production portal', describedAs: 'the company portal login',
      ownedBy: 'COMPANY', custodian: 'Priya', backupCustodian: null, recoveryPath: 'ops@karobar.example',
    });
    const report = assess(register.build(), TODAY);
    assert.equal(report.ready, false);
    const single = report.findings.find((finding) => finding.code === 'SINGLE_POINT_OF_FAILURE:IRIS production portal');
    assert.ok(single);
    assert.match(single.whatToDo['en-IN'], /access-recovery drill/);
  });

  it('wants a written way back in, even where two people are named', () => {
    const register = aReadyCompany();
    register.access({
      vendor: 'PAYMENTS', name: 'Second gateway', describedAs: 'the company dashboard login',
      ownedBy: 'COMPANY', custodian: 'Priya', backupCustodian: 'Arun',
    });
    const report = assess(register.build(), TODAY);
    assert.ok(report.findings.some((finding) => finding.code === 'NO_RECOVERY_PATH:Second gateway'));
  });
});

describe('no vendor credential on a founder’s personal account without documentation', () => {
  it('blocks an undocumented personal account', () => {
    const register = aReadyCompany();
    register.access({
      vendor: 'WHATSAPP_BSP', name: 'BSP sandbox', describedAs: "the founder's own login",
      ownedBy: 'FOUNDER_PERSONAL', custodian: 'Priya', backupCustodian: 'Arun', recoveryPath: 'ops@karobar.example',
    });
    const report = assess(register.build(), TODAY);
    assert.equal(report.ready, false);
    const finding = report.findings.find((item) => item.code === 'UNDOCUMENTED_PERSONAL_ACCESS:BSP sandbox');
    assert.ok(finding);
    assert.match(finding.whatToDo['en-IN'], /one resignation away/);
    assert.ok(finding.blocks.includes('#21'));
  });

  it('allows a documented one, with a date, and says so as something to watch', () => {
    const register = aReadyCompany();
    register.access({
      vendor: 'WHATSAPP_BSP', name: 'BSP sandbox', describedAs: "the founder's own login",
      ownedBy: 'FOUNDER_PERSONAL',
      justification: 'The provider will not open a sandbox before incorporation; this is the trial account only.',
      migrateBy: '2026-12-31',
      custodian: 'Priya', backupCustodian: 'Arun', recoveryPath: 'ops@karobar.example',
    });
    const report = assess(register.build(), TODAY);
    assert.equal(report.ready, true, 'documented is allowed');
    assert.ok(report.findings.some((finding) => finding.code === 'PERSONAL_ACCESS:BSP sandbox' && finding.level === 'ATTENTION'));
  });

  it('blocks once the date to move it has passed, rather than letting it drift', () => {
    const register = aReadyCompany();
    register.access({
      vendor: 'WHATSAPP_BSP', name: 'BSP sandbox', describedAs: "the founder's own login",
      ownedBy: 'FOUNDER_PERSONAL',
      justification: 'Trial account before incorporation.',
      migrateBy: '2026-07-01',
      custodian: 'Priya', backupCustodian: 'Arun', recoveryPath: 'ops@karobar.example',
    });
    const report = assess(register.build(), TODAY);
    assert.equal(report.ready, false);
    assert.ok(report.findings.some((finding) => finding.code === 'PERSONAL_ACCESS_OVERDUE:BSP sandbox'));
  });
});

describe('authorised contacts and ownership are recorded', () => {
  it('requires a signatory, a technical and a billing contact', () => {
    const register = aReadyCompany();
    const withoutContacts = { ...register.build(), contacts: [] };
    const report = assess(withoutContacts, TODAY);
    for (const role of ['AUTHORISED_SIGNATORY', 'TECHNICAL', 'BILLING']) {
      assert.ok(report.findings.some((finding) => finding.code === `NO_CONTACT:${role}`));
    }
  });

  it('notices a contact on an address the company would lose', () => {
    const register = aReadyCompany();
    register.contact({ role: 'GRIEVANCE_OFFICER', name: 'Priya', email: 'priya@gmail.example', backupName: 'Arun' });
    const report = assess(register.build(), TODAY);
    const finding = report.findings.find((item) => item.code === 'PERSONAL_CONTACT_ADDRESS:GRIEVANCE_OFFICER');
    assert.ok(finding);
    assert.match(finding.whatToDo['en-IN'], /keeps when a person leaves/);
  });

  it('notices a document nobody is answerable for', () => {
    const register = aReadyCompany();
    register.document({ kind: 'COMPANY_PAN', status: 'HELD', heldAt: 'vault/company/pan', custodian: 'Priya', backupCustodian: null });
    const report = assess(register.build(), TODAY);
    assert.ok(report.findings.some((finding) => finding.code === 'NO_BACKUP_CUSTODIAN:COMPANY_PAN'));
  });
});
