/**
 * Issue #306 — the live GST and total while a bill is typed, with nothing stored.
 *
 * `POST /api/sales/estimate` takes the very input `POST /api/sales/preview` takes. These tests prove
 * the two can never disagree (random bills, checked head by head against the draft the review
 * stored), that estimating a hundred times leaves no draft, no audit entry, no stock held and no
 * number used, that what would stop a bill comes back as data, and that a viewer is refused.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { useFixedAppClock } from '../src/app-clock.ts';
import { apiRuntime } from '../src/runtime.ts';
import { stockEverything } from './stock-helper.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const DATE = '2026-09-28';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const signIn = async (email = 'owner@sampoorna.example.invalid', password = 'karobar-demo'): Promise<string> => {
  const response = await request('POST', '/api/auth/login', { companyId: SAMPOORNA, email, password });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.sessionId as string;
};

const internals = async (owner: string) => {
  const runtime = apiRuntime();
  const context = runtime.authenticate(`Bearer ${owner}`);
  const app = await runtime.application(context) as any;
  const companyId = runtime.actor(context).companyId;
  return {
    app,
    /** Everything an estimate could leave behind: bills and drafts, audit entries, stock holds and moves. */
    footprint: async () => ({
      bills: (await app.salesRepository.list(companyId)).length,
      // Reading Reports (for the bill numbers below) is itself audited; nothing else may be.
      audit: app.shop.audit.events.filter((event: any) => event.action !== 'reports.viewed').length,
      stock: JSON.stringify(app.shop.inventory.snapshot(), (_key, value) => (typeof value === 'bigint' ? String(value) : value instanceof Map ? [...value] : value)),
      numbers: ((await request('GET', '/api/reports', {}, owner)).body.sales.rows ?? []).map((row: any) => row.number).join(','),
    }),
  };
};

/** A small seeded generator, so a failing bill can be run again exactly. */
const random = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

const paise = (rupees: unknown): number => Math.round(Number(rupees) * 100);

let setUp: Promise<{ owner: string; customers: string[]; items: { id: string; unit: string }[] }> | null = null;

/** Customers in our own state, across a border, and unregistered in a third; items at every slab. */
const setUpCompany = () => setUp ??= (async () => {
  const owner = await signIn();
  const customers: string[] = [];
  for (const body of [
    { legalName: 'Estimate Mehta Supplies', registration: 'regular', gstin: '27AAACM1234K1ZN', line1: 'Plot 22, MIDC Bhosari', city: 'Pune', pincode: '411026' },
    { legalName: 'Estimate Counter Customer', registration: 'unregistered', stateCode: '29', line1: '12 MG Road', city: 'Bengaluru', pincode: '560001' },
    { legalName: 'Estimate Delhi Buyer', registration: 'unregistered', stateCode: '07', line1: '4 Chandni Chowk', city: 'Delhi', pincode: '110006' },
  ]) {
    const created = await request('POST', '/api/customers', body, owner);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    customers.push(created.body.customer.id);
  }
  const items: { id: string; unit: string }[] = [];
  for (const [name, hsnSac, unit, rate] of [
    ['Estimate Notebook', '48202000', 'PCS', '1200'], ['Estimate Shirt', '61091000', 'PCS', '500'],
    ['Estimate Rice', '10063020', 'KGS', '0'], ['Estimate Cement', '25232930', 'BAG', '2800'], ['Estimate Soap', '34011190', 'PCS', '1800'],
  ] as const) {
    const created = await request('POST', '/api/items', { name, kind: 'goods', hsnSac, unit, taxKind: 'taxable', ratePercentTimes100: rate }, owner);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    items.push({ id: created.body.item.id, unit });
  }
  await stockEverything(`Bearer ${owner}`);
  return { owner, customers, items };
})();

test('#306: for random bills the estimate is exactly the review, head by head', async () => {
  const { owner, customers, items } = await setUpCompany();
  const { app } = await internals(owner);
  const next = random(306);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const splits = new Set<string>();
  for (let run = 0; run < 40; run += 1) {
    const lines = Array.from({ length: 1 + Math.floor(next() * 4) }, () => {
      const item = pick(items);
      const quantity = item.unit === 'KGS' ? (1 + Math.floor(next() * 4000) / 100).toFixed(2) : String(1 + Math.floor(next() * 30));
      return { itemId: item.id, quantity, unit: item.unit, rate: (Math.floor(next() * 500000) / 100).toFixed(2) };
    });
    const input = {
      customerId: pick(customers), date: DATE, terms: '30', lines: JSON.stringify(lines),
      freight: next() < 0.5 ? '' : (Math.floor(next() * 300000) / 100).toFixed(2),
      otherCharges: next() < 0.7 ? '' : (Math.floor(next() * 50000) / 100).toFixed(2),
    };
    const estimate = await request('POST', '/api/sales/estimate', input, owner);
    assert.equal(estimate.status, 200, JSON.stringify(estimate.body));
    assert.deepEqual(estimate.body.refusals, [], JSON.stringify(input));
    const preview = await request('POST', '/api/sales/preview', { ...input, requestId: `estimate-306-${run}` }, owner);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const what = `run ${run}: ${JSON.stringify(input)}`;
    assert.equal(estimate.body.total, preview.body.amount, what);

    // Every head against the draft the review stored.
    const draft = await app.salesRepository.findById(app.config.companyId, preview.body.token);
    const totals = draft.pricing.totals;
    for (const head of ['taxableValue', 'cgst', 'sgst', 'utgst', 'igst', 'cess', 'totalTax', 'roundOff'] as const) {
      assert.equal(paise(estimate.body.totals[head]), Number(totals[head].minor), `${head} — ${what}`);
    }
    assert.equal(estimate.body.lines.length, draft.pricing.lines.length, what);
    draft.pricing.lines.forEach((line: any, index: number) => {
      const shown = estimate.body.lines[index];
      assert.equal(shown.lineId, line.lineId);
      for (const head of ['taxableValue', 'cgst', 'sgst', 'igst', 'cess', 'lineTotal'] as const) {
        assert.equal(paise(shown[head]), Number(line[head].minor), `line ${index} ${head} — ${what}`);
      }
    });
    splits.add(draft.pricing.split);
    assert.equal(estimate.body.placeOfSupply.stateCode, draft.pricing.placeOfSupplyStateCode, what);
    assert.match(estimate.body.placeOfSupply['en-IN'], draft.pricing.split === 'IGST' ? / sale · IGST$/ : / sale · CGST \+ SGST$/);
    assert.ok(estimate.body.placeOfSupply['hi-IN'].includes('ki bikri'));
    assert.ok(estimate.body.eInvoice['en-IN'] && estimate.body.eInvoice['hi-IN']);
  }
  assert.deepEqual([...splits].sort(), ['CGST_SGST', 'IGST'], 'both kinds of GST were tried');
});

test('#306: a hundred estimates leave no draft, no audit entry, no stock held and no number used', async () => {
  const { owner, customers, items } = await setUpCompany();
  const { footprint } = await internals(owner);
  const before = await footprint();
  for (let run = 0; run < 100; run += 1) {
    const body = {
      customerId: customers[run % customers.length], date: DATE, terms: '30',
      // Every tenth one asks for far more than is in the godown, so the check without a hold runs too.
      lines: JSON.stringify([{ itemId: items[run % items.length]!.id, quantity: run % 10 === 0 ? '99999999' : String(run + 1), rate: '120.50' }]),
      freight: run % 3 === 0 ? '250' : '',
    };
    const estimate = await request('POST', '/api/sales/estimate', body, owner);
    assert.equal(estimate.status, 200, JSON.stringify(estimate.body));
  }
  assert.deepEqual(await footprint(), before);
});

test('#306: what would stop the bill comes back as data, in both languages', async () => {
  const { owner, customers, items } = await setUpCompany();
  const soap = items.at(-1)!;
  const short = await request('POST', '/api/sales/estimate', {
    customerId: customers[0], date: DATE, lines: JSON.stringify([{ itemId: soap.id, quantity: '99999999', rate: '10' }]),
  }, owner);
  assert.equal(short.status, 200);
  assert.equal(short.body.ready, false);
  assert.equal(short.body.refusals[0].code, 'STOCK_NOT_ENOUGH');
  assert.equal(short.body.refusals[0].itemId, soap.id);
  assert.match(short.body.refusals[0]['en-IN'], /This bill asks for 99999999 PCS/);
  assert.match(short.body.refusals[0]['hi-IN'], /maangta hai/);
  assert.equal(typeof short.body.total, 'number', 'the figures are still shown beside the refusal');

  const nobody = await request('POST', '/api/sales/estimate', { date: DATE, lines: JSON.stringify([{ itemId: soap.id, quantity: '1', rate: '10' }]) }, owner);
  assert.equal(nobody.status, 200);
  assert.equal(nobody.body.total, null);
  assert.equal(nobody.body.refusals[0].code, 'CUSTOMER_REQUIRED');

  const tomorrow = await request('POST', '/api/sales/estimate', { customerId: customers[1], date: '2026-09-29', lines: JSON.stringify([{ itemId: soap.id, quantity: '1', rate: '10' }]) }, owner);
  assert.equal(tomorrow.status, 200);
  assert.equal(tomorrow.body.refusals[0].code, 'SALE_DATE_AFTER_TODAY');

  const ok = await request('POST', '/api/sales/estimate', { customerId: customers[1], date: DATE, lines: JSON.stringify([{ itemId: soap.id, quantity: '2', rate: '50' }]) }, owner);
  assert.equal(ok.body.ready, true);
  // 2 × ₹50 = ₹100, CGST 9% ₹9 + SGST 9% ₹9 = ₹118.
  assert.deepEqual([ok.body.totals.taxableValue, ok.body.totals.cgst, ok.body.totals.sgst, ok.body.total], [100, 9, 9, 118]);
  assert.equal(ok.body.placeOfSupply['en-IN'], 'Karnataka sale · CGST + SGST');
  assert.equal(ok.body.eInvoice.needed, 'NO');
  assert.deepEqual([ok.body.eInvoice['en-IN'], ok.body.eInvoice['hi-IN']], ['No e-invoice needed', 'E-invoice ki zaroorat nahin']);
});

test('#306: estimating needs the permission to start a bill — a viewer is refused', async () => {
  const { customers, items } = await setUpCompany();
  const viewer = await signIn('viewer@sampoorna.example.invalid', 'viewer-demo');
  const body = { customerId: customers[0], date: DATE, lines: JSON.stringify([{ itemId: items[0]!.id, quantity: '1', rate: '10' }]) };
  assert.equal((await request('POST', '/api/sales/estimate', body, viewer)).status, 403);
  assert.equal((await request('POST', '/api/sales/estimate', {}, viewer)).status, 403, 'refused before anything is read');
  assert.equal((await request('POST', '/api/sales/estimate', body)).status, 401);
});
