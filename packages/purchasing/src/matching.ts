// Issue #18 [E18] — holding the order, the delivery and the bill up against each other.
//
// Everything in this file is a pure function of the three documents and the tolerance in force.
// It reads no database, writes nothing and asks nobody's permission, so the same three documents
// always give the same answer — which is what makes a retry safe and a dispute with a supplier
// arguable months later.
//
// The comparison is done per item rather than per line, because the three documents almost never
// number their lines the same way. One order line can be delivered on three lorries and billed
// on two invoices; matching line 1 to line 1 would find disagreements that are not there.

import { createHash } from "node:crypto";
import type { Quantity } from "@invoice/kernel";
import { MICRO } from "../../masters/src/units.ts";
import { formatPaise } from "./money.ts";
import type { Id, Paise } from "../../masters/src/types.ts";
import type {
  GoodsReceipt, MatchFinding, MatchFindingCode, MatchKind, MatchLine, MatchOutcome, MatchResult,
  MatchSeverity, MatchTolerancePolicy, PurchaseOrder,
} from "./matching-types.ts";
import { DEFAULT_MATCH_TOLERANCE } from "./matching-types.ts";

/** The part of a supplier's bill this module needs. Deliberately less than #17's whole bill. */
export interface MatchInvoiceLine {
  readonly lineNumber: number;
  readonly itemId: Id;
  readonly description: string;
  readonly quantity: Quantity;
  readonly ratePaise: Paise;
  readonly gstRateBasisPoints: number;
}

export interface MatchInvoice {
  readonly purchaseId: Id;
  readonly invoiceNumber: string;
  readonly supplierPartyId: Id;
  readonly lines: readonly MatchInvoiceLine[];
}

export interface MatchInput {
  readonly companyId: Id;
  readonly order?: PurchaseOrder;
  /** Every receipt against this purchase. Unconfirmed and cancelled ones are ignored. */
  readonly receipts?: readonly GoodsReceipt[];
  readonly invoice: MatchInvoice;
}

const absolute = (value: bigint): bigint => (value < 0n ? -value : value);

/** micro-units → a readable figure, e.g. `90 BOX`. Trailing zeros are dropped. */
export const showQuantity = (value: Quantity): string => {
  const negative = value.scaled < 0n;
  const size = absolute(value.scaled);
  const whole = size / MICRO;
  const fraction = (size % MICRO).toString().padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`} ${value.unit}`;
};

/**
 * Whether two quantities are close enough to be treated as the same.
 *
 * The allowance is the larger of a percentage of what was expected and a flat figure, so an
 * order for three items is not held to a percentage that works out to nothing.
 */
const quantityWithinTolerance = (expected: bigint, actual: bigint, policy: MatchTolerancePolicy): boolean => {
  const proportional = (absolute(expected) * BigInt(policy.quantityBasisPoints)) / 10_000n;
  const allowed = proportional > policy.quantityAbsoluteMicro ? proportional : policy.quantityAbsoluteMicro;
  return absolute(actual - expected) <= allowed;
};

const priceWithinTolerance = (expected: Paise, actual: Paise, policy: MatchTolerancePolicy): boolean => {
  const proportional = (absolute(expected) * BigInt(policy.priceBasisPoints)) / 10_000n;
  const allowed = proportional > policy.priceAbsolutePaise ? proportional : policy.priceAbsolutePaise;
  return absolute(actual - expected) <= allowed;
};

/** Every item any of the three documents mentions, in the order a reader would meet them. */
interface Gathered {
  readonly itemId: Id;
  description: string;
  orderLineNumber?: number;
  invoiceLineNumber?: number;
  orderedMicro?: bigint;
  receivedMicro?: bigint;
  acceptedMicro?: bigint;
  invoicedMicro?: bigint;
  orderedRatePaise?: Paise;
  invoicedRatePaise?: Paise;
  orderedGst?: number;
  invoicedGst?: number;
  /** Every unit any document used for this item. More than one means we refuse to compare. */
  readonly units: Set<string>;
  /** Why part of a delivery was turned away, in the receiver's words. */
  readonly rejections: string[];
}

const gather = (input: MatchInput): Map<Id, Gathered> => {
  const items = new Map<Id, Gathered>();
  const slot = (itemId: Id, description: string): Gathered => {
    const existing = items.get(itemId);
    if (existing !== undefined) {
      if (existing.description === "") existing.description = description;
      return existing;
    }
    const created: Gathered = { itemId, description, units: new Set<string>(), rejections: [] };
    items.set(itemId, created);
    return created;
  };

  for (const line of input.order?.lines ?? []) {
    const entry = slot(line.itemId, line.description);
    entry.orderLineNumber ??= line.lineNumber;
    entry.orderedMicro = (entry.orderedMicro ?? 0n) + line.quantity.scaled;
    entry.orderedRatePaise ??= line.ratePaise;
    entry.orderedGst ??= line.gstRateBasisPoints;
    entry.units.add(line.quantity.unit);
  }

  // Only a confirmed receipt counts. A draft is somebody's intention and a cancelled one is a
  // delivery that was taken back out of stock; neither is evidence that goods arrived.
  for (const receipt of input.receipts ?? []) {
    if (receipt.state !== "CONFIRMED") continue;
    for (const line of receipt.lines) {
      const entry = slot(line.itemId, line.description);
      entry.receivedMicro = (entry.receivedMicro ?? 0n) + line.receivedQuantity.scaled;
      entry.acceptedMicro = (entry.acceptedMicro ?? 0n) + line.acceptedQuantity.scaled;
      entry.units.add(line.receivedQuantity.unit);
      entry.units.add(line.acceptedQuantity.unit);
      const turnedAway = line.receivedQuantity.scaled - line.acceptedQuantity.scaled;
      if (turnedAway > 0n) {
        entry.rejections.push(
          `${showQuantity({ scaled: turnedAway, unit: line.receivedQuantity.unit })} on ${receipt.receiptNumber}${
            line.rejectionNote !== undefined && line.rejectionNote !== "" ? ` (${line.rejectionNote})` : ""
          }`,
        );
      }
    }
  }

  for (const line of input.invoice.lines) {
    const entry = slot(line.itemId, line.description);
    entry.invoiceLineNumber ??= line.lineNumber;
    entry.invoicedMicro = (entry.invoicedMicro ?? 0n) + line.quantity.scaled;
    entry.invoicedRatePaise ??= line.ratePaise;
    entry.invoicedGst ??= line.gstRateBasisPoints;
    entry.units.add(line.quantity.unit);
  }

  return items;
};

const severityRank: Record<MatchSeverity, number> = { HOLD: 0, REVIEW: 1, INFORMATION: 2 };

/** Like `Partial<MatchFinding>`, but an explicit `undefined` is allowed so it can clear a field. */
type FindingOverrides = { [K in keyof MatchFinding]?: MatchFinding[K] | undefined };

/**
 * Compares an order, the deliveries against it and the supplier's bill.
 *
 * Any of the three may be missing. A shop that buys a carton of soap from the wholesaler down
 * the road has no order and no goods receipt, and this still returns a usable answer for it —
 * that is deliberate, and is why the small-business path needs no extra code path anywhere else.
 */
export const matchPurchase = (
  input: MatchInput,
  policy: MatchTolerancePolicy = DEFAULT_MATCH_TOLERANCE,
): MatchResult => {
  const confirmed = (input.receipts ?? []).filter((receipt) => receipt.state === "CONFIRMED");
  const hasOrder = input.order !== undefined && input.order.state !== "CANCELLED";
  const hasReceipt = confirmed.length > 0;
  const kind: MatchKind = hasOrder && hasReceipt
    ? "THREE_WAY"
    : hasReceipt ? "TWO_WAY_RECEIPT" : hasOrder ? "TWO_WAY_ORDER" : "INVOICE_ONLY";

  const items = gather({ ...input, receipts: confirmed });
  const lines: MatchLine[] = [];
  const all: MatchFinding[] = [];
  let blocked = false;

  for (const entry of items.values()) {
    const findings: MatchFinding[] = [];
    const unit = [...entry.units][0] ?? "";
    const field = (name: string): string =>
      `lines[${entry.invoiceLineNumber ?? entry.orderLineNumber ?? 0}].${name}`;
    // `undefined` in an override means "this document says nothing here", which has to clear the
    // value inherited from the quantity defaults below — a price finding must not carry a
    // quantity in `receiptSays`. Undefined keys are dropped rather than assigned.
    const add = (
      code: MatchFindingCode,
      severity: MatchSeverity,
      name: string,
      message: string,
      extra: FindingOverrides = {},
    ): void => {
      const built: Record<string, unknown> = {
        code,
        severity,
        field: field(name),
        itemId: entry.itemId,
        description: entry.description,
        withinTolerance: false,
        message,
        ...(entry.orderedMicro === undefined ? {} : { orderSays: showQuantity({ scaled: entry.orderedMicro, unit }) }),
        ...(entry.acceptedMicro === undefined ? {} : { receiptSays: showQuantity({ scaled: entry.acceptedMicro, unit }) }),
        ...(entry.invoicedMicro === undefined ? {} : { invoiceSays: showQuantity({ scaled: entry.invoicedMicro, unit }) }),
        ...extra,
      };
      for (const [key, value] of Object.entries(built)) if (value === undefined) delete built[key];
      const finding = built as unknown as MatchFinding;
      findings.push(finding);
      all.push(finding);
    };

    // Two documents describing the same goods in different units cannot be compared without
    // converting a stock figure mid-comparison, which would hide the very difference we are
    // looking for. We say so and stop, rather than producing a confident wrong answer.
    if (entry.units.size > 1) {
      blocked = true;
      add(
        "UNITS_DIFFER",
        "HOLD",
        "quantity",
        `${entry.description} is written in different units on these documents (${[...entry.units].join(", ")}), so we cannot compare them safely. Please put them in the same unit and check again.`,
      );
      lines.push({ itemId: entry.itemId, description: entry.description, findings });
      continue;
    }

    const ordered = entry.orderedMicro;
    const received = entry.receivedMicro;
    const accepted = entry.acceptedMicro;
    const invoiced = entry.invoicedMicro;
    const rejected = received === undefined || accepted === undefined ? undefined : received - accepted;
    const show = (micro: bigint): string => showQuantity({ scaled: micro, unit });

    // ------------------------------------------------------- what the godown turned away
    if (rejected !== undefined && rejected > 0n) {
      add("REJECTED_ON_ARRIVAL", "INFORMATION", "acceptedQuantity",
        `${show(rejected)} of ${entry.description} was not kept: ${entry.rejections.join("; ")}. It has not gone into your stock, so you should not be paying for it.`,
        { difference: show(rejected), receiptSays: accepted === undefined ? undefined : show(accepted) });
    }

    // ------------------------------------------------- the bill against what actually arrived
    if (invoiced !== undefined && accepted !== undefined) {
      const gap = invoiced - accepted;
      if (gap !== 0n) {
        const tolerable = quantityWithinTolerance(accepted, invoiced, policy);
        if (gap > 0n) {
          const extraCost = entry.invoicedRatePaise === undefined ? undefined : (gap * entry.invoicedRatePaise) / MICRO;
          add("INVOICED_ABOVE_ACCEPTED", tolerable ? "INFORMATION" : "HOLD", "quantity",
            tolerable
              ? `${entry.description}: the bill charges for ${show(gap)} more than you kept, which is small enough to be ordinary counting difference, so it has been let through.`
              : `${entry.description}: you kept ${show(accepted)} but the bill charges for ${show(invoiced)}. You are being asked to pay for ${show(gap)} you never received${extraCost === undefined ? "" : `, which is about ${formatPaise(extraCost)}`}. Nothing has been recorded until you decide.`,
            { difference: show(gap), withinTolerance: tolerable });
        } else {
          add("INVOICED_BELOW_ACCEPTED", tolerable ? "INFORMATION" : "REVIEW", "quantity",
            tolerable
              ? `${entry.description}: the bill charges for a little less than you kept, small enough to ignore.`
              : `${entry.description}: you kept ${show(accepted)} but this bill only charges for ${show(invoiced)}. That is usually because the rest is coming on a later bill. Nothing is wrong, but the balance is not billed yet.`,
            { difference: show(-gap), withinTolerance: tolerable });
        }
      }
    } else if (invoiced !== undefined && hasReceipt && accepted === undefined) {
      add("ITEM_NOT_RECEIVED", "HOLD", "quantity",
        `The bill charges for ${entry.description}, but no delivery of it has been confirmed. Please check whether it actually arrived before recording this bill.`);
    } else if (accepted !== undefined && accepted > 0n && invoiced === undefined) {
      add("ITEM_NOT_INVOICED", "INFORMATION", "quantity",
        `${show(accepted)} of ${entry.description} is in your stock but is not on this bill. That is normal when the supplier bills in parts; it will need a bill of its own.`);
    }

    // --------------------------------------------------- the delivery against what was ordered
    if (ordered !== undefined && accepted !== undefined) {
      const gap = accepted - ordered;
      if (gap !== 0n) {
        const tolerable = quantityWithinTolerance(ordered, accepted, policy);
        if (gap > 0n) {
          const quiet = tolerable || policy.allowOverDelivery;
          add("OVER_DELIVERED", quiet ? "INFORMATION" : "HOLD", "quantity",
            quiet
              ? `${entry.description}: ${show(gap)} more than ordered arrived, which is inside what you allow.`
              : `${entry.description}: you ordered ${show(ordered)} but ${show(accepted)} was accepted — ${show(gap)} more than you asked for. Decide whether to keep and pay for the extra.`,
            { difference: show(gap), withinTolerance: tolerable });
        } else {
          const tolerableShort = quantityWithinTolerance(ordered, accepted, policy);
          add("UNDER_DELIVERED", tolerableShort ? "INFORMATION" : "REVIEW", "quantity",
            tolerableShort
              ? `${entry.description}: very slightly less than ordered arrived.`
              : `${entry.description}: you ordered ${show(ordered)} and ${show(accepted)} has arrived so far. ${show(-gap)} is still to come, unless you close the order.`,
            { difference: show(-gap), withinTolerance: tolerableShort });
        }
      }
    }

    // --------------------------------------------------------------------------- the price
    if (entry.orderedRatePaise !== undefined && entry.invoicedRatePaise !== undefined) {
      const gap = entry.invoicedRatePaise - entry.orderedRatePaise;
      if (gap !== 0n) {
        const tolerable = priceWithinTolerance(entry.orderedRatePaise, entry.invoicedRatePaise, policy);
        const billedMicro = invoiced ?? accepted ?? 0n;
        const totalGap = (absolute(gap) * billedMicro) / MICRO;
        add(gap > 0n ? "PRICE_ABOVE_ORDER" : "PRICE_BELOW_ORDER",
          tolerable ? "INFORMATION" : gap > 0n ? "HOLD" : "REVIEW", "ratePaise",
          tolerable
            ? `${entry.description}: the price is a few paise off what was agreed, which is inside what you allow.`
            : gap > 0n
              ? `${entry.description}: you agreed ${formatPaise(entry.orderedRatePaise)} for one ${unit.toLowerCase()}, but the bill charges ${formatPaise(entry.invoicedRatePaise)}. That is ${formatPaise(absolute(gap))} more each, about ${formatPaise(totalGap)} on this bill. Nothing has been recorded until you decide.`
              : `${entry.description}: the bill charges ${formatPaise(entry.invoicedRatePaise)} for one ${unit.toLowerCase()}, less than the ${formatPaise(entry.orderedRatePaise)} agreed. That is in your favour, but worth checking it is the right bill.`,
          {
            orderSays: formatPaise(entry.orderedRatePaise),
            invoiceSays: formatPaise(entry.invoicedRatePaise),
            receiptSays: undefined,
            difference: formatPaise(absolute(gap)),
            withinTolerance: tolerable,
          });
      }
    }

    // ------------------------------------------------------------------------------- the tax
    if (entry.orderedGst !== undefined && entry.invoicedGst !== undefined && entry.orderedGst !== entry.invoicedGst) {
      const pct = (basisPoints: number): string => `${(basisPoints / 100).toFixed(basisPoints % 100 === 0 ? 0 : 2)}%`;
      add("TAX_RATE_DIFFERS", "REVIEW", "gstRateBasisPoints",
        `${entry.description}: the order expected GST at ${pct(entry.orderedGst)} but the bill charges ${pct(entry.invoicedGst)}. One of the two has the wrong rate, and claiming the wrong amount back is a problem at return time.`,
        {
          orderSays: pct(entry.orderedGst),
          invoiceSays: pct(entry.invoicedGst),
          receiptSays: undefined,
          withinTolerance: false,
        });
    }

    // ------------------------------------------------- something billed that was never ordered
    if (hasOrder && ordered === undefined && invoiced !== undefined) {
      add("ITEM_NOT_ORDERED", "HOLD", "itemId",
        `The bill charges for ${entry.description}, which is not on order ${input.order?.orderNumber ?? ""}. Please check whether it was ordered separately before recording this bill.`.replace("  ", " "));
    }

    lines.push({
      itemId: entry.itemId,
      description: entry.description,
      ...(entry.orderLineNumber === undefined ? {} : { orderLineNumber: entry.orderLineNumber }),
      ...(entry.invoiceLineNumber === undefined ? {} : { invoiceLineNumber: entry.invoiceLineNumber }),
      ...(ordered === undefined ? {} : { orderedQuantity: { scaled: ordered, unit } }),
      ...(received === undefined ? {} : { receivedQuantity: { scaled: received, unit } }),
      ...(accepted === undefined ? {} : { acceptedQuantity: { scaled: accepted, unit } }),
      ...(rejected === undefined || rejected <= 0n ? {} : { rejectedQuantity: { scaled: rejected, unit } }),
      ...(invoiced === undefined ? {} : { invoicedQuantity: { scaled: invoiced, unit } }),
      ...(entry.orderedRatePaise === undefined ? {} : { orderedRatePaise: entry.orderedRatePaise }),
      ...(entry.invoicedRatePaise === undefined ? {} : { invoicedRatePaise: entry.invoicedRatePaise }),
      ...(entry.orderedGst === undefined ? {} : { orderedGstRateBasisPoints: entry.orderedGst }),
      ...(entry.invoicedGst === undefined ? {} : { invoicedGstRateBasisPoints: entry.invoicedGst }),
      findings,
    });
  }

  // Which documents were absent is stated once for the whole match, not per item. Neither is a
  // complaint: most purchases in a small shop have neither an order nor a goods receipt, and
  // saying so plainly is what keeps the simple path feeling simple rather than incomplete.
  if (!hasOrder) {
    const finding: MatchFinding = {
      code: "NO_ORDER", severity: "INFORMATION", field: "orderId", withinTolerance: true,
      message: "There is no purchase order for this bill, so it has been checked against what actually arrived. That is perfectly normal for everyday buying.",
    };
    all.push(finding);
  }
  if (!hasReceipt) {
    const finding: MatchFinding = {
      code: "NO_RECEIPT", severity: "INFORMATION", field: "receiptIds", withinTolerance: true,
      message: "Nobody has confirmed the goods arriving, so this bill has only been checked against itself. If you want stock to move on what was actually delivered, confirm the goods first.",
    };
    all.push(finding);
  }

  const sorted = [...all].sort((left, right) => severityRank[left.severity] - severityRank[right.severity]);
  const outcome: MatchOutcome = blocked
    ? "BLOCKED"
    : sorted.some((finding) => finding.severity === "HOLD")
      ? "HOLD_FOR_APPROVAL"
      : sorted.some((finding) => finding.severity === "REVIEW" || (finding.code !== "NO_ORDER" && finding.code !== "NO_RECEIPT"))
        ? "WITHIN_TOLERANCE"
        : "MATCHED";

  const result: MatchResult = {
    companyId: input.companyId,
    purchaseId: input.invoice.purchaseId,
    invoiceNumber: input.invoice.invoiceNumber,
    ...(input.order === undefined ? {} : { orderId: input.order.id, orderNumber: input.order.orderNumber }),
    receiptIds: confirmed.map((receipt) => receipt.id),
    kind,
    outcome,
    lines,
    findings: sorted,
    policy,
    fingerprint: fingerprintOfMatch(input, policy),
    summary: summarise(outcome, kind, sorted, input.invoice.invoiceNumber),
  };
  return result;
};

/** One line, in the order a person would want to hear it: the problem first, the reassurance last. */
const summarise = (
  outcome: MatchOutcome,
  kind: MatchKind,
  findings: readonly MatchFinding[],
  invoiceNumber: string,
): string => {
  const holds = findings.filter((finding) => finding.severity === "HOLD");
  const reviews = findings.filter((finding) => finding.severity === "REVIEW");
  if (outcome === "BLOCKED") {
    return `Bill ${invoiceNumber} cannot be checked against the order and the delivery yet: ${holds[0]?.message ?? "the documents do not describe the goods the same way."}`;
  }
  if (outcome === "HOLD_FOR_APPROVAL") {
    const more = holds.length - 1;
    return `Bill ${invoiceNumber} is on hold. ${holds[0]?.message ?? ""}${more > 0 ? ` There ${more === 1 ? "is 1 other difference" : `are ${more} other differences`} to look at as well.` : ""}`;
  }
  if (outcome === "WITHIN_TOLERANCE") {
    const count = reviews.length;
    return count > 0
      ? `Bill ${invoiceNumber} can be recorded. ${count === 1 ? "There is one thing" : `There are ${count} things`} worth knowing: ${reviews[0]?.message ?? ""}`
      : `Bill ${invoiceNumber} matches, with small differences that are inside what you allow.`;
  }
  return kind === "THREE_WAY"
    ? `Bill ${invoiceNumber} agrees with what you ordered and what arrived. Nothing needs your attention.`
    : kind === "TWO_WAY_RECEIPT"
      ? `Bill ${invoiceNumber} agrees with what arrived. Nothing needs your attention.`
      : `Bill ${invoiceNumber} has nothing to contradict it.`;
};

/**
 * A stable hash over the three documents and the tolerance.
 *
 * Two calls with the same paperwork produce the same fingerprint, which is what lets an approval
 * be pinned to the exact comparison it was given. Change a quantity and the approval no longer
 * covers it, which is the point.
 */
export const fingerprintOfMatch = (input: MatchInput, policy: MatchTolerancePolicy): string => {
  const parts: string[] = [
    `company=${input.companyId}`,
    `invoice=${input.invoice.invoiceNumber}`,
    `order=${input.order?.id ?? "none"}`,
    `tolerance=${policy.quantityBasisPoints}/${policy.quantityAbsoluteMicro}/${policy.priceBasisPoints}/${policy.priceAbsolutePaise}/${policy.taxAbsolutePaise}/${policy.allowOverDelivery}/${policy.effectiveFrom}`,
  ];
  for (const line of input.order?.lines ?? []) {
    parts.push(`o:${line.itemId}:${line.quantity.scaled}${line.quantity.unit}:${line.ratePaise}:${line.gstRateBasisPoints}`);
  }
  for (const receipt of (input.receipts ?? []).filter((candidate) => candidate.state === "CONFIRMED")) {
    for (const line of receipt.lines) {
      parts.push(`r:${receipt.id}:${line.itemId}:${line.receivedQuantity.scaled}:${line.acceptedQuantity.scaled}${line.acceptedQuantity.unit}`);
    }
  }
  for (const line of input.invoice.lines) {
    parts.push(`i:${line.itemId}:${line.quantity.scaled}${line.quantity.unit}:${line.ratePaise}:${line.gstRateBasisPoints}`);
  }
  return createHash("sha256").update(parts.sort().join("|")).digest("hex");
};

/** Findings that stop a bill being recorded until somebody decides. */
export const holdingFindings = (match: MatchResult): readonly MatchFinding[] =>
  match.findings.filter((finding) => finding.severity === "HOLD");
