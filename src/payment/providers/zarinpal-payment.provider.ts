import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentProviderPort } from './payment-provider.port';

/**
 * Zarinpal PaymentProvider adapter - calls the real Zarinpal API.
 *
 * Endpoints:
 *   - Initiate: POST https://api.zarinpal.com/pg/v1/payment/request.json
 *   - Verify:  POST https://api.zarinpal.com/pg/v1/payment/verify.json
 *   - Redirect: https://payment.zarinpal.com/pg/StartPay/{authority}
 *   - Callback: caller-supplied URL receives {authority, status}
 *
 * Production-ready except for error retries; this commit ships the
 * happy path. More sophisticated retry/backoff will be added later.
 *
 * PRD §1: "درگاه آزمایشی با قرارداد قابل جایگزینی" - this adapter
 * plugs into the same PaymentProviderPort as the Mock, so the
 * PAYMENT_PROVIDER env var controls which is active.
 */
@Injectable()
export class ZarinpalPaymentProvider implements PaymentProviderPort {
  private readonly logger = new Logger(ZarinpalPaymentProvider.name);
  readonly name = 'zarinpal';

  private readonly merchantId: string;
  private readonly requestUrl: string;
  private readonly verifyUrl: string;
  private readonly startPayUrl: string;
  private readonly callbackUrl: string;

  constructor(private readonly config: ConfigService) {
    this.merchantId = this.config.get<string>('ZARINPAL_MERCHANT_ID', '');
    this.requestUrl = this.config.get<string>(
      'ZARINPAL_REQUEST_URL',
      'https://api.zarinpal.com/pg/v1/payment/request.json',
    );
    this.verifyUrl = this.config.get<string>(
      'ZARINPAL_VERIFY_URL',
      'https://api.zarinpal.com/pg/v1/payment/verify.json',
    );
    this.startPayUrl = this.config.get<string>(
      'ZARINPAL_START_PAY_URL',
      'https://payment.zarinpal.com/pg/StartPay/',
    );
    this.callbackUrl = this.config.get<string>(
      'ZARINPAL_CALLBACK_URL',
      'http://localhost:3000/api/v1/payment/callback/zarinpal',
    );
    if (!this.merchantId) {
      this.logger.warn('ZARINPAL_MERCHANT_ID not set; Zarinpal calls will fail.');
    }
  }

  async initiate(args: {
    paymentId: string;
    amount: number;
    currency: string;
    description: string;
    mobile?: string;
  }): Promise<{ authority: string; redirectUrl: string; rawResponse?: unknown }> {
    // Zarinpal only accepts IRR (Iranian Rial, not Toman).
    const amountRial = args.currency === 'IRR' ? args.amount : args.amount * 10;

    const body = {
      merchant_id: this.merchantId,
      amount: amountRial,
      description: args.description.slice(0, 255),
      callback_url: `${this.callbackUrl}?paymentId=${args.paymentId}`,
      metadata: { paymentId: args.paymentId, ...(args.mobile ? { mobile: args.mobile } : {}) },
    };

    const resp = await fetch(this.requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = (await resp.json()) as {
      data?: { authority?: string; code?: number | string };
      errors?: { message?: string; code?: number }[];
    };

    if (!resp.ok || !data.data?.authority) {
      const err = data.errors?.[0]?.message ?? `HTTP ${resp.status}`;
      this.logger.error(`Zarinpal initiate failed: ${err}`);
      throw new Error(`Zarinpal initiate failed: ${err}`);
    }

    const authority = data.data.authority;
    const redirectUrl = `${this.startPayUrl}${authority}`;
    return { authority, redirectUrl, rawResponse: data };
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
    // Zarinpal's customer-facing status: "OK" means user authorized,
    // "NOK" means user cancelled. Either way, server-to-server verify
    // is the source of truth.
    if (args.status !== 'OK') {
      return {
        succeeded: false,
        failureReason: `User did not authorize (status=${args.status})`,
      };
    }

    const amountRial = args.amount; // assume currency already IRR
    const body = { merchant_id: this.merchantId, authority: args.authority, amount: amountRial };
    const resp = await fetch(this.verifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await resp.json()) as {
      data?: { ref_id?: number | string; code?: number | string };
      errors?: { message?: string; code?: number }[];
    };

    if (resp.ok && data.data?.ref_id) {
      return {
        succeeded: true,
        providerReference: String(data.data.ref_id),
        rawResponse: data,
      };
    }
    return {
      succeeded: false,
      failureReason: data.errors?.[0]?.message ?? `HTTP ${resp.status}`,
      rawResponse: data,
    };
  }
}
