/**
 * Issue #33 [E33] — one business with two GST numbers, which is the whole point.
 *
 * Sunrise Hardware sells from Bengaluru and keeps a small godown across the border in Maharashtra.
 * That is two registrations, two authorisations, two consents and two sets of credentials — and it
 * is the fixture this module needs, because a product that models "a company's GST connection"
 * instead of "a GST number's authorisation" works perfectly until the day a business opens a second
 * branch and then files an invoice under the wrong state.
 *
 * Every GST number is built by `syntheticGstin`: structurally valid, checksum-correct and belonging
 * to nobody. No production registration, credential or provider secret appears in any fixture.
 */
import { asId, type CompanyId, type UserId } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import { syntheticGstin } from '../../masters/src/fixtures.ts';
import { GSP_PERMISSIONS, type GovernmentScope } from './types.ts';

export const SUNRISE_COMPANY = asId<'Company'>('11111111-1111-4111-8111-111111111111') as unknown as CompanyId;
export const OTHER_COMPANY = asId<'Company'>('77777777-7777-4777-8777-777777777777') as unknown as CompanyId;
export const OWNER_USER = asId<'User'>('22222222-2222-4222-8222-222222222222') as unknown as UserId;
export const CLERK_USER = asId<'User'>('44444444-4444-4444-8444-444444444444') as unknown as UserId;

/** The Bengaluru registration, and the Maharashtra one for the godown. */
export const KARNATAKA_GSTIN = syntheticGstin('29', 'AAECS1234H');
export const MAHARASHTRA_GSTIN = syntheticGstin('27', 'AAECS1234H');

export const SUNRISE_NAME = 'Sunrise Hardware';

/** What a shop connecting for the first time usually asks for. */
export const EVERYDAY_SCOPES: readonly GovernmentScope[] = Object.freeze([
  'EINVOICE_GENERATE',
  'EINVOICE_CANCEL',
  'EINVOICE_FETCH',
  'EWAY_GENERATE',
  'EWAY_UPDATE',
  'GSTR2B_FETCH',
]);

/** Reading only. The permission set a clerk who watches the connection screen should have. */
export const VIEW_ONLY: readonly string[] = Object.freeze([GSP_PERMISSIONS.view]);

export const actorWith = (companyId: CompanyId, permissions: readonly string[], userId: UserId = OWNER_USER): ActorContext => ({
  companyId,
  branchId: asId<'Branch'>('main'),
  userId,
  permissions: [...permissions],
});

export const ownerOf = (companyId: CompanyId = SUNRISE_COMPANY): ActorContext =>
  actorWith(companyId, Object.values(GSP_PERMISSIONS));

/** The sample e-invoice payload, which names the seller's registration as the real one does. */
export const invoicePayload = (gstin: string, number: string): Readonly<Record<string, unknown>> =>
  Object.freeze({
    Version: '1.1',
    SellerDtls: { Gstin: gstin, LglNm: SUNRISE_NAME, Loc: 'Bengaluru', Pin: 560001, Stcd: gstin.slice(0, 2) },
    BuyerDtls: { Gstin: syntheticGstin('29', 'AABCD7788M'), LglNm: 'Deccan Steel', Pos: '29', Loc: 'Mysuru', Pin: 570001, Stcd: '29' },
    DocDtls: { Typ: 'INV', No: number, Dt: '03/08/2026' },
    ValDtls: { AssVal: 100000, CgstVal: 9000, SgstVal: 9000, TotInvVal: 118000 },
  });
