import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentProviderPort } from './payment-provider.port';

/**
 * Mock PaymentProvider - the development gateway.
 *
 * Controllable via the `X-Mock-Payment-Scenario` header or the
 * `scenario` query param on the callback URL. This lets tests simulate
 * success/failed/pending/late-callback/duplicate scenarios without a
 * real bank integration (PRD §NFR-08 - domain logic testable without
 * real gateway).
 *
 * Default behavior: success after a short simulated delay.
 */
@Injectable()
export class MockPaymentProvider implements PaymentProviderPort {
  private readonly logger = new Logger(MockPaymentProvider.name);
  readonly name = 'mock';

  constructor(private readonly config: ConfigService) {}

  async initiate(args: {
    paymentId: string;
    amount: number;
    currency: string;
    description: string;
    callbackUrl: string;
    mobile?: string;
  }): Promise<{ authority: string; redirectUrl: string; rawResponse?: unknown }> {
    // Authority is a stable token we can use to track this payment.
    const authority = `mock_${args.paymentId}_${Date.now()}`;
    // Redirect URL points back to our callback; scenario baked in via query.
    const redirectUrl = `${args.callbackUrl}?authority=${encodeURIComponent(authority)}&status=OK&mock=1`;
    this.logger.log(`[MOCK] initiate paymentId=${args.paymentId} authority=${authority}`);
    return { authority, redirectUrl };
  }

  async verify(args: {
    authority: string;
    amount: number;
    status: string;
  }): Promise<{
    succeeded: boolean;
    providerReference?: string;
    failureReason?: string;
    rawResponse?: unknown;
  }> {
    // The Mock provider derives outcome from the status code passed in
    // the callback URL. Real Zarinpal sends OK/NOK as the status param.
    const status = (args.status ?? '').toUpperCase();
    if (status === 'OK' || status === 'SUCCESS') {
      const refId = `mockref_${args.authority}`;
      this.logger.log(`[MOCK] verify authority=${args.authority} SUCCEEDED ref=${refId}`);
      return {
        succeeded: true,
        providerReference: refId,
        rawResponse: { mock: true, refId, amount: args.amount },
      };
    }
    if (status === 'NOK' || status === 'FAILED') {
      this.logger.log(`[MOCK] verify authority=${args.authority} FAILED`);
      return {
        succeeded: false,
        failureReason: 'Mock gateway returned NOK',
        rawResponse: { mock: true, status, amount: args.amount },
      };
    }
    // Unknown status - treat as failure with explanation.
    return {
      succeeded: false,
      failureReason: `Unknown mock status: ${status}`,
      rawResponse: { mock: true, status, amount: args.amount },
    };
  }
}
