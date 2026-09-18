import { isoDate, money, type CompanyId, type PartyId } from '@invoice/kernel';
import type { PurchaseBillRepository } from '../../purchasing/src/posting-ports.ts';
import type { PurchaseReturnSourcePort } from './ports.ts';

/**
 * Issue #186 — a supplier's bill line carries no HSN code of its own, so the item master is asked.
 * The tax rate is read back from the amounts the supplier charged, never looked up afresh.
 */
const rateOf = (taxablePaise: bigint, taxPaise: bigint): bigint | null =>
  taxablePaise <= 0n ? null : (taxPaise * 10000n + taxablePaise / 2n) / taxablePaise;

export const purchaseReturnSource = (
  bills: PurchaseBillRepository,
  hsnOf: (companyId: string, itemId: string) => string | null = () => null,
): PurchaseReturnSourcePort => ({
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
        hsnOrSac: hsnOf(String(bill.companyId), line.itemId),
        ratePercentTimes100: rateOf(line.taxableValuePaise, line.cgstPaise + line.sgstPaise + line.igstPaise),
        unitPrice: line.quantity.scaled <= 0n ? null : money((line.taxableValuePaise * 1_000_000n + line.quantity.scaled / 2n) / line.quantity.scaled),
      })),
    };
  },
});
