/**
 * Option C — rates the business itself declares.
 *
 * A shopkeeper who has been billing for fifteen years knows the rate they charge. The product does
 * not, because no rate in it has been checked against a notification yet (issue #54). Refusing to
 * bill at all until every rate is sourced would be correct and useless.
 *
 * So a business may declare its own rates. The product then does three things, and they are the
 * whole point:
 *
 *  1. it uses the figure, so work can happen;
 *  2. it records **whose figure it is** — who declared it, and when;
 *  3. it never presents that figure as verified law. Every line, every total, every printed
 *     invoice and every report says the rate came from the business's own records.
 *
 * This is not a shortcut around the register. It is the honest alternative to pretending.
 */
import { compareDates, invalid, type IsoDate } from '@invoice/kernel';
import type { CessRule } from './rate-table.ts';

export interface DeclaredRate {
  readonly companyId: string;
  /** HSN for goods, SAC for services. Matched by longest prefix, as with sourced rates. */
  readonly code: string;
  readonly kind: 'GOODS' | 'SERVICES';
  readonly ratePercentTimes100: bigint;
  readonly cess?: CessRule;
  readonly effectiveFrom: IsoDate;
  readonly effectiveTo: IsoDate | null;
  /** The user who said this is the rate. Never blank. */
  readonly declaredBy: string;
  readonly declaredOn: IsoDate;
  /** Where the business says they got it — their accountant, an old bill, a supplier. */
  readonly basis: string;
}

export interface DeclaredRateReader {
  find(companyId: string, code: string, kind: 'GOODS' | 'SERVICES', on: IsoDate): DeclaredRate | undefined;
  list(companyId: string): readonly DeclaredRate[];
}

/**
 * Refuses a declaration that is not attributable. An unattributed rate is exactly the anonymous
 * number this whole design exists to prevent.
 */
export const validateDeclaredRate = (rate: DeclaredRate): void => {
  if (rate.declaredBy.trim() === '') {
    throw invalid('DECLARED_RATE_NO_AUTHOR', 'A rate the business sets must record who set it.');
  }
  if (rate.basis.trim() === '') {
    throw invalid(
      'DECLARED_RATE_NO_BASIS',
      'Please say where this rate comes from, so anyone reading the bill later knows.',
    );
  }
  if (rate.ratePercentTimes100 < 0n || rate.ratePercentTimes100 > 10000n) {
    throw invalid('DECLARED_RATE_OUT_OF_RANGE', 'A GST rate is between 0 and 100 per cent.');
  }
  if (rate.effectiveTo !== null && compareDates(rate.effectiveTo, rate.effectiveFrom) < 0) {
    throw invalid('DECLARED_RATE_BAD_RANGE', 'This rate stops applying before it starts.');
  }
};

export class InMemoryDeclaredRates implements DeclaredRateReader {
  readonly #rates: DeclaredRate[] = [];

  declare(rate: DeclaredRate): this {
    validateDeclaredRate(rate);
    this.#rates.push(rate);
    return this;
  }

  find(companyId: string, code: string, kind: 'GOODS' | 'SERVICES', on: IsoDate): DeclaredRate | undefined {
    const matches = this.#rates.filter(
      (r) =>
        r.companyId === companyId &&
        r.kind === kind &&
        code.startsWith(r.code) &&
        compareDates(on, r.effectiveFrom) >= 0 &&
        (r.effectiveTo === null || compareDates(on, r.effectiveTo) <= 0),
    );
    if (matches.length === 0) return undefined;
    // Longest code wins, then the most recently declared, so the choice never depends on the
    // order the business happened to enter them in.
    return [...matches].sort((a, b) => {
      if (a.code.length !== b.code.length) return b.code.length - a.code.length;
      return b.declaredOn.localeCompare(a.declaredOn);
    })[0];
  }

  list(companyId: string): readonly DeclaredRate[] {
    return this.#rates.filter((r) => r.companyId === companyId);
  }
}
