/**
 * One `MasterDataService` for the running app, shared by every screen that keeps a record.
 *
 * The business's own bank account (#180), its customers and its items (#181) are all master data,
 * and they all belong in the same store: two services would mean a customer created on the Sale
 * screen was invisible to the challan screen, and a bank account saved on one screen invisible to
 * the bill. It is created lazily and kept for the life of the process, because a service per
 * request would lose every record the moment the request ended.
 *
 * Tenancy is preserved the ordinary way: every write and read carries the signed-in company's own
 * request context, and the store keys each record by company.
 */
import type { CompanyId } from '@invoice/kernel';
import {
  AccessControl,
  AuditLog,
  PlatformCommandService,
  type RequestContext,
} from '../../../packages/platform/src/index.ts';
import { MASTER_APPROVAL_POLICIES, MasterDataService } from '../../../packages/masters/src/index.ts';

let shared: { readonly service: MasterDataService; readonly access: AccessControl } | null = null;

const masters = () => {
  if (shared === null) {
    const audit = new AuditLog();
    shared = {
      service: new MasterDataService(new PlatformCommandService(audit, MASTER_APPROVAL_POLICIES), audit),
      access: new AccessControl(),
    };
  }
  return shared;
};

/** The one master-data service this process keeps. */
export const masterData = (): MasterDataService => masters().service;

/** A request context for this company's own master data. Granted once, then reused. */
export const mastersContext = (companyId: CompanyId | string): RequestContext => {
  const { access } = masters();
  const company = String(companyId);
  access.grant({
    companyId: company,
    userId: `${company}:master-data`,
    branchIds: new Set([`${company}:main`]),
    active: true,
    permissions: new Set(['approval.decide', 'access.review']),
  });
  return access.context(company, `${company}:main`, `${company}:master-data`, `${company}:master-data-session`);
};
