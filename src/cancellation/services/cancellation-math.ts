/**
 * Pure functions extracted from CancellationService for testability.
 * These mirror the exact formulas used in CancellationService.cancelReservation:
 *
 *   refundable = floor(amount * refundPercent / 100)
 *   penalty = amount - refundable
 *   netRefund = max(0, refundable - sideFee)
 *
 * Keeping these pure lets us unit-test the math without spinning up
 * Postgres + Redis + the full NestJS context.
 */

export function computeRefundableAmount(totalAmount: number, refundPercent: number): number {
  if (refundPercent < 0 || refundPercent > 100) {
    throw new Error(`refundPercent must be 0..100, got ${refundPercent}`);
  }
  if (totalAmount < 0) {
    throw new Error(`totalAmount must be >= 0, got ${totalAmount}`);
  }
  return Math.floor((totalAmount * refundPercent) / 100);
}

export function computePenaltyAmount(totalAmount: number, refundableAmount: number): number {
  if (refundableAmount > totalAmount) {
    throw new Error('refundableAmount cannot exceed totalAmount');
  }
  return totalAmount - refundableAmount;
}

export function computeNetRefund(refundableAmount: number, sideFee: number): number {
  if (sideFee < 0) {
    throw new Error(`sideFee must be >= 0, got ${sideFee}`);
  }
  return Math.max(0, refundableAmount - sideFee);
}

export function computeMinutesToStart(startsAt: Date, now: Date): number {
  return (startsAt.getTime() - now.getTime()) / 60000;
}

export function canCancelWithinPolicy(
  minutesToStart: number,
  minMinutesBeforeScreening: number,
  customerCancelAllowed: boolean,
): { allowed: boolean; reason?: string } {
  if (!customerCancelAllowed) {
    return { allowed: false, reason: 'Customer cancellation is disabled by policy' };
  }
  if (minutesToStart < minMinutesBeforeScreening) {
    return {
      allowed: false,
      reason: `Cancellation not allowed within ${minMinutesBeforeScreening}min of start (only ${minutesToStart.toFixed(0)}min remaining)`,
    };
  }
  return { allowed: true };
}
