import { Inject, Injectable, Logger } from '@nestjs/common';
import IORedis, { type Redis } from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { REDIS_KEYS } from './redis.constants';

/**
 * Wrapper around ioredis that:
 *  - automatically applies the global key prefix (REDIS_KEY_PREFIX)
 *  - implements the Cineva seat-hold contract via Lua scripts for atomicity
 *  - exposes idempotency and refresh-token helpers
 *
 * CRITICAL CONTRACT (see Cineva PRD §7.2):
 *   Seat holds are owned by an ownerToken. Releasing or renewing a hold
 *   must verify ownership atomically; deleting a key by name alone would
 *   allow one customer to release another customer's hold.
 */
@Injectable()
export class RedisService {
  private readonly logger = new Logger(RedisService.name);
  private readonly prefix: string;
  private readonly holdTtlSeconds: number;

  // Lua: SETNX with expiry, only if key doesn't exist (acquire hold).
  // Returns "OK" on success, "BUSY" if already held.
  private readonly acquireHoldScript = `
    if redis.call('EXISTS', KEYS[1]) == 1 then
      return 'BUSY'
    end
    redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
    redis.call('SADD', KEYS[2], ARGV[3])
    redis.call('EXPIRE', KEYS[2], tonumber(ARGV[2]))
    return 'OK'
  `;

  // Lua: DEL only if stored value (parsed JSON) contains the expected ownerToken.
  // Returns 1 if deleted, 0 if not (mismatch or missing).
  private readonly releaseHoldScript = `
    local cur = redis.call('GET', KEYS[1])
    if not cur then return 0 end
    local ok, payload = pcall(cjson.decode, cur)
    if not ok then return 0 end
    if payload.ownerToken == ARGV[1] then
      redis.call('DEL', KEYS[1])
      redis.call('SREM', KEYS[2], ARGV[3])
      return 1
    end
    return 0
  `;

  // Lua: EXPIRE only if value contains expected ownerToken.
  private readonly renewHoldScript = `
    local cur = redis.call('GET', KEYS[1])
    if not cur then return 0 end
    local ok, payload = pcall(cjson.decode, cur)
    if not ok then return 0 end
    if payload.ownerToken == ARGV[1] then
      redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
      redis.call('EXPIRE', KEYS[2], tonumber(ARGV[2]))
      return 1
    end
    return 0
  `;

  // Lua: Idempotent execute - returns cached result or runs fn and caches.
  // Args: KEYS[1] = idem key, ARGV[1] = ttl seconds, ARGV[2] = marker value
  // This script implements "first writer wins" pattern.
  private readonly idempotencyReserveScript = `
    local cur = redis.call('GET', KEYS[1])
    if cur then return {1, cur} end
    redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[1]))
    return {0, ''}
  `;

  constructor(
    @Inject(IORedis) private readonly client: Redis,
    private readonly config: ConfigService,
  ) {
    this.prefix = this.config.get<string>('REDIS_KEY_PREFIX', 'cineva:');
    this.holdTtlSeconds = this.config.get<number>('RESERVATION_HOLD_TTL_MINUTES', 10) * 60;
  }

  /** Direct ioredis client (for module-level custom commands). */
  get raw(): Redis {
    return this.client;
  }

  private build(keyType: string, ...parts: string[]): string {
    return `${this.prefix}${keyType}:${parts.join(':')}`;
  }

  // -------------------------------------------------------------
  // Seat hold operations
  // -------------------------------------------------------------

  /**
   * Try to atomically acquire a hold on a single seat for a reservation.
   * Returns true if acquired, false if the seat is already held by another
   * reservation (or by us with a different owner token).
   *
   * @param reservationId Used for the index set so we can bulk-release
   *                      all holds of a reservation in one pass.
   */
  async acquireSeatHold(args: {
    screeningId: string;
    seatId: string;
    reservationId: string;
    ownerToken: string;
    ttlSeconds?: number;
  }): Promise<boolean> {
    const holdKey = this.build(REDIS_KEYS.RESERVATION_HOLD, args.screeningId, args.seatId);
    const indexKey = this.build(REDIS_KEYS.RESERVATION_HOLDS, args.reservationId);
    const ttl = (args.ttlSeconds ?? this.holdTtlSeconds).toString();
    const payload = JSON.stringify({
      reservationId: args.reservationId,
      ownerToken: args.ownerToken,
      expiresAt: Date.now() + Number(ttl) * 1000,
    });

    const result = (await this.client.eval(
      this.acquireHoldScript,
      2,
      holdKey,
      indexKey,
      payload,
      ttl,
      args.seatId,
    )) as string;

    return result === 'OK';
  }

  /**
   * Release a single seat hold, but only if the caller owns it.
   * This prevents accidentally releasing another reservation's hold.
   */
  async releaseSeatHold(args: {
    screeningId: string;
    seatId: string;
    reservationId: string;
    ownerToken: string;
  }): Promise<boolean> {
    const holdKey = this.build(REDIS_KEYS.RESERVATION_HOLD, args.screeningId, args.seatId);
    const indexKey = this.build(REDIS_KEYS.RESERVATION_HOLDS, args.reservationId);
    const result = (await this.client.eval(
      this.releaseHoldScript,
      2,
      holdKey,
      indexKey,
      args.ownerToken,
      args.seatId,
    )) as number;
    return result === 1;
  }

  /**
   * Renew a single hold's TTL, but only if the caller owns it.
   * Renewal is not infinite - the PRD forbids unlimited extensions;
   * callers should track a max-renewals counter in their own logic.
   */
  async renewSeatHold(args: {
    screeningId: string;
    seatId: string;
    ownerToken: string;
    ttlSeconds?: number;
  }): Promise<boolean> {
    const holdKey = this.build(REDIS_KEYS.RESERVATION_HOLD, args.screeningId, args.seatId);
    // Find the reservationId from the existing payload (or pass it in).
    // For renew we read payload first; if no payload, return false.
    const cur = await this.client.get(holdKey);
    if (!cur) return false;
    let payload: { reservationId?: string } = {};
    try {
      payload = JSON.parse(cur);
    } catch {
      return false;
    }
    const reservationId = payload.reservationId ?? '';
    const indexKey = this.build(REDIS_KEYS.RESERVATION_HOLDS, reservationId);
    const ttl = (args.ttlSeconds ?? this.holdTtlSeconds).toString();
    const result = (await this.client.eval(
      this.renewHoldScript,
      2,
      holdKey,
      indexKey,
      args.ownerToken,
      ttl,
    )) as number;
    return result === 1;
  }

  /**
   * Release ALL seat holds for a reservation, verifying ownership per seat.
   * Used when a multi-seat reservation needs to rollback after partial
   * acquisition (all-or-nothing) or when a reservation is cancelled/expired.
   */
  async releaseAllHoldsForReservation(args: {
    reservationId: string;
    ownerToken: string;
    screeningId?: string;
  }): Promise<{ released: string[]; skipped: string[] }> {
    const indexKey = this.build(REDIS_KEYS.RESERVATION_HOLDS, args.reservationId);
    const seatIds = await this.client.smembers(indexKey);
    const released: string[] = [];
    const skipped: string[] = [];

    // No screeningId provided - we need to figure out screening per seat.
    // Seats are stored as just seatId in the index, but the hold key requires
    // screeningId. We read each payload to extract screeningId.
    for (const seatId of seatIds) {
      // We try every key prefix that could contain this seatId - but that's
      // expensive. Better: caller must supply screeningId. Without it, we
      // scan via the index.
      // To keep it simple here: scan keyspace via the index payload.
      // Caller convention: if reservation spans multiple screenings, call
      // this per-screening. We support that by accepting screeningId arg.
      if (!args.screeningId) {
        // Fallback: search the seat-hold:*:{seatId} keyspace.
        // This is O(N) with N=screenings - acceptable for cleanup, not for hot path.
        const keys = await this.client.keys(this.build(REDIS_KEYS.RESERVATION_HOLD, '*', seatId));
        if (keys.length === 0) {
          skipped.push(seatId);
          continue;
        }
        for (const key of keys) {
          const parts = key.split(':');
          const screeningId = parts[parts.length - 2];
          const ok = await this.releaseSeatHold({
            screeningId,
            seatId,
            reservationId: args.reservationId,
            ownerToken: args.ownerToken,
          });
          if (ok) released.push(seatId);
          else skipped.push(seatId);
        }
      } else {
        const ok = await this.releaseSeatHold({
          screeningId: args.screeningId,
          seatId,
          reservationId: args.reservationId,
          ownerToken: args.ownerToken,
        });
        if (ok) released.push(seatId);
        else skipped.push(seatId);
      }
    }
    // The index key may outlive individual holds; clean it up.
    await this.client.del(indexKey);
    return { released, skipped };
  }

  /**
   * Bulk acquire - if any seat fails, release the ones already acquired.
   * Implements all-or-nothing semantics for multi-seat selection
   * (PRD §FR-04 rule 6).
   */
  async acquireHoldsAllOrNothing(args: {
    screeningId: string;
    seatIds: string[];
    reservationId: string;
    ownerToken: string;
    ttlSeconds?: number;
  }): Promise<{ acquired: string[]; failed: string[] }> {
    const acquired: string[] = [];
    const failed: string[] = [];
    for (const seatId of args.seatIds) {
      const ok = await this.acquireSeatHold({
        screeningId: args.screeningId,
        seatId,
        reservationId: args.reservationId,
        ownerToken: args.ownerToken,
        ttlSeconds: args.ttlSeconds,
      });
      if (ok) acquired.push(seatId);
      else {
        failed.push(seatId);
        // Roll back any holds we got - atomically verify ownership per seat.
        for (const releaseId of acquired) {
          await this.releaseSeatHold({
            screeningId: args.screeningId,
            seatId: releaseId,
            reservationId: args.reservationId,
            ownerToken: args.ownerToken,
          });
        }
        return { acquired: [], failed };
      }
    }
    return { acquired, failed };
  }

  // -------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------

  /**
   * Reserve an idempotency key. Returns true if this caller "won" the key
   * (i.e. should run the operation), false if a previous result is already
   * cached (caller should replay the cached result).
   *
   * @returns { won: boolean; cached: string | null }
   */
  async reserveIdempotency(
    key: string,
    ttlSeconds = 86400,
  ): Promise<{ won: boolean; cached: string | null }> {
    const redisKey = this.build(REDIS_KEYS.PAYMENT_IDEMPOTENCY, key);
    const result = (await this.client.eval(
      this.idempotencyReserveScript,
      1,
      redisKey,
      ttlSeconds.toString(),
      'reserved',
    )) as [number, string];
    const [won, cached] = result;
    if (won === 1) {
      return { won: false, cached };
    }
    return { won: true, cached: null };
  }

  /**
   * Persist the result of an idempotent operation so subsequent replays
   * return the same response.
   */
  async storeIdempotencyResult(key: string, result: string, ttlSeconds = 86400): Promise<void> {
    const redisKey = this.build(REDIS_KEYS.PAYMENT_IDEMPOTENCY, key);
    await this.client.set(redisKey, result, 'EX', ttlSeconds);
  }

  async getIdempotencyResult(key: string): Promise<string | null> {
    const redisKey = this.build(REDIS_KEYS.PAYMENT_IDEMPOTENCY, key);
    return this.client.get(redisKey);
  }

  // -------------------------------------------------------------
  // Generic helpers
  // -------------------------------------------------------------

  async getJson<T>(keyType: string, ...parts: string[]): Promise<T | null> {
    const key = this.build(keyType, ...parts);
    const raw = await this.client.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async setJsonWithTtl(
    keyType: string,
    parts: string[],
    value: unknown,
    ttlSeconds: number,
  ): Promise<void> {
    const key = this.build(keyType, ...parts);
    await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async invalidate(keyType: string, ...parts: string[]): Promise<void> {
    const key = this.build(keyType, ...parts);
    await this.client.del(key);
  }

  /**
   * Increment a counter with TTL (rate limiting). Returns the new value.
   * First call sets the TTL; subsequent calls just increment.
   */
  async incrWithTtl(keyType: string, parts: string[], ttlSeconds: number): Promise<number> {
    const key = this.build(keyType, ...parts);
    const pipeline = this.client.multi();
    pipeline.incr(key);
    pipeline.expire(key, ttlSeconds, 'NX'); // only set TTL if no TTL exists
    const results = (await pipeline.exec()) ?? [];
    return (results[0]?.[1] as number) ?? 0;
  }

  /**
   * Returns the TTL of a key (in seconds). -2 = missing, -1 = no TTL.
   */
  async ttl(keyType: string, ...parts: string[]): Promise<number> {
    const key = this.build(keyType, ...parts);
    return this.client.ttl(key);
  }

  /** Health-check for /health/redis endpoint. */
  async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (err) {
      this.logger.error(`ping failed: ${(err as Error).message}`);
      return false;
    }
  }
}
