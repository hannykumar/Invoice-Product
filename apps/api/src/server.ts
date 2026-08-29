import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DomainError } from '@invoice/kernel';
import { PlatformError } from '../../../packages/platform/src/index.ts';
import { apiRuntime, AuthenticationError } from './runtime.ts';
import { finishOnboarding, previewOnboarding } from './onboarding-application.ts';
import { DemoApplication } from './demo-application.ts';

const json = (status: number, body: unknown) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(body, (_key, value) => typeof value === 'bigint' ? value.toString() : value) });

export interface ApiResult { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string; }

const statusOf = (error: unknown): number => {
  if (error instanceof AuthenticationError) return 401;
  if (error instanceof DomainError) {
    if (error.kind === 'FORBIDDEN') return 403;
    if (error.kind === 'NOT_FOUND') return 404;
    if (error.kind === 'CONFLICT' || error.kind === 'NOT_ALLOWED') return 409;
    return 422;
  }
  if (error instanceof PlatformError) {
    if (error.code === 'FORBIDDEN') return 403;
    if (error.code === 'NOT_FOUND' || error.code === 'TENANT_ISOLATION') return 404;
    if (error.code === 'SESSION_EXPIRED' || error.code === 'SESSION_REVOKED') return 401;
    return 409;
  }
  return 400;
};

export async function handleApi(method: string, pathname: string, body: Record<string, unknown> = {}, authorization?: string): Promise<ApiResult> {
  try {
    const runtime = apiRuntime();
    if (method === 'POST' && pathname === '/api/auth/login') return json(200, runtime.signIn(body));
    const context = runtime.authenticate(authorization);
    const actor = runtime.actor(context);
    const app = await runtime.application(context);
    if (method === 'GET' && pathname === '/api/session') return json(200, { company: runtime.companySummary(context.companyId), userId: context.actorId, permissions: [...context.permissions] });
    if (method === 'GET' && pathname === '/api/dashboard') return json(200, await app.dashboard(actor));
    if (method === 'GET' && pathname === '/api/reports') return json(200, await app.reports(actor));
    // Setting up a business runs against its own fresh company, so it needs a signed-in session but
    // not the session's company. Gated by authentication above, like the rest of the app.
    if (method === 'POST' && pathname === '/api/onboarding/preview') return json(200, await previewOnboarding(body));
    if (method === 'POST' && pathname === '/api/onboarding/finish') return json(200, await finishOnboarding(body));
    // Issue #26 — does this bill need an IRN, and its life with the government.
    if (method === 'GET' && pathname === '/api/einvoices/invoices') return json(200, await app.issuedInvoices(actor));
    if (method === 'POST' && pathname === '/api/einvoices/preview') return json(200, await app.previewEInvoice(actor, body));
    if (method === 'POST' && pathname === '/api/einvoices/register') return json(200, await app.registerEInvoice(actor, body));
    if (method === 'POST' && pathname === '/api/einvoices/reconcile') return json(200, await app.reconcileEInvoice(actor, body));
    if (method === 'POST' && pathname === '/api/einvoices/cancel') return json(200, await app.cancelEInvoice(actor, body));
    if (method === 'POST' && pathname === '/api/einvoices/offline') return json(200, await app.eInvoiceOfflineJson(actor, body));
    // Issue #19 — what we know about a supplier, and the evidence behind each warning.
    if (method === 'GET' && pathname === '/api/suppliers/choices') return json(200, { choices: DemoApplication.supplierChoices() });
    if (method === 'POST' && pathname === '/api/suppliers/check') return json(200, await app.checkSupplier(actor, body));
    if (method === 'POST' && pathname === '/api/suppliers/check/acknowledge') return json(200, await app.acknowledgeSupplierRisk(actor, body));
    // Issue #18 — the order, the delivery and the comparison between them and the bill.
    if (method === 'POST' && pathname === '/api/purchase-orders') return json(200, await app.recordOrder(actor, body));
    if (method === 'POST' && pathname === '/api/goods-receipts') return json(200, await app.recordReceipt(actor, body));
    if (method === 'POST' && pathname === '/api/purchases/match') return json(200, await app.matchPurchaseBill(actor, body));
    if (method === 'POST' && pathname === '/api/purchases/match/approve') return json(200, await app.approvePurchaseMatch(actor, body));
    const purchaseMatch = /^\/api\/purchases\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && purchaseMatch?.[1] !== undefined) return json(200, await app.purchase(actor, decodeURIComponent(purchaseMatch[1])));
    if (method === 'POST' && pathname === '/api/purchases/preview') return json(200, app.previewPurchase(actor, body));
    if (method === 'POST' && pathname === '/api/purchases/record') return json(200, await app.recordPurchase(actor, body));
    if (method === 'POST' && pathname === '/api/sales/preview') return json(200, await app.previewSale(actor, body));
    if (method === 'POST' && pathname === '/api/sales/record') return json(200, await app.recordSale(actor, body));
    if (method === 'POST' && pathname === '/api/payments/preview') return json(200, await app.previewPayment(actor, body));
    if (method === 'POST' && pathname === '/api/payments/record') return json(200, await app.recordPayment(actor, body));
    return json(404, { state: 'failed', title: 'Not found', message: 'That API route does not exist. Nothing was saved.' });
  } catch (error) {
    return json(statusOf(error), {
      state: 'failed',
      title: error instanceof AuthenticationError ? 'Sign in required' : 'Nothing was saved',
      code: error instanceof DomainError || error instanceof PlatformError ? error.code : undefined,
      message: error instanceof Error ? error.message : 'The request could not be completed.',
    });
  }
}

const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
};

export async function serveApi(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  let body: Record<string, unknown> = {};
  try { body = await readBody(request); }
  catch { const result = json(400, { state: 'failed', title: 'Nothing was saved', message: 'The request body is not valid JSON.' }); response.writeHead(result.status, result.headers); response.end(result.body); return; }
  const result = await handleApi(request.method ?? 'GET', url.pathname, body, request.headers.authorization);
  response.writeHead(result.status, result.headers);
  response.end(result.body);
}

export const apiServer = createServer(serveApi);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.API_PORT ?? 4172);
  apiServer.listen(port, '127.0.0.1', () => console.log(`Karobar API: http://127.0.0.1:${port}`));
}
