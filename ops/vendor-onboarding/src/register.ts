/**
 * Issue #49 [X01] — the register itself.
 *
 * Every write goes through `safeReference`, so the thing that must not be in git cannot get in by
 * accident. Everything else here is bookkeeping: what exists, who holds it, when it expires.
 */
import { safeReference } from './redaction.ts';
import type {
  AuthorisedContact,
  CompanyDocument,
  CompanyRecord,
  DocumentKind,
  EntityType,
  VendorAccess,
} from './model.ts';

export class VendorOnboardingRegister {
  #legalName: string | null = null;
  #entityType: EntityType | null = null;
  #incorporatedOn: string | null = null;
  #registeredStateCode: string | null = null;
  #domain: string | null = null;
  readonly #documents = new Map<DocumentKind, CompanyDocument>();
  readonly #accesses: VendorAccess[] = [];
  readonly #contacts: AuthorisedContact[] = [];

  company(input: {
    legalName?: string | null;
    entityType?: EntityType | null;
    incorporatedOn?: string | null;
    registeredStateCode?: string | null;
    domain?: string | null;
  }): this {
    if (input.legalName !== undefined) this.#legalName = safeReference(input.legalName);
    if (input.entityType !== undefined) this.#entityType = input.entityType;
    if (input.incorporatedOn !== undefined) this.#incorporatedOn = input.incorporatedOn;
    if (input.registeredStateCode !== undefined) this.#registeredStateCode = input.registeredStateCode;
    if (input.domain !== undefined) this.#domain = safeReference(input.domain);
    return this;
  }

  /**
   * Records that a document exists and where it is kept.
   *
   * `heldAt` is a pointer — a vault item, a folder. Writing the document's number here throws,
   * which is the whole safety property of this module.
   */
  document(input: {
    kind: DocumentKind;
    status: CompanyDocument['status'];
    heldAt?: string | null;
    expiresOn?: string | null;
    custodian?: string | null;
    backupCustodian?: string | null;
    note?: string | null;
  }): this {
    this.#documents.set(input.kind, {
      kind: input.kind,
      status: input.status,
      heldAt: safeReference(input.heldAt ?? null),
      expiresOn: input.expiresOn ?? null,
      custodian: input.custodian ?? null,
      backupCustodian: input.backupCustodian ?? null,
      note: safeReference(input.note ?? null),
    });
    return this;
  }

  access(input: Omit<VendorAccess, 'justification' | 'migrateBy' | 'custodian' | 'backupCustodian' | 'recoveryPath'> & {
    justification?: string | null;
    migrateBy?: string | null;
    custodian?: string | null;
    backupCustodian?: string | null;
    recoveryPath?: string | null;
  }): this {
    this.#accesses.push({
      vendor: input.vendor,
      name: safeReference(input.name) as string,
      describedAs: safeReference(input.describedAs) as string,
      ownedBy: input.ownedBy,
      justification: safeReference(input.justification ?? null),
      migrateBy: input.migrateBy ?? null,
      custodian: input.custodian ?? null,
      backupCustodian: input.backupCustodian ?? null,
      recoveryPath: safeReference(input.recoveryPath ?? null),
    });
    return this;
  }

  contact(input: AuthorisedContact): this {
    this.#contacts.push({
      role: input.role,
      name: safeReference(input.name) as string,
      email: safeReference(input.email) as string,
      backupName: safeReference(input.backupName),
    });
    return this;
  }

  build(): CompanyRecord {
    return {
      legalName: this.#legalName,
      entityType: this.#entityType,
      incorporatedOn: this.#incorporatedOn,
      registeredStateCode: this.#registeredStateCode,
      domain: this.#domain,
      documents: [...this.#documents.values()],
      accesses: [...this.#accesses],
      contacts: [...this.#contacts],
    };
  }
}
