import assert from 'node:assert/strict';
import test from 'node:test';
import { InvoiceDeliveryService, type DeliveryProvider } from '../src/index.ts';

const context = (companyId = 'co') => ({ companyId, actorId: 'owner', permissions: new Set(['invoice.delivery.manage']) });
const pdf = async () => ({ filename: 'INV-1.pdf', bytes: Buffer.from('%PDF-1.7\ntest') });

test('a delivery is idempotent, auditable, and cannot change the invoice', async () => {
  const sent: string[] = [];
  const provider: DeliveryProvider = { async send(input) { sent.push(input.invoiceId); assert.equal(input.attachment?.contentType, 'application/pdf'); assert.equal(input.attachment?.bytes.toString(), '%PDF-1.7\ntest'); return { providerMessageId: 'message-1' }; } };
  const service = new InvoiceDeliveryService(provider, pdf, () => 100);
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
  const provider: DeliveryProvider = { async send(input) { assert.equal(input.attachment?.contentType, 'application/pdf'); if (fail) throw new Error('outage'); return { providerMessageId: 'message-2' }; } };
  const service = new InvoiceDeliveryService(provider, pdf, () => 100);
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
  const service = new InvoiceDeliveryService({ async send() { return { providerMessageId: 'unused' }; } }, pdf, () => now);
  const token = service.createDocumentLink(context(), 'INV-1', 100);
  assert.equal(service.resolveDocumentLink(token), 'INV-1');
  now = 1_100;
  assert.equal(service.resolveDocumentLink(token), null);
  const delivery = service.queue(context(), { invoiceId: 'INV-1', recipientId: 'customer@example.test', channel: 'sms', idempotencyKey: 'sms-1' });
  assert.throws(() => service.get(context('other'), delivery.id), /not found/);
});

test('SMS retains its link and a missing PDF fails before the provider sends', async () => {
  let calls = 0;
  const service = new InvoiceDeliveryService({ async send(input) { calls++; assert.equal(input.attachment, undefined); return { providerMessageId: 'sms' }; } }, async () => { throw new Error('PDF unavailable'); });
  const sms = service.queue(context(), { invoiceId: 'INV-1', recipientId: '+919999999999', channel: 'sms', idempotencyKey: 'sms' });
  assert.equal((await service.send(context(), sms.id, 'https://example.test/doc')).status, 'sent');
  const email = service.queue(context(), { invoiceId: 'INV-1', recipientId: 'a@example.test', channel: 'email', idempotencyKey: 'mail' });
  assert.equal((await service.send(context(), email.id, 'https://example.test/doc')).status, 'failed');
  assert.equal(calls, 1);
});
