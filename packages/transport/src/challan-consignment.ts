/**
 * Issue #141 — a delivery challan as the document travelling with the goods.
 *
 * CGST Rule 55(3): goods moving on a delivery challan instead of an invoice are declared on an
 * e-way bill just the same. The portal takes the challan as document type "CHL". The reason for the
 * movement — job work, own use, exhibition — comes from the challan's own reason table
 * (`challanReason(...).movementReason` in `packages/sales`), so the dispatch clerk is never asked a
 * question the challan has already answered, and there is one table rather than two to keep apart.
 *
 * The challan shape below is written out structurally rather than imported from the sales module,
 * so this package keeps no dependency on it. `DeliveryChallan` in `packages/sales` satisfies it.
 */
import type { ConsignmentDocument, ConsignmentLine } from "./types.ts";

interface ChallanAmount {
  readonly minor: bigint;
}

export interface ChallanForMovement {
  readonly id: string;
  readonly number: string;
  readonly documentDate: string;
  readonly lines: readonly {
    readonly itemName: string;
    readonly hsnOrSac: string;
    readonly quantity: { readonly scaled: bigint; readonly unit: string };
    readonly taxableValue: ChallanAmount;
    readonly cgst: ChallanAmount;
    readonly sgst: ChallanAmount;
    readonly utgst: ChallanAmount;
    readonly igst: ChallanAmount;
    readonly cess: ChallanAmount;
    readonly exemptSupply: boolean;
  }[];
}

const quantityText = (scaled: bigint): string => {
  const whole = scaled / 1_000_000n;
  const fraction = (scaled % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
};

/**
 * The challan as the e-way bill carries it.
 *
 * UTGST is carried as state tax, which is how the portal takes it: it has one column for both.
 */
export const consignmentFromChallan = (challan: ChallanForMovement): ConsignmentDocument => ({
  documentId: challan.id,
  documentType: "DELIVERY_CHALLAN",
  documentNumber: challan.number,
  documentDate: challan.documentDate,
  lines: challan.lines.map(
    (line): ConsignmentLine => ({
      description: line.itemName,
      hsnCode: line.hsnOrSac,
      quantity: quantityText(line.quantity.scaled),
      unit: line.quantity.unit,
      taxableValuePaise: line.taxableValue.minor,
      cgstPaise: line.cgst.minor,
      sgstPaise: line.sgst.minor + line.utgst.minor,
      igstPaise: line.igst.minor,
      cessPaise: line.cess.minor,
      isExemptSupply: line.exemptSupply,
    }),
  ),
});
