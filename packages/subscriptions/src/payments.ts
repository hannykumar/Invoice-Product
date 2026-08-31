/**
 * Issue #42 [E42] — taking the money, behind a replaceable adapter.
 *
 * The provider sits behind #8's `ConnectorGateway`, so nothing in this package holds a provider SDK
 * or a credential, development runs on the mock, and a retry carries the same idempotency key the
 * first attempt did. A provider that fails is a fact about the provider: it moves the subscription
 * along its lifecycle and touches no business record.
 */
import type { ConnectorGateway } from '../../platform/src/index.ts';
import type { ChargeOutcome, ChargeRequest, PaymentProviderPort } from './ports.ts';

export const PAYMENTS_CONNECTOR = 'payments' as const;

export const connectorPaymentProvider = (gateway: ConnectorGateway): PaymentProviderPort => ({
  async charge(request: ChargeRequest): Promise<ChargeOutcome> {
    try {
      const response = await gateway.execute(PAYMENTS_CONNECTOR, {
        tenantId: request.companyId,
        operation: 'charge_subscription',
        // Only what the provider needs. No card, no account, no credential — the vault holds those.
        payload: { invoiceId: request.invoiceId, amountPaise: request.amountPaise.toString() },
        idempotencyKey: request.idempotencyKey,
        correlationId: request.correlationId,
      });
      return {
        providerReference: response.providerRequestId,
        state: response.status === 'completed' ? 'PAID' : 'PENDING',
        failureReason: null,
      };
    } catch (error) {
      return {
        providerReference: '',
        state: 'FAILED',
        failureReason: error instanceof Error && error.message !== ''
          ? error.message
          : 'The payment could not be taken. Nothing about your books has changed.',
      };
    }
  },
});

/** A provider that always succeeds, for a demo and for tests that are about something else. */
export const alwaysPays = (): PaymentProviderPort => ({
  async charge(request) {
    return { providerReference: `mock-${request.invoiceId}`, state: 'PAID', failureReason: null };
  },
});
