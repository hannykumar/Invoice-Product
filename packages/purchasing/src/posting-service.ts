// Issue #17 [E17] — posting an approved purchase.
//
// One approved bill becomes three things that must all happen together: the entry in the books,
// the goods in the godown, and the amount owed to the supplier. All three are written inside one
// unit of work, so a failure anywhere leaves nothing behind — there is no half-saved bill.
//
// The supplier's balance is not a fourth store. It is the credit on the supplier's own account in
// the same voucher, which is why it cannot drift from the books; issue #20 reads the open bills
// through `purchaseDocumentLedger` below.

import { conflict, invalid, isoDate, money, notFound, type IsoDate } from "@invoice/kernel";
import type { ActorContext, AuditPort, LedgerStore, LedgerService } from "@invoice/ledger";
import type { VoucherId } from "@invoice/kernel";
import type { Clock } from "@invoice/kernel";
import { formatPaise } from "./money.ts";
import { buildPurchasePosting, computePurchaseTotals } from "./posting.ts";
import { splitLineTax } from "./posting.ts";
import type { PurchaseAccountCodes } from "./posting.ts";
import type { PurchaseBillRepository, PurchaseInventoryPort } from "./posting-ports.ts";
import type {
  ApprovedPurchase, PurchaseBill, PurchaseBillReceipt, PurchasePostingPreview, PurchasePostingResult,
} from "./posting-types.ts";

/** Posting a purchase is posting to the books, so it is the ledger's own permission. */
export const PURCHASE_POST_PERMISSION = "ledger.post.purchase";
export const PURCHASE_REVERSE_PERMISSION = "ledger.reverse";

/** The purchase lane holds dates as plain strings; the ledger brands them. Convert at the edge. */
const addDays = (date: string, days: number): IsoDate => {
  const base = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) throw invalid("PURCHASE_DATE_INVALID", `"${date}" is not a date we can read.`);
  base.setUTCDate(base.getUTCDate() + days);
  return isoDate(base.toISOString().slice(0, 10));
};

export interface PurchasePostingDeps {
  readonly store: LedgerStore;
  readonly ledger: LedgerService;
  readonly inventory: PurchaseInventoryPort;
  readonly bills: PurchaseBillRepository;
  readonly audit: AuditPort;
  readonly clock: Clock;
  /** Only needed while GPT 1's chart has no role for these. See the contract. */
  readonly accountCodes?: PurchaseAccountCodes;
  readonly idFactory?: () => string;
}

export class PurchasePostingService {
  readonly #store: LedgerStore;
  readonly #ledger: LedgerService;
  readonly #inventory: PurchaseInventoryPort;
  readonly #bills: PurchaseBillRepository;
  readonly #audit: AuditPort;
  readonly #clock: Clock;
  readonly #codes: PurchaseAccountCodes;
  readonly #newId: () => string;

  constructor(deps: PurchasePostingDeps) {
    this.#store = deps.store;
    this.#ledger = deps.ledger;
    this.#inventory = deps.inventory;
    this.#bills = deps.bills;
    this.#audit = deps.audit;
    this.#clock = deps.clock;
    this.#codes = deps.accountCodes ?? {};
    this.#newId = deps.idFactory ?? (() => crypto.randomUUID());
  }

  // ------------------------------------------------------------------- reading

  async bill(actor: ActorContext, id: string): Promise<PurchaseBill | null> {
    return this.#bills.findById(actor.companyId, id);
  }

  async billForPurchase(actor: ActorContext, purchaseId: string): Promise<PurchaseBill | null> {
    return this.#bills.findByPurchaseId(actor.companyId, purchaseId);
  }

  /**
   * Everything the posting would write, written nowhere. What a person approves on this screen is
   * exactly what lands in the books.
   */
  preview(actor: ActorContext, approved: ApprovedPurchase): PurchasePostingPreview {
    this.#assertOwn(actor, approved);
    this.#assertPostable(approved);
    const totals = computePurchaseTotals(approved);
    const dueDate = addDays(approved.invoiceDate, approved.creditDays ?? 0);
    const receipts = approved.lines
      .map((line, index) => ({ line, cost: totals.lineCostPaise[index] ?? 0n }))
      .filter((entry) => entry.line.supplyKind === "GOODS" && entry.line.warehouseId !== undefined && entry.line.receivedAgainstReceiptId === undefined)
      .map((entry) => ({
        itemId: entry.line.itemId,
        warehouseId: entry.line.warehouseId as string,
        ...(entry.line.batchId === undefined ? {} : { batchId: entry.line.batchId }),
        quantity: entry.line.quantity,
        valuePaise: entry.cost,
      }));
    return {
      tax: totals.tax,
      dueDate,
      totalPaise: approved.invoiceTotalPaise,
      roundOffPaise: totals.roundOffPaise,
      receipts,
      summary: this.#summarise(approved, dueDate, totals.tax, receipts.length),
      warnings: totals.warnings,
    };
  }

  // ------------------------------------------------------------------- writing

  /**
   * Posts an approved purchase.
   *
   * Calling it again for the same purchase returns the bill that already exists rather than
   * writing a second one — that is what makes a retry after a timeout safe, whatever the network
   * did, and it holds even when the caller sends a different idempotency key.
   */
  async post(actor: ActorContext, approved: ApprovedPurchase, idempotencyKey: string): Promise<PurchasePostingResult> {
    this.#assertOwn(actor, approved);
    if (idempotencyKey.trim() === "") {
      throw invalid("PURCHASE_IDEMPOTENCY_KEY_REQUIRED", "Every posting needs a key so a retry cannot record it twice.");
    }
    this.#assertPostable(approved);

    const existing = await this.#bills.findByPurchaseId(actor.companyId, approved.id);
    if (existing !== null) {
      if (existing.state === "REVERSED") {
        throw conflict(
          "PURCHASE_ALREADY_REVERSED",
          `Bill ${approved.invoiceNumber} was recorded and then reversed. To record it again, approve it afresh, so the correction stays visible.`,
        );
      }
      return { bill: existing, deduplicated: true };
    }

    // Everything is worked out before anything is written, so a disagreement in the arithmetic is
    // found while the books are still untouched.
    const totals = computePurchaseTotals(approved);
    const dueDate = addDays(approved.invoiceDate, approved.creditDays ?? 0);
    const at = this.#clock.now().toISOString();
    const billId = this.#newId();
    const receivedByReceiptIds = [...new Set(
      approved.lines.map((line) => line.receivedAgainstReceiptId).filter((id): id is string => id !== undefined),
    )];
    const lineSnapshots = approved.lines.map((line, index) => {
      const split = splitLineTax(line.taxableValuePaise, line, totals.tax.intraState);
      const ineligible = line.itcEligibility === "INELIGIBLE" ? split.total : 0n;
      const eligible = ineligible === 0n;
      const ordinarySupplierValue = line.taxableValuePaise + (approved.taxLiability === "SUPPLIER" ? split.total : 0n);
      return {
        lineNumber: line.lineNumber, itemId: line.itemId, description: line.description,
        supplyKind: line.supplyKind, quantity: line.quantity,
        ...(line.warehouseId === undefined ? {} : { warehouseId: line.warehouseId }),
        ...(line.batchId === undefined ? {} : { batchId: line.batchId }),
        ...(line.serialNumbers === undefined ? {} : { serialNumbers: line.serialNumbers }),
        taxableValuePaise: line.taxableValuePaise,
        cgstPaise: eligible ? split.cgst : 0n, sgstPaise: eligible ? split.sgst : 0n,
        igstPaise: eligible ? split.igst : 0n, cessPaise: eligible ? split.cess : 0n,
        ineligibleItcPaise: ineligible,
        // Allocate the bill-level rounding to the last line. That makes a full set of line
        // returns recover the exact printed supplier total while every partial line remains
        // traceable to its original value.
        supplierValuePaise: ordinarySupplierValue + (index === approved.lines.length - 1 ? totals.roundOffPaise : 0n),
      };
    });

    const outcome = await this.#store.transaction(actor.companyId, async (uow) => {
      const lines = await buildPurchasePosting(uow.accounts, actor.companyId, approved, totals, this.#codes);
      const posted = await this.#ledger.postVoucherIn(uow, actor, {
        idempotencyKey: `purchase:post:${approved.id}`,
        type: "PURCHASE",
        date: isoDate(approved.invoiceDate),
        narration: `Bill ${approved.invoiceNumber} from ${approved.supplierName}`,
        source: { kind: "purchase_invoice", id: approved.id, number: approved.invoiceNumber },
        lines,
      });

      // The goods move in the same unit of work as the entry. A godown that refuses the receipt —
      // an unknown item, a batch that was not named — undoes the voucher with it.
      const receipts: PurchaseBillReceipt[] = [];
      for (const [index, line] of approved.lines.entries()) {
        if (line.supplyKind !== "GOODS" || line.warehouseId === undefined) continue;
        // The delivery already moved these goods, by the quantity the godown accepted. Receiving
        // them again here would put the supplier's claimed quantity on the shelf a second time.
        if (line.receivedAgainstReceiptId !== undefined) continue;
        const cost = totals.lineCostPaise[index] ?? 0n;
        const movement = await this.#inventory.receiveIn(actor, {
          idempotencyKey: `purchase:receive:${approved.id}:${line.lineNumber}`,
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          batchId: line.batchId ?? null,
          ...(line.serialNumbers === undefined ? {} : { serialNumbers: line.serialNumbers }),
          quantity: line.quantity,
          lineCostPaise: cost,
          documentDate: isoDate(approved.invoiceDate),
          source: { kind: "purchase_invoice", id: approved.id, number: approved.invoiceNumber },
        });
        receipts.push({
          lineNumber: line.lineNumber,
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          ...(line.batchId === undefined ? {} : { batchId: line.batchId }),
          ...(line.serialNumbers === undefined ? {} : { serialNumbers: line.serialNumbers }),
          quantity: line.quantity,
          valuePaise: cost,
          stockMovementId: movement.id,
        });
      }

      const bill: PurchaseBill = {
        id: billId,
        companyId: actor.companyId,
        purchaseId: approved.id,
        sourceDocumentId: approved.sourceDocumentId,
        supplierPartyId: approved.supplierPartyId,
        supplierName: approved.supplierName,
        invoiceNumber: approved.invoiceNumber,
        invoiceDate: approved.invoiceDate,
        dueDate,
        totalPaise: approved.invoiceTotalPaise,
        tax: totals.tax,
        state: "POSTED",
        voucherId: posted.voucher.id,
        lines: lineSnapshots,
        receipts,
        ...(receivedByReceiptIds.length === 0 ? {} : { receivedByReceiptIds }),
        postedBy: actor.userId,
        postedAt: at,
        idempotencyKey,
        summary: this.#summarise(approved, dueDate, totals.tax, receipts.length),
      };
      await this.#bills.insert(bill);
      return { bill, voucher: posted.voucher, deduplicated: posted.deduplicated };
    });

    // The transaction has committed; only now is it true that this happened.
    await this.#ledger.recordPosted(actor, outcome.voucher);
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: "purchase.bill_posted",
      subjectType: "purchase_invoice",
      subjectId: outcome.bill.id,
      summary: outcome.bill.summary,
      details: {
        number: approved.invoiceNumber,
        supplier: approved.supplierName,
        total: formatPaise(approved.invoiceTotalPaise),
        voucherId: outcome.voucher.id,
        stockMovements: String(outcome.bill.receipts.length),
        split: totals.tax.intraState ? "CGST_SGST" : "IGST",
        reverseCharge: String(totals.tax.reverseCharge),
        sourceDocumentId: approved.sourceDocumentId,
      },
    });
    return { bill: outcome.bill, deduplicated: outcome.deduplicated };
  }

  /**
   * Undoes a posted bill with an equal and opposite entry.
   *
   * The original voucher is left exactly as it was. Posted entries are immutable, so a correction
   * is always a new entry anyone can see, never a quiet edit.
   */
  async reverse(
    actor: ActorContext,
    billId: string,
    input: { readonly on: IsoDate; readonly reason: string; readonly negativeOverrideReason?: string },
  ): Promise<PurchaseBill> {
    const bill = await this.#bills.findById(actor.companyId, billId);
    if (bill === null) throw notFound("PURCHASE_BILL_UNKNOWN", "We could not find that purchase bill.");
    if (bill.state === "REVERSED") {
      throw conflict("PURCHASE_ALREADY_REVERSED", "This bill has already been reversed.");
    }
    if (input.reason.trim() === "") {
      throw invalid("PURCHASE_REVERSAL_REASON_REQUIRED", "Please say why this bill is being reversed; the reason is kept with the entry.");
    }

    const at = this.#clock.now().toISOString();
    const outcome = await this.#store.transaction(actor.companyId, async (uow) => {
      const reversal = await this.#ledger.reverseVoucherIn(uow, actor, {
        idempotencyKey: `purchase:reverse:${bill.id}`,
        voucherId: bill.voucherId as VoucherId,
        date: input.on,
        reason: input.reason,
      });

      // The goods go back out in the same unit of work. If some of them have already been sold,
      // the godown refuses unless an authorised person says why, and the whole reversal is undone
      // rather than leaving the books and the shelf disagreeing.
      for (const receipt of bill.receipts) {
        await this.#inventory.returnIn(actor, {
          idempotencyKey: `purchase:return:${bill.id}:${receipt.lineNumber}`,
          itemId: receipt.itemId,
          warehouseId: receipt.warehouseId,
          batchId: receipt.batchId ?? null,
          ...(receipt.serialNumbers === undefined ? {} : { serialNumbers: receipt.serialNumbers }),
          quantity: receipt.quantity,
          lineCostPaise: receipt.valuePaise,
          documentDate: input.on,
          source: { kind: "purchase_invoice", id: bill.purchaseId, number: bill.invoiceNumber },
          reason: input.reason,
          ...(input.negativeOverrideReason === undefined ? {} : { negativeOverrideReason: input.negativeOverrideReason }),
        });
      }

      const updated: PurchaseBill = {
        ...bill,
        state: "REVERSED",
        reversedByVoucherId: reversal.voucher.id,
        reversalReason: input.reason,
        summary: `Bill ${bill.invoiceNumber} has been reversed: ${formatPaise(bill.totalPaise)} is no longer owed, the goods have been taken back out of stock, and the GST claimed on it has been undone. Reason kept on record: ${input.reason}`,
      };
      await this.#bills.update(updated);
      return { updated, reversal: reversal.voucher };
    });

    await this.#ledger.recordReversed(actor, bill.voucherId as VoucherId, outcome.reversal, input.reason);
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: "purchase.bill_reversed",
      subjectType: "purchase_invoice",
      subjectId: bill.id,
      summary: outcome.updated.summary,
      details: { number: bill.invoiceNumber, supplier: bill.supplierName, reversalVoucherId: outcome.reversal.id },
      overrideReason: input.reason,
    });
    return outcome.updated;
  }

  // ------------------------------------------------------------------ internals

  #assertOwn(actor: ActorContext, approved: ApprovedPurchase): void {
    if (approved.companyId !== actor.companyId) {
      throw notFound("PURCHASE_UNKNOWN", "We could not find that purchase.");
    }
  }

  /** #16's verdict is the gate. A bill it did not clear never reaches the books. */
  #assertPostable(approved: ApprovedPurchase): void {
    const verdict = approved.verdict;
    if (verdict.companyId !== approved.companyId) {
      throw invalid("PURCHASE_VERDICT_MISMATCH", "The checks on this bill belong to a different business, so it cannot be recorded.");
    }
    if (verdict.status !== "POSTABLE") {
      const blocking = verdict.findings.filter((finding) => finding.severity === "MATERIAL");
      throw invalid(
        "PURCHASE_NOT_CLEARED",
        blocking.length > 0
          ? `This bill still has something to sort out: ${blocking[0]?.message ?? verdict.summary}`
          : `This bill has not been cleared for recording yet. ${verdict.summary}`,
        { messageId: "purchase.not_cleared", details: { status: verdict.status } },
      );
    }
    if (verdict.duplicate.verdict === "CONFIRMED") {
      throw conflict(
        "PURCHASE_DUPLICATE",
        `This looks like a bill you have already entered, so it has not been recorded twice. ${verdict.duplicate.message}`.trim(),
      );
    }
  }

  #summarise(approved: ApprovedPurchase, dueDate: IsoDate, tax: PurchaseBill["tax"], receipts: number): string {
    const claimable = tax.cgstPaise + tax.sgstPaise + tax.igstPaise + tax.cessPaise;
    // Goods that came in on a confirmed delivery are already on the shelf; saying "nothing was
    // added to your stock" would read as though the delivery had been lost.
    const alreadyIn = approved.lines.some((line) => line.receivedAgainstReceiptId !== undefined);
    const stock = receipts > 0
      ? `${receipts} item${receipts === 1 ? "" : "s"} went into your stock`
      : alreadyIn
        ? "the goods were already put into your stock when the delivery was confirmed"
        : "nothing was added to your stock";
    const claim = claimable > 0n && !tax.reverseCharge ? `${formatPaise(claimable)} of GST can be claimed back, and ` : "";
    return `${formatPaise(approved.invoiceTotalPaise)} is now owed to ${approved.supplierName} for bill ${approved.invoiceNumber}, due on ${dueDate}. ${claim}${stock}.`;
  }
}

/** Kept so the money helper is available to callers building a preview screen. */
export const paiseToMoney = money;
