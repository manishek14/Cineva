/**
 * Redis key namespace prefixes used across Cineva.
 * The actual prefix string is built by RedisService by prepending
 * the global REDIS_KEY_PREFIX env (default "cineva:").
 *
 * Key naming conventions:
 *   - Reservation hold: seat-hold:{screeningId}:{seatId} -> JSON({ reservationId, ownerToken, expiresAt })
 *   - Reservation hold index: res-holds:{reservationId} -> SET of seatIds held by a reservation
 *   - OTP rate limit: otp-rate:{phone} -> counter
 *   - OTP resend cooldown: otp-cool:{phone} -> 1 with TTL
 *   - JWT refresh allowlist: auth:refresh:{userId}:{tokenId} -> 1 with TTL
 *   - JWT refresh blacklist: auth:refresh-bl:{tokenId} -> 1 with TTL (until natural expiry)
 *   - Payment idempotency: pay:idem:{key} -> JSON({ result, expiresAt })
 */
export const REDIS_KEYS = {
  RESERVATION_HOLD: 'seat-hold',
  RESERVATION_HOLDS: 'res-holds',
  SCREENING_CACHE: 'screening-cache',
  MOVIE_CACHE: 'movie-cache',
  OTP_RATE: 'otp-rate',
  OTP_COOLDOWN: 'otp-cool',
  OTP_RESEND_HOURLY: 'otp-resend-hour',
  OTP_CHALLENGE: 'otp-challenge',
  JWT_REFRESH: 'auth:refresh',
  JWT_REFRESH_BLACKLIST: 'auth:refresh-bl',
  PAYMENT_IDEMPOTENCY: 'pay:idem',
  RESERVATION_LOCK: 'res-lock',
  SCREENING_LOCK: 'screening-lock',
} as const;

export const REDIS_TOKEN = 'REDIS_CLIENT';
