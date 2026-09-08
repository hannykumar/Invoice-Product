/**
 * Issue #44 — what happens to a sale when the government's service is down.
 *
 * The sales module's `ComplianceHookPort` carries a promise in a comment: the books must not wait
 * for a government service. Neither module's own tests can check it, because each stubs the other —
 * the sales tests use a no-op hook and the e-invoice tests never see a ledger. The failure it is
 * guarding against is the worst kind: an IRP timeout rolling back a sale that already moved stock,
 * or a bill shown to a shopkeeper as registered when nothing reached the government.
 *
 * So these scenarios wire the real e-invoice service into the real sales service, drive the
 * synthetic IRP into outage and timeout on purpose, and assert on both sides of the seam.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isoDate, quantityFromString, rupees, toDecimalString } from '@invoice/kernel';
import { partyBalance, trialBalance } from '@invoice/ledger';
import { makeEInvoiceDesk } from '../../packages/gst/src/einvoice-fixtures.ts';
import {
  COMPANY, CUSTOMER, makeBusiness, einvoiceHooks, einvoiceApplicability,
  salesInvoiceToEInvoiceDocument, purchase,
} from './harness.ts';

/** The e-invoice desk and a business whose sales are reported through it. */
const makeReportingBusiness = async (options: { readonly turnoverPaise?: bigint } = {}) => {
  const desk = makeEInvoiceDesk({ now: '2026-08-29T10:00:00.000Z' });
  const shop = await makeBusiness({
    compliance: einvoiceHooks(desk.service, { ...desk.actor, companyId: COMPANY }, options),
  });
  await shop.posting.post(
    shop.actor,
    purchase({ id: 'e2e-irp-buy', sourceDocumentId: 'e2e-irp-source', invoiceNumber: 'E2E/IRP/BUY' }),
    'e2e:compliance:purchase',
  );
  return { desk, shop };
};

const sell = async (shop: Awaited<ReturnType<typeof makeBusiness>>, key: string) => {
  const draft = await shop.sales.createDraft(shop.actor, {
    idempotencyKey: `e2e:compliance:${key}:draft`,
    input: {
      partyId: CUSTOMER,
      customerType: 'B2B',
      supplyKind: 'GOODS',
      documentDate: isoDate('2026-08-29'),
      dueDate: isoDate('2026-09-28'),
      lines: [{
        lineId: 'steel', itemId: 'TMT12', quantity: quantityFromString('100', 'KGS'),
        unitPrice: rupees(100), priceBasis: 'EXCLUSIVE', warehouseId: 'wh-main',
      }],
    },
  });
  return shop.sales.finalise(shop.actor, { idempotencyKey: `e2e:compliance:${key}:final`, invoiceId: draft.id });
};

test('a healthy portal registers the bill and the IRN reaches the sales record', async () => {
  const { desk, shop } = await makeReportingBusiness();
  const issued = await sell(shop, 'healthy');

  assert.equal(issued.invoice.state, 'FINAL');
  const record = await desk.service.forDocument(desk.actor, issued.invoice.id);
  assert.equal(record?.status, 'REGISTERED');
  assert.match(record?.acknowledgement?.irn ?? '', /^[0-9a-f]{64}$/);

  // The seam: what the sales module was told matches what the e-invoice module holds.
  const registration = issued.registrations?.find((item) => item.kind === 'E_INVOICE');
  assert.equal(registration?.status, 'REGISTERED');
  assert.equal(registration?.reference, record?.acknowledgement?.irn);
});

test('the portal being down does not cost the shopkeeper the sale', async () => {
  const { desk, shop } = await makeReportingBusiness();
  desk.portal.setMode('outage');

  const issued = await sell(shop, 'outage');

  // Everything the business depends on happened anyway.
  assert.equal(issued.invoice.state, 'FINAL');
  assert.equal((await shop.inventoryService.balance(shop.actor, { itemId: 'TMT12', warehouseId: 'wh-main' })).physical.scaled, 400_000000n);
  assert.equal(toDecimalString((await partyBalance(shop.store.read(), COMPANY, CUSTOMER)).balance), '11800.00');
  assert.equal((await trialBalance(shop.store.read(), COMPANY)).balanced, true);

  // And the one thing that did not happen is reported as not having happened.
  const registration = issued.registrations?.find((item) => item.kind === 'E_INVOICE');
  assert.equal(registration?.status, 'FAILED');
  assert.equal(registration?.reference, null);
  const record = await desk.service.forDocument(desk.actor, issued.invoice.id);
  assert.equal(record?.status, 'FAILED');
  assert.equal(record?.failure?.retryable, true);
  // The wording a shopkeeper reads must not leave them thinking the bill is invalid.
  assert.match(record?.message ?? '', /safe in your books/);
});

test('a timed-out call is never reported as a registered e-invoice', async () => {
  // The single most damaging thing this product could do is show `PENDING` as registered.
  const { desk, shop } = await makeReportingBusiness();
  desk.portal.setMode('timeout');

  const issued = await sell(shop, 'timeout');
  const record = await desk.service.forDocument(desk.actor, issued.invoice.id);

  assert.notEqual(record?.status, 'REGISTERED');
  assert.equal(record?.acknowledgement, undefined);
  assert.equal(issued.registrations?.find((item) => item.kind === 'E_INVOICE')?.reference, null);
});

test('when the portal comes back, the same bill registers once and only once', async () => {
  const { desk, shop } = await makeReportingBusiness();
  desk.portal.setMode('outage');
  const issued = await sell(shop, 'recovery');
  assert.equal((await desk.service.forDocument(desk.actor, issued.invoice.id))?.status, 'FAILED');

  desk.portal.setMode('healthy');
  const retried = await desk.service.register(desk.actor, {
    document: salesInvoiceToEInvoiceDocument(issued.invoice),
    applicability: einvoiceApplicability(issued.invoice.documentDate),
  });
  assert.equal(retried.status, 'REGISTERED');

  // A second retry after success must return the same IRN rather than registering again: an IRN
  // cannot be quietly withdrawn, so a duplicate is a permanent problem on a government record.
  const again = await desk.service.register(desk.actor, {
    document: salesInvoiceToEInvoiceDocument(issued.invoice),
    applicability: einvoiceApplicability(issued.invoice.documentDate),
  });
  assert.equal(again.acknowledgement?.irn, retried.acknowledgement?.irn);
  assert.equal((await desk.service.list(desk.actor)).length, 1);

  // And the books never moved through any of it.
  assert.equal((await trialBalance(shop.store.read(), COMPANY)).balanced, true);
  assert.equal(toDecimalString((await partyBalance(shop.store.read(), COMPANY, CUSTOMER)).balance), '11800.00');
});

test('a small business below the threshold sells without any of this happening', async () => {
  // The ordinary case, and the one that must not acquire a government round trip by accident:
  // most MSMEs need no IRN at all, and the sale must not slow down or fail because of one.
  const { desk, shop } = await makeReportingBusiness({ turnoverPaise: 90_00_000_00n });
  const issued = await sell(shop, 'below-threshold');

  assert.equal(issued.invoice.state, 'FINAL');
  assert.equal(issued.registrations?.find((item) => item.kind === 'E_INVOICE')?.status, 'NOT_APPLICABLE');
  assert.equal((await desk.service.list(desk.actor)).length, 0, 'nothing should have been recorded against the government');
  assert.equal((await trialBalance(shop.store.read(), COMPANY)).balanced, true);
});
