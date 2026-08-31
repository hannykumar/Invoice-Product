/**
 * Issue #49 [X01] — the company, and the document pack every provider will ask for.
 *
 * Incorporating a company is not something software does. What software can do is stop the
 * paperwork from being the thing that quietly fails: keep one register of what exists, who holds
 * each access, when each document expires, and which integration is blocked without it — and
 * refuse to let that register become a place where a real identifier or a credential is written
 * down.
 *
 * So this module holds **status and pointers, never contents**. "We hold the certificate of
 * incorporation; it is in the company vault at `mca/coi.pdf`; Priya holds it and Arun is the
 * backup" is a fact worth keeping in git. The certificate number is not.
 */

export type Bilingual = { readonly 'en-IN': string; readonly 'hi-IN': string };

/** The entity types an Indian software business actually chooses between. */
export type EntityType = 'PRIVATE_LIMITED' | 'LLP' | 'OPC' | 'PARTNERSHIP' | 'PROPRIETORSHIP';

export type DocumentKind =
  | 'CERTIFICATE_OF_INCORPORATION'
  | 'MOA_AOA'
  | 'COMPANY_PAN'
  | 'COMPANY_TAN'
  | 'GST_REGISTRATION'
  | 'BANK_ACCOUNT_PROOF'
  | 'BOARD_RESOLUTION'
  | 'AUTHORISED_SIGNATORY_ID'
  | 'REGISTERED_ADDRESS_PROOF'
  | 'DOMAIN_OWNERSHIP'
  | 'OFFICIAL_EMAIL'
  | 'DPIIT_RECOGNITION'
  | 'SECURITY_QUESTIONNAIRE'
  | 'DATA_PROCESSING_AGREEMENT'
  | 'PROFESSIONAL_INDEMNITY_INSURANCE';

export type DocumentStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'HELD' | 'EXPIRED';

/** The outside parties this product will have to sign something with. */
export type VendorKind = 'GSP_IRP' | 'BANK_FEED' | 'WHATSAPP_BSP' | 'VEHICLE_DATA' | 'PAYMENTS';

/**
 * Who an access belongs to.
 *
 * `FOUNDER_PERSONAL` is not forbidden — at the beginning of a company it is often the only thing
 * available. It is forbidden to be *undocumented*: it must say why, and by when it moves to the
 * company. That is the issue's own acceptance criterion, and the register enforces it.
 */
export type AccessOwnership = 'COMPANY' | 'FOUNDER_PERSONAL';

export interface CompanyDocument {
  readonly kind: DocumentKind;
  readonly status: DocumentStatus;
  /** Where it lives. A path or a vault item name — never the document, never its number. */
  readonly heldAt: string | null;
  /** Renewal date, where the document has one. Null means it does not expire. */
  readonly expiresOn: string | null;
  /** The person answerable for it, and the person who can act if they are unavailable. */
  readonly custodian: string | null;
  readonly backupCustodian: string | null;
  readonly note: string | null;
}

export interface VendorAccess {
  readonly vendor: VendorKind;
  readonly name: string;
  /** The login or portal account, described — never a username, never a secret. */
  readonly describedAs: string;
  readonly ownedBy: AccessOwnership;
  /** Required when `ownedBy` is `FOUNDER_PERSONAL`: why, and by when it moves. */
  readonly justification: string | null;
  readonly migrateBy: string | null;
  readonly custodian: string | null;
  readonly backupCustodian: string | null;
  readonly recoveryPath: string | null;
}

export interface AuthorisedContact {
  readonly role: 'AUTHORISED_SIGNATORY' | 'TECHNICAL' | 'BILLING' | 'GRIEVANCE_OFFICER';
  readonly name: string;
  /** An address at the company's own domain. A personal mailbox is a finding, not a contact. */
  readonly email: string;
  readonly backupName: string | null;
}

export interface CompanyRecord {
  readonly legalName: string | null;
  readonly entityType: EntityType | null;
  readonly incorporatedOn: string | null;
  readonly registeredStateCode: string | null;
  readonly domain: string | null;
  readonly documents: readonly CompanyDocument[];
  readonly accesses: readonly VendorAccess[];
  readonly contacts: readonly AuthorisedContact[];
}

export type FindingLevel = 'BLOCKING' | 'ATTENTION' | 'INFORMATION';

export interface Finding {
  readonly level: FindingLevel;
  readonly code: string;
  readonly what: Bilingual;
  readonly whatToDo: Bilingual;
  /** The GitHub issues this finding holds up, so the cost of not doing it is visible. */
  readonly blocks: readonly string[];
}

export interface VendorReadiness {
  readonly vendor: VendorKind;
  readonly ready: boolean;
  readonly missing: readonly DocumentKind[];
  readonly findings: readonly Finding[];
  readonly blocks: readonly string[];
}

export interface ReadinessReport {
  readonly asOf: string;
  readonly company: CompanyRecord;
  readonly vendors: readonly VendorReadiness[];
  readonly findings: readonly Finding[];
  readonly ready: boolean;
  readonly summary: Bilingual;
}
