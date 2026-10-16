import { envSchema as DEFAULTS } from './env.defaults';
import { validate } from './env.validation';

/**
 * Build the configuration object the rest of the app consumes.
 * Values come from `process.env`; fallbacks come from `env.defaults`.
 */
export function configuration(): Record<string, string | number | boolean> {
  const raw: Record<string, string | undefined> = {};
  for (const key of Object.keys(DEFAULTS)) {
    raw[key] = process.env[key] ?? (DEFAULTS as Record<string, string>)[key];
  }
  return validate(raw);
}
