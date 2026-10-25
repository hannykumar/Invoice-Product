/**
 * Issue #389 — where the running app's callback secrets come from, and what happens without one.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { configureGovernmentWebhooks, DEVELOPMENT_WEBHOOK_SECRET, governmentWebhookSecrets } from '../src/government-webhooks.ts';
import { redactSecretText } from '../../../packages/platform/src/credentials.ts';

const LIVE_IRP = 'irp-live-389';
const production = { NODE_ENV: 'production', GOVERNMENT_WEBHOOK_SECRET_IRP: LIVE_IRP };

test('outside development a connector without a secret refuses every callback, and start-up says so', async () => {
  const secrets = governmentWebhookSecrets(production);
  assert.deepEqual(await secrets.webhookSecrets('irp'), [LIVE_IRP]);
  // The publicly known development secret is never used here.
  assert.deepEqual(await secrets.webhookSecrets('gst'), []);
  assert.deepEqual(secrets.missing, ['eway_bill', 'gst']);
  const warnings: string[] = [];
  configureGovernmentWebhooks(null, production, (message) => warnings.push(message));
  assert.match(warnings.join('\n'), /GOVERNMENT_WEBHOOK_SECRET_EWAY_BILL, GOVERNMENT_WEBHOOK_SECRET_GST/);
});

test('in development a connector without a secret uses the development one; a set secret wins and is redacted', async () => {
  const secrets = governmentWebhookSecrets({ NODE_ENV: 'development', GOVERNMENT_WEBHOOK_SECRET_GST: 'old-gst-389, new-gst-389' });
  assert.deepEqual(await secrets.webhookSecrets('irp'), [DEVELOPMENT_WEBHOOK_SECRET]);
  assert.deepEqual(await secrets.webhookSecrets('gst'), ['old-gst-389', 'new-gst-389']);
  assert.deepEqual(secrets.missing, []);
  assert.equal(redactSecretText('secret new-gst-389 leaked'), 'secret [REDACTED] leaked');
});
