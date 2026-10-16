/**
 * PaymentProvider contract.
 *
 * Any payment gateway (Zarinpal, Mock, future Stripe/Saman) implements
 * this interface. The PaymentService uses the configured provider via
 * dependency injection - swapping providers is a config change, not
 * code change (PRD §1: "درگاه آزمایشی با قرارداد قابل جایگزینی").
 */
export interface PaymentProviderPort {
  /** Stable identifier; persisted in Payment.provider column. */
  readonly name: string;

  /**
   * Initiate a payment at the gateway. Returns the URL the customer
   * must be redirected to, plus an authority token to track the session.
   */
  initiate(args: {
    paymentId: string;
    amount: number;
    currency: string;
    description: string;
    callbackUrl: string;
    mobile?: string;
  }): Promise<{
    authority: string;
    redirectUrl: string;
    rawResponse?: unknown;
  }>;

  /**
   * Verify a payment at the gateway (server-to-server).
   * Must be idempotent - calling twice with the same authority must
   * return the same outcome (PRD §FR-06).
   */
  verify(args: {
    authority: string;
    amount: number;
    status: string;
  }): Promise<{
    succeeded: boolean;
    providerReference?: string;
    failureReason?: string;
    rawResponse?: unknown;
  }>;
}

/**
 * Symbol used as the DI token for the active PaymentProvider.
 * The actual provider is selected by PAYMENT_PROVIDER env.
 */
export const PAYMENT_PROVIDER_TOKEN = 'PAYMENT_PROVIDER';
