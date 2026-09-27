import type { SalesInvoice, SalesRepository } from '@invoice/sales';
import type { OriginalReturnLine, SalesReturnSourcePort } from './ports.ts';

type PricedLine = NonNullable<SalesInvoice['pricing']>['lines'][number];

const originalLine = (
  priced: PricedLine,
  facts: Pick<OriginalReturnLine, 'lineId' | 'itemId' | 'supplyKind' | 'quantity' | 'warehouseId' | 'hsnOrSac'>,
): OriginalReturnLine => {
  const reverseCharge = priced.reverseCharge;
  return {
    ...facts,
    description: priced.itemName,
    taxableValue: priced.taxableValue,
    cgst: reverseCharge ? { ...priced.cgst, minor: 0n } : priced.cgst,
    sgst: reverseCharge ? { ...priced.sgst, minor: 0n } : priced.sgst,
    utgst: reverseCharge ? { ...priced.utgst, minor: 0n } : priced.utgst,
    igst: reverseCharge ? { ...priced.igst, minor: 0n } : priced.igst,
    cess: reverseCharge ? { ...priced.cess, minor: 0n } : priced.cess,
    total: priced.lineTotal,
    ratePercentTimes100: priced.ratePercentTimes100,
    unitPrice: priced.unitPrice,
  };
};

export const salesReturnSource = (
  sales: SalesRepository,
  isGovernmentRegistered: (
    companyId: Parameters<SalesRepository['findById']>[0],
    documentId: Parameters<SalesRepository['findById']>[1],
  ) => Promise<boolean> = async () => false,
): SalesReturnSourcePort => ({
  async findSalesDocument(companyId, id) {
    const invoice = await sales.findById(companyId, id);
    if (invoice === null || invoice.number === null || invoice.pricing === null) return null;
    return {
      id: invoice.id,
      companyId: invoice.companyId,
      number: invoice.number,
      date: invoice.documentDate,
      partyId: invoice.partyId,
      state: invoice.state === 'CANCELLED' ? 'CANCELLED' : 'FINAL',
      governmentRegistered: await isGovernmentRegistered(companyId, id),
      lines: [
        ...invoice.lines.map((input) => {
          const priced = invoice.pricing?.lines.find((line) => line.lineId === input.lineId);
          if (priced === undefined) throw new Error(`Final invoice ${invoice.id} has no pricing snapshot for line ${input.lineId}.`);
          return originalLine(priced, {
            lineId: input.lineId, itemId: input.itemId, supplyKind: invoice.supplyKind,
            quantity: input.quantity, warehouseId: input.warehouseId ?? null, hsnOrSac: priced.hsnOrSac,
          });
        }),
        // Issue #233 — freight and other charges are part of the bill too, so a credit note for the
        // whole bill can credit them. A charge has no code of its own; it is reported under the
        // goods it travelled with (#188, #231). The code of the largest goods line at the charge's
        // rate is kept for the one case where the charge is credited with none of its goods left.
        ...invoice.pricing.lines.filter((line) => line.kind === 'CHARGE').map((charge) => {
          const goods = invoice.pricing!.lines
            .filter((line) => line.kind !== 'CHARGE' && line.ratePercentTimes100 === charge.ratePercentTimes100 && line.hsnOrSac !== null)
            .sort((a, b) => (b.taxableValue.minor > a.taxableValue.minor ? 1 : b.taxableValue.minor < a.taxableValue.minor ? -1 : 0))[0];
          return originalLine(charge, {
            lineId: charge.lineId, itemId: charge.itemId, supplyKind: invoice.supplyKind,
            quantity: charge.quantity, warehouseId: null, hsnOrSac: goods?.hsnOrSac ?? null,
          });
        }),
      ],
    };
  },
});
