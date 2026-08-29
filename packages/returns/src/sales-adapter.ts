import type { SalesRepository } from '@invoice/sales';
import type { SalesReturnSourcePort } from './ports.ts';

export const salesReturnSource = (sales: SalesRepository): SalesReturnSourcePort => ({
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
      governmentRegistered: false,
      lines: invoice.lines.map((input) => {
        const priced = invoice.pricing?.lines.find((line) => line.lineId === input.lineId);
        if (priced === undefined) throw new Error(`Final invoice ${invoice.id} has no pricing snapshot for line ${input.lineId}.`);
        const reverseCharge = priced.reverseCharge;
        return {
          lineId: input.lineId,
          itemId: input.itemId,
          description: priced.itemName,
          supplyKind: invoice.supplyKind,
          quantity: input.quantity,
          warehouseId: input.warehouseId ?? null,
          taxableValue: priced.taxableValue,
          cgst: reverseCharge ? { ...priced.cgst, minor: 0n } : priced.cgst,
          sgst: reverseCharge ? { ...priced.sgst, minor: 0n } : priced.sgst,
          utgst: reverseCharge ? { ...priced.utgst, minor: 0n } : priced.utgst,
          igst: reverseCharge ? { ...priced.igst, minor: 0n } : priced.igst,
          cess: reverseCharge ? { ...priced.cess, minor: 0n } : priced.cess,
          total: priced.lineTotal,
        };
      }),
    };
  },
});
