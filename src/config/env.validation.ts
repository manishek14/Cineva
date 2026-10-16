// Lightweight env validation without external Joi dependency.
// We add Joi later if validation needs become complex. For now,
// simple coercion + required checks are sufficient.

const REQUIRED_KEYS = [
  'DATABASE_HOST',
  'DATABASE_USER',
  'DATABASE_PASSWORD',
  'DATABASE_NAME',
  'REDIS_HOST',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
] as const;

const NUMERIC_KEYS = new Set([
  'PORT',
  'DATABASE_PORT',
  'DATABASE_POOL_SIZE',
  'REDIS_PORT',
  'REDIS_DB',
  'OTP_TTL_SECONDS',
  'OTP_LENGTH',
  'OTP_MAX_ATTEMPTS',
  'OTP_RESEND_COOLDOWN_SECONDS',
  'OTP_RESEND_MAX_PER_HOUR',
  'RESERVATION_HOLD_TTL_MINUTES',
  'CANCELLATION_MIN_MINUTES_BEFORE_SCREENING_FLOOR',
  'CANCELLATION_DEFAULT_PENALTY_PERCENT',
  'CANCELLATION_DEFAULT_REFUND_PERCENT',
  'PAYMENT_CALLBACK_TIMEOUT_MINUTES',
]);

const BOOLEAN_KEYS = new Set([
  'DATABASE_SYNC',
  'DATABASE_LOGGING',
  'CANCELLATION_DEFAULT_CUSTOMER_CANCEL_ALLOWED',
  'OTP_DEV_PRINT_TO_LOG',
]);

export type AppConfig = Record<string, string | number | boolean>;

export function validate(raw: Record<string, string | undefined>): AppConfig {
  const errors: string[] = [];

  for (const key of REQUIRED_KEYS) {
    if (!raw[key]) {
      errors.push(`Missing required env var: ${key}`);
    }
  }

  // Secrets must be at least 32 chars (avoid weak JWT secrets in prod).
  if (process.env.NODE_ENV === 'production') {
    if (raw.JWT_ACCESS_SECRET && raw.JWT_ACCESS_SECRET.length < 32) {
      errors.push('JWT_ACCESS_SECRET must be at least 32 chars in production');
    }
    if (raw.JWT_REFRESH_SECRET && raw.JWT_REFRESH_SECRET.length < 32) {
      errors.push('JWT_REFRESH_SECRET must be at least 32 chars in production');
    }
  }

  const out: AppConfig = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (NUMERIC_KEYS.has(key)) {
      const num = Number(value);
      if (Number.isNaN(num)) {
        errors.push(`${key} must be numeric, got "${value}"`);
      } else {
        out[key] = num;
        continue;
      }
    }
    if (BOOLEAN_KEYS.has(key)) {
      out[key] = ['true', '1', 'yes'].includes(value.toLowerCase());
      continue;
    }
    out[key] = value;
  }

  if (errors.length > 0) {
    throw new Error(`Environment validation failed:\n  - ${errors.join('\n  - ')}`);
  }
  return out;
}
