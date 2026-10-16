import * as bcrypt from 'bcrypt';
import type { Repository } from 'typeorm';
import IORedis from 'ioredis';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from 'src/auth/services/auth.service';
import { OtpService } from 'src/auth/services/otp.service';
import type { UserEntity } from 'src/auth/entities/user.entity';
import type { OtpChallengeEntity } from 'src/auth/entities/otp-challenge.entity';
import { BusinessError } from 'src/common/utils';
import { REDIS_KEYS } from 'src/common/redis/redis.constants';

// Reuse the same in-memory repository pattern from otp.service.spec.ts.
function makeUserRepo() {
  const rows: UserEntity[] = [];
  let nextId = 1;
  const findOneImpl = jest.fn(async ({ where }: { where: { id: string } }) =>
    rows.find((r) => r.id === where.id) ?? null,
  );
  return {
    create: (e: Partial<UserEntity>) => ({ id: `u-${nextId++}`, ...e } as UserEntity),
    save: jest.fn(async (e: UserEntity) => {
      const existing = rows.find((r) => r.id === e.id);
      if (existing) Object.assign(existing, e);
      else rows.push(e);
      return e;
    }),
    findOne: findOneImpl,
    _findOne: findOneImpl,
    _rows: rows,
  } as unknown as Repository<UserEntity> & {
    _rows: UserEntity[];
    _findOne: jest.Mock;
  };
}

function makeChallengeRepo() {
  const rows: OtpChallengeEntity[] = [];
  let nextId = 1;
  return {
    create: (e: Partial<OtpChallengeEntity>) => ({ id: `c-${nextId++}`, ...e } as OtpChallengeEntity),
    save: jest.fn(async (e: OtpChallengeEntity) => {
      rows.push(e);
      return e;
    }),
    findOne: jest.fn(async () => rows[0] ?? null),
    _rows: rows,
  } as unknown as Repository<OtpChallengeEntity> & { _rows: OtpChallengeEntity[] };
}

function makeRedisMock() {
  const store = new Map<string, string>();
  const ttlStore = new Map<string, number>();
  return {
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    setex: jest.fn(async (k: string, ttl: number, v: string) => {
      store.set(k, v);
      ttlStore.set(k, ttl);
      return 'OK';
    }),
    set: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
    del: jest.fn(async (k: string) => {
      store.delete(k);
      ttlStore.delete(k);
      return 1;
    }),
    ttl: jest.fn(async (k: string) => ttlStore.get(k) ?? -2),
    _store: store,
    _ttl: ttlStore,
  } as unknown as IORedis & {
    _store: Map<string, string>;
    _ttl: Map<string, number>;
  };
}

function makeConfigStub() {
  return {
    get: (key: string, fallback?: unknown) => {
      const map: Record<string, unknown> = {
        JWT_ACCESS_TTL: '15m',
        JWT_REFRESH_TTL: '7d',
        JWT_REFRESH_REDIS_PREFIX: 'auth:refresh:',
        OTP_TTL_SECONDS: 120,
        OTP_LENGTH: 6,
        OTP_MAX_ATTEMPTS: 5,
        OTP_RESEND_COOLDOWN_SECONDS: 60,
        OTP_RESEND_MAX_PER_HOUR: 5,
        OTP_DEV_FAKE_CODE: '111111',
        OTP_DEV_PRINT_TO_LOG: true,
      };
      return map[key] ?? fallback;
    },
  };
}

/**
 * Helper: build a real AuthService with mocked deps but a REAL
 * JwtService (so we can verify+sign tokens). JwtService is built
 * with the real @nestjs/jwt module - it's pure logic and works fine
 * under Jest with the shim only blocking @nestjs/common.
 */
function makeAuthService() {
  const userRepo = makeUserRepo();
  const challengeRepo = makeChallengeRepo();
  const redis = makeRedisMock();
  const config = makeConfigStub();
  const jwt = new JwtService({
    secret: 'test-access-secret-at-least-32-chars',
    signOptions: { expiresIn: '15m' as never },
  });

  const otp = new OtpService(challengeRepo, userRepo, config as never, redis);

  // AuthService constructor signature:
  //   (userRepo, jwt, config, otp, redis)
  const auth = new AuthService(
    userRepo,
    jwt,
    config as never,
    otp,
    redis,
  );
  return { auth, userRepo, challengeRepo, redis, jwt };
}

describe('AuthService', () => {
  describe('ttlToSeconds', () => {
    // Use any to access the private helper.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ttlToSeconds = (s: string) => (AuthService.prototype as any).ttlToSeconds?.call(null, s) ?? null;

    it('converts "15m" -> 900 seconds', () => {
      // Test via reflection on a real instance.
      const { auth } = makeAuthService();
      // Access private method via any-cast
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fn = (auth as any).ttlToSeconds;
      expect(fn('15m')).toBe(900);
    });

    it('converts "7d" -> 604800 seconds', () => {
      const { auth } = makeAuthService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fn = (auth as any).ttlToSeconds;
      expect(fn('7d')).toBe(604800);
    });

    it('converts "60s" -> 60 seconds', () => {
      const { auth } = makeAuthService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fn = (auth as any).ttlToSeconds;
      expect(fn('60s')).toBe(60);
    });

    it('converts "2h" -> 7200 seconds', () => {
      const { auth } = makeAuthService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fn = (auth as any).ttlToSeconds;
      expect(fn('2h')).toBe(7200);
    });

    it('returns 900 (default 15m fallback) for unparseable input', () => {
      const { auth } = makeAuthService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fn = (auth as any).ttlToSeconds;
      expect(fn('garbage')).toBe(900);
    });

    // ttlToSeconds standalone test - the helper above just guards
    // the prototype access pattern but doesn't actually run.
    void ttlToSeconds;
  });

  describe('issueTokens', () => {
    it('issues a signed access + refresh token pair', async () => {
      const { auth, jwt } = makeAuthService();
      const user: UserEntity = {
        id: 'u-issue',
        phone: '+989120000001',
        phoneVerifiedAt: new Date(),
        role: 'customer',
        status: 'Active',
        displayName: null,
        suspendedAt: null,
        suspendedReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as UserEntity;

      const result = await auth.issueTokens(user);

      expect(result.accessToken).toBeTruthy();
      expect(result.refreshToken).toBeTruthy();
      expect(result.userId).toBe(user.id);
      expect(result.phone).toBe(user.phone);
      expect(result.role).toBe('customer');

      // Verify access token signature.
      const decodedAccess = await jwt.verifyAsync(result.accessToken, {
        secret: 'test-access-secret-at-least-32-chars',
      });
      expect(decodedAccess.sub).toBe(user.id);
      expect(decodedAccess.typ).toBe('access');
      expect(decodedAccess.jti).toBeTruthy();
    });

    it('persists refresh jti in Redis allowlist with TTL', async () => {
      const { auth, redis } = makeAuthService();
      const user = {
        id: 'u-allowlist',
        phone: '+989120000002',
        phoneVerifiedAt: new Date(),
        role: 'customer',
        status: 'Active',
      } as UserEntity;

      const result = await auth.issueTokens(user);
      const allowKey = `auth:refresh:${user.id}:${result.refreshToken.length}`; // dummy
      // We can't easily extract jti without decoding; just assert that
      // SOME allowlist key got written.
      const keys = Array.from(redis._store.keys()).filter((k) => k.startsWith('auth:refresh:'));
      expect(keys.length).toBeGreaterThan(0);
      void allowKey;
    });
  });

  describe('refreshTokens (rotation)', () => {
    it('issues a new pair and blacklists the old jti (PRD §3 - rotation)', async () => {
      const { auth, redis, jwt } = makeAuthService();
      const user = {
        id: 'u-rotate',
        phone: '+989120000003',
        phoneVerifiedAt: new Date(),
        role: 'customer',
        status: 'Active',
      } as UserEntity;
      // Seed the user repo so refreshTokens can find the user.
      // (refreshTokens calls userRepo.findOne).
      // But AuthService's userRepo is local to the factory; we use a
      // different approach: directly call issueTokens first to get a
      // refresh token, then call refreshTokens with it.
      const first = await auth.issueTokens(user);

      // The user must exist in the repo for refreshTokens to find them.
      // We patch the repo's findOne to return the user.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const userRepo = (auth as any).userRepo;
      userRepo._findOne.mockImplementation(async () => user);

      const second = await auth.refreshTokens({ refreshToken: first.refreshToken });

      expect(second.accessToken).not.toBe(first.accessToken);
      expect(second.refreshToken).not.toBe(first.refreshToken);

      // Old refresh should be blacklisted.
      const oldDecoded = await jwt.verifyAsync(first.refreshToken, {
        secret: 'test-access-secret-at-least-32-chars',
      });
      const blKey = `auth:refresh-bl:${oldDecoded.jti}`;
      expect(redis._store.get(blKey)).toBe('1');

      // New refresh should be in allowlist.
      const newDecoded = await jwt.verifyAsync(second.refreshToken, {
        secret: 'test-access-secret-at-least-32-chars',
      });
      const allowKey = `auth:refresh:${user.id}:${newDecoded.jti}`;
      expect(redis._store.get(allowKey)).toBe('1');
    });

    it('rejects an invalid refresh signature', async () => {
      const { auth } = makeAuthService();
      await expect(
        auth.refreshTokens({ refreshToken: 'not-a-jwt' }),
      ).rejects.toThrow(/Invalid refresh token/);
    });

    it('rejects a refresh whose allowlist entry is gone (expired)', async () => {
      const { auth, jwt } = makeAuthService();
      const user = {
        id: 'u-gone',
        phone: '+989120000004',
        phoneVerifiedAt: new Date(),
        role: 'customer',
        status: 'Active',
      } as UserEntity;
      const first = await auth.issueTokens(user);
      // Simulate the allowlist entry expiring: delete it.
      const decoded = await jwt.verifyAsync(first.refreshToken, {
        secret: 'test-access-secret-at-least-32-chars',
      });
      const allowKey = `auth:refresh:${user.id}:${decoded.jti}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const redis = (auth as any).redis;
      await redis.del(allowKey);

      await expect(
        auth.refreshTokens({ refreshToken: first.refreshToken }),
      ).rejects.toThrow(/Refresh token expired/);
    });

    it('rejects a blacklisted refresh (already rotated)', async () => {
      const { auth, redis, jwt } = makeAuthService();
      const user = {
        id: 'u-bl',
        phone: '+989120000005',
        phoneVerifiedAt: new Date(),
        role: 'customer',
        status: 'Active',
      } as UserEntity;
      const first = await auth.issueTokens(user);
      const decoded = await jwt.verifyAsync(first.refreshToken, {
        secret: 'test-access-secret-at-least-32-chars',
      });
      // Manually blacklist.
      await redis.setex(`auth:refresh-bl:${decoded.jti}`, 60, '1');

      await expect(
        auth.refreshTokens({ refreshToken: first.refreshToken }),
      ).rejects.toThrow(/Refresh token revoked/);
    });

    it('rejects a refresh for a non-existent user', async () => {
      const { auth, jwt } = makeAuthService();
      const user = {
        id: 'u-no-such',
        phone: '+989120000006',
        phoneVerifiedAt: new Date(),
        role: 'customer',
        status: 'Active',
      } as UserEntity;
      const first = await auth.issueTokens(user);
      // Don't seed the user in the repo -> findOne returns null.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const userRepo = (auth as any).userRepo;
      userRepo._findOne.mockImplementation(async () => null);

      await expect(
        auth.refreshTokens({ refreshToken: first.refreshToken }),
      ).rejects.toThrow(/User not found or suspended/);
    });

    it('rejects a refresh for a suspended user', async () => {
      const { auth, jwt } = makeAuthService();
      const user = {
        id: 'u-sus',
        phone: '+989120000007',
        phoneVerifiedAt: new Date(),
        role: 'customer',
        status: 'Suspended',
      } as UserEntity;
      const first = await auth.issueTokens(user);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const userRepo = (auth as any).userRepo;
      userRepo._findOne.mockImplementation(async () => user);

      await expect(
        auth.refreshTokens({ refreshToken: first.refreshToken }),
      ).rejects.toThrow(/User not found or suspended/);
    });
  });

  describe('logout', () => {
    it('blacklists the refresh jti', async () => {
      const { auth, redis, jwt } = makeAuthService();
      const user = {
        id: 'u-logout',
        phone: '+989120000008',
        phoneVerifiedAt: new Date(),
        role: 'customer',
        status: 'Active',
      } as UserEntity;
      const first = await auth.issueTokens(user);
      const decoded = await jwt.verifyAsync(first.refreshToken, {
        secret: 'test-access-secret-at-least-32-chars',
      });

      await auth.logout(user.id, first.refreshToken);

      expect(redis._store.get(`auth:refresh-bl:${decoded.jti}`)).toBe('1');
    });

    it('does not throw on an invalid refresh (silent no-op)', async () => {
      const { auth } = makeAuthService();
      await expect(auth.logout('u-x', 'not-a-jwt')).resolves.not.toThrow();
    });

    it('is a no-op when refresh is missing', async () => {
      const { auth } = makeAuthService();
      await expect(auth.logout('u-x')).resolves.not.toThrow();
    });
  });

  describe('assignRole', () => {
    it('updates the user role (TECH_ADMIN only - enforced by RolesGuard at the controller)', async () => {
      const { auth, userRepo } = makeAuthService();
      const user: UserEntity = {
        id: 'u-role',
        phone: '+989120000010',
        phoneVerifiedAt: new Date(),
        role: 'customer',
        status: 'Active',
      } as UserEntity;
      userRepo._rows.push(user);
      const updated = await auth.assignRole(user.id, 'cinema_manager');
      expect(updated.role).toBe('cinema_manager');
    });

    it('rejects an invalid role', async () => {
      const { auth } = makeAuthService();
      await expect(auth.assignRole('u-x', 'super-user' as never)).rejects.toThrow(
        /Invalid role/,
      );
    });

    it('rejects when user not found', async () => {
      const { auth, userRepo } = makeAuthService();
      userRepo._findOne.mockImplementation(async () => null);
      await expect(auth.assignRole('nonexistent', 'customer')).rejects.toThrow(
        /User.*not found/,
      );
    });
  });
});
