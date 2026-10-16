import * as bcrypt from 'bcrypt';
import type { Repository } from 'typeorm';
import IORedis from 'ioredis';
import { OtpService } from 'src/auth/services/otp.service';
import type { OtpChallengeEntity, OtpPurpose } from 'src/auth/entities/otp-challenge.entity';
import type { UserEntity } from 'src/auth/entities/user.entity';
import { BusinessError } from 'src/common/utils';
import { ERROR_CODES } from 'src/common/constants/error-codes';

/**
 * In-memory mocks for the two repositories OtpService depends on.
 * We avoid TypeORM entirely - just store rows in a Map.
 */
function makeMockChallengeRepo() {
  const rows: OtpChallengeEntity[] = [];
  const repo = {
    create: (entity: Partial<OtpChallengeEntity>) => ({ ...entity } as OtpChallengeEntity),
    save: jest.fn(async (entity: OtpChallengeEntity) => {
      const existing = rows.find((r) => r.id === entity.id);
      if (existing) Object.assign(existing, entity);
      else rows.push(entity);
      return entity;
    }),
    findOne: jest.fn(async ({ where }: { where: { phone: string; purpose: OtpPurpose } }) => {
      const matches = rows.filter(
        (r) => r.phone === where.phone && r.purpose === where.purpose,
      );
      return matches.length > 0 ? matches[matches.length - 1] : null;
    }),
    _rows: rows,
  } as unknown as Repository<OtpChallengeEntity> & { _rows: OtpChallengeEntity[] };
  return repo;
}

function makeMockUserRepo() {
  const rows: UserEntity[] = [];
  let nextId = 1;
  return {
    create: (entity: Partial<UserEntity>) =>
      ({ id: `mock-uid-${nextId++}`, ...entity } as UserEntity),
    save: jest.fn(async (entity: UserEntity) => {
      const existing = rows.find((r) => r.id === entity.id);
      if (existing) Object.assign(existing, entity);
      else rows.push(entity);
      return entity;
    }),
    findOne: jest.fn(async ({ where }: { where: { phone: string } }) =>
      rows.find((r) => r.phone === where.phone) ?? null,
    ),
    _rows: rows,
  } as unknown as Repository<UserEntity> & { _rows: UserEntity[] };
}

function makeMockRedis() {
  const store = new Map<string, string>();
  const ttlStore = new Map<string, number>();
  return {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    setex: jest.fn(async (key: string, ttl: number, value: string) => {
      store.set(key, value);
      ttlStore.set(key, ttl);
      return 'OK';
    }),
    incr: jest.fn(async (key: string) => {
      const n = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(n));
      return n;
    }),
    expire: jest.fn(async (key: string, ttl: number, mode: string) => {
      if (mode === 'NX' && ttlStore.has(key)) return 0;
      ttlStore.set(key, ttl);
      return 1;
    }),
    ttl: jest.fn(async (key: string) => ttlStore.get(key) ?? -2),
    _store: store,
  } as unknown as IORedis & {
    _store: Map<string, string>;
  };
}

function makeConfigStub() {
  return {
    get: (key: string, fallback?: unknown) => {
      const map: Record<string, unknown> = {
        OTP_TTL_SECONDS: 120,
        OTP_LENGTH: 6,
        OTP_MAX_ATTEMPTS: 5,
        OTP_RESEND_COOLDOWN_SECONDS: 60,
        OTP_RESEND_MAX_PER_HOUR: 5,
        OTP_DEV_FAKE_CODE: '111111',
        OTP_DEV_PRINT_TO_LOG: true, // surface devCode so we can assert it
      };
      return map[key] ?? fallback;
    },
  };
}

describe('OtpService', () => {
  let otp: OtpService;
  let challengeRepo: ReturnType<typeof makeMockChallengeRepo>;
  let userRepo: ReturnType<typeof makeMockUserRepo>;
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    challengeRepo = makeMockChallengeRepo();
    userRepo = makeMockUserRepo();
    redis = makeMockRedis();
    process.env.NODE_ENV = 'test';
    otp = new OtpService(
      challengeRepo,
      userRepo,
      makeConfigStub() as never,
      redis,
    );
  });

  describe('requestOtp', () => {
    it('creates a challenge and returns expiresIn', async () => {
      const result = await otp.requestOtp({ phone: '+989120000001' });
      expect(result.phone).toBe('+989120000001');
      expect(result.expiresIn).toBe(120);
      expect(result.devCode).toBe('111111'); // dev mode surfaces the fake code
    });

    it('stores the code as bcrypt hash (never plaintext)', async () => {
      await otp.requestOtp({ phone: '+989120000002' });
      const saved = challengeRepo._rows[0];
      expect(saved.codeHash).not.toBe('111111');
      // Bcrypt hash format: $2b$10$<22-char-salt><31-char-hash>
      expect(saved.codeHash).toMatch(/^\$2[ab]\$\d{2}\$.{53}$/);
      // Verify hash actually matches the dev fake code.
      expect(await bcrypt.compare('111111', saved.codeHash)).toBe(true);
    });

    it('sets expiresAt = now + ttl seconds (server-authoritative)', async () => {
      const before = Date.now();
      await otp.requestOtp({ phone: '+989120000003' });
      const saved = challengeRepo._rows[0];
      const after = Date.now();
      const minExpiry = before + 119 * 1000;
      const maxExpiry = after + 121 * 1000;
      expect(saved.expiresAt.getTime()).toBeGreaterThanOrEqual(minExpiry);
      expect(saved.expiresAt.getTime()).toBeLessThanOrEqual(maxExpiry);
    });

    it('rate-limits resend within cooldown window (PRD §NFR-05)', async () => {
      await otp.requestOtp({ phone: '+989120000004' });
      // Immediate second request should hit the cooldown check (Redis SETEX).
      // Our mock's ttl returns 60 (we set TTL=60 for cooldown).
      await expect(otp.requestOtp({ phone: '+989120000004' })).rejects.toThrow(
        /Please wait \d+s before requesting another OTP/,
      );
    });

    it('rate-limits resend hourly cap', async () => {
      // Simulate 5 prior resends in the sliding hour. OtpService uses
      // the raw key without the cineva: prefix because it accesses the
      // ioredis client directly.
      redis._store.set('otp-resend-hour:+989120000005', '5');
      await expect(otp.requestOtp({ phone: '+989120000005' })).rejects.toThrow(
        /Too many OTP requests/,
      );
    });

    it('returns devCode only in non-production mode', async () => {
      process.env.NODE_ENV = 'production';
      try {
        const result = await otp.requestOtp({ phone: '+989120000006' });
        expect(result.devCode).toBeUndefined();
      } finally {
        process.env.NODE_ENV = 'test';
      }
    });
  });

  describe('verifyOtp', () => {
    it('rejects when no challenge exists', async () => {
      await expect(
        otp.verifyOtp({ phone: '+989120000000', code: '111111' }),
      ).rejects.toThrow(/No active OTP challenge/);
    });

    it('succeeds on first valid code', async () => {
      await otp.requestOtp({ phone: '+989120000001' });
      const result = await otp.verifyOtp({ phone: '+989120000001', code: '111111' });
      expect(result.phone).toBe('+989120000001');
      const saved = challengeRepo._rows[0];
      expect(saved.consumedAt).toBeInstanceOf(Date);
      expect(saved.succeeded).toBe(true);
    });

    it('rejects a previously consumed challenge (one-time use, PRD §NFR-05)', async () => {
      await otp.requestOtp({ phone: '+989120000002' });
      await otp.verifyOtp({ phone: '+989120000002', code: '111111' });
      await expect(
        otp.verifyOtp({ phone: '+989120000002', code: '111111' }),
      ).rejects.toThrow(/OTP already consumed/);
    });

    it('rejects an expired challenge (PRD §NFR-05)', async () => {
      await otp.requestOtp({ phone: '+989120000003' });
      const saved = challengeRepo._rows[0];
      saved.expiresAt = new Date(Date.now() - 1000); // expired
      await expect(
        otp.verifyOtp({ phone: '+989120000003', code: '111111' }),
      ).rejects.toThrow(/OTP expired/);
    });

    it('increments attempts on wrong code', async () => {
      await otp.requestOtp({ phone: '+989120000004' });
      await expect(
        otp.verifyOtp({ phone: '+989120000004', code: '999999' }),
      ).rejects.toThrow(/Invalid OTP code; \d+ attempts left/);
      expect(challengeRepo._rows[0].attempts).toBe(1);
    });

    it('rejects after max attempts exceeded (PRD §NFR-05)', async () => {
      await otp.requestOtp({ phone: '+989120000005' });
      const saved = challengeRepo._rows[0];
      saved.attempts = 5; // at the limit
      await expect(
        otp.verifyOtp({ phone: '+989120000005', code: '111111' }),
      ).rejects.toThrow(/OTP max attempts exceeded/);
    });

    it('succeeds despite prior wrong attempts within budget', async () => {
      await otp.requestOtp({ phone: '+989120000006' });
      const saved = challengeRepo._rows[0];
      saved.attempts = 3;
      const result = await otp.verifyOtp({ phone: '+989120000006', code: '111111' });
      expect(result.phone).toBe('+989120000006');
    });
  });

  describe('ensureUserForPhone', () => {
    it('creates a User row on first sight', async () => {
      const user = await otp.ensureUserForPhone('+989120000001');
      expect(user.id).toBeDefined();
      expect(user.phone).toBe('+989120000001');
      expect(user.phoneVerifiedAt).toBeInstanceOf(Date);
      expect(user.role).toBe('customer');
      expect(user.status).toBe('Active');
    });

    it('sets phoneVerifiedAt on an existing user without it', async () => {
      // Pre-seed an unverified user.
      userRepo._rows.push({
        id: 'preexisting-id',
        phone: '+989120000002',
        phoneVerifiedAt: null,
        role: 'customer',
        status: 'Active',
        displayName: null,
        suspendedAt: null,
        suspendedReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as UserEntity);
      const user = await otp.ensureUserForPhone('+989120000002');
      expect(user.id).toBe('preexisting-id');
      expect(user.phoneVerifiedAt).toBeInstanceOf(Date);
    });

    it('returns existing verified user unchanged', async () => {
      const original = await otp.ensureUserForPhone('+989120000003');
      const before = original.phoneVerifiedAt;
      // Second call should not modify.
      const second = await otp.ensureUserForPhone('+989120000003');
      expect(second.id).toBe(original.id);
      expect(second.phoneVerifiedAt).toBe(before);
    });
  });
});
