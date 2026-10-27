/**
 * Issue #350 — which routes are heavy work, and which call a service that costs money per call.
 * Heavy routes are limited per company per minute, by plan; paid ones also count against the
 * company's daily allowance and Karobar's daily spending cap for that service. A route listed here
 * that is not in the route table fails `apps/api/test/rate-limits.test.ts`.
 */
import type { PaidService } from '../../../../packages/platform/src/rate-limits.ts';

export const COSTS: Readonly<Record<string, { readonly paid?: PaidService }>> = {
  // Documents drawn by a browser on our side.
  'GET /api/sales/:invoice/pdf': {},
  'GET /api/eway/:invoice/pdf': {},
  'GET /api/returns/:note/pdf': {},
  // A month's GST worked out from every bill.
  'POST /api/gst-returns/prepare': {},
  'POST /api/gst-returns/export': {},
  'POST /api/itc/import': {},
  'POST /api/migration/analyse': {},
  // Government calls through the GSP (#26, #27, #29).
  'POST /api/einvoices/register': { paid: 'gsp' },
  'POST /api/einvoices/cancel': { paid: 'gsp' },
  'POST /api/eway/generate': { paid: 'gsp' },
  'POST /api/eway/extend': { paid: 'gsp' },
  'POST /api/eway/vehicle': { paid: 'gsp' },
  'POST /api/eway/cancel': { paid: 'gsp' },
  'POST /api/vehicles/record': { paid: 'gsp' },
  // The assistant (#34, #47): no language model is called yet, but it will be.
  'POST /api/assistant/ask': { paid: 'llm' },
  'POST /api/agent/plan': { paid: 'llm' },
  'POST /api/agent/execute': { paid: 'llm' },
};

export const costOf = (method: string, path: string) => COSTS[`${method} ${path}`];
