import { validate } from 'src/config/env.validation';

describe('env validation', () => {
  function baseValid(): Record<string, string | undefined> {
    return {
      DATABASE_HOST: 'localhost',
      DATABASE_USER: 'cineva',
      DATABASE_PASSWORD: 'secret',
      DATABASE_NAME: 'cineva',
      REDIS_HOST: 'localhost',
      JWT_ACCESS_SECRET: 'a'.repeat(40),
      JWT_REFRESH_SECRET: 'b'.repeat(40),
      PORT: '3000',
      DATABASE_PORT: '5432',
      REDIS_PORT: '6379',
    };
  }

  it('throws when required keys are missing', () => {
    const env = baseValid();
    delete env.DATABASE_HOST;
    expect(() => validate(env)).toThrowError(/Missing required env var: DATABASE_HOST/);
  });

  it('coerces numeric keys from string to number', () => {
    const result = validate(baseValid());
    expect(result.PORT).toBe(3000);
    expect(typeof result.PORT).toBe('number');
    expect(result.DATABASE_PORT).toBe(5432);
    expect(result.REDIS_PORT).toBe(6379);
  });

  it('rejects non-numeric value in a numeric slot', () => {
    const env = baseValid();
    env.PORT = 'not-a-number';
    expect(() => validate(env)).toThrowError(/PORT must be numeric/);
  });

  it('coerces boolean keys', () => {
    const env = baseValid();
    env.DATABASE_SYNC = 'true';
    env.DATABASE_LOGGING = 'false';
    const result = validate(env);
    expect(result.DATABASE_SYNC).toBe(true);
    expect(result.DATABASE_LOGGING).toBe(false);
  });

  it('accepts "1" as boolean true', () => {
    const env = baseValid();
    env.DATABASE_SYNC = '1';
    expect(validate(env).DATABASE_SYNC).toBe(true);
  });

  it('accepts "yes" as boolean true (case-insensitive)', () => {
    const env = baseValid();
    env.DATABASE_SYNC = 'YES';
    expect(validate(env).DATABASE_SYNC).toBe(true);
  });

  it('does not enforce 32-char secret minimum outside production', () => {
    const env = baseValid();
    env.JWT_ACCESS_SECRET = 'short';
    expect(() => validate(env)).not.toThrow();
  });

  it('enforces 32-char JWT secret in production', () => {
    const env = baseValid();
    process.env.NODE_ENV = 'production';
    env.JWT_ACCESS_SECRET = 'short';
    expect(() => validate(env)).toThrowError(/JWT_ACCESS_SECRET must be at least 32 chars in production/);
    process.env.NODE_ENV = 'test';
  });

  it('preserves string values for non-coerced keys', () => {
    const env = baseValid();
    env.APP_NAME = 'Cineva';
    const result = validate(env);
    expect(result.APP_NAME).toBe('Cineva');
  });

  it('omits undefined values from the result', () => {
    const env = baseValid();
    env.APP_NAME = undefined;
    const result = validate(env) as Record<string, unknown>;
    expect(result.APP_NAME).toBeUndefined();
  });
});
