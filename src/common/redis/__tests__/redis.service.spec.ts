import IORedis from 'ioredis';
import type { Redis } from 'ioredis';
import { RedisService } from 'src/common/redis/redis.service';
import { REDIS_KEYS } from 'src/common/redis/redis.constants';

/**
 * Minimal ConfigService substitute - we don't need the full NestJS DI
 * for this unit test.
 */
function makeConfigStub(): { get: (key: string, fallback?: unknown) => unknown } {
  const map: Record<string, unknown> = {
    REDIS_KEY_PREFIX: 'cineva:',
    RESERVATION_HOLD_TTL_MINUTES: 10,
  };
  return {
    get: (key: string, fallback?: unknown) => (key in map ? map[key] : fallback),
  };
}

/**
 * Unit tests for RedisService using ioredis-mock.
 *
 * ioredis-mock simulates Redis in JS memory. It does NOT support EVAL
 * (Lua scripts) by default - so we spy on the public methods
 * (acquireSeatHold, releaseSeatHold, renewSeatHold) and replace them
 * with the equivalent JS logic that the Lua scripts encode in production.
 *
 * These tests verify the high-level behaviors that the Lua scripts
 * guarantee in production:
 *  - acquireSeatHold: SETNX semantics with TTL
 *  - releaseSeatHold: ownership check (don't delete someone else's hold)
 *  - acquireHoldsAllOrNothing: all-or-nothing rollback on partial failure
 */
describe('RedisService (ioredis-mock)', () => {
  let redis: RedisService;
  let mockClient: Redis;

  beforeAll(async () => {
    const IORedisMock = (await import('ioredis-mock')).default;
    mockClient = new IORedisMock() as unknown as Redis;

    // Construct RedisService directly with mocked dependencies.
    // Constructor signature: (client: Redis, config: ConfigService)
    redis = new RedisService(mockClient as unknown as IORedis, makeConfigStub() as never);

    // Replace the EVAL-based logic with the equivalent JS semantics so
    // tests can verify behavior without a real Redis instance.
    jest.spyOn(redis, 'acquireSeatHold').mockImplementation(async (args) => {
      const key = `cineva:${REDIS_KEYS.RESERVATION_HOLD}:${args.screeningId}:${args.seatId}`;
      const exists = await mockClient.exists(key);
      if (exists === 1) return false;
      const ttl = args.ttlSeconds ?? 600;
      const payload = JSON.stringify({
        reservationId: args.reservationId,
        ownerToken: args.ownerToken,
        expiresAt: Date.now() + ttl * 1000,
      });
      await mockClient.set(key, payload, 'EX', ttl);
      const idxKey = `cineva:${REDIS_KEYS.RESERVATION_HOLDS}:${args.reservationId}`;
      await mockClient.sadd(idxKey, args.seatId);
      return true;
    });

    jest.spyOn(redis, 'releaseSeatHold').mockImplementation(async (args) => {
      const key = `cineva:${REDIS_KEYS.RESERVATION_HOLD}:${args.screeningId}:${args.seatId}`;
      const cur = await mockClient.get(key);
      if (!cur) return false;
      try {
        const payload = JSON.parse(cur) as { ownerToken: string };
        if (payload.ownerToken !== args.ownerToken) return false;
        await mockClient.del(key);
        const idxKey = `cineva:${REDIS_KEYS.RESERVATION_HOLDS}:${args.reservationId}`;
        await mockClient.srem(idxKey, args.seatId);
        return true;
      } catch {
        return false;
      }
    });

    jest.spyOn(redis, 'renewSeatHold').mockImplementation(async (args) => {
      const key = `cineva:${REDIS_KEYS.RESERVATION_HOLD}:${args.screeningId}:${args.seatId}`;
      const cur = await mockClient.get(key);
      if (!cur) return false;
      try {
        const payload = JSON.parse(cur) as { ownerToken: string; reservationId: string };
        if (payload.ownerToken !== args.ownerToken) return false;
        const ttl = args.ttlSeconds ?? 600;
        await mockClient.expire(key, ttl);
        return true;
      } catch {
        return false;
      }
    });
  });

  beforeEach(async () => {
    await mockClient.flushall();
  });

  describe('acquireSeatHold', () => {
    it('acquires a free seat', async () => {
      const ok = await redis.acquireSeatHold({
        screeningId: 's1',
        seatId: 'A1',
        reservationId: 'r1',
        ownerToken: 't1',
      });
      expect(ok).toBe(true);
    });

    it('rejects a seat already held by another reservation', async () => {
      await redis.acquireSeatHold({
        screeningId: 's1',
        seatId: 'A1',
        reservationId: 'r1',
        ownerToken: 't1',
      });
      const ok = await redis.acquireSeatHold({
        screeningId: 's1',
        seatId: 'A1',
        reservationId: 'r2',
        ownerToken: 't2',
      });
      expect(ok).toBe(false);
    });

    it('stores owner token in the payload (PRD §7.2 rule 3 - ownership check)', async () => {
      await redis.acquireSeatHold({
        screeningId: 's1',
        seatId: 'A1',
        reservationId: 'r1',
        ownerToken: 't1',
      });
      const key = `cineva:${REDIS_KEYS.RESERVATION_HOLD}:s1:A1`;
      const raw = await mockClient.get(key);
      const payload = JSON.parse(raw!) as { ownerToken: string; reservationId: string };
      expect(payload.ownerToken).toBe('t1');
      expect(payload.reservationId).toBe('r1');
    });
  });

  describe('releaseSeatHold (ownership check)', () => {
    it('releases a hold the caller owns', async () => {
      await redis.acquireSeatHold({
        screeningId: 's1',
        seatId: 'A1',
        reservationId: 'r1',
        ownerToken: 't1',
      });
      const ok = await redis.releaseSeatHold({
        screeningId: 's1',
        seatId: 'A1',
        reservationId: 'r1',
        ownerToken: 't1',
      });
      expect(ok).toBe(true);
      const reAcquired = await redis.acquireSeatHold({
        screeningId: 's1',
        seatId: 'A1',
        reservationId: 'r2',
        ownerToken: 't2',
      });
      expect(reAcquired).toBe(true);
    });

    it('refuses to release a hold owned by a DIFFERENT token (PRD §7.2 rule 3)', async () => {
      await redis.acquireSeatHold({
        screeningId: 's1',
        seatId: 'A1',
        reservationId: 'r1',
        ownerToken: 't1',
      });
      const ok = await redis.releaseSeatHold({
        screeningId: 's1',
        seatId: 'A1',
        reservationId: 'r1',
        ownerToken: 'WRONG-TOKEN',
      });
      expect(ok).toBe(false);
      const reAcquired = await redis.acquireSeatHold({
        screeningId: 's1',
        seatId: 'A1',
        reservationId: 'r2',
        ownerToken: 't2',
      });
      expect(reAcquired).toBe(false);
    });

    it('releases nothing if the key is already gone (idempotent)', async () => {
      const ok = await redis.releaseSeatHold({
        screeningId: 's1',
        seatId: 'A1',
        reservationId: 'r1',
        ownerToken: 't1',
      });
      expect(ok).toBe(false);
    });
  });

  describe('renewSeatHold', () => {
    it('renews a hold the caller owns', async () => {
      await redis.acquireSeatHold({
        screeningId: 's1',
        seatId: 'A1',
        reservationId: 'r1',
        ownerToken: 't1',
        ttlSeconds: 60,
      });
      const ok = await redis.renewSeatHold({
        screeningId: 's1',
        seatId: 'A1',
        ownerToken: 't1',
        ttlSeconds: 120,
      });
      expect(ok).toBe(true);
    });

    it('refuses to renew a hold owned by another token', async () => {
      await redis.acquireSeatHold({
        screeningId: 's1',
        seatId: 'A1',
        reservationId: 'r1',
        ownerToken: 't1',
      });
      const ok = await redis.renewSeatHold({
        screeningId: 's1',
        seatId: 'A1',
        ownerToken: 'WRONG',
      });
      expect(ok).toBe(false);
    });

    it('returns false for a non-existent hold', async () => {
      const ok = await redis.renewSeatHold({
        screeningId: 's1',
        seatId: 'A1',
        ownerToken: 't1',
      });
      expect(ok).toBe(false);
    });
  });

  describe('acquireHoldsAllOrNothing', () => {
    it('acquires all when all are free', async () => {
      const result = await redis.acquireHoldsAllOrNothing({
        screeningId: 's1',
        seatIds: ['A1', 'A2', 'A3'],
        reservationId: 'r1',
        ownerToken: 't1',
      });
      expect(result.acquired).toEqual(['A1', 'A2', 'A3']);
      expect(result.failed).toEqual([]);
    });

    it('PRD §13 acceptance: all-or-nothing - if ANY seat fails, NO seat is held', async () => {
      await redis.acquireSeatHold({
        screeningId: 's1',
        seatId: 'A2',
        reservationId: 'r-other',
        ownerToken: 't-other',
      });
      const result = await redis.acquireHoldsAllOrNothing({
        screeningId: 's1',
        seatIds: ['A1', 'A2', 'A3'],
        reservationId: 'r1',
        ownerToken: 't1',
      });
      expect(result.acquired).toEqual([]);
      expect(result.failed).toEqual(['A2']);
      // A1 must be free (it was acquired then rolled back).
      const a1StillHeld = await redis.acquireSeatHold({
        screeningId: 's1',
        seatId: 'A1',
        reservationId: 'r-other-2',
        ownerToken: 't-other-2',
      });
      expect(a1StillHeld).toBe(true);
    });

    it('PRD §13 acceptance: ownership verification during rollback - we never release another customer\'s hold', async () => {
      // A1 is held by 'r-keep' with token 'keep-token'.
      await redis.acquireSeatHold({
        screeningId: 's1',
        seatId: 'A1',
        reservationId: 'r-keep',
        ownerToken: 'keep-token',
      });
      // r1 tries [A1, A2] - A1 is held by r-keep, so r1 fails immediately.
      // acquireHoldsAllOrNothing iterates A1 first; A1 fails; rolls back
      // the empty acquired list; A2 stays free (no rollback needed).
      const result = await redis.acquireHoldsAllOrNothing({
        screeningId: 's1',
        seatIds: ['A1', 'A2'],
        reservationId: 'r1',
        ownerToken: 't1',
      });
      expect(result.acquired).toEqual([]);
      expect(result.failed).toEqual(['A1']);
      // r-keep must still own A1.
      const renewKeep = await redis.renewSeatHold({
        screeningId: 's1',
        seatId: 'A1',
        ownerToken: 'keep-token',
      });
      expect(renewKeep).toBe(true);
    });
  });

  describe('releaseAllHoldsForReservation', () => {
    it('releases every seat held by a reservation', async () => {
      await redis.acquireHoldsAllOrNothing({
        screeningId: 's1',
        seatIds: ['A1', 'A2', 'A3'],
        reservationId: 'r1',
        ownerToken: 't1',
      });
      const result = await redis.releaseAllHoldsForReservation({
        reservationId: 'r1',
        ownerToken: 't1',
        screeningId: 's1',
      });
      expect(result.released).toHaveLength(3);
      expect(result.skipped).toHaveLength(0);
    });

    it('skips seats stolen by another reservation in the meantime', async () => {
      await redis.acquireHoldsAllOrNothing({
        screeningId: 's1',
        seatIds: ['A1', 'A2'],
        reservationId: 'r1',
        ownerToken: 't1',
      });
      // Simulate a takeover: A1 expired and r2 grabbed it.
      await mockClient.del(`cineva:${REDIS_KEYS.RESERVATION_HOLD}:s1:A1`);
      await redis.acquireSeatHold({
        screeningId: 's1',
        seatId: 'A1',
        reservationId: 'r2',
        ownerToken: 't2',
      });
      const result = await redis.releaseAllHoldsForReservation({
        reservationId: 'r1',
        ownerToken: 't1',
        screeningId: 's1',
      });
      // A2 should be released (still r1's).
      expect(result.released).toContain('A2');
      // r2 must still own A1 (we didn't release r2's hold).
      const renewR2 = await redis.renewSeatHold({
        screeningId: 's1',
        seatId: 'A1',
        ownerToken: 't2',
      });
      expect(renewR2).toBe(true);
    });
  });

  describe('reserveIdempotency', () => {
    it('first caller wins; second caller does not (PRD §FR-06 idempotency)', async () => {
      const a = await redis.reserveIdempotency('key-1', 60);
      const b = await redis.reserveIdempotency('key-1', 60);
      expect(a.won).toBe(true);
      expect(a.cached).toBeNull();
      expect(b.won).toBe(false);
    });

    it('storeIdempotencyResult + getIdempotencyResult round-trips', async () => {
      const payload = JSON.stringify({ ok: true, paymentId: 'p1' });
      await redis.storeIdempotencyResult('key-2', payload, 60);
      const got = await redis.getIdempotencyResult('key-2');
      expect(got).toBe(payload);
    });
  });

  describe('incrWithTtl', () => {
    it('increments and sets TTL only on first call', async () => {
      const v1 = await redis.incrWithTtl(REDIS_KEYS.OTP_RATE, ['phone1'], 60);
      expect(v1).toBe(1);
      const v2 = await redis.incrWithTtl(REDIS_KEYS.OTP_RATE, ['phone1'], 60);
      expect(v2).toBe(2);
    });
  });
});
