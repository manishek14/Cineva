/**
 * BullMQ queue names + job IDs. Used by ReservationService (for triggering
 * expiry jobs) and the processors in this module (for consuming them).
 */
export const QUEUES = {
  RESERVATION_EXPIRY: 'reservation-expiry',
  PAYMENT_CALLBACK_TIMEOUT: 'payment-callback-timeout',
  RECONCILIATION: 'reconciliation',
  OUTBOX_DISPATCH: 'outbox-dispatch',
} as const;

/**
 * Job data shapes - shared between producer (ReservationService) and
 * consumer (ReservationExpiryProcessor).
 */
export interface ReservationExpiryJobData {
  reservationId: string;
  expiresAt: string; // ISO; the job is scheduled to fire at this time
}

export interface ReconciliationJobData {
  // no payload - this job runs periodically and scans for stale rows
  scope: 'all';
}

export interface PaymentCallbackTimeoutJobData {
  paymentId: string;
  initiatedAt: string;
}
