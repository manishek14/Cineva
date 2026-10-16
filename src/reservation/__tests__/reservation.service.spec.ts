import type { Repository, DataSource, EntityManager } from 'typeorm';
import { ReservationService } from 'src/reservation/services/reservation.service';
import { ReservationEntity, ReservationStatus } from 'src/reservation/entities/reservation.entity';
import { ReservationSeatEntity, ReservationSeatStatus } from 'src/reservation/entities/reservation-seat.entity';
import { SeatAllocationEntity, AllocationStatus } from 'src/reservation/entities/seat-allocation.entity';
import { ScreeningEntity } from 'src/screening/entities/screening.entity';
import { ScreeningSeatEntity, ScreeningSeatStatus } from 'src/screening/entities/screening-seat.entity';
import type { RedisService } from 'src/common/redis/redis.service';
import type { ConfigService } from '@nestjs/config';
import { BusinessError } from 'src/common/utils';
import { ERROR_CODES } from 'src/common/constants/error-codes';

/**
 * ReservationService unit tests focused on the PRD §13 acceptance
 * criteria that are testable without a real PostgreSQL instance:
 *
 *   - All-or-nothing multi-seat (PRD §13 acceptance: 'سفارش چندصندلی
 *     فقط در صورت موفقیت تخصیص تمام صندلی‌ها ثبت می‌شود')
 *   - Redis failure rollback (PRD §7.3: 'Redis موفق، ثبت دیتابیس
 *     ناموفق -> نگه‌داری موقت باید پاک یا در مسیر بازیابی قرار گیرد')
 *   - DB unique violation -> friendly conflict
 *   - Expire is idempotent (PRD §NFR-04)
 *   - Expire is a no-op if reservation is no longer PendingPayment
 *     (PRD §7.2 rule 4: 'انقضا فقط به TTL وابسته نیست')
 *   - Reconciliation scans for stale PendingPayment rows
 *
 * We mock DataSource.transaction so the test controls when the tx body
 * runs and can simulate success or failure.
 */

function makeMockRepo<T extends object>(): Repository<T> {
  return {
    find: jest.fn(async () => []),
    findOne: jest.fn(async () => null),
    save: jest.fn(async (e: T) => e),
    update: jest.fn(async () => ({})),
    create: jest.fn((e: Partial<T>) => e as T),
    createQueryBuilder: () => ({
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn(async () => [[], 0]),
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(async () => null),
    }),
  } as unknown as Repository<T>;
}

function makeConfigStub(): ConfigService {
  return {
    get: (key: string, fallback?: unknown) => {
      const map: Record<string, unknown> = {
        RESERVATION_HOLD_TTL_MINUTES: 10,
        RESERVATION_HOLDER_TOKEN_PREFIX: 'res:',
      };
      return map[key] ?? fallback;
    },
  } as ConfigService;
}

function makeRedisStub() {
  return {
    acquireHoldsAllOrNothing: jest.fn(),
    releaseAllHoldsForReservation: jest.fn(async () => ({ released: [], skipped: [] })),
    releaseSeatHold: jest.fn(),
    renewSeatHold: jest.fn(),
  } as unknown as jest.Mocked<RedisService>;
}

describe('ReservationService - PRD §13 acceptance (no Postgres required)', () => {
  let reservationRepo: Repository<ReservationEntity>;
  let resSeatRepo: Repository<ReservationSeatEntity>;
  let allocationRepo: Repository<SeatAllocationEntity>;
  let screeningRepo: Repository<ScreeningEntity>;
  let screeningSeatRepo: Repository<ScreeningSeatEntity>;
  let ds: { transaction: jest.Mock };
  let redis: jest.Mocked<RedisService>;
  let config: ConfigService;
  let service: ReservationService;

  beforeEach(() => {
    reservationRepo = makeMockRepo<ReservationEntity>();
    resSeatRepo = makeMockRepo<ReservationSeatEntity>();
    allocationRepo = makeMockRepo<SeatAllocationEntity>();
    screeningRepo = makeMockRepo<ScreeningEntity>();
    screeningSeatRepo = makeMockRepo<ScreeningSeatEntity>();
    ds = {
      transaction: jest.fn(),
    } as unknown as { transaction: jest.Mock };
    redis = makeRedisStub();
    config = makeConfigStub();
    service = new ReservationService(
      reservationRepo,
      resSeatRepo,
      allocationRepo,
      screeningRepo,
      screeningSeatRepo,
      ds as unknown as DataSource,
      redis,
      config,
    );
  });

  describe('createReservation - all-or-nothing + Redis failure rollback', () => {
    function setupHappyPathScreening() {
      const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // tomorrow
      (screeningRepo.findOne as jest.Mock).mockResolvedValue({
        id: 's-1',
        movieId: 'm-1',
        hallId: 'h-1',
        startsAt,
        endsAt: new Date(startsAt.getTime() + 90 * 60 * 1000),
        salesOpensAt: new Date(Date.now() - 60 * 60 * 1000), // sales opened 1h ago (in the past)
        setupBufferMinutes: 15,
        status: 'Published',
        basePriceToman: 200_000,
      } as ScreeningEntity);
      (screeningSeatRepo.find as jest.Mock).mockResolvedValue([
        { id: 'ss-1', screeningId: 's-1', seatId: 'seat-1', price: 200_000, saleStatus: 'Available' },
        { id: 'ss-2', screeningId: 's-1', seatId: 'seat-2', price: 200_000, saleStatus: 'Available' },
      ]);
    }

    it('PRD §13: all-or-nothing - if Redis fails to acquire ANY seat, throw SEAT_ALREADY_HELD and never enter the DB transaction', async () => {
      setupHappyPathScreening();
      (redis.acquireHoldsAllOrNothing as jest.Mock).mockResolvedValue({
        acquired: [],
        failed: ['ss-2'],
      });

      await expect(
        service.createReservation({
          screeningId: 's-1',
          screeningSeatIds: ['ss-1', 'ss-2'],
        }),
      ).rejects.toThrow(/Seats already held by another customer/);

      // Tx must NOT have been entered.
      expect(ds.transaction).not.toHaveBeenCalled();
      // Verify the thrown error carries the right code.
      try {
        await service.createReservation({
          screeningId: 's-1',
          screeningSeatIds: ['ss-1', 'ss-2'],
        });
      } catch (err) {
        expect(err).toBeInstanceOf(BusinessError);
        expect((err as BusinessError).code).toBe(ERROR_CODES.SEAT_ALREADY_HELD);
      }
    });

    it('PRD §7.3: Redis succeeds but DB fails -> Redis holds are released WITH OWNERSHIP CHECK', async () => {
      setupHappyPathScreening();
      (redis.acquireHoldsAllOrNothing as jest.Mock).mockResolvedValue({
        acquired: ['ss-1', 'ss-2'],
        failed: [],
      });
      // DB transaction throws (simulate unique violation on insert).
      (ds.transaction as jest.Mock).mockRejectedValue(
        new Error('unique violation 23505: duplicate key'),
      );

      await expect(
        service.createReservation({
          screeningId: 's-1',
          screeningSeatIds: ['ss-1', 'ss-2'],
        }),
      ).rejects.toThrow(/Some seats were just taken by another customer/);

      // Redis release was called with the ownerToken.
      expect(redis.releaseAllHoldsForReservation).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerToken: expect.any(String),
          screeningId: 's-1',
        }),
      );
    });

    it('PRD §7.3: Redis succeeds but DB fails with non-unique error -> throws INTERNAL', async () => {
      setupHappyPathScreening();
      (redis.acquireHoldsAllOrNothing as jest.Mock).mockResolvedValue({
        acquired: ['ss-1', 'ss-2'],
        failed: [],
      });
      (ds.transaction as jest.Mock).mockRejectedValue(new Error('connection lost'));

      await expect(
        service.createReservation({
          screeningId: 's-1',
          screeningSeatIds: ['ss-1', 'ss-2'],
        }),
      ).rejects.toThrow(/Reservation failed; held seats released/);

      expect(redis.releaseAllHoldsForReservation).toHaveBeenCalled();
    });

    it('rejects when screening is not Published', async () => {
      (screeningRepo.findOne as jest.Mock).mockResolvedValue({
        id: 's-1',
        status: 'Draft',
        startsAt: new Date(Date.now() + 60 * 60 * 1000),
        salesOpensAt: new Date(Date.now() - 60 * 60 * 1000),
      } as ScreeningEntity);
      await expect(
        service.createReservation({
          screeningId: 's-1',
          screeningSeatIds: ['ss-1'],
        }),
      ).rejects.toThrow(/Screening not available for sale/);
    });

    it('rejects when sales have not opened yet (PRD §FR-03)', async () => {
      const future = new Date(Date.now() + 60 * 60 * 1000);
      (screeningRepo.findOne as jest.Mock).mockResolvedValue({
        id: 's-1',
        status: 'Published',
        startsAt: future,
        salesOpensAt: new Date(future.getTime() + 60 * 1000), // sales open AFTER start - which is wrong but here means future
      } as ScreeningEntity);
      await expect(
        service.createReservation({
          screeningId: 's-1',
          screeningSeatIds: ['ss-1'],
        }),
      ).rejects.toThrow(/Sales open at/);
    });

    it('rejects when screening already started', async () => {
      (screeningRepo.findOne as jest.Mock).mockResolvedValue({
        id: 's-1',
        status: 'Published',
        startsAt: new Date(Date.now() - 60 * 1000), // already started
        salesOpensAt: new Date(Date.now() - 120 * 1000),
      } as ScreeningEntity);
      await expect(
        service.createReservation({
          screeningId: 's-1',
          screeningSeatIds: ['ss-1'],
        }),
      ).rejects.toThrow(/Screening already started/);
    });

    it('rejects when a requested seat is Blocked or Sold', async () => {
      const future = new Date(Date.now() + 60 * 60 * 1000);
      (screeningRepo.findOne as jest.Mock).mockResolvedValue({
        id: 's-1',
        status: 'Published',
        startsAt: future,
        salesOpensAt: new Date(Date.now() - 60 * 1000), // sales already open (past)
      } as ScreeningEntity);
      (screeningSeatRepo.find as jest.Mock).mockResolvedValue([
        { id: 'ss-1', screeningId: 's-1', seatId: 'seat-1', price: 200_000, saleStatus: 'Sold' },
      ]);
      await expect(
        service.createReservation({
          screeningId: 's-1',
          screeningSeatIds: ['ss-1'],
        }),
      ).rejects.toThrow(/Seat ss-1 is Sold and cannot be reserved/);
    });
  });

  describe('expireReservation - idempotency + state re-check', () => {
    it('PRD §NFR-04: returns silently when reservation does not exist', async () => {
      (reservationRepo.findOne as jest.Mock).mockResolvedValue(null);
      await expect(service.expireReservation('r-nonexistent')).resolves.not.toThrow();
    });

    it('PRD §7.2 rule 4: idempotent - already processed -> no-op (expire_processed_at guard)', async () => {
      const r = {
        id: 'r-1',
        status: 'PendingPayment',
        expiresAt: new Date(Date.now() - 1000),
        expireProcessedAt: new Date(), // already processed
        seats: [],
      } as unknown as ReservationEntity;
      (reservationRepo.findOne as jest.Mock).mockResolvedValue(r);
      await service.expireReservation('r-1');
      // No save should be called because we early-return.
      expect(reservationRepo.save as jest.Mock).not.toHaveBeenCalled();
    });

    it('PRD §7.2 rule 4: if reservation has moved to Confirmed, expiry is a no-op (NOT solely TTL-based)', async () => {
      const r = {
        id: 'r-1',
        status: 'Confirmed',
        expiresAt: new Date(Date.now() - 1000), // TTL passed...
        expireProcessedAt: null, // not yet processed
        seats: [],
      } as unknown as ReservationEntity;
      (reservationRepo.findOne as jest.Mock).mockResolvedValue(r);
      (reservationRepo.save as jest.Mock).mockResolvedValue(r);

      await service.expireReservation('r-1');

      // Should mark processedAt to avoid re-processing; should NOT
      // call releaseReservationSeats (status wasn't PendingPayment).
      const saveCall = (reservationRepo.save as jest.Mock).mock.calls[0][0] as ReservationEntity;
      expect(saveCall.status).toBe('Confirmed'); // unchanged
      expect(saveCall.expireProcessedAt).toBeInstanceOf(Date);
    });

    it('PRD §NFR-04: idempotent - job fires but TTL not yet expired -> no-op (job fired early)', async () => {
      const r = {
        id: 'r-1',
        status: 'PendingPayment',
        expiresAt: new Date(Date.now() + 60 * 1000), // still in future
        expireProcessedAt: null,
        seats: [],
      } as unknown as ReservationEntity;
      (reservationRepo.findOne as jest.Mock).mockResolvedValue(r);
      await service.expireReservation('r-1');
      expect(reservationRepo.save as jest.Mock).not.toHaveBeenCalled();
    });
  });

  describe('reconcileExpired - scans for stale rows', () => {
    it('PRD §7.3 / §NFR-04: reconciliation picks up reservations whose expiry job was lost', async () => {
      const stale = [
        { id: 'r-1', status: 'PendingPayment', expiresAt: new Date(Date.now() - 1000) },
        { id: 'r-2', status: 'PendingPayment', expiresAt: new Date(Date.now() - 2000) },
      ];
      (reservationRepo.find as jest.Mock).mockResolvedValue(stale);
      // expireReservation will short-circuit (already-processed guard).
      // We expect it to be called once per stale row.
      const spy = jest.spyOn(service, 'expireReservation').mockResolvedValue(undefined);

      const result = await service.reconcileExpired();

      expect(spy).toHaveBeenCalledTimes(2);
      expect(result.expired).toBe(2);
    });

    it('returns 0 expired when no stale rows', async () => {
      (reservationRepo.find as jest.Mock).mockResolvedValue([]);
      const result = await service.reconcileExpired();
      expect(result.expired).toBe(0);
    });
  });

  describe('listMine - PRD §NFR-06 (customer can see only their own)', () => {
    it('returns the customer\'s reservations only', async () => {
      (reservationRepo.find as jest.Mock).mockResolvedValue([
        {
          id: 'r-1',
          customerId: 'u-1',
          status: 'PendingPayment',
          totalAmount: 100,
          currency: 'IRR',
          seats: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
      const result = await service.listMine('u-1');
      expect(result).toHaveLength(1);
      // Verify the query was scoped to the customerId.
      const callArgs = (reservationRepo.find as jest.Mock).mock.calls[0][0];
      expect(callArgs.where).toEqual({ customerId: 'u-1' });
    });
  });

  describe('findOne - PRD §NFR-06 ownership', () => {
    it('returns the reservation when caller is the owner', async () => {
      (reservationRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'r-1',
        customerId: 'u-1',
        guestPhone: null,
        seats: [],
        status: 'PendingPayment',
        totalAmount: 100,
        currency: 'IRR',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const result = await service.findOne('r-1', 'u-1');
      expect(result.id).toBe('r-1');
    });

    it('throws FORBIDDEN when caller is not the owner and there is no guest phone', async () => {
      (reservationRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'r-1',
        customerId: 'u-1',
        guestPhone: null, // guest phone not set -> ownership is enforced
      });
      await expect(service.findOne('r-1', 'u-other')).rejects.toThrow(
        /You do not own this reservation/,
      );
    });

    it('allows access when guestPhone is set (guests access via UUID URL)', async () => {
      (reservationRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'r-1',
        customerId: null,
        guestPhone: '+989120000001', // guest reservation
        seats: [],
        status: 'PendingPayment',
        totalAmount: 100,
        currency: 'IRR',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const result = await service.findOne('r-1', 'u-other');
      expect(result.id).toBe('r-1');
    });

    it('throws NOT_FOUND when reservation does not exist', async () => {
      (reservationRepo.findOne as jest.Mock).mockResolvedValue(null);
      await expect(service.findOne('r-nonexistent', 'u-1')).rejects.toThrow(
        /Reservation.*not found/,
      );
    });
  });

  describe('extendTtl - PRD §FR-05 rule 6 (no unlimited extension)', () => {
    it('rejects extension when reservation is not PendingPayment', async () => {
      (reservationRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'r-1',
        status: 'Confirmed',
        expiresAt: new Date(Date.now() + 60 * 1000),
        createdAt: new Date(Date.now() - 60 * 1000),
        seats: [],
      });
      await expect(
        service.extendTtl('r-1', { additionalMinutes: 5 }),
      ).rejects.toThrow(/Cannot extend reservation in status Confirmed/);
    });

    it('rejects extension when reservation already expired', async () => {
      (reservationRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'r-1',
        status: 'PendingPayment',
        expiresAt: new Date(Date.now() - 60 * 1000), // past
        createdAt: new Date(Date.now() - 120 * 1000),
        seats: [],
      });
      await expect(
        service.extendTtl('r-1', { additionalMinutes: 5 }),
      ).rejects.toThrow(/Reservation already expired/);
    });

    it('PRD §FR-05 rule 6: rejects extension that would exceed 2x default TTL (no unlimited)', async () => {
      // Create a reservation 19 minutes ago with expiresAt 1 minute from now.
      // Default TTL = 10 minutes, so max lifetime = 20 minutes.
      // Extending by 5 minutes would make lifetime = 25 minutes -> rejected.
      (reservationRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'r-1',
        status: 'PendingPayment',
        expiresAt: new Date(Date.now() + 60 * 1000), // 1 min remaining
        createdAt: new Date(Date.now() - 19 * 60 * 1000), // 19 min ago
        screeningId: 's-1',
        ownerToken: 't-1',
        seats: [{ screeningSeatId: 'ss-1' }],
      });
      await expect(
        service.extendTtl('r-1', { additionalMinutes: 5 }),
      ).rejects.toThrow(/Maximum reservation lifetime reached/);
    });
  });

  describe('cancelPending - idempotency + ownership', () => {
    it('rejects when reservation is Confirmed (use cancellation endpoint instead)', async () => {
      (reservationRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'r-1',
        status: 'Confirmed',
        customerId: 'u-1',
        guestPhone: null,
        seats: [],
        screeningId: 's-1',
        ownerToken: 't-1',
      });
      await expect(service.cancelPending('r-1', 'u-1')).rejects.toThrow(
        /Reservation is confirmed; use the cancellation endpoint/,
      );
    });

    it('rejects when reservation is Expired', async () => {
      (reservationRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'r-1',
        status: 'Expired',
        customerId: 'u-1',
        guestPhone: null,
        seats: [],
        screeningId: 's-1',
        ownerToken: 't-1',
      });
      await expect(service.cancelPending('r-1', 'u-1')).rejects.toThrow(
        /Reservation already expired/,
      );
    });

    it('rejects when caller is not the owner and there is no guest phone', async () => {
      (reservationRepo.findOne as jest.Mock).mockResolvedValue({
        id: 'r-1',
        status: 'PendingPayment',
        customerId: 'u-1',
        guestPhone: null,
        seats: [],
      });
      await expect(service.cancelPending('r-1', 'u-other')).rejects.toThrow(
        /Not your reservation/,
      );
    });
  });
});
