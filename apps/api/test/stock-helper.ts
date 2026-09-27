/**
 * Issue #229 — test glue for the many tests that are about a bill, not about stock.
 *
 * A sale now takes its goods out of the godown and is refused when they are not there. Tests that
 * check how a bill is taxed, printed or sent sell goods nobody bought first, so before each sale
 * they call this, which enters a large opening count of every goods item the business keeps. The
 * stock rules themselves are proved in `sale-stock.test.ts`, which never calls it.
 */
import { money, quantityFromString } from '@invoice/kernel';
import { items } from '../src/catalogue-application.ts';
import { apiRuntime } from '../src/runtime.ts';

let topUps = 0;

export const stockEverything = async (authorization: string | undefined): Promise<void> => {
  if (authorization === undefined) return;
  const runtime = apiRuntime();
  let context;
  try {
    context = runtime.authenticate(authorization);
  } catch {
    return; // not signed in: the request will be refused on its own, which is what it tests
  }
  const actor = runtime.actor(context);
  const app = await runtime.application(context);
  topUps += 1;
  for (const item of items(context.companyId)) {
    if (item.kind !== 'goods') continue;
    await app.recordOpeningStock(actor, {
      idempotencyKey: `test-opening:${item.id}:${topUps}`,
      itemId: item.id,
      quantity: quantityFromString('100000', item.baseUnit),
      unitCost: money(1_00n),
    });
  }
};

const SELLING = new Set(['/api/sales/preview', '/api/sales/record', '/api/presale/convert', '/api/presale/issue-sale']);

/** True for the requests that make or issue a bill of goods. */
export const sells = (method: string, path: string): boolean => method === 'POST' && SELLING.has(path);
