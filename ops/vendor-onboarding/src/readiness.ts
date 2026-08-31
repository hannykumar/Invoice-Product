/**
 * Issue #49 [X01] — reading the register back as findings.
 *
 * The three acceptance criteria, in order, are the three checks that can fail here:
 *
 *  1. **Required company documents are securely available** — a document a provider asks for is
 *     either held with a custodian, or it is a blocking finding naming the integrations it holds up.
 *  2. **No vendor credential depends on a founder's personal account without documentation** — a
 *     personal account is allowed, an *undocumented* one is not: it must say why and by when it
 *     moves, and a date that has passed becomes blocking rather than quietly ageing.
 *  3. **Authorised contacts and ownership are recorded** — every access and every document needs a
 *     named custodian and a named backup, because one person holding something alone is the
 *     failure the access-recovery drill exists to find.
 */
import { DOCUMENT_LABELS, VENDOR_BLOCKS, VENDOR_LABELS, VENDOR_REQUIREMENTS } from './catalogue.ts';
import { isCompanyAddress } from './redaction.ts';
import type {
  CompanyRecord,
  DocumentKind,
  Finding,
  ReadinessReport,
  VendorKind,
  VendorReadiness,
} from './model.ts';

const ALL_VENDORS: readonly VendorKind[] = ['GSP_IRP', 'BANK_FEED', 'WHATSAPP_BSP', 'VEHICLE_DATA', 'PAYMENTS'];

const daysBetween = (later: string, earlier: string): number =>
  Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);

/** A document a provider asks for counts only when it is actually in hand and not expired. */
const held = (company: CompanyRecord, kind: DocumentKind): boolean =>
  company.documents.find((document) => document.kind === kind)?.status === 'HELD';

const finding = (
  level: Finding['level'],
  code: string,
  what: Finding['what'],
  whatToDo: Finding['whatToDo'],
  blocks: readonly string[] = [],
): Finding => ({ level, code, what, whatToDo, blocks });

export const assessVendor = (company: CompanyRecord, vendor: VendorKind): VendorReadiness => {
  const required = VENDOR_REQUIREMENTS[vendor];
  const missing = required.filter((kind) => !held(company, kind));
  const blocks = VENDOR_BLOCKS[vendor];
  const findings: Finding[] = [];

  if (missing.length > 0) {
    findings.push(finding(
      'BLOCKING',
      `VENDOR_PACK_INCOMPLETE:${vendor}`,
      {
        'en-IN': `${VENDOR_LABELS[vendor]['en-IN']}: ${missing.length} of ${required.length} documents are not in hand yet.`,
        'hi-IN': `${VENDOR_LABELS[vendor]['hi-IN']}: ${required.length} mein se ${missing.length} kaagaz abhi haath mein nahin hain.`,
      },
      {
        'en-IN': `Still needed: ${missing.map((kind) => DOCUMENT_LABELS[kind]['en-IN']).join('; ')}.`,
        'hi-IN': `Abhi chahiye: ${missing.map((kind) => DOCUMENT_LABELS[kind]['hi-IN']).join('; ')}.`,
      },
      blocks,
    ));
  }

  return { vendor, ready: missing.length === 0, missing, findings, blocks };
};

export const assess = (company: CompanyRecord, asOf: string): ReadinessReport => {
  const vendors = ALL_VENDORS.map((vendor) => assessVendor(company, vendor));
  const findings: Finding[] = [];

  if (company.legalName === null || company.entityType === null) {
    findings.push(finding(
      'BLOCKING',
      'NO_COMPANY_YET',
      {
        'en-IN': 'There is no legal entity yet, so nothing can be signed with anybody.',
        'hi-IN': 'Abhi koi kaanooni company nahin hai, isliye kisi ke saath kuch sign nahin ho sakta.',
      },
      {
        'en-IN': 'Take the entity comparison in this folder to a chartered accountant or company secretary, settle the form, and incorporate. Everything else here waits on that.',
        'hi-IN': 'Is folder mein di gayi tulna kisi CA ya company secretary ko dikhayein, roop tay karein, aur company banayein. Baaki sab isi ka intezar kar raha hai.',
      },
      [...new Set(ALL_VENDORS.flatMap((vendor) => VENDOR_BLOCKS[vendor]))],
    ));
  }

  // Expiry. A renewal that has slipped is not paperwork — it is an integration that stops.
  for (const document of company.documents) {
    if (document.expiresOn === null) continue;
    const days = daysBetween(document.expiresOn, asOf);
    if (days < 0) {
      findings.push(finding('BLOCKING', `DOCUMENT_EXPIRED:${document.kind}`,
        { 'en-IN': `${DOCUMENT_LABELS[document.kind]['en-IN']} expired on ${document.expiresOn}.`, 'hi-IN': `${DOCUMENT_LABELS[document.kind]['hi-IN']} ${document.expiresOn} ko khatam ho gaya.` },
        { 'en-IN': `Renew it. ${document.custodian ?? 'Nobody'} is named as the custodian.`, 'hi-IN': `Ise navinikaran karayein. Iske liye ${document.custodian ?? 'koi nahin'} zimmedar hai.` },
        vendorsNeeding(document.kind)));
    } else if (days <= 45) {
      findings.push(finding('ATTENTION', `DOCUMENT_EXPIRING:${document.kind}`,
        { 'en-IN': `${DOCUMENT_LABELS[document.kind]['en-IN']} expires in ${days} days.`, 'hi-IN': `${DOCUMENT_LABELS[document.kind]['hi-IN']} ${days} din mein khatam ho raha hai.` },
        { 'en-IN': 'Start the renewal now, while it is still cheap to be early.', 'hi-IN': 'Abhi navinikaran shuru karein, jab tak jaldi karna sasta hai.' },
        vendorsNeeding(document.kind)));
    }
  }

  // A document nobody is answerable for is a document that will be missing when it matters.
  for (const document of company.documents.filter((candidate) => candidate.status === 'HELD')) {
    if (document.custodian === null) {
      findings.push(finding('ATTENTION', `NO_CUSTODIAN:${document.kind}`,
        { 'en-IN': `Nobody is named as answerable for ${DOCUMENT_LABELS[document.kind]['en-IN'].toLowerCase()}.`, 'hi-IN': `${DOCUMENT_LABELS[document.kind]['hi-IN']} ke liye koi zimmedar nahin hai.` },
        { 'en-IN': 'Name a custodian and a backup.', 'hi-IN': 'Ek zimmedar aur ek backup ka naam likhein.' }));
    } else if (document.backupCustodian === null) {
      findings.push(finding('ATTENTION', `NO_BACKUP_CUSTODIAN:${document.kind}`,
        { 'en-IN': `Only ${document.custodian} can reach ${DOCUMENT_LABELS[document.kind]['en-IN'].toLowerCase()}.`, 'hi-IN': `${DOCUMENT_LABELS[document.kind]['hi-IN']} tak sirf ${document.custodian} pahunch sakte hain.` },
        { 'en-IN': 'Name a second person. One person on holiday should not stop a filing.', 'hi-IN': 'Doosre vyakti ka naam likhein. Ek vyakti ki chhutti se filing nahin rukni chahiye.' }));
    }
  }

  // The acceptance criterion, in full.
  for (const access of company.accesses) {
    if (access.ownedBy === 'FOUNDER_PERSONAL') {
      if (access.justification === null || access.migrateBy === null) {
        findings.push(finding('BLOCKING', `UNDOCUMENTED_PERSONAL_ACCESS:${access.name}`,
          {
            'en-IN': `${access.name} is held on a founder's personal account with no written reason or date to move it.`,
            'hi-IN': `${access.name} sansthapak ke niji account par hai, bina likhit karan aur badalne ki tarikh ke.`,
          },
          {
            'en-IN': 'Either move it to a company account, or write down why it cannot move yet and the date it will. An undocumented personal account is one resignation away from losing the integration.',
            'hi-IN': 'Ya to ise company ke account par le jaayein, ya likh dein ki abhi kyun nahin ja sakta aur kab jayega. Bina likhe niji account ek isteefe ki doori par hai.',
          },
          VENDOR_BLOCKS[access.vendor]));
      } else if (daysBetween(access.migrateBy, asOf) < 0) {
        findings.push(finding('BLOCKING', `PERSONAL_ACCESS_OVERDUE:${access.name}`,
          {
            'en-IN': `${access.name} was meant to move off a personal account by ${access.migrateBy}, and has not.`,
            'hi-IN': `${access.name} ko ${access.migrateBy} tak niji account se hatna tha, hata nahin.`,
          },
          { 'en-IN': 'Move it now, or agree a new date in writing rather than letting it drift.', 'hi-IN': 'Abhi hatayein, ya likhit mein nayi tarikh tay karein — aise hi chalne na dein.' },
          VENDOR_BLOCKS[access.vendor]));
      } else {
        findings.push(finding('ATTENTION', `PERSONAL_ACCESS:${access.name}`,
          { 'en-IN': `${access.name} is on a founder's personal account until ${access.migrateBy}.`, 'hi-IN': `${access.name} ${access.migrateBy} tak sansthapak ke niji account par hai.` },
          { 'en-IN': access.justification, 'hi-IN': access.justification }));
      }
    }
    if (access.custodian === null || access.backupCustodian === null) {
      findings.push(finding('BLOCKING', `SINGLE_POINT_OF_FAILURE:${access.name}`,
        {
          'en-IN': `${access.name} has no second person who can get into it.`,
          'hi-IN': `${access.name} mein ghusne wala doosra vyakti koi nahin hai.`,
        },
        {
          'en-IN': 'Name a backup and record the recovery path. This is what the access-recovery drill checks.',
          'hi-IN': 'Ek backup ka naam aur wapas pahunchne ka tarika likhein. Access recovery abhyas isi ko jaanchta hai.',
        },
        VENDOR_BLOCKS[access.vendor]));
    }
    if (access.recoveryPath === null) {
      findings.push(finding('ATTENTION', `NO_RECOVERY_PATH:${access.name}`,
        { 'en-IN': `There is no written way back into ${access.name} if the usual one fails.`, 'hi-IN': `Agar aam rasta na chale to ${access.name} mein wapas jaane ka koi likha tarika nahin hai.` },
        { 'en-IN': 'Write down the recovery route and try it once.', 'hi-IN': 'Wapas jaane ka rasta likhein aur ek baar aazma kar dekhein.' }));
    }
  }

  // Contacts.
  const roles = new Set(company.contacts.map((contact) => contact.role));
  for (const role of ['AUTHORISED_SIGNATORY', 'TECHNICAL', 'BILLING'] as const) {
    if (!roles.has(role)) {
      findings.push(finding('BLOCKING', `NO_CONTACT:${role}`,
        { 'en-IN': `No ${role.toLowerCase().replace(/_/g, ' ')} contact is recorded.`, 'hi-IN': `${role.toLowerCase().replace(/_/g, ' ')} ke liye koi sampark darj nahin hai.` },
        { 'en-IN': 'Every provider form asks for these three. Decide them once and reuse them.', 'hi-IN': 'Har provider ka form yeh teen maangta hai. Ek baar tay karein aur dobara istemal karein.' }));
    }
  }
  for (const contact of company.contacts) {
    if (!isCompanyAddress(contact.email, company.domain)) {
      findings.push(finding('ATTENTION', `PERSONAL_CONTACT_ADDRESS:${contact.role}`,
        {
          'en-IN': `The ${contact.role.toLowerCase().replace(/_/g, ' ')} contact uses an address that is not on the company domain.`,
          'hi-IN': `${contact.role.toLowerCase().replace(/_/g, ' ')} ka sampark pata company ke domain par nahin hai.`,
        },
        {
          'en-IN': 'Providers send contract notices and outage warnings there. It should be an address the company keeps when a person leaves.',
          'hi-IN': 'Provider wahin anubandh aur kharabi ki soochna bhejte hain. Yeh aisa pata hona chahiye jo vyakti ke jaane par bhi company ke paas rahe.',
        }));
    }
  }

  const blocking = findings.filter((item) => item.level === 'BLOCKING').length +
    vendors.flatMap((vendor) => vendor.findings).filter((item) => item.level === 'BLOCKING').length;
  const attention = findings.filter((item) => item.level === 'ATTENTION').length;

  return {
    asOf,
    company,
    vendors,
    findings,
    ready: blocking === 0,
    summary: blocking === 0
      ? {
          'en-IN': `Everything a provider asks for is in hand${attention === 0 ? '.' : `, with ${attention} thing${attention === 1 ? '' : 's'} to keep an eye on.`}`,
          'hi-IN': `Provider jo maangte hain sab haath mein hai${attention === 0 ? '.' : `, ${attention} baat par nazar rakhni hai.`}`,
        }
      : {
          'en-IN': `${blocking} thing${blocking === 1 ? '' : 's'} must be done before any provider contract can be signed${attention === 0 ? '.' : `, and ${attention} more need an eye.`}`,
          'hi-IN': `Kisi bhi provider ke saath anubandh se pehle ${blocking} kaam karne hain${attention === 0 ? '.' : `, aur ${attention} par nazar rakhni hai.`}`,
        },
  };
};

const vendorsNeeding = (kind: DocumentKind): readonly string[] =>
  ALL_VENDORS.filter((vendor) => VENDOR_REQUIREMENTS[vendor].includes(kind)).flatMap((vendor) => VENDOR_BLOCKS[vendor]);
