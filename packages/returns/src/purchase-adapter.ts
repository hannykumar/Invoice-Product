import { isoDate, money, type CompanyId, type PartyId } from '@invoice/kernel';
import type { PurchaseBillRepository } from '../../purchasing/src/posting-ports.ts';
import type { PurchaseReturnSourcePort } from './ports.ts';

export const purchaseReturnSource = (bills: PurchaseBillRepository): PurchaseReturnSourcePort => ({
  async findPurchaseDocument(companyId, id) {
    const bill = await bills.findById(companyId, id);
    if (bill === null) return null;
    return {
      id: bill.id,
      companyId: bill.companyId as CompanyId,
      number: bill.invoiceNumber,
      date: isoDate(String(bill.invoiceDate)),
      partyId: bill.supplierPartyId as PartyId,
      partyName: bill.supplierName,
      state: bill.state === 'POSTED' ? 'FINAL' : 'CANCELLED',
      reverseCharge: bill.tax.reverseCharge,
      governmentRegistered: false,
      lines: bill.lines.map((line) => ({
        lineId: String(line.lineNumber), itemId: line.itemId, description: line.description,
        supplyKind: line.supplyKind, quantity: line.quantity, warehouseId: line.warehouseId ?? null,
        taxableValue: money(line.taxableValuePaise), cgst: money(line.cgstPaise), sgst: money(line.sgstPaise),
        utgst: money(0n), igst: money(line.igstPaise), cess: money(line.cessPaise),
        ineligibleTax: money(line.ineligibleItcPaise), total: money(line.supplierValuePaise),
      })),
    };
  },
});
