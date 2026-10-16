// Global test setup. Runs before each test file.
// Sets sane defaults for env vars so config validation doesn't fail
// in unit tests that don't explicitly set their own env.

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test_access_secret_at_least_32_chars_long';
process.env.JWT_REFRESH_SECRET = 'test_refresh_secret_at_least_32_chars_long';
process.env.JWT_ACCESS_TTL = '15m';
process.env.JWT_REFRESH_TTL = '7d';
process.env.DATABASE_HOST = 'localhost';
process.env.DATABASE_PORT = '5432';
process.env.DATABASE_USER = 'cineva_test';
process.env.DATABASE_PASSWORD = 'cineva_test';
process.env.DATABASE_NAME = 'cineva_test';
process.env.REDIS_HOST = 'localhost';
process.env.REDIS_PORT = '6379';
process.env.OTP_DEV_FAKE_CODE = '111111';
process.env.OTP_DEV_PRINT_TO_LOG = 'false';
process.env.PAYMENT_PROVIDER = 'mock';

// Suppress noisy logs during tests.
const originalConsole = console.log;
if (!process.env.CINEVA_TEST_VERBOSE) {
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[')) return; // suppress [DEV OTP] etc.
    originalConsole(...args);
  };
}
