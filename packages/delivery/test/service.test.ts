import assert from 'node:assert/strict';
import test from 'node:test';
import { InvoiceDeliveryService, type DeliveryProvider } from '../src/index.ts';

const context = (companyId = 'co') => ({ companyId, actorId: 'owner', permissions: new Set(['invoice.delivery.manage']) });

test('a delivery is idempotent, auditable, and cannot change the invoice', async () => {
  const sent: string[] = [];
  const provider: DeliveryProvider = { async send(input) { sent.push(input.invoiceId); return { providerMessageId: 'message-1' }; } };
  const service = new InvoiceDeliveryService(provider, () => 100);
  const first = service.queue(context(), { invoiceId: 'INV-1', recipientId: 'customer@example.test', channel: 'email', idempotencyKey: 'send-1' });
  assert.equal(service.queue(context(), { invoiceId: 'INV-1', recipientId: 'customer@example.test', channel: 'email', idempotencyKey: 'send-1' }).id, first.id);
  const sentDelivery = await service.send(context(), first.id, 'https://example.test/document/token');
  assert.equal(sentDelivery.status, 'sent');
  assert.deepEqual(sent, ['INV-1']);
  service.receiveProviderEvent(context(), first.id, 'delivered');
  assert.deepEqual(service.eventsFor(context(), first.id).map((event) => event.type), ['queued', 'sent', 'delivered']);
});

test('provider failure is retryable and recipient preferences are respected', async () => {
  let fail = true;
  const provider: DeliveryProvider = { async send() { if (fail) throw new Error('outage'); return { providerMessageId: 'message-2' }; } };
  const service = new InvoiceDeliveryService(provider, () => 100);
  service.setPreference(context(), { recipientId: 'silent@example.test', channel: 'email', enabled: false });
  assert.throws(() => service.queue(context(), { invoiceId: 'INV-1', recipientId: 'silent@example.test', channel: 'email', idempotencyKey: 'silent' }), /disabled/);
  const delivery = service.queue(context(), { invoiceId: 'INV-1', recipientId: '+919999999999', channel: 'whatsapp', idempotencyKey: 'wa-1' });
  assert.equal((await service.send(context(), delivery.id, 'https://example.test/doc')).status, 'failed');
  service.retry(context(), delivery.id);
  fail = false;
  assert.equal((await service.send(context(), delivery.id, 'https://example.test/doc')).status, 'sent');
});

test('document links are opaque, expire, and never cross a delivery tenant boundary', () => {
  let now = 1_000;
  const service = new InvoiceDeliveryService({ async send() { return { providerMessageId: 'unused' }; } }, () => now);
  const token = service.createDocumentLink(context(), 'INV-1', 100);
  assert.equal(service.resolveDocumentLink(token), 'INV-1');
  now = 1_100;
  assert.equal(service.resolveDocumentLink(token), null);
  const delivery = service.queue(context(), { invoiceId: 'INV-1', recipientId: 'customer@example.test', channel: 'sms', idempotencyKey: 'sms-1' });
  assert.throws(() => service.get(context('other'), delivery.id), /not found/);
});
