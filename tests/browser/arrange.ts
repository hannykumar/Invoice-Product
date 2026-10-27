/**
 * Issue #495 — arranging what a web-app spec then looks at, through the same API routes the screens
 * call. Every name is new to the run (a random part, not a clock reading: the app treats names that
 * differ only in their last letters as the same item or customer), so the shared database of an
 * earlier spec never changes what a spec sees.
 */
import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { syntheticGstin } from "../../packages/masters/src/fixtures.ts";
import { apiCall, ensureBusinessDetails, today } from "./helpers.ts";

export const distinct = (word: string) => `${word} ${randomUUID().slice(0, 8)}`;

const letter = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
/** A structurally valid, invented GST number for a state — new every call. */
export const gstinFor = (state: string) => syntheticGstin(state, `AAA${letter()}${letter()}${1000 + Math.floor(Math.random() * 9000)}${letter()}`);

export interface Shop {
  readonly cookie: string;
  readonly today: string;
  readonly supplier: { id: string; name: string };
}

/** A signed-in session, the business's own address on file, and a supplier new to this spec. */
export async function openShop(request: APIRequestContext, cookie: string): Promise<Shop> {
  await ensureBusinessDetails(request, cookie);
  const name = distinct("Krishna Steel");
  const made = await apiCall(request, cookie, "/api/suppliers", {
    legalName: name, gstin: gstinFor("29"), registration: "regular", stateCode: "29", pincode: "560058",
    line1: "Plot 5, Peenya Industrial Area", city: "Bengaluru", acknowledgeSimilar: true,
  });
  return { cookie, today: await today(request, cookie), supplier: { id: made.supplier.id as string, name } };
}

/** A goods item, and (when `stock` is given) a supplier bill that puts that many in the godown. */
export async function addGoods(request: APIRequestContext, shop: Shop, input: { name: string; unit?: string; price?: string; rate?: string; hsnSac?: string; stock?: string; cost?: string }) {
  const unit = input.unit ?? "PCS";
  const made = await apiCall(request, shop.cookie, "/api/items", {
    name: input.name, kind: "goods", hsnSac: input.hsnSac ?? "34011190", unit, taxKind: "taxable", ratePercentTimes100: input.rate ?? "500",
    basis: "Browser test item", price: input.price ?? "30", acknowledgeSimilar: true,
  });
  const id = made.item.id as string;
  if (input.stock !== undefined) {
    await apiCall(request, shop.cookie, "/api/purchases/record", {
      supplierId: shop.supplier.id, reference: distinct("SRS"), date: shop.today,
      lines: JSON.stringify([{ itemId: id, quantity: input.stock, unit, rate: input.cost ?? "20", gst: input.rate ?? "500" }]),
    });
  }
  return { id, name: input.name };
}

/** A named customer with a phone number the WhatsApp message can use. */
export async function addCustomerWithPhone(request: APIRequestContext, shop: Shop, name: string, phone: string) {
  const made = await apiCall(request, shop.cookie, "/api/customers", {
    legalName: name, registration: "unregistered", stateCode: "29", pincode: "560058", line1: "MG Road", city: "Bengaluru", phone, acknowledgeSimilar: true,
  });
  return { id: made.customer.id as string, name };
}

/** A recorded sale (a bill), through the route the sale screen calls. `terms` is "now" (paid) or the days allowed. */
export async function recordSale(request: APIRequestContext, shop: Shop, input: { customerId: string; itemId: string; quantity: string; rate: string; unit?: string; terms?: string; paidBy?: string }) {
  return apiCall(request, shop.cookie, "/api/sales/record", {
    customerId: input.customerId, date: shop.today, terms: input.terms ?? "now", ...(input.terms === undefined || input.terms === "now" ? { paidBy: input.paidBy ?? "CASH" } : {}),
    requestId: randomUUID(), lines: JSON.stringify([{ itemId: input.itemId, quantity: input.quantity, unit: input.unit ?? "PCS", rate: input.rate }]),
  });
}

/** A customer with a plain name, for bills made out to somebody. */
export async function addCustomer(request: APIRequestContext, shop: Shop, name: string) {
  return addCustomerWithPhone(request, shop, name, "");
}

/** A supplier new to this spec (no bills yet), with a GST number of its own. */
export async function addSupplier(request: APIRequestContext, shop: Shop, name: string) {
  const made = await apiCall(request, shop.cookie, "/api/suppliers", {
    legalName: name, gstin: gstinFor("29"), registration: "regular", stateCode: "29", pincode: "560058",
    line1: "Plot 9, Peenya Industrial Area", city: "Bengaluru", acknowledgeSimilar: true,
  });
  return { id: made.supplier.id as string, name };
}
