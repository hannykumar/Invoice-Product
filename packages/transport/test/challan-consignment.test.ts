/**
 * Issue #141 — a delivery challan can carry an e-way bill (CGST Rule 55(3)).
 *
 * The challan goes on the e-way bill as document type "CHL", with the reason for the movement the
 * challan itself recorded, and the rules decide from it exactly as they do from an invoice.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { challanReason } from "@invoice/sales";
import { consignmentFromChallan } from "../src/challan-consignment.ts";
import { decideEwayApplicability } from "../src/applicability.ts";
import { buildPartA, SUB_SUPPLY_CODES } from "../src/payload.ts";
import { interStateMovement } from "../src/fixtures.ts";
import { GURUGRAM, inr, qty } from "../../sales/test/fixtures.ts";
import { crateChallan, makeDispatchDesk } from "../../sales/test/challan-fixtures.ts";

test("a job-work challan becomes a CHL document with the job-work reason", async () => {
  const desk = await makeDispatchDesk();
  // Five crates, ₹1,050 of goods: far below any value limit.
  const challan = await desk.challans.issue(desk.actor, {
    idempotencyKey: "eway-jw",
    input: crateChallan({ partyId: GURUGRAM, lines: [{ lineId: "l1", itemId: "CRATE-P", quantity: qty("5", "PCS"), unitPrice: inr(210) }] }),
  });

  const document = consignmentFromChallan(challan);
  assert.equal(document.documentType, "DELIVERY_CHALLAN");
  assert.equal(document.documentNumber, "DC/26-27/0000001");
  assert.equal(document.lines[0]?.taxableValuePaise, 105000n);
  assert.equal(document.lines[0]?.quantity, "5");
  assert.equal(document.lines[0]?.igstPaise, 0n, "no tax on goods out for job work");

  const movement = interStateMovement({ reason: challanReason(challan.reason).movementReason, documents: [document] });
  const decision = decideEwayApplicability(movement);
  assert.equal(decision.outcome, "REQUIRED", "job work across a state border needs an e-way bill at any value");
  assert.equal(decision.ruleId, "EWB.ANY_VALUE.INTER_STATE_JOB_WORK");

  const partA = buildPartA(movement);
  assert.ok(partA.ok, partA.ok ? "" : partA.problems.map((p) => p.message).join(" "));
  assert.equal(partA.payload.docType, "CHL");
  assert.equal(partA.payload.docNo, "DC/26-27/0000001");
  assert.equal(partA.payload.subSupplyType, SUB_SUPPLY_CODES.JOB_WORK);
});

test("a sale challan carries its tax to the e-way bill", async () => {
  const desk = await makeDispatchDesk();
  const challan = await desk.challans.issue(desk.actor, {
    idempotencyKey: "eway-sale",
    input: crateChallan({ partyId: GURUGRAM, reason: "SUPPLY_INVOICE_TO_FOLLOW" }),
  });
  const document = consignmentFromChallan(challan);
  assert.equal(document.lines[0]?.igstPaise, 151200n);
  assert.equal(challanReason(challan.reason).movementReason, "SUPPLY");
});
