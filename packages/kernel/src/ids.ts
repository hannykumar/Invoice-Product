/**
 * Stable identifiers.
 *
 * Every identifier is a branded string so that a company id can never be passed where an account
 * id is expected. The brand exists only at compile time; at runtime these are plain strings.
 */
declare const brand: unique symbol;
export type Id<TTag extends string> = string & { readonly [brand]: TTag };

export type CompanyId = Id<'Company'>;
export type BranchId = Id<'Branch'>;
export type UserId = Id<'User'>;
export type AccountId = Id<'Account'>;
export type PartyId = Id<'Party'>;
export type VoucherId = Id<'Voucher'>;
export type JournalLineId = Id<'JournalLine'>;
export type FiscalPeriodId = Id<'FiscalPeriod'>;
export type IdempotencyKey = Id<'IdempotencyKey'>;

export const asId = <TTag extends string>(value: string): Id<TTag> => value as Id<TTag>;

export const newId = <TTag extends string>(): Id<TTag> => crypto.randomUUID() as Id<TTag>;
