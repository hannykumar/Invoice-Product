/**
 * Issue #32 [E32] — one shop, one filing season.
 *
 * Sunrise Hardware in Bengaluru is the same shop the purchase reconciliation (#31) uses, on purpose:
 * the mismatches that module finds in July are the mismatches this module warns about before the
 * July summary return, and reading the two test files side by side shows one story rather than two
 * unrelated sets of made-up numbers.
 *
 * Beside it, Konkan Traders exists to be the awkward case — a business whose filing frequency
 * nobody has recorded. It has no deadlines at all, and one question waiting to be answered.
 */
import { asId, isoDate, rupees, type CompanyId, type IsoDate, type UserId } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import { syntheticGstin } from '../../masters/src/fixtures.ts';
import type { EInvoiceBacklogReader, ReturnReadinessReader, UnresolvedPurchaseReader } from './adapters.ts';
import { CALENDAR_PERMISSIONS, type CompanyComplianceProfile } from './types.ts';

export const SUNRISE_COMPANY = asId<'Company'>('11111111-1111-4111-8111-111111111111') as unknown as CompanyId;
export const KONKAN_COMPANY = asId<'Company'>('33333333-3333-4333-8333-333333333333') as unknown as CompanyId;
export const OWNER_USER = asId<'User'>('22222222-2222-4222-8222-222222222222') as unknown as UserId;
export const ACCOUNTANT_USER = asId<'User'>('44444444-4444-4444-8444-444444444444') as unknown as UserId;

export const SUNRISE_GSTIN = syntheticGstin('29', 'AAECS1234H');
export const KONKAN_GSTIN = syntheticGstin('30', 'AAFCK4321L');

/** A regular monthly filer in Karnataka that makes e-invoices and sends goods by lorry. */
export const SUNRISE_PROFILE: CompanyComplianceProfile = Object.freeze<CompanyComplianceProfile>({
  companyId: SUNRISE_COMPANY,
  legalName: 'Sunrise Hardware',
  gstin: SUNRISE_GSTIN,
  registrationType: { value: 'REGULAR', basis: 'DERIVED' },
  gstFilingFrequency: {
    value: 'MONTHLY',
    basis: 'DECLARED',
    declaredBy: OWNER_USER,
    declaredOn: isoDate('2026-04-02'),
    basisNote: 'The owner read the filing preference off the portal during setup.',
  },
  eInvoiceApplicable: { value: true, basis: 'DERIVED' },
  movesGoods: { value: true, basis: 'DERIVED' },
  stateCode: { value: '29', basis: 'DERIVED' },
  // The shop moved onto this product at the start of July 2026. June's returns were filed by their
  // old accountant in another system, and this calendar does not accuse anybody about them.
  calendarFrom: isoDate('2026-07-01'),
  timeZone: 'Asia/Kolkata',
  saturdayIsWorking: true,
});

/**
 * A business whose filing frequency nobody recorded.
 *
 * The tempting thing is to assume monthly, because most businesses are monthly. This shop is the
 * reason not to: if it files quarterly, a monthly deadline would be a wrong date from a confident
 * machine, and if it files monthly, an unanswered question costs one tap to fix.
 */
export const KONKAN_PROFILE: CompanyComplianceProfile = Object.freeze<CompanyComplianceProfile>({
  companyId: KONKAN_COMPANY,
  legalName: 'Konkan Traders',
  gstin: KONKAN_GSTIN,
  registrationType: { value: 'REGULAR', basis: 'DERIVED' },
  gstFilingFrequency: null,
  eInvoiceApplicable: { value: false, basis: 'DERIVED' },
  movesGoods: { value: false, basis: 'DERIVED' },
  stateCode: { value: '30', basis: 'DERIVED' },
  calendarFrom: isoDate('2026-07-01'),
  timeZone: 'Asia/Kolkata',
  saturdayIsWorking: true,
});

/** A composition dealer: no GSTR-1, no GSTR-3B, one quarterly statement. */
export const COMPOSITION_PROFILE: CompanyComplianceProfile = Object.freeze<CompanyComplianceProfile>({
  ...SUNRISE_PROFILE,
  companyId: asId<'Company'>('55555555-5555-4555-8555-555555555555') as unknown as CompanyId,
  legalName: 'Vasavi Provision Stores',
  registrationType: { value: 'COMPOSITION', basis: 'DERIVED' },
  gstFilingFrequency: { value: 'QUARTERLY', basis: 'DERIVED' },
  eInvoiceApplicable: { value: false, basis: 'DERIVED' },
});

export const actorWith = (companyId: CompanyId, ...permissions: readonly string[]): ActorContext => ({
  companyId,
  branchId: asId<'Branch'>('main'),
  userId: OWNER_USER,
  permissions: [...permissions],
});

export const ownerOf = (companyId: CompanyId = SUNRISE_COMPANY): ActorContext =>
  actorWith(companyId, ...Object.values(CALENDAR_PERMISSIONS));

/**
 * July's unresolved purchases, in the shape a warning needs.
 *
 * Three bills, ₹36,000 of credit resting on them — the same three the reconciliation leaves open in
 * #31's own fixture.
 */
export const julyMismatches: UnresolvedPurchaseReader = {
  async unresolvedFor(_companyId, periodKey) {
    if (periodKey !== '2026-07') return { count: 0, amount: rupees(0), records: [] };
    return {
      count: 3,
      amount: rupees(36_000),
      records: [
        { kind: 'purchase_bill', id: 'bill-STL-2210', label: 'Deccan Steel — STL-2210', amount: rupees(21_600) },
        { kind: 'purchase_bill', id: 'bill-PNT-118', label: 'Mysore Paints — PNT-118', amount: rupees(9_000) },
        { kind: 'purchase_bill', id: 'bill-PPR-77', label: 'Coastal Paper — PPR-77', amount: rupees(5_400) },
      ],
    };
  },
};

export const julyReturnReadiness: ReturnReadinessReader = {
  async readinessFor(_companyId, periodKey) {
    if (periodKey !== '2026-07') return null;
    return { prepared: false, taxPayable: rupees(1_48_500), blockingIssues: 0 };
  },
};

export const julyEInvoiceBacklog: EInvoiceBacklogReader = {
  async pendingFor(_companyId, periodKey) {
    if (periodKey !== '2026-07') return { count: 0, records: [] };
    return {
      count: 2,
      records: [
        { kind: 'sales_invoice', id: 'SI-1042', label: 'Invoice SI-1042 dated 3 August 2026' },
        { kind: 'sales_invoice', id: 'SI-1051', label: 'Invoice SI-1051 dated 9 August 2026' },
      ],
    };
  },
};

/** Independence Day 2026, a Saturday, and Ganesh Chaturthi — the holidays the tests lean on. */
export const KARNATAKA_HOLIDAYS_2026: readonly IsoDate[] = Object.freeze([
  isoDate('2026-08-15'),
  isoDate('2026-09-14'),
  isoDate('2026-10-20'),
]);
