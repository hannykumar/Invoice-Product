// A runnable walkthrough of issue #17: `npm run demo:posting`.
//
// Five approved bills go to the books. Watch the entry, the godown and the supplier's account
// move together — and watch the ones that are refused move nothing at all.

import { isoDate, toDecimalString } from "@invoice/kernel";
import { formatQuantity } from "../../masters/src/units.ts";
import { quantity } from "../../masters/src/units.ts";
import { formatPaise } from "./money.ts";
import { purchaseDocumentLedger } from "./posting-adapters.ts";
import type { ApprovedPurchase } from "./posting-types.ts";
import { COMPANY, SUPPLIER, clearedVerdict, makeShop, purchase, steelLine } from "./posting-fixtures.ts";

const line = (text = "") => console.log(text);

const intraState = clearedVerdict({
  taxCheck: { basis: "RULES_ENGINE", intraState: true, ruleSetVersion: "gst-2026.1", ruleId: "POS.INTRASTATE", explanation: "Supplier and godown are both in Karnataka." },
});

export async function runDemo(): Promise<void> {
  const shop = await makeShop();
  const documents = purchaseDocumentLedger(shop.bills, async () => "Shree Ram Steels Private Limited");

  const bills: readonly { title: string; approved: ApprovedPurchase }[] = [
    {
      title: "1. Steel from Pune into a Bengaluru godown — a different state, so IGST",
      approved: purchase(),
    },
    {
      title: "2. Soap bought by the box but kept in pieces, same state, with 50 paise of rounding",
      approved: purchase({
        id: "pur-2", sourceDocumentId: "doc-2", verdict: intraState, invoiceNumber: "NPT/26/118",
        lines: [steelLine({ itemId: "SOAP", description: "Herbal Bath Soap 100g", hsnSac: "34011190", quantity: quantity("10", "BOX"), ratePaise: 24_000n, taxableValuePaise: 2_400_00n, batchId: "batch-jul" })],
        invoiceTotalPaise: 2_832_50n,
      }),
    },
    {
      title: "3. Freight from an unregistered transporter — reverse charge, the GST is yours to pay",
      approved: purchase({
        id: "pur-3", sourceDocumentId: "doc-3", verdict: intraState, invoiceNumber: "GTA/26/004",
        taxLiability: "REVERSE_CHARGE", invoiceTotalPaise: 5_000_00n, creditDays: 15,
        lines: [steelLine({ itemId: "FRT", description: "Inward freight", hsnSac: "996511", supplyKind: "SERVICES", warehouseId: undefined, quantity: quantity("1", "NOS"), ratePaise: 500_000n, taxableValuePaise: 5_000_00n, gstRateBasisPoints: 500 })],
      }),
    },
    {
      title: "4. A bill whose total does not match its own lines — refused",
      approved: purchase({ id: "pur-4", sourceDocumentId: "doc-4", invoiceNumber: "SRS/2026/0051", invoiceTotalPaise: 45_000_00n }),
    },
    {
      title: "5. Goods with no godown chosen — refused",
      approved: purchase({ id: "pur-5", sourceDocumentId: "doc-5", invoiceNumber: "SRS/2026/0052", lines: [steelLine({ warehouseId: undefined })] }),
    },
  ];

  line("Recording approved purchases (issue #17)");
  line("=".repeat(80));

  for (const { title, approved } of bills) {
    line();
    line(title);
    try {
      for (const warning of shop.posting.preview(shop.actor, approved).warnings) line(`  note     : ${warning}`);
      const { bill } = await shop.posting.post(shop.actor, approved, `demo:${approved.id}`);
      line(`  result   : recorded`);
      line(`  in words : ${bill.summary}`);
      const voucher = await shop.store.read().vouchers.findById(COMPANY, bill.voucherId as never);
      line(`  books    :`);
      for (const entry of voucher?.lines ?? []) {
        const account = await shop.store.read().accounts.findById(COMPANY, entry.accountId);
        const side = entry.debit.minor > 0n ? `Dr ${toDecimalString(entry.debit)}` : `Cr ${toDecimalString(entry.credit)}`;
        line(`      ${(account?.name ?? "?").padEnd(36)} ${side.padStart(14)}   ${entry.narration ?? ""}`);
      }
      for (const receipt of bill.receipts) {
        const balance = await shop.inventoryService.balance(shop.actor, { itemId: receipt.itemId, warehouseId: receipt.warehouseId, batchId: receipt.batchId ?? null });
        line(`  godown   : ${formatQuantity(receipt.quantity)} received, ${formatQuantity(balance.physical)} now in ${receipt.warehouseId}`);
      }
      line(`  owed     : ${formatPaise(bill.totalPaise)} due ${bill.dueDate}`);
    } catch (error) {
      line(`  result   : refused — nothing was saved`);
      line(`      ${(error as Error).message}`);
    }
  }

  line();
  line("Approving the same bill a second time");
  line("-".repeat(80));
  const again = await shop.posting.post(shop.actor, purchase(), "demo:a-different-key-entirely");
  line(`  same bill returned  : ${again.deduplicated}`);
  line(`  entries in the books: ${(await shop.store.read().vouchers.list(COMPANY, {})).length}`);
  const steel = await shop.inventoryService.balance(shop.actor, { itemId: "TMT12", warehouseId: "wh-main" });
  line(`  steel in the godown : ${formatQuantity(steel.physical)} (not doubled)`);

  line();
  line("What the payments screen sees");
  line("-".repeat(80));
  for (const open of await documents.openDocuments(COMPANY, SUPPLIER as never)) {
    line(`  ${open.number.padEnd(16)} ${toDecimalString(open.value).padStart(12)}  due ${open.dueDate}`);
  }

  line();
  line("Sending the steel back");
  line("-".repeat(80));
  const reversed = await shop.posting.reverse(shop.actor, again.bill.id, { on: isoDate("2026-07-28"), reason: "Wrong grade of steel; the whole lot went back." });
  line(`  in words            : ${reversed.summary}`);
  const after = await shop.inventoryService.balance(shop.actor, { itemId: "TMT12", warehouseId: "wh-main" });
  line(`  steel in the godown : ${formatQuantity(after.physical)}`);
  line(`  entries in the books: ${(await shop.store.read().vouchers.list(COMPANY, {})).length} (the first one is never edited)`);
  line(`  still owed          : ${(await documents.openDocuments(COMPANY, SUPPLIER as never)).length} bill(s)`);

  line();
  line(`Recorded in the audit trail: ${shop.audit.events.length} events.`);
  line("No database, no GST portal and no real supplier were needed for any of this.");
}

if (import.meta.url === `file://${process.argv[1]}`) await runDemo();
