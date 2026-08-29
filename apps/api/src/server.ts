import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoApplication } from './demo-application.ts';

const json = (status: number, body: unknown) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(body, (_key, value) => typeof value === 'bigint' ? value.toString() : value) });

export interface ApiResult { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string; }

export async function handleApi(method: string, pathname: string, body: Record<string, unknown> = {}): Promise<ApiResult> {
  try {
    const app = await demoApplication();
    if (method === 'GET' && pathname === '/api/dashboard') return json(200, await app.dashboard());
    if (method === 'POST' && pathname === '/api/purchases/preview') return json(200, app.previewPurchase(body));
    if (method === 'POST' && pathname === '/api/purchases/record') return json(200, await app.recordPurchase(body));
    if (method === 'POST' && pathname === '/api/sales/preview') return json(200, await app.previewSale(body));
    if (method === 'POST' && pathname === '/api/sales/record') return json(200, await app.recordSale(body));
    if (method === 'POST' && pathname === '/api/payments/preview') return json(200, await app.previewPayment(body));
    if (method === 'POST' && pathname === '/api/payments/record') return json(200, await app.recordPayment(body));
    return json(404, { state: 'failed', title: 'Not found', message: 'That API route does not exist. Nothing was saved.' });
  } catch (error) {
    return json(400, { state: 'failed', title: 'Nothing was saved', message: error instanceof Error ? error.message : 'The request could not be completed.' });
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
  const result = await handleApi(request.method ?? 'GET', url.pathname, await readBody(request));
  response.writeHead(result.status, result.headers);
  response.end(result.body);
}

export const apiServer = createServer(serveApi);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.API_PORT ?? 4172);
  apiServer.listen(port, '127.0.0.1', () => console.log(`Karobar API: http://127.0.0.1:${port}`));
}
